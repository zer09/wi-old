import type Database from "better-sqlite3";
import { z } from "zod";

import {
  canonicalJson,
  CanonicalJsonValueSchema,
  CommandIdSchema,
  SessionEventSchema,
  SessionIdSchema,
  type SessionEvent,
} from "@wi/protocol";

import { applyMigrations } from "../common/migrations.js";
import { StorageError } from "../common/worker-rpc.js";
import {
  AcceptCommandInputSchema,
  AcceptedCommandResultSchema,
  AppendTransactionInputSchema,
  BoundedProviderRequestDataInputSchema,
  InputRecordSchema,
  PendingApprovalRecordSchema,
  PendingInputRecordSchema,
  ProviderStepRecordSchema,
  RunMessageRecordSchema,
  RunRecordSchema,
  SessionProviderDefaultRecordSchema,
  ToolExecutionRecordSchema,
  ProjectionMutationSchema,
  SESSION_EVENT_PAGE_BOUNDS,
  SESSION_FORMAT_VERSION,
  SESSION_SCHEMA_VERSION,
  SessionCatalogObservationSchema,
  SessionCatalogProjectionSchema,
  SessionEventPageInputSchema,
  SessionManifestSchema,
  SessionRecoveryResultSchema,
  CreationProvenanceSchema,
  type CreationProvenance,
  type AcceptCommandInput,
  type AcceptedCommandResult,
  type AppendTransactionInput,
  type AppendTransactionInspection,
  type BoundedProviderRequestData,
  type InputRecord,
  type PendingApprovalRecord,
  type PendingInputRecord,
  type ProviderStepRecord,
  type RunMessageRecord,
  type RunRecord,
  type SessionProviderDefaultRecord,
  type ToolExecutionRecord,
  type SessionCatalogObservation,
  type SessionCatalogProjection,
  type SessionEventPage,
  type SessionManifest,
  type SessionRecoveryResult,
} from "../types.js";
import { sessionMigrations } from "./migrations.js";
import { applyProjection, areProjectionsApplied } from "./projections.js";

export const InitializeSessionInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  projectId: z.string().nullable(),
  title: z.string(),
  createdAtMs: z.number().int().nonnegative().safe(),
  eventId: z.string().min(1),
  // Direct storage fixtures retained from pre-v4 may initialize without this
  // immutable identity; normal SessionStoreManager creation always supplies it.
  creation: CreationProvenanceSchema.optional(),
});

interface EventRow {
  sequence: number;
  eventId: string;
  eventType: string;
  createdAtMs: number;
  payloadJson: string;
}

interface AcceptedCommandRow {
  commandId: string;
  commandMethod: string;
  payloadHash: string;
  acceptedSequence: number | null;
  runId: string | null;
  resultJson: string;
  acceptedAtMs: number;
}

function runIdFromData(data: unknown): string | null {
  if (data === null || typeof data !== "object" || !("runId" in data)) return null;
  const runId = (data as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : null;
}

function decodeStoredValue<T>(description: string, decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new StorageError("storage.corrupt", `Stored ${description} is invalid`);
  }
}

export class SessionRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly allowTestOperations: boolean,
    private readonly allowTestFailpoints = false,
  ) {
    applyMigrations(database, sessionMigrations, SESSION_SCHEMA_VERSION);
  }

  initialize(inputValue: unknown): { manifest: SessionManifest; events: readonly SessionEvent[] } {
    const input = InitializeSessionInputSchema.parse(inputValue);
    const existing = this.getManifestOrNull();
    if (existing !== null) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.projectId !== input.projectId ||
        existing.title !== input.title ||
        existing.createdAtMs !== input.createdAtMs
      ) {
        throw new StorageError("storage.corrupt", "Session manifest identity does not match");
      }
      const provenance = this.getCreationProvenance();
      if (
        provenance !== null &&
        input.creation !== undefined &&
        canonicalJson(provenance) !== canonicalJson(input.creation)
      ) {
        throw new StorageError("storage.corrupt", "Session creation provenance does not match");
      }
      const events = this.getEventsAfter(0, 1);
      const created = events[0];
      if (
        created === undefined ||
        created.eventType !== "session.created" ||
        created.eventId !== input.eventId
      ) {
        throw new StorageError("storage.corrupt", "Session creation event identity does not match");
      }
      const createdProjectId = created.data.projectId ?? null;
      if (created.data.title !== input.title || createdProjectId !== input.projectId) {
        throw new StorageError("storage.corrupt", "Session creation event payload does not match");
      }
      return { manifest: existing, events };
    }

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO manifest (
             singleton, session_id, project_id, created_at_ms, schema_version,
             format_version, title, last_event_sequence
           ) VALUES (1, @sessionId, @projectId, @createdAtMs, @schemaVersion,
                     @formatVersion, @title, 0)`,
        )
        .run({
          ...input,
          schemaVersion: SESSION_SCHEMA_VERSION,
          formatVersion: SESSION_FORMAT_VERSION,
        });
      const data = {
        eventVersion: 1 as const,
        title: input.title,
        ...(input.projectId === null ? {} : { projectId: input.projectId }),
      };
      const events = this.appendRows([
        {
          eventId: input.eventId,
          eventType: "session.created",
          createdAtMs: input.createdAtMs,
          data,
        },
      ]);
      if (input.creation !== undefined) {
        this.database
          .prepare(
            `INSERT INTO creation_provenance (
               singleton, command_id, payload_hash, command_method, event_id, result_json, accepted_at_ms
             ) VALUES (1, @commandId, @payloadHash, @commandMethod, @eventId, @resultJson, @acceptedAtMs)`,
          )
          .run({ ...input.creation, resultJson: canonicalJson(input.creation.result) });
      }
      return events;
    });
    const events = transaction.immediate();
    return { manifest: this.getManifest(), events };
  }

  getManifest(): SessionManifest {
    const manifest = this.getManifestOrNull();
    if (manifest === null) {
      throw new StorageError("storage.session_uninitialized", "Session is not initialized");
    }
    return manifest;
  }

  getCreationProvenance(): CreationProvenance | null {
    const row = this.database
      .prepare(
        `SELECT command_id AS commandId, payload_hash AS payloadHash, command_method AS commandMethod,
                event_id AS eventId, result_json AS resultJson, accepted_at_ms AS acceptedAtMs
         FROM creation_provenance WHERE singleton = 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return decodeStoredValue("session creation provenance", () => {
      const { resultJson, ...provenance } = row;
      return CreationProvenanceSchema.parse({
        ...provenance,
        result: JSON.parse(String(resultJson)),
      });
    });
  }

  private getManifestOrNull(): SessionManifest | null {
    const row = this.database
      .prepare(
        `SELECT session_id AS sessionId, project_id AS projectId, created_at_ms AS createdAtMs,
                schema_version AS schemaVersion, format_version AS formatVersion,
                title, last_event_sequence AS lastEventSequence
         FROM manifest WHERE singleton = 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row === undefined
      ? null
      : decodeStoredValue("session manifest", () => SessionManifestSchema.parse(row));
  }

  private appendRows(eventsInput: readonly unknown[]): readonly SessionEvent[] {
    const manifest = this.getManifest();
    let expectedSequence = manifest.lastEventSequence;
    const inserted: SessionEvent[] = [];
    const statement = this.database.prepare(
      `INSERT INTO events (
         event_id, event_type, event_version, created_at_ms, run_id, item_id, payload_json
       ) VALUES (@eventId, @eventType, @eventVersion, @createdAtMs, @runId, @itemId, @payloadJson)`,
    );

    for (const value of eventsInput) {
      const eventInput = z
        .strictObject({
          eventId: z.string().min(1),
          eventType: z.string().min(1),
          createdAtMs: z.number().int().nonnegative().safe(),
          data: z.unknown(),
          itemId: z.string().nullable().optional(),
        })
        .parse(value);
      const eventVersion =
        eventInput.data !== null &&
        typeof eventInput.data === "object" &&
        "eventVersion" in eventInput.data
          ? (eventInput.data as { eventVersion?: unknown }).eventVersion
          : undefined;
      if (eventVersion !== 1 && eventVersion !== 2) {
        throw new StorageError(
          "protocol.invalid_message",
          "Event version must be 1 or 2",
        );
      }

      const result = statement.run({
        eventId: eventInput.eventId,
        eventType: eventInput.eventType,
        eventVersion,
        createdAtMs: eventInput.createdAtMs,
        runId: runIdFromData(eventInput.data),
        itemId: eventInput.itemId ?? null,
        payloadJson: canonicalJson(eventInput.data),
      });
      const sequence = Number(result.lastInsertRowid);
      expectedSequence += 1;
      if (sequence !== expectedSequence) {
        throw new StorageError("storage.corrupt", "Session event sequence is not contiguous");
      }
      inserted.push(
        SessionEventSchema.parse({
          v: 1,
          kind: "event",
          sessionId: manifest.sessionId,
          sequence,
          eventId: eventInput.eventId,
          eventType: eventInput.eventType,
          createdAtMs: eventInput.createdAtMs,
          data: eventInput.data,
        }),
      );
    }

    this.database
      .prepare("UPDATE manifest SET last_event_sequence = ? WHERE singleton = 1")
      .run(expectedSequence);
    return inserted;
  }

  private applyTransaction(input: AppendTransactionInput): {
    events: readonly SessionEvent[];
    headSequence: number;
  } {
    const events = this.appendRows(input.events);
    for (const mutation of input.projections ?? []) {
      applyProjection(this.database, ProjectionMutationSchema.parse(mutation));
    }
    const headSequence = events.at(-1)?.sequence ?? this.getManifest().lastEventSequence;
    return { events, headSequence };
  }

  appendTransaction(inputValue: unknown): {
    events: readonly SessionEvent[];
    headSequence: number;
  } {
    const input = AppendTransactionInputSchema.parse(inputValue);
    if (input.testFailpoint !== undefined && !this.allowTestFailpoints) {
      throw new StorageError("storage.worker_failed", "Storage failpoints are disabled");
    }
    const transaction = this.database.transaction(() => {
      const result = this.applyTransaction(input);
      if (input.testFailpoint === "crash_before_commit") process.exit(71);
      return result;
    });
    const result = transaction.immediate();
    if (input.testFailpoint === "crash_after_commit") process.exit(72);
    return result;
  }

  inspectAppendTransaction(inputValue: unknown): AppendTransactionInspection {
    const input = AppendTransactionInputSchema.parse(inputValue);
    const inspect = this.database.transaction(() => ({
      storedEvents: input.events.map((event) => this.getEventById(event.eventId)),
      headSequence: this.getHeadSequence(),
      projectionsApplied: areProjectionsApplied(this.database, input.projections),
    }));
    return inspect.deferred();
  }

  acceptCommand(inputValue: unknown): AcceptedCommandResult {
    const input = AcceptCommandInputSchema.parse(inputValue);
    if (input.transaction.testFailpoint !== undefined && !this.allowTestFailpoints) {
      throw new StorageError("storage.worker_failed", "Storage failpoints are disabled");
    }
    const transaction = this.database.transaction(() => {
      const existing = this.getAcceptedCommandRow(input.commandId);
      if (existing !== null) {
        if (
          existing.commandMethod !== input.commandMethod ||
          existing.payloadHash !== input.payloadHash
        ) {
          throw new StorageError(
            "protocol.command_id_conflict",
            `Command ${input.commandId} was reused with different content`,
          );
        }
        return this.acceptedResult(existing, true, []);
      }

      const append = this.applyTransaction(input.transaction);
      this.database
        .prepare(
          `INSERT INTO accepted_commands (
             command_id, command_method, payload_hash, accepted_sequence,
             run_id, result_json, accepted_at_ms
           ) VALUES (
             @commandId, @commandMethod, @payloadHash, @acceptedSequence,
             @runId, @resultJson, @acceptedAtMs
           )`,
        )
        .run({
          commandId: input.commandId,
          commandMethod: input.commandMethod,
          payloadHash: input.payloadHash,
          acceptedSequence: append.headSequence,
          runId: input.runId,
          resultJson: canonicalJson(input.result),
          acceptedAtMs: input.acceptedAtMs,
        });
      if (input.transaction.testFailpoint === "crash_before_commit") process.exit(71);
      if (input.transaction.testFailpoint === "after_command_event_insert_before_commit") {
        process.exit(74);
      }
      const row = this.getAcceptedCommandRow(input.commandId);
      if (row === null) throw new Error("Accepted command disappeared");
      return this.acceptedResult(row, false, append.events);
    });
    const result = transaction.immediate();
    if (input.transaction.testFailpoint === "crash_after_commit") process.exit(72);
    return result;
  }

  private getAcceptedCommandRow(commandIdValue: string): AcceptedCommandRow | null {
    const commandId = CommandIdSchema.parse(commandIdValue);
    const row = this.database
      .prepare(
        `SELECT command_id AS commandId, command_method AS commandMethod,
                payload_hash AS payloadHash, accepted_sequence AS acceptedSequence,
                run_id AS runId, result_json AS resultJson, accepted_at_ms AS acceptedAtMs
         FROM accepted_commands WHERE command_id = ?`,
      )
      .get(commandId) as AcceptedCommandRow | undefined;
    return row ?? null;
  }

  getAcceptedCommand(commandIdValue: string): AcceptedCommandResult | null {
    const row = this.getAcceptedCommandRow(commandIdValue);
    return row === null ? null : this.acceptedResult(row, true, []);
  }

  private acceptedResult(
    row: AcceptedCommandRow,
    duplicate: boolean,
    events: readonly SessionEvent[],
  ): AcceptedCommandResult {
    return decodeStoredValue(`accepted command ${row.commandId}`, () =>
      AcceptedCommandResultSchema.parse({
        commandId: row.commandId,
        commandMethod: row.commandMethod as AcceptCommandInput["commandMethod"],
        payloadHash: row.payloadHash,
        acceptedSequence: row.acceptedSequence,
        runId: row.runId,
        result: CanonicalJsonValueSchema.parse(JSON.parse(row.resultJson) as unknown),
        acceptedAtMs: row.acceptedAtMs,
        duplicate,
        events: [...events],
      }),
    );
  }

  private decodeEventRow(row: EventRow, sessionId: string): SessionEvent {
    return decodeStoredValue(`session event ${row.sequence}`, () =>
      SessionEventSchema.parse({
        v: 1,
        kind: "event",
        sessionId,
        sequence: row.sequence,
        eventId: row.eventId,
        eventType: row.eventType,
        createdAtMs: row.createdAtMs,
        data: JSON.parse(row.payloadJson) as unknown,
      }),
    );
  }

  getEventsAfter(afterSequence: number, throughSequence?: number): readonly SessionEvent[] {
    const after = z.number().int().nonnegative().safe().parse(afterSequence);
    const through =
      throughSequence === undefined
        ? this.getManifest().lastEventSequence
        : z.number().int().nonnegative().safe().parse(throughSequence);
    const rows = this.database
      .prepare(
        `SELECT sequence, event_id AS eventId, event_type AS eventType,
                created_at_ms AS createdAtMs, payload_json AS payloadJson
         FROM events
         WHERE sequence > ? AND sequence <= ?
         ORDER BY sequence`,
      )
      .all(after, through) as EventRow[];
    const sessionId = this.getManifest().sessionId;
    return rows.map((row) => this.decodeEventRow(row, sessionId));
  }

  getEventPageAfter(inputValue: unknown): SessionEventPage {
    const input = SessionEventPageInputSchema.parse(inputValue);
    const sessionId = this.getManifest().sessionId;
    const rows = this.database
      .prepare(
        `SELECT sequence, event_id AS eventId, event_type AS eventType,
                created_at_ms AS createdAtMs, payload_json AS payloadJson
         FROM events
         WHERE sequence > ? AND sequence <= ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .iterate(
        input.afterSequence,
        input.throughSequence,
        input.maximumEvents + 1,
      ) as IterableIterator<EventRow>;
    const events: SessionEvent[] = [];
    let eventBytesTotal = 0;
    let stoppedAtBound = false;
    for (const row of rows) {
      if (events.length >= input.maximumEvents) {
        stoppedAtBound = true;
        break;
      }
      if (Buffer.byteLength(row.payloadJson) > input.maximumSingleEventBytes) {
        throw new StorageError(
          "storage.payload_too_large",
          `Stored session event ${row.sequence} exceeds the replay event byte limit`,
        );
      }
      const event = this.decodeEventRow(row, sessionId);
      const eventBytes = Buffer.byteLength(JSON.stringify(event));
      if (eventBytes > input.maximumSingleEventBytes) {
        throw new StorageError(
          "storage.payload_too_large",
          `Session event ${row.sequence} exceeds the replay event byte limit`,
        );
      }
      const separatorBytes = events.length === 0 ? 0 : 1;
      if (
        eventBytesTotal >
        input.maximumBytes -
          SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes -
          separatorBytes -
          eventBytes
      ) {
        if (events.length === 0) {
          throw new StorageError(
            "storage.payload_too_large",
            `Session event ${row.sequence} does not fit within a replay page`,
          );
        }
        stoppedAtBound = true;
        break;
      }
      events.push(event);
      eventBytesTotal += separatorBytes + eventBytes;
    }
    const pageWithoutSize = {
      events,
      nextAfterSequence: events.at(-1)?.sequence ?? input.afterSequence,
      done: !stoppedAtBound,
    };
    let serializedBytes = 0;
    while (true) {
      const measured = Buffer.byteLength(
        JSON.stringify({ ...pageWithoutSize, serializedBytes }),
      );
      if (measured === serializedBytes) break;
      serializedBytes = measured;
    }
    if (serializedBytes > input.maximumBytes) {
      throw new StorageError(
        "storage.payload_too_large",
        "Replay page response exceeded its serialized byte limit",
      );
    }
    return { ...pageWithoutSize, serializedBytes };
  }

  getHeadSequence(): number {
    return this.getManifest().lastEventSequence;
  }

  getEventById(eventId: string): SessionEvent | null {
    const row = this.database
      .prepare(
        `SELECT sequence, event_id AS eventId, event_type AS eventType,
                created_at_ms AS createdAtMs, payload_json AS payloadJson
         FROM events WHERE event_id = ?`,
      )
      .get(eventId) as EventRow | undefined;
    if (row === undefined) return null;
    const sessionId = this.getManifest().sessionId;
    return decodeStoredValue(`session event ${row.sequence}`, () =>
      SessionEventSchema.parse({
        v: 1,
        kind: "event",
        sessionId,
        sequence: row.sequence,
        eventId: row.eventId,
        eventType: row.eventType,
        createdAtMs: row.createdAtMs,
        data: JSON.parse(row.payloadJson) as unknown,
      }),
    );
  }

  getRun(runId: string): RunRecord | null {
    const row = this.database
      .prepare(
        `SELECT run_id AS runId, state, provider_id AS providerId,
                provider_config_json AS providerConfigJson,
                provider_snapshot_json AS providerSnapshotJson,
                created_at_ms AS createdAtMs,
                started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                cancelled_at_ms AS cancelledAtMs, failure_category AS failureCategory,
                failure_message AS failureMessage,
                active_provider_step_id AS activeProviderStepId
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as
        | (Omit<RunRecord, "providerConfig" | "providerSelection"> & {
            providerConfigJson: string;
            providerSnapshotJson: string | null;
          })
        | undefined;
    if (row === undefined) return null;
    const { providerConfigJson, providerSnapshotJson, ...record } = row;
    return decodeStoredValue(`run ${runId}`, () =>
      RunRecordSchema.parse({
        ...record,
        providerConfig: CanonicalJsonValueSchema.parse(JSON.parse(providerConfigJson) as unknown),
        providerSelection: providerSnapshotJson === null
          ? null
          : JSON.parse(providerSnapshotJson) as unknown,
      }),
    );
  }

  getSessionProviderDefault(): SessionProviderDefaultRecord | null {
    const row = this.database.prepare(
      `SELECT default_json AS defaultJson, updated_sequence AS updatedSequence,
              event_id AS eventId FROM session_provider_default WHERE singleton = 1`,
    ).get() as { defaultJson: string; updatedSequence: number; eventId: string } | undefined;
    if (row === undefined) return null;
    return decodeStoredValue("session provider default", () =>
      SessionProviderDefaultRecordSchema.parse({
        default: JSON.parse(row.defaultJson) as unknown,
        updatedSequence: row.updatedSequence,
        eventId: row.eventId,
      }),
    );
  }

  getRunProviderMatch(runId: string, expectedProviderId: string): "missing" | "match" | "mismatch" {
    const row = this.database
      .prepare(
        `SELECT CASE WHEN provider_id = @expectedProviderId THEN 1 ELSE 0 END AS matches
         FROM runs WHERE run_id = @runId`,
      )
      .get({ runId, expectedProviderId }) as { matches: number } | undefined;
    if (row === undefined) return "missing";
    return row.matches === 1 ? "match" : "mismatch";
  }

  getBoundedProviderRequestData(inputValue: unknown): BoundedProviderRequestData {
    const input = BoundedProviderRequestDataInputSchema.parse(inputValue);
    const run = this.database
      .prepare(
        `SELECT CASE WHEN provider_id = @expectedProviderId THEN 1 ELSE 0 END AS providerMatches,
                length(CAST(provider_config_json AS BLOB)) AS providerConfigBytes,
                EXISTS(
                  SELECT 1 FROM tool_executions
                  WHERE run_id = @runId AND state = 'outcome_unknown'
                ) AS hasOutcomeUnknown
         FROM runs WHERE run_id = @runId`,
      )
      .get(input) as
      | { providerMatches: number; providerConfigBytes: number; hasOutcomeUnknown: number }
      | undefined;
    if (run === undefined) return { status: "missing" };
    if (run.providerMatches !== 1) return { status: "provider_mismatch" };
    if (run.hasOutcomeUnknown === 1) return { status: "unsafe_outcome_unknown" };
    if (run.providerConfigBytes > input.maxProviderConfigBytes) {
      return { status: "limit_exceeded", boundary: "provider_config" };
    }

    const providerConfig = this.database
      .prepare(`SELECT provider_config_json AS providerConfigJson FROM runs WHERE run_id = ?`)
      .get(input.runId) as { providerConfigJson: string } | undefined;
    if (providerConfig === undefined) return { status: "missing" };
    const requestPrefix =
      `{"runId":${JSON.stringify(input.runId)},"stepId":${JSON.stringify(input.stepId)},` +
      `"stepIndex":${input.stepIndex},"providerConfig":${providerConfig.providerConfigJson},` +
      `"input":`;
    const requestSuffix = "}";
    const envelopeBytes = Buffer.byteLength(requestPrefix) + Buffer.byteLength(requestSuffix);
    if (envelopeBytes + 2 > input.maxRequestBytes) {
      return { status: "limit_exceeded", boundary: "request_bytes" };
    }
    const maxInputBytes = input.maxRequestBytes - envelopeBytes;

    const messages = this.database
      .prepare(
        `SELECT m.message_id AS messageId, m.role,
                SUM(length(CAST(COALESCE(p.text_content, '') AS BLOB))) AS rawTextBytes
         FROM messages m
         JOIN message_parts p ON p.message_id = m.message_id
         WHERE m.run_id = @runId AND m.role != 'tool'
         GROUP BY m.message_id, m.role, m.created_at_ms
         HAVING SUM(length(CAST(COALESCE(p.text_content, '') AS BLOB))) > 0
         ORDER BY m.created_at_ms, m.message_id
         LIMIT @limit`,
      )
      .all({ runId: input.runId, limit: input.maxInputItems + 1 }) as {
      messageId: string;
      role: "user" | "assistant" | "system";
      rawTextBytes: number;
    }[];
    if (messages.length > input.maxInputItems) {
      return { status: "limit_exceeded", boundary: "input_items" };
    }
    if (messages.some((message) => message.rawTextBytes > input.maxMessageTextBytes)) {
      return { status: "limit_exceeded", boundary: "message_text" };
    }

    const remainingItems = input.maxInputItems - messages.length;
    const tools = this.database
      .prepare(
        `SELECT call_id AS callId, state,
                length(CAST(tool_name AS BLOB)) AS rawToolNameBytes,
                CASE WHEN result_json IS NULL THEN 4
                     ELSE length(CAST(result_json AS BLOB)) END AS resultJsonBytes,
                CASE WHEN error_json IS NULL THEN 4
                     ELSE length(CAST(error_json AS BLOB)) END AS errorJsonBytes
         FROM tool_executions
         WHERE run_id = @runId
           AND state IN ('completed', 'failed', 'denied', 'cancelled')
         ORDER BY requested_at_ms, call_id
         LIMIT @limit`,
      )
      .all({ runId: input.runId, limit: remainingItems + 1 }) as {
      callId: string;
      state: "completed" | "failed" | "denied" | "cancelled";
      rawToolNameBytes: number;
      resultJsonBytes: number;
      errorJsonBytes: number;
    }[];
    if (tools.length > remainingItems) {
      return { status: "limit_exceeded", boundary: "input_items" };
    }
    if (tools.some((tool) => tool.rawToolNameBytes > input.maxToolNameBytes)) {
      return { status: "limit_exceeded", boundary: "tool_name" };
    }

    let minimumInputBytes = 2 + Math.max(0, messages.length + tools.length - 1);
    for (const message of messages) {
      const emptyItem = JSON.stringify({ type: "message", role: message.role, text: "" });
      minimumInputBytes += Buffer.byteLength(emptyItem) + message.rawTextBytes;
      if (minimumInputBytes > maxInputBytes) {
        return { status: "limit_exceeded", boundary: "request_bytes" };
      }
    }
    for (const tool of tools) {
      const emptyItem = JSON.stringify({
        type: "tool_result",
        callId: tool.callId,
        toolName: "",
        outcome: tool.state,
        result: null,
        error: null,
      });
      minimumInputBytes +=
        Buffer.byteLength(emptyItem) -
        4 -
        4 +
        tool.rawToolNameBytes +
        tool.resultJsonBytes +
        tool.errorJsonBytes;
      if (minimumInputBytes > maxInputBytes) {
        return { status: "limit_exceeded", boundary: "request_bytes" };
      }
    }

    const inputItems: string[] = [];
    let inputBytes = 2;
    const appendItem = (item: string): boolean => {
      const separatorBytes = inputItems.length === 0 ? 0 : 1;
      const nextBytes = inputBytes + separatorBytes + Buffer.byteLength(item);
      if (nextBytes > maxInputBytes) return false;
      inputItems.push(item);
      inputBytes = nextBytes;
      return true;
    };
    const messageText = this.database.prepare(
      `SELECT group_concat(text_content, '') AS text
       FROM (
         SELECT COALESCE(text_content, '') AS text_content
         FROM message_parts WHERE message_id = ? ORDER BY part_index
       )`,
    );
    for (const message of messages) {
      const row = messageText.get(message.messageId) as { text: string | null };
      const item = JSON.stringify({ type: "message", role: message.role, text: row.text ?? "" });
      if (!appendItem(item)) {
        return { status: "limit_exceeded", boundary: "request_bytes" };
      }
    }

    const toolData = this.database.prepare(
      `SELECT tool_name AS toolName, state, result_json AS resultJson, error_json AS errorJson
       FROM tool_executions WHERE call_id = ?`,
    );
    for (const tool of tools) {
      const row = toolData.get(tool.callId) as {
        toolName: string;
        state: typeof tool.state;
        resultJson: string | null;
        errorJson: string | null;
      };
      const item =
        `{"type":"tool_result","callId":${JSON.stringify(tool.callId)},` +
        `"toolName":${JSON.stringify(row.toolName)},"outcome":${JSON.stringify(row.state)},` +
        `"result":${row.resultJson ?? "null"},"error":${row.errorJson ?? "null"}}`;
      if (!appendItem(item)) {
        return { status: "limit_exceeded", boundary: "request_bytes" };
      }
    }

    const inputJson = `[${inputItems.join(",")}]`;
    const requestJson = `${requestPrefix}${inputJson}${requestSuffix}`;
    if (Buffer.byteLength(requestJson) > input.maxRequestBytes) {
      return { status: "limit_exceeded", boundary: "request_bytes" };
    }
    return { status: "ready", requestJson };
  }

  getProviderStep(stepId: string): ProviderStepRecord | null {
    const row = this.database
      .prepare(
        `SELECT step_id AS stepId, run_id AS runId, step_index AS stepIndex, state,
                started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                response_id AS responseId, error_category AS errorCategory,
                error_message AS errorMessage, diagnostic_id AS diagnosticId
         FROM provider_steps WHERE step_id = ?`,
      )
      .get(stepId) as unknown;
    if (row === undefined) return null;
    return decodeStoredValue(`provider step ${stepId}`, () => ProviderStepRecordSchema.parse(row));
  }

  getProviderStepsForRun(runId: string): readonly ProviderStepRecord[] {
    const rows = this.database
      .prepare(
        `SELECT step_id AS stepId, run_id AS runId, step_index AS stepIndex, state,
                started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                response_id AS responseId, error_category AS errorCategory,
                error_message AS errorMessage, diagnostic_id AS diagnosticId
         FROM provider_steps WHERE run_id = ? ORDER BY step_index`,
      )
      .all(runId) as unknown[];
    return rows.map((row) =>
      decodeStoredValue("provider step", () => ProviderStepRecordSchema.parse(row)),
    );
  }

  private decodeToolExecution(row: Record<string, unknown>): ToolExecutionRecord {
    const { resultJson, errorJson, ...record } = row;
    const effectClass = record.effectClass === "unclassified" ? null : record.effectClass;
    return decodeStoredValue(`tool execution ${String(record.callId)}`, () =>
      ToolExecutionRecordSchema.parse({
        ...record,
        effectClass,
        result:
          resultJson === null
            ? null
            : CanonicalJsonValueSchema.parse(JSON.parse(String(resultJson)) as unknown),
        error:
          errorJson === null
            ? null
            : CanonicalJsonValueSchema.parse(JSON.parse(String(errorJson)) as unknown),
      }),
    );
  }

  private toolExecutionRows(where: string, ...values: readonly string[]): readonly ToolExecutionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT call_id AS callId, run_id AS runId, step_id AS stepId,
                tool_name AS toolName, arguments_json AS argumentsJson,
                arguments_hash AS argumentsHash, effect_class AS effectClass, state,
                attempt_count AS attemptCount, requested_at_ms AS requestedAtMs,
                started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                result_json AS resultJson, error_json AS errorJson
         FROM tool_executions WHERE ${where}
         ORDER BY requested_at_ms, call_id`,
      )
      .all(...values) as Record<string, unknown>[];
    return rows.map((row) => this.decodeToolExecution(row));
  }

  getRecentProviderStepsForRun(runId: string, limitValue: unknown): readonly ProviderStepRecord[] {
    const limit = z.number().int().positive().max(1024).parse(limitValue);
    const rows = this.database
      .prepare(
        `SELECT step_id AS stepId, run_id AS runId, step_index AS stepIndex, state,
                started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                response_id AS responseId, error_category AS errorCategory,
                error_message AS errorMessage, diagnostic_id AS diagnosticId
         FROM provider_steps WHERE run_id = ? ORDER BY step_index DESC LIMIT ?`,
      )
      .all(runId, limit) as unknown[];
    return rows
      .map((row) => decodeStoredValue("provider step", () => ProviderStepRecordSchema.parse(row)))
      .reverse();
  }

  getToolExecution(callId: string): ToolExecutionRecord | null {
    return this.toolExecutionRows("call_id = ?", callId)[0] ?? null;
  }

  getToolExecutionsForStep(stepId: string): readonly ToolExecutionRecord[] {
    return this.toolExecutionRows(
      "call_id IN (SELECT call_id FROM tool_call_occurrences WHERE step_id = ?)",
      stepId,
    );
  }

  getToolExecutionsForRun(runId: string): readonly ToolExecutionRecord[] {
    return this.toolExecutionRows("run_id = ?", runId);
  }

  private decodeRunMessages(messages: readonly Record<string, unknown>[]): readonly RunMessageRecord[] {
    const partStatement = this.database.prepare(
      `SELECT text_content AS textContent FROM message_parts
       WHERE message_id = ? ORDER BY part_index`,
    );
    return messages.map((message) => {
      const parts = partStatement.all(message.messageId) as { textContent: string | null }[];
      return decodeStoredValue(`run message ${String(message.messageId)}`, () =>
        RunMessageRecordSchema.parse({
          ...message,
          text: parts.map((part) => part.textContent ?? "").join(""),
        }),
      );
    });
  }

  getRunMessages(runId: string): readonly RunMessageRecord[] {
    const messages = this.database
      .prepare(
        `SELECT message_id AS messageId, run_id AS runId, role, state,
                created_at_ms AS createdAtMs, completed_at_ms AS completedAtMs
         FROM messages WHERE run_id = ? ORDER BY created_at_ms, message_id`,
      )
      .all(runId) as Record<string, unknown>[];
    return this.decodeRunMessages(messages);
  }

  getStreamingMessagesForStep(stepId: string): readonly RunMessageRecord[] {
    const messages = this.database
      .prepare(
        `SELECT DISTINCT m.message_id AS messageId, m.run_id AS runId, m.role, m.state,
                m.created_at_ms AS createdAtMs, m.completed_at_ms AS completedAtMs
         FROM events e
         JOIN messages m ON m.message_id = json_extract(e.payload_json, '$.messageId')
         WHERE e.event_type = 'provider.text.delta'
           AND json_extract(e.payload_json, '$.stepId') = ?
           AND m.role = 'assistant'
           AND m.state = 'streaming'
         ORDER BY m.created_at_ms, m.message_id`,
      )
      .all(stepId) as Record<string, unknown>[];
    return this.decodeRunMessages(messages);
  }

  getNonterminalRuns(): readonly RunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT runs.run_id AS runId, runs.state,
                runs.provider_id AS providerId,
                runs.provider_config_json AS providerConfigJson,
                runs.provider_snapshot_json AS providerSnapshotJson,
                runs.created_at_ms AS createdAtMs,
                runs.started_at_ms AS startedAtMs,
                runs.completed_at_ms AS completedAtMs,
                runs.cancelled_at_ms AS cancelledAtMs,
                runs.failure_category AS failureCategory,
                runs.failure_message AS failureMessage,
                runs.active_provider_step_id AS activeProviderStepId
         FROM runs
         LEFT JOIN accepted_commands AS command
           ON command.run_id = runs.run_id AND command.command_method = 'message.submit'
         WHERE state NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
         ORDER BY command.accepted_sequence IS NULL, command.accepted_sequence,
                  runs.created_at_ms, runs.run_id`,
      )
      .all() as (Omit<RunRecord, "providerConfig" | "providerSelection"> & {
        providerConfigJson: string;
        providerSnapshotJson: string | null;
      })[];
    return rows.map(({ providerConfigJson, providerSnapshotJson, ...record }) =>
      decodeStoredValue(`run ${record.runId}`, () =>
        RunRecordSchema.parse({
          ...record,
          providerConfig: CanonicalJsonValueSchema.parse(JSON.parse(providerConfigJson) as unknown),
          providerSelection: providerSnapshotJson === null
            ? null
            : JSON.parse(providerSnapshotJson) as unknown,
        }),
      ),
    );
  }

  getCatalogProjection(): SessionCatalogProjection {
    const latestEvent = this.database
      .prepare("SELECT created_at_ms AS createdAtMs FROM events ORDER BY sequence DESC LIMIT 1")
      .get() as { createdAtMs: number } | undefined;
    const runEvent = this.database
      .prepare(
        `SELECT event_type AS eventType FROM events
         WHERE event_type IN (
           'run.created', 'run.started', 'run.waiting_for_user', 'run.cancel.requested',
           'run.cancelled', 'run.completed', 'run.failed', 'run.interrupted'
         )
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get() as { eventType: string } | undefined;
    const runStates: Readonly<Record<string, SessionCatalogProjection["lastRunState"]>> = {
      "run.created": "created",
      "run.started": "running",
      "run.waiting_for_user": "waiting_for_user",
      "run.cancel.requested": "cancelling",
      "run.cancelled": "cancelled",
      "run.completed": "completed",
      "run.failed": "failed",
      "run.interrupted": "interrupted",
    };
    const messageEvent = this.database
      .prepare(
        `SELECT payload_json AS payloadJson FROM events
         WHERE event_type = 'user.message.appended'
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get() as { payloadJson: string } | undefined;
    const messageData =
      messageEvent === undefined
        ? null
        : decodeStoredValue("latest user message", () =>
            z
              .strictObject({ text: z.string() })
              .passthrough()
              .parse(JSON.parse(messageEvent.payloadJson) as unknown),
          );
    return decodeStoredValue("catalog projection", () =>
      SessionCatalogProjectionSchema.parse({
        updatedAtMs: latestEvent?.createdAtMs ?? this.getManifest().createdAtMs,
        lastRunState: runEvent === undefined ? null : (runStates[runEvent.eventType] ?? null),
        lastMessagePreview: messageData?.text.slice(0, 200) ?? null,
      }),
    );
  }

  getPendingApprovals(): readonly PendingApprovalRecord[] {
    const rows = this.database
      .prepare(
        `SELECT approval_id AS approvalId, run_id AS runId, call_id AS callId,
                state, action_digest AS actionDigest, requested_at_ms AS requestedAtMs
         FROM approvals WHERE state = 'pending' ORDER BY requested_at_ms, approval_id`,
      )
      .all() as unknown[];
    return rows.map((row) =>
      decodeStoredValue("pending approval", () => PendingApprovalRecordSchema.parse(row)),
    );
  }

  getPendingInputs(): readonly PendingInputRecord[] {
    const rows = this.database
      .prepare(
        `SELECT input_id AS inputId, run_id AS runId, state, prompt,
                requested_at_ms AS requestedAtMs
         FROM pending_inputs WHERE state = 'pending' ORDER BY requested_at_ms, input_id`,
      )
      .all() as unknown[];
    return rows.map((row) =>
      decodeStoredValue("pending input", () => PendingInputRecordSchema.parse(row)),
    );
  }

  getInput(inputId: string): InputRecord | null {
    const row = this.database
      .prepare(
        `SELECT input_id AS inputId, run_id AS runId, state, prompt,
                requested_at_ms AS requestedAtMs, resolved_at_ms AS resolvedAtMs,
                value_json AS valueJson
         FROM pending_inputs WHERE input_id = ?`,
      )
      .get(inputId) as
      | {
          inputId: string;
          runId: string;
          state: string;
          prompt: string;
          requestedAtMs: number;
          resolvedAtMs: number | null;
          valueJson: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    return decodeStoredValue("input", () => {
      const { valueJson, ...input } = row;
      return InputRecordSchema.parse({
        ...input,
        value: valueJson === null ? null : (JSON.parse(valueJson) as unknown),
      });
    });
  }

  getPendingInputCount(): number {
    return this.getPendingInputs().length;
  }

  getCatalogObservation(): SessionCatalogObservation {
    const recoveryNeeded = (
      this.database
        .prepare(
          "SELECT COUNT(*) AS count FROM runs WHERE state IN ('created', 'queued', 'running', 'waiting_for_user', 'cancelling')",
        )
        .get() as { count: number }
    ).count > 0;
    return SessionCatalogObservationSchema.parse({
      headSequence: this.getHeadSequence(),
      projection: this.getCatalogProjection(),
      pendingApprovalCount: this.getPendingApprovals().length,
      pendingInputCount: this.getPendingInputCount(),
      recoveryNeeded,
    });
  }

  recover(): SessionRecoveryResult {
    const interruptedRunIds = (
      this.database.prepare("SELECT run_id AS id FROM runs WHERE state IN ('running', 'cancelling')").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const interruptedStepIds = (
      this.database.prepare("SELECT step_id AS id FROM provider_steps WHERE state = 'streaming'").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const startedToolCalls = this.database
      .prepare(
        `SELECT call_id AS callId, effect_class AS effectClass
         FROM tool_executions WHERE state = 'started' ORDER BY call_id`,
      )
      .all() as SessionRecoveryResult["startedToolCalls"];
    const outcomeUnknownRunIds = (
      this.database
        .prepare(
          `SELECT DISTINCT tool.run_id AS runId
           FROM tool_executions AS tool
           JOIN runs AS run ON run.run_id = tool.run_id
           WHERE tool.state = 'outcome_unknown'
             AND run.state IN ('created', 'queued', 'running', 'waiting_for_user', 'cancelling')
           ORDER BY tool.run_id`,
        )
        .all() as { runId: string }[]
    ).map(({ runId }) => runId);

    // Milestone 2 reports raw recovery candidates. Later milestones own transition policy/events.
    return decodeStoredValue("session recovery state", () =>
      SessionRecoveryResultSchema.parse({
        interruptedRunIds,
        interruptedStepIds,
        startedToolCalls,
        outcomeUnknownRunIds,
      }),
    );
  }

  testGetProjectionIdentity(
    kind: "run" | "message" | "messagePart" | "providerStep" | "toolExecution" | "approval" | "input",
    id: string,
  ): Record<string, string | number | null> {
    if (!this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Test operations are disabled");
    }
    const queries = {
      run: `SELECT run_id AS runId, provider_id AS providerId,
                   provider_config_json AS providerConfigJson, created_at_ms AS createdAtMs
            FROM runs WHERE run_id = ?`,
      message: `SELECT message_id AS messageId, run_id AS runId, role,
                       created_at_ms AS createdAtMs FROM messages WHERE message_id = ?`,
      messagePart: `SELECT part_id AS partId, message_id AS messageId,
                           part_index AS partIndex, part_type AS partType
                    FROM message_parts WHERE part_id = ?`,
      providerStep: `SELECT step_id AS stepId, run_id AS runId, step_index AS stepIndex,
                            started_at_ms AS startedAtMs FROM provider_steps WHERE step_id = ?`,
      toolExecution: `SELECT call_id AS callId, run_id AS runId, step_id AS stepId,
                             tool_name AS toolName, arguments_json AS argumentsJson,
                             arguments_hash AS argumentsHash, effect_class AS effectClass
                      FROM tool_executions WHERE call_id = ?`,
      approval: `SELECT approval_id AS approvalId, run_id AS runId, call_id AS callId,
                        action_digest AS actionDigest FROM approvals WHERE approval_id = ?`,
      input: `SELECT input_id AS inputId, run_id AS runId, prompt
              FROM pending_inputs WHERE input_id = ?`,
    } as const;
    const row = this.database.prepare(queries[kind]).get(id) as
      | Record<string, string | number | null>
      | undefined;
    if (row === undefined) throw new StorageError("session.not_found", "Projection not found");
    return row;
  }

  testGetPragmas(): Record<string, string | number> {
    if (!this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Test operations are disabled");
    }
    const sqliteVersion = this.database.prepare("SELECT sqlite_version() AS version").get() as {
      version: string;
    };
    return {
      journalMode: this.database.pragma("journal_mode", { simple: true }) as string,
      synchronous: this.database.pragma("synchronous", { simple: true }) as number,
      foreignKeys: this.database.pragma("foreign_keys", { simple: true }) as number,
      busyTimeout: this.database.pragma("busy_timeout", { simple: true }) as number,
      trustedSchema: this.database.pragma("trusted_schema", { simple: true }) as number,
      sqliteVersion: sqliteVersion.version,
    };
  }

  testCorruptManifest(): void {
    if (!this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Test operations are disabled");
    }
    this.database.prepare("UPDATE manifest SET schema_version = 0 WHERE singleton = 1").run();
  }

  testMutateEvent(action: "update" | "delete", sequence: number): void {
    if (!this.allowTestOperations) {
      throw new StorageError("storage.worker_failed", "Test operations are disabled");
    }
    if (action === "update") {
      this.database.prepare("UPDATE events SET event_type = event_type WHERE sequence = ?").run(sequence);
    } else {
      this.database.prepare("DELETE FROM events WHERE sequence = ?").run(sequence);
    }
  }
}
