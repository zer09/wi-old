import type Database from "better-sqlite3";

import {
  canonicalJson,
  type ProviderStepState,
  type RunState,
  type ToolExecutionState,
} from "@wi/protocol";

import { StorageError } from "../common/worker-rpc.js";
import type { ProjectionMutation } from "../types.js";
import { assertAllowedRunTransition } from "./run-transitions.js";

function identityConflict(entity: string, id: string): never {
  throw new StorageError("session.invalid_transition", `${entity} ${id} changed immutable identity`);
}

function canonicalArgumentsJson(value: string): string {
  try {
    return canonicalJson(JSON.parse(value) as unknown);
  } catch {
    throw new StorageError("provider.protocol_error", "Tool argumentsJson is not canonical JSON");
  }
}

const providerStepTransitions: Readonly<Record<ProviderStepState, ReadonlySet<ProviderStepState>>> = {
  created: new Set(["streaming"]),
  streaming: new Set(["completed", "failed", "cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

const toolTransitions: Readonly<Record<ToolExecutionState, ReadonlySet<ToolExecutionState>>> = {
  staged: new Set(["requested", "failed", "discarded"]),
  requested: new Set(["awaiting_approval", "started", "failed", "cancelled"]),
  awaiting_approval: new Set(["approved", "denied", "cancelled"]),
  approved: new Set(["started", "cancelled"]),
  started: new Set(["requested", "completed", "failed", "cancelled", "outcome_unknown"]),
  completed: new Set(),
  failed: new Set(),
  denied: new Set(),
  cancelled: new Set(),
  outcome_unknown: new Set(),
  discarded: new Set(),
};

function assertProviderStepTransition(current: ProviderStepState, next: ProviderStepState): void {
  if (!providerStepTransitions[current].has(next)) {
    throw new StorageError(
      "session.invalid_transition",
      `Provider step cannot transition from ${current} to ${next}`,
    );
  }
}

function assertToolTransition(current: ToolExecutionState, next: ToolExecutionState): void {
  if (!toolTransitions[current].has(next)) {
    throw new StorageError(
      "session.invalid_transition",
      `Tool execution cannot transition from ${current} to ${next}`,
    );
  }
}

interface RunRow {
  readonly state: RunState;
  readonly providerId: string;
  readonly providerConfigJson: string;
  readonly providerSnapshotJson: string | null;
  readonly providerChainId: string | null;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly cancelledAtMs: number | null;
  readonly failureCategory: string | null;
  readonly failureMessage: string | null;
  readonly activeProviderStepId: string | null;
}

export function applyProjection(database: Database.Database, mutation: ProjectionMutation): void {
  switch (mutation.kind) {
    case "run.put": {
      const providerConfigJson = canonicalJson(mutation.providerConfig);
      const providerSelectionJson = mutation.providerSelection == null
        ? null
        : canonicalJson(mutation.providerSelection);
      const providerChainId = mutation.providerSelection?.providerChainId ?? null;
      const existing = database
        .prepare(
          `SELECT state, provider_id AS providerId, provider_config_json AS providerConfigJson,
                  provider_snapshot_json AS providerSnapshotJson,
                  provider_chain_id AS providerChainId,
                  created_at_ms AS createdAtMs, started_at_ms AS startedAtMs,
                  completed_at_ms AS completedAtMs, cancelled_at_ms AS cancelledAtMs,
                  failure_category AS failureCategory, failure_message AS failureMessage,
                  active_provider_step_id AS activeProviderStepId
           FROM runs WHERE run_id = ?`,
        )
        .get(mutation.runId) as RunRow | undefined;
      if (existing !== undefined) {
        if (
          existing.providerId !== mutation.providerId ||
          existing.providerConfigJson !== providerConfigJson ||
          existing.providerSnapshotJson !== providerSelectionJson ||
          existing.providerChainId !== providerChainId ||
          existing.createdAtMs !== mutation.createdAtMs
        ) {
          identityConflict("Run", mutation.runId);
        }
        if (
          existing.state !== mutation.state ||
          existing.startedAtMs !== mutation.startedAtMs ||
          existing.completedAtMs !== mutation.completedAtMs ||
          existing.cancelledAtMs !== mutation.cancelledAtMs ||
          existing.failureCategory !== mutation.failureCategory ||
          existing.failureMessage !== mutation.failureMessage ||
          existing.activeProviderStepId !== mutation.activeProviderStepId
        ) {
          throw new StorageError(
            "session.invalid_transition",
            `Run ${mutation.runId} state must change through run.state`,
          );
        }
        return;
      }
      database
        .prepare(
          `INSERT INTO runs (
             run_id, state, provider_id, provider_config_json, provider_snapshot_json,
             provider_chain_id, created_at_ms, started_at_ms, completed_at_ms,
             cancelled_at_ms, failure_category, failure_message, active_provider_step_id
           ) VALUES (
             @runId, @state, @providerId, @providerConfigJson, @providerSelectionJson,
             @providerChainId, @createdAtMs, @startedAtMs, @completedAtMs,
             @cancelledAtMs, @failureCategory, @failureMessage, @activeProviderStepId
           )`,
        )
        .run({ ...mutation, providerConfigJson, providerSelectionJson, providerChainId });
      return;
    }
    case "run.state": {
      const existing = database
        .prepare(
          `SELECT state, provider_id AS providerId, provider_config_json AS providerConfigJson,
                  created_at_ms AS createdAtMs, started_at_ms AS startedAtMs,
                  completed_at_ms AS completedAtMs, cancelled_at_ms AS cancelledAtMs,
                  failure_category AS failureCategory, failure_message AS failureMessage,
                  active_provider_step_id AS activeProviderStepId
           FROM runs WHERE run_id = ?`,
        )
        .get(mutation.runId) as RunRow | undefined;
      if (existing === undefined) {
        throw new StorageError("session.not_found", "Run projection not found");
      }
      if (existing.state !== mutation.expectedState) {
        throw new StorageError(
          "session.invalid_transition",
          `Run ${mutation.runId} is ${existing.state}, expected ${mutation.expectedState}`,
        );
      }
      assertAllowedRunTransition(mutation.expectedState, mutation.nextState);
      const result = database
        .prepare(
          `UPDATE runs SET
             state = @nextState,
             started_at_ms = @startedAtMs,
             completed_at_ms = @completedAtMs,
             cancelled_at_ms = @cancelledAtMs,
             failure_category = @failureCategory,
             failure_message = @failureMessage,
             active_provider_step_id = @activeProviderStepId
           WHERE run_id = @runId AND state = @expectedState`,
        )
        .run(mutation);
      if (result.changes !== 1) {
        throw new StorageError("session.invalid_transition", "Run transition lost its state CAS");
      }
      return;
    }
    case "run.activeProviderStep": {
      const result = database
        .prepare(
          `UPDATE runs SET active_provider_step_id = @activeProviderStepId
           WHERE run_id = @runId
             AND (active_provider_step_id = @expectedActiveProviderStepId
                  OR (active_provider_step_id IS NULL AND @expectedActiveProviderStepId IS NULL))
             AND state NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`,
        )
        .run(mutation);
      if (result.changes !== 1) {
        throw new StorageError(
          "session.invalid_transition",
          `Run ${mutation.runId} active provider step lost its identity CAS`,
        );
      }
      return;
    }
    case "message.put": {
      const existing = database
        .prepare(
          `SELECT run_id AS runId, role, created_at_ms AS createdAtMs
           FROM messages WHERE message_id = ?`,
        )
        .get(mutation.messageId) as
        | { runId: string | null; role: string; createdAtMs: number }
        | undefined;
      if (
        existing !== undefined &&
        (existing.runId !== mutation.runId ||
          existing.role !== mutation.role ||
          existing.createdAtMs !== mutation.createdAtMs)
      ) {
        identityConflict("Message", mutation.messageId);
      }
      database
        .prepare(
          `INSERT INTO messages (
             message_id, run_id, role, state, created_at_ms, completed_at_ms
           ) VALUES (
             @messageId, @runId, @role, @state, @createdAtMs, @completedAtMs
           ) ON CONFLICT(message_id) DO UPDATE SET
             state = excluded.state,
             completed_at_ms = excluded.completed_at_ms`,
        )
        .run(mutation);
      return;
    }
    case "messagePart.put": {
      const existing = database
        .prepare(
          `SELECT message_id AS messageId, part_index AS partIndex, part_type AS partType
           FROM message_parts WHERE part_id = ?`,
        )
        .get(mutation.partId) as
        | { messageId: string; partIndex: number; partType: string }
        | undefined;
      if (
        existing !== undefined &&
        (existing.messageId !== mutation.messageId ||
          existing.partIndex !== mutation.partIndex ||
          existing.partType !== mutation.partType)
      ) {
        identityConflict("Message part", mutation.partId);
      }
      database
        .prepare(
          `INSERT INTO message_parts (
             part_id, message_id, part_index, part_type, text_content, data_json
           ) VALUES (
             @partId, @messageId, @partIndex, @partType, @textContent, @dataJson
           ) ON CONFLICT(part_id) DO UPDATE SET
             text_content = excluded.text_content,
             data_json = excluded.data_json`,
        )
        .run({
          ...mutation,
          dataJson: mutation.data === null ? null : canonicalJson(mutation.data),
        });
      return;
    }
    case "providerStep.put": {
      const existing = database
        .prepare(
          `SELECT run_id AS runId, step_index AS stepIndex, state,
                  started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                  response_id AS responseId, error_category AS errorCategory,
                  error_message AS errorMessage, diagnostic_id AS diagnosticId
           FROM provider_steps WHERE step_id = ?`,
        )
        .get(mutation.stepId) as
        | {
            runId: string;
            stepIndex: number;
            state: ProviderStepState;
            startedAtMs: number;
            completedAtMs: number | null;
            responseId: string | null;
            errorCategory: string | null;
            errorMessage: string | null;
            diagnosticId: string | null;
          }
        | undefined;
      if (existing === undefined) {
        if (mutation.expectedState !== undefined) {
          throw new StorageError("session.invalid_transition", "Provider step CAS target is missing");
        }
      } else {
        if (
          existing.runId !== mutation.runId ||
          existing.stepIndex !== mutation.stepIndex ||
          existing.startedAtMs !== mutation.startedAtMs ||
          (existing.responseId !== null && existing.responseId !== mutation.responseId)
        ) {
          identityConflict("Provider step", mutation.stepId);
        }
        const unchanged =
          existing.state === mutation.state &&
          existing.completedAtMs === mutation.completedAtMs &&
          existing.responseId === mutation.responseId &&
          existing.errorCategory === mutation.errorCategory &&
          existing.errorMessage === mutation.errorMessage &&
          existing.diagnosticId === (mutation.diagnosticId ?? null);
        if (unchanged) return;
        if (mutation.expectedState === undefined || existing.state !== mutation.expectedState) {
          throw new StorageError(
            "session.invalid_transition",
            `Provider step ${mutation.stepId} lost its state CAS`,
          );
        }
        assertProviderStepTransition(existing.state, mutation.state);
      }
      database
        .prepare(
          `INSERT INTO provider_steps (
             step_id, run_id, step_index, state, started_at_ms, completed_at_ms,
             response_id, error_category, error_message, diagnostic_id
           ) VALUES (
             @stepId, @runId, @stepIndex, @state, @startedAtMs, @completedAtMs,
             @responseId, @errorCategory, @errorMessage, @diagnosticId
           ) ON CONFLICT(step_id) DO UPDATE SET
             state = excluded.state,
             completed_at_ms = excluded.completed_at_ms,
             response_id = excluded.response_id,
             error_category = excluded.error_category,
             error_message = excluded.error_message,
             diagnostic_id = excluded.diagnostic_id`,
        )
        .run({ ...mutation, diagnosticId: mutation.diagnosticId ?? null });
      return;
    }
    case "toolExecution.put": {
      const argumentsJson = canonicalArgumentsJson(mutation.argumentsJson);
      const effectClass = mutation.effectClass ?? "unclassified";
      const resultJson = mutation.result === null ? null : canonicalJson(mutation.result);
      const errorJson = mutation.error === null ? null : canonicalJson(mutation.error);
      const existing = database
        .prepare(
          `SELECT run_id AS runId, step_id AS stepId, tool_name AS toolName,
                  arguments_json AS argumentsJson, arguments_hash AS argumentsHash,
                  effect_class AS effectClass, state, attempt_count AS attemptCount,
                  requested_at_ms AS requestedAtMs, started_at_ms AS startedAtMs,
                  completed_at_ms AS completedAtMs, result_json AS resultJson,
                  error_json AS errorJson
           FROM tool_executions WHERE call_id = ?`,
        )
        .get(mutation.callId) as
        | {
            runId: string;
            stepId: string;
            toolName: string;
            argumentsJson: string;
            argumentsHash: string;
            effectClass: string;
            state: ToolExecutionState;
            attemptCount: number;
            requestedAtMs: number;
            startedAtMs: number | null;
            completedAtMs: number | null;
            resultJson: string | null;
            errorJson: string | null;
          }
        | undefined;
      if (existing === undefined) {
        if (mutation.expectedState !== undefined) {
          throw new StorageError("session.invalid_transition", "Tool execution CAS target is missing");
        }
      } else {
        const firstClassification =
          existing.effectClass === "unclassified" && existing.state === "staged";
        const effectConflict = existing.effectClass !== effectClass && !firstClassification;
        if (
          existing.runId !== mutation.runId ||
          existing.stepId !== mutation.stepId ||
          existing.toolName !== mutation.toolName ||
          canonicalArgumentsJson(existing.argumentsJson) !== argumentsJson ||
          existing.argumentsHash !== mutation.argumentsHash ||
          existing.requestedAtMs !== mutation.requestedAtMs ||
          effectConflict
        ) {
          throw new StorageError(
            "provider.protocol_error",
            `Tool call ${mutation.callId} was reused with different identity`,
          );
        }
        const unchanged =
          existing.effectClass === effectClass &&
          existing.state === mutation.state &&
          existing.attemptCount === mutation.attemptCount &&
          existing.startedAtMs === mutation.startedAtMs &&
          existing.completedAtMs === mutation.completedAtMs &&
          existing.resultJson === resultJson &&
          existing.errorJson === errorJson;
        if (unchanged) return;
        if (mutation.expectedState === undefined || existing.state !== mutation.expectedState) {
          throw new StorageError(
            "session.invalid_transition",
            `Tool call ${mutation.callId} lost its state CAS`,
          );
        }
        assertToolTransition(existing.state, mutation.state);
        if (
          mutation.state === "started" &&
          mutation.attemptCount !== existing.attemptCount + 1
        ) {
          throw new StorageError(
            "session.invalid_transition",
            `Tool call ${mutation.callId} attempt count did not increment exactly once`,
          );
        }
        if (
          mutation.state !== "started" &&
          mutation.attemptCount !== existing.attemptCount
        ) {
          throw new StorageError(
            "session.invalid_transition",
            `Tool call ${mutation.callId} attempt count changed outside execution start`,
          );
        }
        if (
          existing.state === "started" &&
          mutation.state === "requested" &&
          existing.effectClass !== "pure"
        ) {
          throw new StorageError(
            "session.invalid_transition",
            `Only a pure tool call may be reconciled for retry`,
          );
        }
      }
      database
        .prepare(
          `INSERT INTO tool_executions (
             call_id, run_id, step_id, tool_name, arguments_json, arguments_hash,
             effect_class, state, attempt_count, requested_at_ms, started_at_ms,
             completed_at_ms, result_json, error_json
           ) VALUES (
             @callId, @runId, @stepId, @toolName, @argumentsJson, @argumentsHash,
             @effectClass, @state, @attemptCount, @requestedAtMs, @startedAtMs,
             @completedAtMs, @resultJson, @errorJson
           ) ON CONFLICT(call_id) DO UPDATE SET
             effect_class = excluded.effect_class,
             state = excluded.state,
             attempt_count = excluded.attempt_count,
             started_at_ms = excluded.started_at_ms,
             completed_at_ms = excluded.completed_at_ms,
             result_json = excluded.result_json,
             error_json = excluded.error_json`,
        )
        .run({
          ...mutation,
          argumentsJson,
          effectClass,
          resultJson,
          errorJson,
        });
      return;
    }
    case "toolCallOccurrence.put": {
      const identities = database
        .prepare(
          `SELECT
             (SELECT run_id FROM provider_steps WHERE step_id = @stepId) AS stepRunId,
             (SELECT run_id FROM tool_executions WHERE call_id = @callId) AS toolRunId`,
        )
        .get(mutation) as { stepRunId: string | null; toolRunId: string | null };
      if (identities.stepRunId === null || identities.toolRunId === null) {
        throw new StorageError(
          "session.invalid_transition",
          `Tool call occurrence ${mutation.callId} has missing provenance`,
        );
      }
      if (identities.stepRunId !== mutation.runId || identities.toolRunId !== mutation.runId) {
        throw new StorageError(
          "provider.protocol_error",
          `Tool call occurrence ${mutation.callId} crossed run identity`,
        );
      }
      const existing = database
        .prepare(
          `SELECT run_id AS runId, occurred_at_ms AS occurredAtMs
           FROM tool_call_occurrences WHERE step_id = ? AND call_id = ?`,
        )
        .get(mutation.stepId, mutation.callId) as
        | { runId: string; occurredAtMs: number }
        | undefined;
      if (existing !== undefined) {
        if (existing.runId !== mutation.runId || existing.occurredAtMs !== mutation.occurredAtMs) {
          identityConflict("Tool call occurrence", `${mutation.stepId}/${mutation.callId}`);
        }
        return;
      }
      database
        .prepare(
          `INSERT INTO tool_call_occurrences (step_id, call_id, run_id, occurred_at_ms)
           VALUES (@stepId, @callId, @runId, @occurredAtMs)`,
        )
        .run(mutation);
      return;
    }
    case "approval.put": {
      const existing = database
        .prepare(
          `SELECT run_id AS runId, call_id AS callId, action_digest AS actionDigest
           FROM approvals WHERE approval_id = ?`,
        )
        .get(mutation.approvalId) as
        | { runId: string; callId: string; actionDigest: string }
        | undefined;
      if (existing !== undefined) {
        if (
          existing.runId !== mutation.runId ||
          existing.callId !== mutation.callId ||
          existing.actionDigest !== mutation.actionDigest
        ) {
          identityConflict("Approval", mutation.approvalId);
        }
        return;
      }
      database
        .prepare(
          `INSERT INTO approvals (
             approval_id, run_id, call_id, state, action_digest, requested_at_ms
           ) VALUES (
             @approvalId, @runId, @callId, 'pending', @actionDigest, @requestedAtMs
           )`,
        )
        .run(mutation);
      return;
    }
    case "approval.resolve": {
      const result = database
        .prepare(
          `UPDATE approvals SET
             state = @resolution,
             resolved_at_ms = @resolvedAtMs,
             resolution = @resolution,
             resolved_by_client_id = @resolvedByClientId
           WHERE approval_id = @approvalId AND state = 'pending'`,
        )
        .run(mutation);
      if (result.changes !== 1) {
        throw new StorageError(
          "session.invalid_transition",
          `Approval ${mutation.approvalId} is missing or already resolved`,
        );
      }
      return;
    }
    case "input.put": {
      const existing = database
        .prepare(
          `SELECT run_id AS runId, prompt FROM pending_inputs WHERE input_id = ?`,
        )
        .get(mutation.inputId) as { runId: string; prompt: string } | undefined;
      if (existing !== undefined) {
        if (existing.runId !== mutation.runId || existing.prompt !== mutation.prompt) {
          identityConflict("Input", mutation.inputId);
        }
        return;
      }
      database
        .prepare(
          `INSERT INTO pending_inputs (
             input_id, run_id, state, prompt, requested_at_ms
           ) VALUES (
             @inputId, @runId, 'pending', @prompt, @requestedAtMs
           )`,
        )
        .run(mutation);
      return;
    }
    case "input.resolve": {
      const result = database
        .prepare(
          `UPDATE pending_inputs SET
             state = 'resolved', resolved_at_ms = @resolvedAtMs, value_json = @valueJson
           WHERE input_id = @inputId AND state = 'pending'`,
        )
        .run({ ...mutation, valueJson: canonicalJson(mutation.value) });
      if (result.changes !== 1) {
        throw new StorageError(
          "session.invalid_transition",
          `Input ${mutation.inputId} is missing or already resolved`,
        );
      }
      return;
    }
    case "session.providerDefault.put": {
      const event = database
        .prepare("SELECT sequence FROM events WHERE event_id = ?")
        .get(mutation.eventId) as { sequence: number } | undefined;
      if (event === undefined) {
        throw new StorageError("session.invalid_transition", "Provider default event is missing");
      }
      const defaultJson = canonicalJson(mutation.default);
      const existing = database
        .prepare(
          "SELECT default_json AS defaultJson, updated_sequence AS updatedSequence, event_id AS eventId FROM session_provider_default WHERE singleton = 1",
        )
        .get() as { defaultJson: string; updatedSequence: number; eventId: string } | undefined;
      if (existing !== undefined && existing.updatedSequence >= event.sequence) {
        if (
          existing.updatedSequence !== event.sequence ||
          existing.eventId !== mutation.eventId ||
          existing.defaultJson !== defaultJson
        ) {
          throw new StorageError("session.invalid_transition", "Provider default projection regressed");
        }
        return;
      }
      database.prepare(
        `INSERT INTO session_provider_default (
           singleton, default_json, updated_sequence, event_id
         ) VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           default_json = excluded.default_json,
           updated_sequence = excluded.updated_sequence,
           event_id = excluded.event_id`,
      ).run(defaultJson, event.sequence, mutation.eventId);
      return;
    }
    case "run.pendingInteractions.cancel": {
      database
        .prepare(
          `UPDATE approvals SET state = 'cancelled', resolved_at_ms = @cancelledAtMs
           WHERE run_id = @runId AND state = 'pending'`,
        )
        .run(mutation);
      database
        .prepare(
          `UPDATE pending_inputs SET state = 'cancelled', resolved_at_ms = @cancelledAtMs
           WHERE run_id = @runId AND state = 'pending'`,
        )
        .run(mutation);
      database
        .prepare(
          `UPDATE tool_executions SET state = 'cancelled', completed_at_ms = @cancelledAtMs,
                                      error_json = '{"code":"provider.cancelled","message":"Run cancelled."}'
           WHERE run_id = @runId
             AND state IN ('requested', 'awaiting_approval', 'approved')`,
        )
        .run(mutation);
      return;
    }
  }
}

function projectionTarget(mutation: ProjectionMutation): string {
  switch (mutation.kind) {
    case "run.put":
    case "run.state":
      return `run.state:${mutation.runId}`;
    case "run.activeProviderStep":
      return `run.activeProviderStep:${mutation.runId}`;
    case "message.put":
      return `message:${mutation.messageId}`;
    case "messagePart.put":
      return `messagePart:${mutation.partId}`;
    case "providerStep.put":
      return `providerStep:${mutation.stepId}`;
    case "toolExecution.put":
      return `toolExecution:${mutation.callId}`;
    case "toolCallOccurrence.put":
      return `toolCallOccurrence:${mutation.stepId}:${mutation.callId}`;
    case "approval.put":
    case "approval.resolve":
      return `approval:${mutation.approvalId}`;
    case "input.put":
    case "input.resolve":
      return `input:${mutation.inputId}`;
    case "run.pendingInteractions.cancel":
      return `run.pendingInteractions.cancel:${mutation.runId}`;
    case "session.providerDefault.put":
      return "session.providerDefault";
  }
}

function rowMatches(
  row: Readonly<Record<string, unknown>> | undefined,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (row === undefined) return false;
  return Object.entries(expected).every(([key, value]) => row[key] === value);
}

function projectionApplied(database: Database.Database, mutation: ProjectionMutation): boolean {
  switch (mutation.kind) {
    case "run.put": {
      const row = database
        .prepare(
          `SELECT state, provider_id AS providerId, provider_config_json AS providerConfigJson,
                  provider_snapshot_json AS providerSelectionJson,
                  provider_chain_id AS providerChainId,
                  created_at_ms AS createdAtMs, started_at_ms AS startedAtMs,
                  completed_at_ms AS completedAtMs, cancelled_at_ms AS cancelledAtMs,
                  failure_category AS failureCategory, failure_message AS failureMessage,
                  active_provider_step_id AS activeProviderStepId
           FROM runs WHERE run_id = ?`,
        )
        .get(mutation.runId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        state: mutation.state,
        providerId: mutation.providerId,
        providerConfigJson: canonicalJson(mutation.providerConfig),
        providerSelectionJson: mutation.providerSelection == null
          ? null
          : canonicalJson(mutation.providerSelection),
        providerChainId: mutation.providerSelection?.providerChainId ?? null,
        createdAtMs: mutation.createdAtMs,
        startedAtMs: mutation.startedAtMs,
        completedAtMs: mutation.completedAtMs,
        cancelledAtMs: mutation.cancelledAtMs,
        failureCategory: mutation.failureCategory,
        failureMessage: mutation.failureMessage,
        activeProviderStepId: mutation.activeProviderStepId,
      });
    }
    case "run.state": {
      const row = database
        .prepare(
          `SELECT state, started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                  cancelled_at_ms AS cancelledAtMs, failure_category AS failureCategory,
                  failure_message AS failureMessage,
                  active_provider_step_id AS activeProviderStepId
           FROM runs WHERE run_id = ?`,
        )
        .get(mutation.runId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        state: mutation.nextState,
        startedAtMs: mutation.startedAtMs,
        completedAtMs: mutation.completedAtMs,
        cancelledAtMs: mutation.cancelledAtMs,
        failureCategory: mutation.failureCategory,
        failureMessage: mutation.failureMessage,
        activeProviderStepId: mutation.activeProviderStepId,
      });
    }
    case "run.activeProviderStep": {
      const row = database
        .prepare(`SELECT active_provider_step_id AS activeProviderStepId FROM runs WHERE run_id = ?`)
        .get(mutation.runId) as Record<string, unknown> | undefined;
      return rowMatches(row, { activeProviderStepId: mutation.activeProviderStepId });
    }
    case "message.put": {
      const row = database
        .prepare(
          `SELECT run_id AS runId, role, state, created_at_ms AS createdAtMs,
                  completed_at_ms AS completedAtMs
           FROM messages WHERE message_id = ?`,
        )
        .get(mutation.messageId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        runId: mutation.runId,
        role: mutation.role,
        state: mutation.state,
        createdAtMs: mutation.createdAtMs,
        completedAtMs: mutation.completedAtMs,
      });
    }
    case "messagePart.put": {
      const row = database
        .prepare(
          `SELECT message_id AS messageId, part_index AS partIndex, part_type AS partType,
                  text_content AS textContent, data_json AS dataJson
           FROM message_parts WHERE part_id = ?`,
        )
        .get(mutation.partId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        messageId: mutation.messageId,
        partIndex: mutation.partIndex,
        partType: mutation.partType,
        textContent: mutation.textContent,
        dataJson: mutation.data === null ? null : canonicalJson(mutation.data),
      });
    }
    case "providerStep.put": {
      const row = database
        .prepare(
          `SELECT run_id AS runId, step_index AS stepIndex, state,
                  started_at_ms AS startedAtMs, completed_at_ms AS completedAtMs,
                  response_id AS responseId, error_category AS errorCategory,
                  error_message AS errorMessage, diagnostic_id AS diagnosticId
           FROM provider_steps WHERE step_id = ?`,
        )
        .get(mutation.stepId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        runId: mutation.runId,
        stepIndex: mutation.stepIndex,
        state: mutation.state,
        startedAtMs: mutation.startedAtMs,
        completedAtMs: mutation.completedAtMs,
        responseId: mutation.responseId,
        errorCategory: mutation.errorCategory,
        errorMessage: mutation.errorMessage,
        diagnosticId: mutation.diagnosticId ?? null,
      });
    }
    case "toolExecution.put": {
      const row = database
        .prepare(
          `SELECT run_id AS runId, step_id AS stepId, tool_name AS toolName,
                  arguments_json AS argumentsJson, arguments_hash AS argumentsHash,
                  effect_class AS effectClass, state, attempt_count AS attemptCount,
                  requested_at_ms AS requestedAtMs, started_at_ms AS startedAtMs,
                  completed_at_ms AS completedAtMs, result_json AS resultJson,
                  error_json AS errorJson
           FROM tool_executions WHERE call_id = ?`,
        )
        .get(mutation.callId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        runId: mutation.runId,
        stepId: mutation.stepId,
        toolName: mutation.toolName,
        argumentsJson: canonicalArgumentsJson(mutation.argumentsJson),
        argumentsHash: mutation.argumentsHash,
        effectClass: mutation.effectClass ?? "unclassified",
        state: mutation.state,
        attemptCount: mutation.attemptCount,
        requestedAtMs: mutation.requestedAtMs,
        startedAtMs: mutation.startedAtMs,
        completedAtMs: mutation.completedAtMs,
        resultJson: mutation.result === null ? null : canonicalJson(mutation.result),
        errorJson: mutation.error === null ? null : canonicalJson(mutation.error),
      });
    }
    case "toolCallOccurrence.put": {
      const row = database
        .prepare(
          `SELECT run_id AS runId, occurred_at_ms AS occurredAtMs
           FROM tool_call_occurrences WHERE step_id = ? AND call_id = ?`,
        )
        .get(mutation.stepId, mutation.callId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        runId: mutation.runId,
        occurredAtMs: mutation.occurredAtMs,
      });
    }
    case "approval.put": {
      const row = database
        .prepare(
          `SELECT run_id AS runId, call_id AS callId, state,
                  action_digest AS actionDigest, requested_at_ms AS requestedAtMs,
                  resolved_at_ms AS resolvedAtMs, resolution,
                  resolved_by_client_id AS resolvedByClientId
           FROM approvals WHERE approval_id = ?`,
        )
        .get(mutation.approvalId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        runId: mutation.runId,
        callId: mutation.callId,
        state: "pending",
        actionDigest: mutation.actionDigest,
        requestedAtMs: mutation.requestedAtMs,
        resolvedAtMs: null,
        resolution: null,
        resolvedByClientId: null,
      });
    }
    case "approval.resolve": {
      const row = database
        .prepare(
          `SELECT state, resolved_at_ms AS resolvedAtMs, resolution,
                  resolved_by_client_id AS resolvedByClientId
           FROM approvals WHERE approval_id = ?`,
        )
        .get(mutation.approvalId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        state: mutation.resolution,
        resolvedAtMs: mutation.resolvedAtMs,
        resolution: mutation.resolution,
        resolvedByClientId: mutation.resolvedByClientId,
      });
    }
    case "input.put": {
      const row = database
        .prepare(
          `SELECT run_id AS runId, state, prompt, requested_at_ms AS requestedAtMs,
                  resolved_at_ms AS resolvedAtMs, value_json AS valueJson
           FROM pending_inputs WHERE input_id = ?`,
        )
        .get(mutation.inputId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        runId: mutation.runId,
        state: "pending",
        prompt: mutation.prompt,
        requestedAtMs: mutation.requestedAtMs,
        resolvedAtMs: null,
        valueJson: null,
      });
    }
    case "input.resolve": {
      const row = database
        .prepare(
          `SELECT state, resolved_at_ms AS resolvedAtMs, value_json AS valueJson
           FROM pending_inputs WHERE input_id = ?`,
        )
        .get(mutation.inputId) as Record<string, unknown> | undefined;
      return rowMatches(row, {
        state: "resolved",
        resolvedAtMs: mutation.resolvedAtMs,
        valueJson: canonicalJson(mutation.value),
      });
    }
    case "session.providerDefault.put": {
      const row = database
        .prepare(
          "SELECT default_json AS defaultJson, event_id AS eventId FROM session_provider_default WHERE singleton = 1",
        )
        .get() as Record<string, unknown> | undefined;
      return rowMatches(row, {
        defaultJson: canonicalJson(mutation.default),
        eventId: mutation.eventId,
      });
    }
    case "run.pendingInteractions.cancel": {
      const row = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM approvals WHERE run_id = @runId AND state = 'pending') AS approvals,
             (SELECT COUNT(*) FROM pending_inputs WHERE run_id = @runId AND state = 'pending') AS inputs,
             (SELECT COUNT(*) FROM tool_executions
              WHERE run_id = @runId AND state IN ('requested', 'awaiting_approval', 'approved')) AS tools`,
        )
        .get(mutation) as Record<string, unknown> | undefined;
      return rowMatches(row, { approvals: 0, inputs: 0, tools: 0 });
    }
  }
}

/** Verifies the final durable projection values represented by one committed event batch. */
export function areProjectionsApplied(
  database: Database.Database,
  mutations: readonly ProjectionMutation[],
): boolean {
  const finalMutations = new Map<string, ProjectionMutation>();
  for (const mutation of mutations) finalMutations.set(projectionTarget(mutation), mutation);
  for (const mutation of finalMutations.values()) {
    if (!projectionApplied(database, mutation)) return false;
  }
  return true;
}
