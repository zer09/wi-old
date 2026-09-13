import type Database from "better-sqlite3";
import { z } from "zod";

import {
  BrowserSessionSummarySchema,
  canonicalJson,
  CommandIdSchema,
  DiagnosticIdSchema,
  EventIdSchema,
  ProviderCapabilitiesSnapshotSchema,
  ProviderConnectionIdSchema,
  PROVIDER_CONNECTION_LIMITS,
  ProviderLifecycleOperationKindSchema,
  SessionIdSchema,
  type BrowserSessionSummary,
} from "@wi/protocol";

import { applyMigrations } from "../common/migrations.js";
import { StorageError } from "../common/worker-rpc.js";
import {
  CATALOG_SCHEMA_VERSION,
  EnvironmentConnectionRegistrationSchema,
  FileConnectionReservationSchema,
  GlobalCommandRecordSchema,
  HashSchema,
  ProviderCatalogStateSchema,
  ProviderConnectionRecordSchema,
  ProviderCredentialFileIdentitySchema,
  ProviderLifecycleOperationRecordSchema,
  RecoveredConnectionReservationSchema,
  RecoveryAdmissionSchema,
  SessionCreationRequestSchema,
  ProjectRecordSchema,
  SessionManifestSchema,
  SessionStatusSchema,
  SessionSummarySchema,
  type GlobalCommandRecord,
  type GlobalCommandReservation,
  type ProviderCatalogState,
  type ProviderConnectionRecord,
  type ProviderLifecycleOperationRecord,
  type ProjectRecord,
  type SessionManifest,
  type SessionSummary,
} from "../types.js";
import { catalogMigrations } from "./migrations.js";

export const MAXIMUM_BOUNDED_SESSION_LIST_LIMIT = 1_001;
export const MAXIMUM_CATALOG_REPAIR_PAGE_SIZE = 1_000;
const BOUNDED_SESSION_LIST_TEXT_CODE_POINTS = 256;

export const BoundedSessionListInputSchema = z.strictObject({
  limit: z.number().int().positive().max(MAXIMUM_BOUNDED_SESSION_LIST_LIMIT),
});

export const UnavailableReasonSchema = z.enum(["quarantined"]);
export type UnavailableReason = z.infer<typeof UnavailableReasonSchema>;

export const CatalogRepairPageInputSchema = z.strictObject({
  afterSessionId: z.union([SessionIdSchema, z.null()]),
  limit: z.number().int().positive().max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
});
export const CatalogRepairPageSchema = z.strictObject({
  records: z.array(z.strictObject({
    sessionId: SessionIdSchema,
    status: SessionStatusSchema,
    unavailableReason: z.union([UnavailableReasonSchema, z.null()]),
  })).max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
  nextCursor: z.union([SessionIdSchema, z.null()]),
});
export type CatalogRepairPage = z.infer<typeof CatalogRepairPageSchema>;

export const MarkSessionsMissingInputSchema = z.strictObject({
  sessions: z.array(z.strictObject({
    sessionId: SessionIdSchema,
    dbRelativePath: z.string().min(1),
  })).max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
});

export const CatalogRepairReasonSchema = z.enum([
  "catalog_new",
  "catalog_corrupt",
  "explicit",
]);
export type CatalogRepairReason = z.infer<typeof CatalogRepairReasonSchema>;

export const ReserveGlobalCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  payloadHash: HashSchema,
  reservedSessionId: SessionIdSchema,
  reservedEventId: EventIdSchema,
  request: SessionCreationRequestSchema,
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const CompleteGlobalCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  payloadHash: HashSchema,
  result: z.unknown(),
  acceptedAtMs: z.number().int().nonnegative().safe(),
});

export const FailGlobalCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  payloadHash: HashSchema,
  session: SessionSummarySchema,
  failureCode: z.string().min(1),
  failureMessage: z.string(),
  diagnosticId: z.string().min(1),
  quarantinedRelativePath: z.union([z.string().min(1), z.null()]),
  failedAtMs: z.number().int().nonnegative().safe(),
});
export type FailGlobalCommandInput = z.infer<typeof FailGlobalCommandInputSchema>;

export const SetGlobalCommandQuarantineInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  diagnosticId: DiagnosticIdSchema,
  quarantinedRelativePath: z.string().min(1),
});
export type SetGlobalCommandQuarantineInput = z.infer<
  typeof SetGlobalCommandQuarantineInputSchema
>;

export const CreateSessionIndexInputSchema = SessionSummarySchema.extend({
  unavailableReason: z.union([UnavailableReasonSchema, z.null()]).default(null),
}).superRefine((input, context) => {
  if (input.status !== "unavailable" && input.unavailableReason !== null) {
    context.addIssue({
      code: "custom",
      path: ["unavailableReason"],
      message: "Only an unavailable session can retain unavailable provenance",
    });
  }
});
export type CreateSessionIndexInput = z.input<typeof CreateSessionIndexInputSchema>;

export const UpdateSessionProjectionInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  updatedAtMs: z.number().int().nonnegative().safe(),
  lastEventSequence: z.number().int().nonnegative().safe(),
  lastRunState: SessionSummarySchema.shape.lastRunState,
  lastMessagePreview: SessionSummarySchema.shape.lastMessagePreview,
  requiresAttention: z.boolean(),
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
  recoveryNeeded: z.boolean().default(false),
});
export type UpdateSessionProjectionInput = z.input<typeof UpdateSessionProjectionInputSchema>;

export const CatalogProjectionUpdateResultSchema = z.strictObject({
  summary: SessionSummarySchema,
  outcome: z.enum(["applied", "idempotent", "stale"]),
});
export type CatalogProjectionUpdateResult = z.infer<typeof CatalogProjectionUpdateResultSchema>;

export const MarkSessionStatusInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  status: SessionStatusSchema.exclude(["ready"]),
});
export type MarkSessionStatusInput = z.infer<typeof MarkSessionStatusInputSchema>;

export const RepairSessionClassificationInputSchema = z.strictObject({
  sessionId: SessionIdSchema,
  dbRelativePath: z.string().min(1),
  status: SessionStatusSchema.exclude(["ready"]),
  sessionSchemaVersion: z.number().int().positive().safe().nullable(),
  unavailableReason: z.union([UnavailableReasonSchema, z.null()]),
}).superRefine((input, context) => {
  if (input.status !== "unavailable" && input.unavailableReason !== null) {
    context.addIssue({
      code: "custom",
      path: ["unavailableReason"],
      message: "Only an unavailable session can retain unavailable provenance",
    });
  }
});
export type RepairSessionClassificationInput = z.infer<
  typeof RepairSessionClassificationInputSchema
>;

export const ReconcileSessionInputSchema = z.strictObject({
  manifest: SessionManifestSchema,
  dbRelativePath: z.string().min(1),
  expectedCatalogSequence: z.union([z.number().int().nonnegative().safe(), z.null()]),
  expectedCatalogStatus: z.union([SessionSummarySchema.shape.status, z.null()]),
  updatedAtMs: z.number().int().nonnegative().safe(),
  lastRunState: SessionSummarySchema.shape.lastRunState,
  lastMessagePreview: SessionSummarySchema.shape.lastMessagePreview,
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
  recoveryNeeded: z.boolean().default(false),
});

export const ReconcileSessionResultSchema = z.strictObject({
  summary: SessionSummarySchema,
  applied: z.boolean(),
});
export type ReconcileSessionResult = z.infer<typeof ReconcileSessionResultSchema>;

export const ProviderConnectionCommandResultSchema = z.strictObject({
  connection: ProviderConnectionRecordSchema,
  operation: ProviderLifecycleOperationRecordSchema,
  catalogRevision: z.number().int().nonnegative().safe(),
  duplicate: z.boolean(),
});
export type ProviderConnectionCommandResult = z.infer<typeof ProviderConnectionCommandResultSchema>;

export const FileConnectionReservationResultSchema = z.strictObject({
  connection: z.union([ProviderConnectionRecordSchema, z.null()]),
  operation: ProviderLifecycleOperationRecordSchema,
  catalogRevision: z.number().int().nonnegative().safe(),
  duplicate: z.boolean(),
});
export type FileConnectionReservationResult = z.infer<
  typeof FileConnectionReservationResultSchema
>;

export const MarkEnvironmentConnectionUnavailableInputSchema = z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  expectedGeneration: z.number().int().positive().safe(),
  expectedLifecycleRevision: z.number().int().positive().safe(),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const RenameProviderConnectionInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  contentHash: HashSchema,
  connectionId: ProviderConnectionIdSchema,
  expectedMetadataRevision: z.number().int().positive().safe(),
  displayName: z.string().min(1).max(256),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const DisableProviderConnectionInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  contentHash: HashSchema,
  connectionId: ProviderConnectionIdSchema,
  expectedLifecycleRevision: z.number().int().positive().safe(),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const PrepareProviderLifecycleInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: z.string().min(1).max(128),
  contentHash: HashSchema,
  operationKind: ProviderLifecycleOperationKindSchema,
  connectionId: ProviderConnectionIdSchema,
  expectedLifecycleRevision: z.union([z.number().int().positive().safe(), z.null()]),
  expectedGeneration: z.union([z.number().int().positive().safe(), z.null()]),
  credentialBackendKind: z.enum(["file", "environment"]),
  credentialInternalRef: z.union([z.string().regex(/^credref_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  targetEnvelopeId: z.union([z.string().regex(/^envl_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  provisioningId: z.union([z.string().regex(/^prov_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  stagingInternalRef: z.union([z.string().regex(/^stage_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  stagingFileIdentity: z.union([ProviderCredentialFileIdentitySchema, z.null()]),
  recoveryEpochId: z.union([z.string().regex(/^recepoch_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  expectedSafeMetadata: z.union([z.unknown(), z.null()]),
  createdAtMs: z.number().int().nonnegative().safe(),
});

export const FailProviderRecoveryInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  contentHash: HashSchema,
  failureCode: z.string().min(1).max(128),
  failureMessage: z.string().max(512),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const ObserveProviderLifecycleEffectInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  contentHash: HashSchema,
  observedEnvelopeId: z.union([z.string().regex(/^envl_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  credentialInternalRef: z.union([z.string().regex(/^credref_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const FailOrphanedProviderLifecycleInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  contentHash: HashSchema,
  diagnosticId: z.union([DiagnosticIdSchema, z.null()]),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const CompleteProviderLifecycleInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  contentHash: HashSchema,
  observedEnvelopeId: z.union([z.string().regex(/^envl_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  credentialInternalRef: z.union([z.string().regex(/^credref_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u), z.null()]),
  terminalPhase: z.enum(["succeeded", "failed", "failed_after_effect"]),
  lifecycleStatus: z.enum(["ready", "reauth_required", "disabled", "rate_limited", "unavailable"]),
  recoveryTombstone: z.boolean().default(false),
  result: z.union([z.unknown(), z.null()]),
  failureCode: z.union([z.string().min(1).max(128), z.null()]),
  failureMessage: z.union([z.string().max(512), z.null()]),
  diagnosticId: z.union([DiagnosticIdSchema, z.null()]),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

export const ProviderMetadataCommandResultSchema = z.strictObject({
  connection: ProviderConnectionRecordSchema,
  catalogRevision: z.number().int().nonnegative().safe(),
  duplicate: z.boolean(),
});
export type ProviderMetadataCommandResult = z.infer<typeof ProviderMetadataCommandResultSchema>;

export const PutProviderCapabilitiesInputSchema = z.strictObject({
  snapshot: ProviderCapabilitiesSnapshotSchema,
  expectedMetadataRevision: z.number().int().positive().safe(),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

function decodeCatalogValue<T>(description: string, decode: () => T): T {
  try {
    return decode();
  } catch {
    throw new StorageError("storage.corrupt", `Stored ${description} is invalid`);
  }
}

interface GlobalCommandRow {
  commandId: string;
  commandMethod: "session.create";
  payloadHash: string;
  state: "creating" | "accepted" | "failed";
  reservedSessionId: string;
  reservedEventId: string;
  requestJson: string;
  resultJson: string | null;
  acceptedAtMs: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  diagnosticId: string | null;
  quarantinedRelativePath: string | null;
  updatedAtMs: number;
}

function globalCommandFromRow(row: GlobalCommandRow): GlobalCommandRecord {
  return decodeCatalogValue(`global command ${row.commandId}`, () =>
    GlobalCommandRecordSchema.parse({
      commandId: row.commandId,
      commandMethod: row.commandMethod,
      payloadHash: row.payloadHash,
      state: row.state,
      reservedSessionId: row.reservedSessionId,
      reservedEventId: row.reservedEventId,
      request: JSON.parse(row.requestJson) as unknown,
      result: row.resultJson === null ? null : (JSON.parse(row.resultJson) as unknown),
      acceptedAtMs: row.acceptedAtMs,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      diagnosticId: row.diagnosticId,
      quarantinedRelativePath: row.quarantinedRelativePath,
      updatedAtMs: row.updatedAtMs,
    }),
  );
}

function providerConnectionFromRow(row: Record<string, unknown>): ProviderConnectionRecord {
  return decodeCatalogValue("provider connection", () =>
    ProviderConnectionRecordSchema.parse({
      connectionId: row.connectionId,
      providerId: row.providerId,
      authMode: row.authMode,
      displayName: row.displayName,
      credentialBackend: row.credentialBackendKind === "environment"
        ? { kind: "environment", variableName: row.environmentVariableName }
        : { kind: "file" },
      credentialInternalRef: row.credentialInternalRef,
      envelopeId: row.envelopeId,
      credentialGeneration: row.credentialGeneration,
      lifecycleRevision: row.lifecycleRevision,
      metadataRevision: row.metadataRevision,
      lifecycleStatus: row.lifecycleStatus,
      identity: JSON.parse(String(row.identityJson)) as unknown,
      identityVerificationStatus: row.identityVerificationStatus,
      capabilitiesVersion: row.capabilitiesVersion,
      lifecycleOwnerKind: row.lifecycleOwnerKind,
      deleted: row.deleted === 1,
      recoveryTombstone: row.recoveryTombstone === 1,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
    }),
  );
}

function providerOperationFromRow(row: Record<string, unknown>): ProviderLifecycleOperationRecord {
  return decodeCatalogValue("provider lifecycle operation", () =>
    ProviderLifecycleOperationRecordSchema.parse({
      commandId: row.commandId,
      commandMethod: row.commandMethod,
      contentHash: row.contentHash,
      operationKind: row.operationKind,
      targetConnectionId: row.targetConnectionId,
      expectedLifecycleRevision: row.expectedLifecycleRevision,
      expectedGeneration: row.expectedGeneration,
      reservedLifecycleRevision: row.reservedLifecycleRevision,
      reservedGeneration: row.reservedGeneration,
      ownerKey: row.ownerKey,
      provisioningId: row.provisioningId,
      stagingInternalRef: row.stagingInternalRef,
      stagingFileIdentity: row.stagingFileIdentityJson === null
        ? null
        : JSON.parse(String(row.stagingFileIdentityJson)) as unknown,
      credentialBackendKind: row.credentialBackendKind,
      credentialInternalRef: row.credentialInternalRef,
      envelopeId: row.envelopeId,
      recoveryEpochId: row.recoveryEpochId,
      expectedSafeMetadata: row.expectedSafeMetadataJson === null
        ? null
        : JSON.parse(String(row.expectedSafeMetadataJson)) as unknown,
      recoveryFileIdentity: row.recoveryFileIdentityJson === null
        ? null
        : JSON.parse(String(row.recoveryFileIdentityJson)) as unknown,
      phase: row.phase,
      result: row.resultJson === null ? null : JSON.parse(String(row.resultJson)) as unknown,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      diagnosticId: row.diagnosticId,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
    }),
  );
}

function sessionFromRow(row: Record<string, unknown>): SessionSummary {
  return decodeCatalogValue("session summary", () =>
    SessionSummarySchema.parse({
      ...row,
      requiresAttention: row.requiresAttention === 1,
      recoveryCandidate: row.recoveryCandidate === 1,
    }),
  );
}

function browserSessionFromRow(row: Record<string, unknown>): BrowserSessionSummary {
  return decodeCatalogValue("browser session summary", () =>
    BrowserSessionSummarySchema.parse({
      ...row,
      requiresAttention: row.requiresAttention === 1,
    }),
  );
}

export class CatalogRepository {
  constructor(private readonly database: Database.Database) {
    applyMigrations(database, catalogMigrations, CATALOG_SCHEMA_VERSION, {
      onFreshDatabase: () => {
        database
          .prepare("INSERT INTO catalog_repair_state (singleton, reason) VALUES (1, 'catalog_new')")
          .run();
      },
    });
  }

  getRepairReason(): CatalogRepairReason | null {
    const row = this.database
      .prepare("SELECT reason FROM catalog_repair_state WHERE singleton = 1")
      .get() as { reason: unknown } | undefined;
    return row === undefined
      ? null
      : decodeCatalogValue("catalog repair state", () =>
          CatalogRepairReasonSchema.parse(row.reason),
        );
  }

  beginRepair(reasonValue: unknown): CatalogRepairReason {
    const reason = CatalogRepairReasonSchema.parse(reasonValue);
    this.database
      .prepare(
        `INSERT INTO catalog_repair_state (singleton, reason) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET reason = excluded.reason`,
      )
      .run(reason);
    return reason;
  }

  completeRepair(): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM catalog_repair_state WHERE singleton = 1").run();
      this.database
        .prepare("INSERT INTO catalog_meta (key, value) VALUES ('repair_completed', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
        .run();
    })();
  }

  hasCompletedRepair(): boolean {
    return this.database
      .prepare("SELECT 1 AS present FROM catalog_meta WHERE key = 'repair_completed'")
      .get() !== undefined;
  }

  createProject(project: ProjectRecord): ProjectRecord {
    const input = ProjectRecordSchema.parse(project);
    this.database
      .prepare(
        `INSERT INTO projects (
          project_id, name, root_path, root_realpath, created_at_ms, updated_at_ms, config_json
        ) VALUES (
          @projectId, @name, @rootPath, @rootRealpath, @createdAtMs, @updatedAtMs, @configJson
        ) ON CONFLICT(project_id) DO UPDATE SET
          name = excluded.name,
          root_path = excluded.root_path,
          root_realpath = excluded.root_realpath,
          updated_at_ms = excluded.updated_at_ms,
          config_json = excluded.config_json`,
      )
      .run({ ...input, configJson: canonicalJson(input.config) });
    return input;
  }

  reserveGlobalCommand(inputValue: unknown): GlobalCommandReservation {
    const input = ReserveGlobalCommandInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const existing = this.getGlobalCommand(input.commandId);
      if (existing !== null) {
        if (existing.payloadHash !== input.payloadHash || existing.commandMethod !== "session.create") {
          throw new StorageError(
            "protocol.command_id_conflict",
            `Command ${input.commandId} was reused with different content`,
          );
        }
        return { command: existing, duplicate: true };
      }
      if (
        this.getProviderLifecycleOperation(input.commandId) !== null ||
        this.hasProviderMetadataCommand(input.commandId)
      ) {
        throw new StorageError(
          "protocol.command_id_conflict",
          `Command ${input.commandId} is already owned by a provider command`,
        );
      }

      this.database
        .prepare(
          `INSERT INTO catalog_commands (
            command_id, command_method, payload_hash, state, reserved_session_id,
            reserved_event_id, request_json, updated_at_ms
          ) VALUES (
            @commandId, 'session.create', @payloadHash, 'creating', @reservedSessionId,
            @reservedEventId, @requestJson, @updatedAtMs
          )`,
        )
        .run({ ...input, requestJson: canonicalJson(input.request) });
      const created = this.getGlobalCommand(input.commandId);
      if (created === null) throw new Error("Reserved global command disappeared");
      return { command: created, duplicate: false };
    })();
  }

  completeGlobalCommand(inputValue: unknown): GlobalCommandRecord {
    const input = CompleteGlobalCommandInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const existing = this.getGlobalCommand(input.commandId);
      if (existing === null) throw new StorageError("session.not_found", "Global command reservation not found");
      if (existing.payloadHash !== input.payloadHash) {
        throw new StorageError(
          "protocol.command_id_conflict",
          `Command ${input.commandId} was reused with different content`,
        );
      }
      if (existing.state === "accepted") {
        // Recovery provenance is canonical.  A duplicate completion must agree
        // with every immutable accepted field instead of silently preserving a
        // contradictory catalog result.
        if (
          existing.commandMethod !== "session.create" ||
          canonicalJson(existing.result) !== canonicalJson(input.result) ||
          existing.acceptedAtMs !== input.acceptedAtMs
        ) {
          throw new StorageError(
            "storage.corrupt",
            `Accepted global command ${input.commandId} conflicts with canonical provenance`,
          );
        }
        return existing;
      }
      if (existing.state === "failed") {
        throw new StorageError(
          "session.invalid_transition",
          `Global command ${input.commandId} already failed`,
        );
      }

      this.database
        .prepare(
          `UPDATE catalog_commands
           SET state = 'accepted', result_json = @resultJson,
               accepted_at_ms = @acceptedAtMs, updated_at_ms = @acceptedAtMs
           WHERE command_id = @commandId`,
        )
        .run({
          commandId: input.commandId,
          resultJson: canonicalJson(input.result),
          acceptedAtMs: input.acceptedAtMs,
        });
      const completed = this.getGlobalCommand(input.commandId);
      if (completed === null) throw new Error("Completed global command disappeared");
      return completed;
    })();
  }

  failGlobalCommand(inputValue: unknown): GlobalCommandRecord {
    const input = FailGlobalCommandInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const existing = this.getGlobalCommand(input.commandId);
      if (existing === null) {
        throw new StorageError("session.not_found", "Global command reservation not found");
      }
      if (existing.payloadHash !== input.payloadHash) {
        throw new StorageError(
          "protocol.command_id_conflict",
          `Command ${input.commandId} was reused with different content`,
        );
      }
      if (existing.state === "accepted") {
        throw new StorageError("session.invalid_transition", "Accepted session creation cannot fail");
      }
      if (existing.state === "failed") return existing;

      this.createSessionIndex({
        ...input.session,
        unavailableReason: input.quarantinedRelativePath === null ? null : "quarantined",
      });
      const result = {
        sessionId: input.session.sessionId,
        failed: true,
        code: input.failureCode,
        message: input.failureMessage,
        diagnosticId: input.diagnosticId,
      };
      this.database
        .prepare(
          `UPDATE catalog_commands SET
             state = 'failed', result_json = @resultJson, failure_code = @failureCode,
             failure_message = @failureMessage, diagnostic_id = @diagnosticId,
             quarantined_relative_path = @quarantinedRelativePath,
             updated_at_ms = @failedAtMs
           WHERE command_id = @commandId AND state = 'creating'`,
        )
        .run({ ...input, resultJson: canonicalJson(result) });
      const failed = this.getGlobalCommand(input.commandId);
      if (failed === null) throw new Error("Failed global command disappeared");
      return failed;
    })();
  }

  setGlobalCommandQuarantine(inputValue: unknown): GlobalCommandRecord {
    const input = SetGlobalCommandQuarantineInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const existing = this.getGlobalCommand(input.commandId);
      if (existing === null) {
        throw new StorageError("session.not_found", "Global command reservation not found");
      }
      if (existing.state !== "failed" || existing.diagnosticId !== input.diagnosticId) {
        throw new StorageError(
          "session.invalid_transition",
          "Only the matching failed session creation can record quarantine",
        );
      }
      if (
        existing.quarantinedRelativePath !== null &&
        existing.quarantinedRelativePath !== input.quarantinedRelativePath
      ) {
        throw new StorageError(
          "session.invalid_transition",
          "Failed session creation already recorded a different quarantine path",
        );
      }
      if (existing.quarantinedRelativePath === null) {
        this.database
          .prepare(
            `UPDATE catalog_commands SET quarantined_relative_path = @quarantinedRelativePath
             WHERE command_id = @commandId AND state = 'failed' AND diagnostic_id = @diagnosticId
               AND quarantined_relative_path IS NULL`,
          )
          .run(input);
      }
      this.database
        .prepare(
          `UPDATE sessions SET unavailable_reason = 'quarantined'
           WHERE session_id = ? AND status = 'unavailable'`,
        )
        .run(existing.reservedSessionId);
      const updated = this.getGlobalCommand(input.commandId);
      if (updated === null) throw new Error("Failed global command disappeared");
      return updated;
    })();
  }

  listCreatingGlobalCommands(): readonly GlobalCommandRecord[] {
    const rows = this.database
      .prepare(
        `SELECT command_id AS commandId, command_method AS commandMethod,
                payload_hash AS payloadHash, state, reserved_session_id AS reservedSessionId,
                reserved_event_id AS reservedEventId, request_json AS requestJson,
                result_json AS resultJson, accepted_at_ms AS acceptedAtMs,
                failure_code AS failureCode, failure_message AS failureMessage,
                diagnostic_id AS diagnosticId,
                quarantined_relative_path AS quarantinedRelativePath,
                updated_at_ms AS updatedAtMs
         FROM catalog_commands WHERE state = 'creating' ORDER BY updated_at_ms, command_id`,
      )
      .all() as GlobalCommandRow[];
    return rows.map(globalCommandFromRow);
  }

  getGlobalCommand(commandId: string): GlobalCommandRecord | null {
    const row = this.database
      .prepare(
        `SELECT command_id AS commandId, command_method AS commandMethod,
                payload_hash AS payloadHash, state, reserved_session_id AS reservedSessionId,
                reserved_event_id AS reservedEventId, request_json AS requestJson,
                result_json AS resultJson, accepted_at_ms AS acceptedAtMs,
                failure_code AS failureCode, failure_message AS failureMessage,
                diagnostic_id AS diagnosticId,
                quarantined_relative_path AS quarantinedRelativePath,
                updated_at_ms AS updatedAtMs
         FROM catalog_commands WHERE command_id = ?`,
      )
      .get(commandId) as GlobalCommandRow | undefined;
    return row === undefined ? null : globalCommandFromRow(row);
  }

  createSessionIndex(
    inputValue: unknown,
    options: {
      readonly allowPathRepair?: boolean;
      readonly allowReadyPromotion?: boolean;
    } = {},
  ): SessionSummary {
    const input = CreateSessionIndexInputSchema.parse(inputValue);
    this.database.transaction(() => {
      const existing = this.getSession(input.sessionId);
      if (
        options.allowPathRepair !== true &&
        existing !== null &&
        existing.dbRelativePath !== input.dbRelativePath
      ) {
        throw new StorageError("storage.corrupt", "Session path changed for an existing session");
      }
      if (
        options.allowReadyPromotion !== true &&
        existing !== null &&
        existing.status !== "ready" &&
        input.status === "ready"
      ) {
        throw new StorageError(
          "storage.corrupt",
          "Only validated repair can restore a non-ready session",
        );
      }
      this.database
        .prepare(
          `INSERT INTO sessions (
             session_id, project_id, db_relative_path, title, status, created_at_ms, updated_at_ms,
             last_event_sequence, last_run_state, last_message_preview, requires_attention,
             pending_approval_count, pending_input_count, session_schema_version, recovery_candidate,
             unavailable_reason
           ) VALUES (
             @sessionId, @projectId, @dbRelativePath, @title, @status, @createdAtMs, @updatedAtMs,
             @lastEventSequence, @lastRunState, @lastMessagePreview, @requiresAttention,
             @pendingApprovalCount, @pendingInputCount, @sessionSchemaVersion, @recoveryCandidate,
             @unavailableReason
           ) ON CONFLICT(session_id) DO UPDATE SET
             project_id = excluded.project_id,
             db_relative_path = excluded.db_relative_path,
             title = excluded.title,
             status = excluded.status,
             created_at_ms = excluded.created_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             last_event_sequence = excluded.last_event_sequence,
             last_run_state = excluded.last_run_state,
             last_message_preview = excluded.last_message_preview,
             requires_attention = excluded.requires_attention,
             pending_approval_count = excluded.pending_approval_count,
             pending_input_count = excluded.pending_input_count,
             session_schema_version = excluded.session_schema_version,
             unavailable_reason = excluded.unavailable_reason,
             recovery_candidate = CASE
               WHEN sessions.recovery_candidate = 1 AND excluded.recovery_candidate = 0 THEN 0
               WHEN excluded.recovery_candidate = 1 THEN 1
               ELSE sessions.recovery_candidate
             END`,
        )
        .run({
          ...input,
          requiresAttention: input.requiresAttention ? 1 : 0,
          recoveryCandidate: input.recoveryCandidate ? 1 : 0,
        });
    })();
    const created = this.getSession(input.sessionId);
    if (created === null) throw new Error("Session index disappeared");
    return created;
  }

  countSessions(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
      count: number;
    };
    if (!Number.isSafeInteger(row.count) || row.count < 0) {
      throw new StorageError("storage.corrupt", "Catalog session count is invalid");
    }
    return row.count;
  }

  listSessions(): readonly SessionSummary[] {
    const rows = this.database
      .prepare(
        `SELECT session_id AS sessionId, project_id AS projectId,
                db_relative_path AS dbRelativePath, title, status,
                created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs,
                last_event_sequence AS lastEventSequence, last_run_state AS lastRunState,
                last_message_preview AS lastMessagePreview, requires_attention AS requiresAttention,
                pending_approval_count AS pendingApprovalCount,
                pending_input_count AS pendingInputCount,
                session_schema_version AS sessionSchemaVersion,
                recovery_candidate AS recoveryCandidate
         FROM sessions ORDER BY updated_at_ms DESC, session_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(sessionFromRow);
  }

  listCatalogRepairPage(inputValue: unknown): CatalogRepairPage {
    const input = CatalogRepairPageInputSchema.parse(inputValue);
    const rows = this.database
      .prepare(
        `SELECT session_id AS sessionId, status,
                unavailable_reason AS unavailableReason
         FROM sessions
         WHERE @afterSessionId IS NULL OR session_id > @afterSessionId
         ORDER BY session_id
         LIMIT @rowLimit`,
      )
      .all({
        afterSessionId: input.afterSessionId,
        rowLimit: input.limit + 1,
      }) as Record<string, unknown>[];
    const hasMore = rows.length > input.limit;
    const records = CatalogRepairPageSchema.shape.records.parse(rows.slice(0, input.limit));
    return {
      records,
      nextCursor: hasMore ? (records.at(-1)?.sessionId ?? null) : null,
    };
  }

  markSessionsMissing(inputValue: unknown): readonly string[] {
    const input = MarkSessionsMissingInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const updated: string[] = [];
      const statement = this.database.prepare(
        `UPDATE sessions SET
           db_relative_path = @dbRelativePath,
           status = 'missing',
           unavailable_reason = NULL,
           recovery_candidate = 0
         WHERE session_id = @sessionId
           AND (status <> 'unavailable' OR unavailable_reason IS NULL)`,
      );
      for (const session of input.sessions) {
        if (statement.run(session).changes === 1) updated.push(session.sessionId);
      }
      return updated;
    })();
  }

  listBrowserSessionsBounded(inputValue: unknown): readonly BrowserSessionSummary[] {
    const input = BoundedSessionListInputSchema.parse(inputValue);
    const rows = this.database
      .prepare(
        `SELECT session_id AS sessionId,
                substr(title, 1, ${BOUNDED_SESSION_LIST_TEXT_CODE_POINTS}) AS title, status,
                created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs,
                last_event_sequence AS lastEventSequence, last_run_state AS lastRunState,
                substr(last_message_preview, 1, ${BOUNDED_SESSION_LIST_TEXT_CODE_POINTS})
                  AS lastMessagePreview,
                requires_attention AS requiresAttention,
                pending_approval_count AS pendingApprovalCount,
                pending_input_count AS pendingInputCount
         FROM sessions
         WHERE status <> 'missing'
         ORDER BY updated_at_ms DESC, session_id
         LIMIT @limit`,
      )
      .all(input) as Record<string, unknown>[];
    return rows.map(browserSessionFromRow);
  }

  getSession(sessionId: string): SessionSummary | null {
    const row = this.database
      .prepare(
        `SELECT session_id AS sessionId, project_id AS projectId,
                db_relative_path AS dbRelativePath, title, status,
                created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs,
                last_event_sequence AS lastEventSequence, last_run_state AS lastRunState,
                last_message_preview AS lastMessagePreview, requires_attention AS requiresAttention,
                pending_approval_count AS pendingApprovalCount,
                pending_input_count AS pendingInputCount,
                session_schema_version AS sessionSchemaVersion,
                recovery_candidate AS recoveryCandidate
         FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : sessionFromRow(row);
  }

  updateSessionProjection(inputValue: unknown): CatalogProjectionUpdateResult {
    const input = UpdateSessionProjectionInputSchema.parse(inputValue);
    const existing = this.getSession(input.sessionId);
    if (existing === null) throw new StorageError("session.not_found", "Session index not found");
    if (input.lastEventSequence < existing.lastEventSequence) {
      return { summary: existing, outcome: "stale" };
    }
    if (input.lastEventSequence === existing.lastEventSequence) {
      const identical =
        input.updatedAtMs === existing.updatedAtMs &&
        input.lastRunState === existing.lastRunState &&
        input.lastMessagePreview === existing.lastMessagePreview &&
        input.requiresAttention === existing.requiresAttention &&
        input.pendingApprovalCount === existing.pendingApprovalCount &&
        input.pendingInputCount === existing.pendingInputCount;
      if (!identical) {
        throw new StorageError(
          "storage.catalog_projection_conflict",
          `Catalog projection ${input.sessionId} conflicts at head ${input.lastEventSequence}`,
        );
      }
      return { summary: existing, outcome: "idempotent" };
    }

    const result = this.database
      .prepare(
        `UPDATE sessions SET
           updated_at_ms = @updatedAtMs,
           last_event_sequence = @lastEventSequence,
           last_run_state = @lastRunState,
           last_message_preview = @lastMessagePreview,
           requires_attention = @requiresAttention,
           pending_approval_count = @pendingApprovalCount,
           pending_input_count = @pendingInputCount,
           recovery_candidate = CASE WHEN @recoveryNeeded = 0 THEN 0 ELSE 1 END
         WHERE session_id = @sessionId AND last_event_sequence < @lastEventSequence`,
      )
      .run({
        ...input,
        requiresAttention: input.requiresAttention ? 1 : 0,
        recoveryNeeded: input.recoveryNeeded ? 1 : 0,
      });
    if (result.changes !== 1) {
      throw new StorageError("storage.catalog_projection_conflict", "Catalog projection lost its head CAS");
    }
    const updated = this.getSession(input.sessionId);
    if (updated === null) throw new Error("Updated session index disappeared");
    return { summary: updated, outcome: "applied" };
  }

  listRecoveryCandidates(inputValue: unknown = {}): {
    readonly sessionIds: readonly string[];
    readonly nextCursor: { readonly updatedAtMs: number; readonly sessionId: string } | null;
  } {
    const input = z
      .strictObject({
        afterUpdatedAtMs: z.number().int().nonnegative().safe().nullable().default(null),
        afterSessionId: SessionIdSchema.nullable().default(null),
        limit: z.number().int().positive().max(1_000).default(1_000),
      })
      .parse(inputValue);
    if ((input.afterUpdatedAtMs === null) !== (input.afterSessionId === null)) {
      throw new StorageError("storage.corrupt", "Recovery candidate cursor is incomplete");
    }
    const rows = this.database
      .prepare(
        `SELECT session_id AS sessionId, updated_at_ms AS updatedAtMs FROM sessions
         WHERE status = 'ready' AND recovery_candidate = 1
           AND (
             @afterUpdatedAtMs IS NULL
             OR updated_at_ms > @afterUpdatedAtMs
             OR (updated_at_ms = @afterUpdatedAtMs AND session_id > @afterSessionId)
           )
         ORDER BY updated_at_ms, session_id LIMIT @limit`,
      )
      .all(input) as readonly { sessionId: string; updatedAtMs: number }[];
    const last = rows.at(-1);
    return {
      sessionIds: rows.map((row) => SessionIdSchema.parse(row.sessionId)),
      nextCursor: last === undefined ? null : { updatedAtMs: last.updatedAtMs, sessionId: SessionIdSchema.parse(last.sessionId) },
    };
  }

  markRecoveryCandidate(sessionIdValue: unknown): void {
    const sessionId = SessionIdSchema.parse(sessionIdValue);
    const result = this.database
      .prepare("UPDATE sessions SET recovery_candidate = 1 WHERE session_id = ?")
      .run(sessionId);
    if (result.changes !== 1) throw new StorageError("session.not_found", "Session index not found");
  }

  markSessionStatus(inputValue: unknown): SessionSummary {
    const input = MarkSessionStatusInputSchema.parse(inputValue);
    const result = this.database
      .prepare(
        `UPDATE sessions SET status = @status, unavailable_reason = NULL
         WHERE session_id = @sessionId`,
      )
      .run(input);
    if (result.changes !== 1) throw new StorageError("session.not_found", "Session index not found");
    const updated = this.getSession(input.sessionId);
    if (updated === null) throw new Error("Updated session index disappeared");
    return updated;
  }

  repairSessionClassification(inputValue: unknown): SessionSummary {
    const input = RepairSessionClassificationInputSchema.parse(inputValue);
    const result = this.database
      .prepare(
        `UPDATE sessions SET
           db_relative_path = @dbRelativePath,
           status = @status,
           session_schema_version = COALESCE(@sessionSchemaVersion, session_schema_version),
           unavailable_reason = @unavailableReason,
           recovery_candidate = 0
         WHERE session_id = @sessionId`,
      )
      .run(input);
    if (result.changes !== 1) throw new StorageError("session.not_found", "Session index not found");
    const updated = this.getSession(input.sessionId);
    if (updated === null) throw new Error("Repaired session index disappeared");
    return updated;
  }

  getProviderCatalogState(): ProviderCatalogState {
    const row = this.database.prepare(
      `SELECT catalog_revision AS catalogRevision, rebuilt_epoch AS rebuiltEpoch,
              recovery_active AS recoveryActive
       FROM provider_catalog_state WHERE singleton = 1`,
    ).get() as Record<string, unknown> | undefined;
    return ProviderCatalogStateSchema.parse({
      ...row,
      recoveryActive: row?.recoveryActive === 1,
    });
  }

  setProviderCatalogRecoveryActive(activeValue: unknown): ProviderCatalogState {
    const active = z.boolean().parse(activeValue);
    this.database.prepare(
      `UPDATE provider_catalog_state
       SET recovery_active = ?,
           rebuilt_epoch = CASE WHEN ? = 1 AND recovery_active = 0
             THEN rebuilt_epoch + 1 ELSE rebuilt_epoch END
       WHERE singleton = 1`,
    ).run(active ? 1 : 0, active ? 1 : 0);
    return this.getProviderCatalogState();
  }

  private incrementProviderCatalogRevision(): number {
    this.database.prepare(
      "UPDATE provider_catalog_state SET catalog_revision = catalog_revision + 1 WHERE singleton = 1",
    ).run();
    return this.getProviderCatalogState().catalogRevision;
  }

  getProviderConnection(connectionIdValue: unknown): ProviderConnectionRecord | null {
    const connectionId = ProviderConnectionIdSchema.parse(connectionIdValue);
    const row = this.database.prepare(
      `SELECT
         connection_id AS connectionId, provider_id AS providerId, auth_mode AS authMode,
         display_name AS displayName, credential_backend_kind AS credentialBackendKind,
         credential_internal_ref AS credentialInternalRef,
         environment_variable_name AS environmentVariableName, envelope_id AS envelopeId,
         credential_generation AS credentialGeneration, lifecycle_revision AS lifecycleRevision,
         metadata_revision AS metadataRevision, lifecycle_status AS lifecycleStatus,
         identity_json AS identityJson, identity_verification_status AS identityVerificationStatus,
         capabilities_version AS capabilitiesVersion,
         lifecycle_owner_kind AS lifecycleOwnerKind, deleted,
         recovery_tombstone AS recoveryTombstone, created_at_ms AS createdAtMs,
         updated_at_ms AS updatedAtMs
       FROM provider_connections WHERE connection_id = ?`,
    ).get(connectionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : providerConnectionFromRow(row);
  }

  listProviderConnections(inputValue: unknown): {
    readonly connections: readonly ProviderConnectionRecord[];
    readonly catalogRevision: number;
    readonly truncated: boolean;
  } {
    const input = z.strictObject({ limit: z.number().int().positive().max(1_001) }).parse(inputValue);
    const rows = this.database.prepare(
      `SELECT
         connection_id AS connectionId, provider_id AS providerId, auth_mode AS authMode,
         display_name AS displayName, credential_backend_kind AS credentialBackendKind,
         credential_internal_ref AS credentialInternalRef,
         environment_variable_name AS environmentVariableName, envelope_id AS envelopeId,
         credential_generation AS credentialGeneration, lifecycle_revision AS lifecycleRevision,
         metadata_revision AS metadataRevision, lifecycle_status AS lifecycleStatus,
         identity_json AS identityJson, identity_verification_status AS identityVerificationStatus,
         capabilities_version AS capabilitiesVersion,
         lifecycle_owner_kind AS lifecycleOwnerKind, deleted,
         recovery_tombstone AS recoveryTombstone, created_at_ms AS createdAtMs,
         updated_at_ms AS updatedAtMs
       FROM provider_connections ORDER BY updated_at_ms DESC, connection_id LIMIT ?`,
    ).all(input.limit) as Record<string, unknown>[];
    return {
      connections: rows.slice(0, 1_000).map(providerConnectionFromRow),
      catalogRevision: this.getProviderCatalogState().catalogRevision,
      truncated: rows.length > 1_000,
    };
  }

  getProviderLifecycleOperation(commandIdValue: unknown): ProviderLifecycleOperationRecord | null {
    const commandId = CommandIdSchema.parse(commandIdValue);
    const row = this.database.prepare(
      `SELECT command_id AS commandId, command_method AS commandMethod,
         content_hash AS contentHash, operation_kind AS operationKind,
         target_connection_id AS targetConnectionId,
         expected_lifecycle_revision AS expectedLifecycleRevision,
         expected_generation AS expectedGeneration,
         reserved_lifecycle_revision AS reservedLifecycleRevision,
         reserved_generation AS reservedGeneration, owner_key AS ownerKey,
         provisioning_id AS provisioningId, staging_internal_ref AS stagingInternalRef,
         staging_file_identity_json AS stagingFileIdentityJson,
         credential_backend_kind AS credentialBackendKind,
         credential_internal_ref AS credentialInternalRef, envelope_id AS envelopeId,
         recovery_epoch_id AS recoveryEpochId,
         expected_safe_metadata_json AS expectedSafeMetadataJson,
         recovery_file_identity_json AS recoveryFileIdentityJson, phase,
         result_json AS resultJson, failure_code AS failureCode,
         failure_message AS failureMessage, diagnostic_id AS diagnosticId,
         created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
       FROM provider_lifecycle_operations WHERE command_id = ?`,
    ).get(commandId) as Record<string, unknown> | undefined;
    return row === undefined ? null : providerOperationFromRow(row);
  }

  hasProviderMetadataCommand(commandIdValue: unknown): boolean {
    const commandId = CommandIdSchema.parse(commandIdValue);
    return this.database.prepare(
      "SELECT 1 AS present FROM provider_metadata_commands WHERE command_id = ?",
    ).get(commandId) !== undefined;
  }

  private assertProviderConnectionCapacity(): void {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM provider_connections",
    ).get() as { count: number };
    if (row.count >= PROVIDER_CONNECTION_LIMITS.maximumConnections) {
      throw new StorageError(
        "provider.connection_limit_exceeded",
        "The provider connection limit has been reached",
      );
    }
  }

  private assertNoCatalogGlobalCommand(commandId: string): void {
    if (this.getGlobalCommand(commandId) !== null) {
      throw new StorageError(
        "protocol.command_id_conflict",
        "Provider command ID is already owned by a catalog-global command",
      );
    }
  }

  private assertNoProviderMetadataCommand(commandId: string): void {
    this.assertNoCatalogGlobalCommand(commandId);
    const existing = this.database.prepare(
      "SELECT 1 FROM provider_metadata_commands WHERE command_id = ?",
    ).get(commandId);
    if (existing !== undefined) {
      throw new StorageError(
        "protocol.command_id_conflict",
        "Provider command ID is already owned by a metadata command",
      );
    }
  }

  registerEnvironmentConnection(inputValue: unknown): ProviderConnectionCommandResult {
    const input = EnvironmentConnectionRegistrationSchema.parse(inputValue);
    const identityClaim = input.identityClaim?.workspacePresence === "unknown"
      ? null
      : input.identityClaim;
    return this.database.transaction(() => {
      this.assertNoProviderMetadataCommand(input.commandId);
      const existingOperation = this.getProviderLifecycleOperation(input.commandId);
      if (existingOperation !== null) {
        if (existingOperation.contentHash !== input.contentHash || existingOperation.commandMethod !== "providerConnection.environment.create") {
          throw new StorageError("protocol.command_id_conflict", "Provider command ID was reused with different content");
        }
        const connection = this.getProviderConnection(existingOperation.targetConnectionId);
        if (connection === null) throw new StorageError("storage.corrupt", "Provider command target is missing");
        return {
          connection,
          operation: existingOperation,
          catalogRevision: this.getProviderCatalogState().catalogRevision,
          duplicate: true,
        };
      }
      if (this.getProviderConnection(input.connectionId) !== null) {
        throw new StorageError("protocol.command_id_conflict", "Provider connection identity is occupied");
      }
      if (identityClaim !== null) {
        const identityWinner = this.database.prepare(
          "SELECT connection_id AS connectionId FROM provider_identity_claims WHERE identity_key = ?",
        ).get(identityClaim.identityKey) as { connectionId: string } | undefined;
        if (identityWinner !== undefined) {
          const winner = this.getProviderConnection(identityWinner.connectionId);
          if (winner === null || winner.deleted) {
            throw new StorageError("storage.corrupt", "Authoritative provider identity winner is unavailable");
          }
          this.database.prepare(
            `INSERT INTO provider_lifecycle_operations (
               command_id, command_method, content_hash, operation_kind,
               target_connection_id, expected_lifecycle_revision, expected_generation,
               reserved_lifecycle_revision, reserved_generation, owner_key,
               credential_backend_kind, phase, result_json, created_at_ms, updated_at_ms
             ) VALUES (?, 'providerConnection.environment.create', ?, 'create', ?, NULL, NULL, ?, ?, ?, ?, 'succeeded', ?, ?, ?)`,
          ).run(
            input.commandId, input.contentHash, winner.connectionId,
            winner.lifecycleRevision, winner.credentialGeneration, winner.connectionId,
            winner.credentialBackend.kind, canonicalJson({ connectionId: winner.connectionId }),
            input.createdAtMs, input.createdAtMs,
          );
          const operation = this.getProviderLifecycleOperation(input.commandId);
          if (operation === null) throw new StorageError("storage.corrupt", "Provider identity resolution disappeared");
          return {
            connection: winner,
            operation,
            catalogRevision: this.getProviderCatalogState().catalogRevision,
            duplicate: false,
          };
        }
      }
      this.assertProviderConnectionCapacity();
      const identityJson = canonicalJson(input.identity);
      this.database.prepare(
        `INSERT INTO provider_connections (
           connection_id, provider_id, auth_mode, display_name,
           credential_backend_kind, credential_internal_ref, environment_variable_name,
           envelope_id, credential_generation, lifecycle_revision, metadata_revision,
           lifecycle_status, identity_json, identity_verification_status,
           capabilities_version, lifecycle_owner_command_id, lifecycle_owner_kind,
           deleted, recovery_tombstone, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 'environment', NULL, ?, NULL, 1, 1, 1, ?, ?, ?, NULL, NULL, NULL, 0, 0, ?, ?)`,
      ).run(
        input.connectionId, input.providerId, input.authMode, input.displayName,
        input.variableName, input.initialStatus, identityJson, input.identity.status,
        input.createdAtMs, input.createdAtMs,
      );
      if (identityClaim !== null) {
        this.database.prepare(
          `INSERT INTO provider_identity_claims (
             identity_key, provider_id, auth_mode, stable_kind, stable_value,
             workspace_presence, workspace_value, connection_id, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          identityClaim.identityKey, input.providerId, input.authMode,
          identityClaim.stableKind, identityClaim.stableValue,
          identityClaim.workspacePresence, identityClaim.workspaceValue,
          input.connectionId, input.createdAtMs,
        );
      }
      this.database.prepare(
        `INSERT INTO provider_lifecycle_operations (
           command_id, command_method, content_hash, operation_kind,
           target_connection_id, expected_lifecycle_revision, expected_generation,
           reserved_lifecycle_revision, reserved_generation, owner_key,
           credential_backend_kind, phase, result_json, created_at_ms, updated_at_ms
         ) VALUES (?, 'providerConnection.environment.create', ?, 'create', ?, NULL, NULL, 1, 1, ?, 'environment', 'succeeded', ?, ?, ?)`,
      ).run(
        input.commandId, input.contentHash, input.connectionId, input.connectionId,
        canonicalJson({ connectionId: input.connectionId }), input.createdAtMs, input.createdAtMs,
      );
      const catalogRevision = this.incrementProviderCatalogRevision();
      const connection = this.getProviderConnection(input.connectionId);
      const operation = this.getProviderLifecycleOperation(input.commandId);
      if (connection === null || operation === null) throw new StorageError("storage.corrupt", "Provider registration disappeared");
      return { connection, operation, catalogRevision, duplicate: false };
    })();
  }

  admitProviderRecovery(inputValue: unknown): ProviderLifecycleOperationRecord {
    const input = RecoveryAdmissionSchema.parse(inputValue);
    return this.database.transaction(() => {
      this.assertNoProviderMetadataCommand(input.commandId);
      const existing = this.getProviderLifecycleOperation(input.commandId);
      if (existing !== null) {
        if (existing.contentHash !== input.contentHash || existing.commandMethod !== input.commandMethod) {
          throw new StorageError("protocol.command_id_conflict", "Recovery command ID was reused with different content");
        }
        return existing;
      }
      this.database.prepare(
        `INSERT INTO provider_lifecycle_operations (
           command_id, command_method, content_hash, operation_kind, target_connection_id,
           expected_lifecycle_revision, expected_generation, reserved_lifecycle_revision,
           reserved_generation, owner_key, credential_backend_kind, recovery_epoch_id,
           expected_safe_metadata_json, phase, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'credential_recovery', ?, NULL, NULL, 1, ?, ?, 'file', ?, ?, 'validating', ?, ?)`,
      ).run(
        input.commandId, input.commandMethod, input.contentHash, input.connectionId,
        input.generation, input.connectionId, input.recoveryEpochId,
        canonicalJson(input.expectedSafeMetadata), input.createdAtMs, input.createdAtMs,
      );
      const admitted = this.getProviderLifecycleOperation(input.commandId);
      if (admitted === null) throw new StorageError("storage.corrupt", "Recovery admission disappeared");
      return admitted;
    })();
  }

  failProviderRecovery(inputValue: unknown): ProviderLifecycleOperationRecord {
    const input = FailProviderRecoveryInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const operation = this.getProviderLifecycleOperation(input.commandId);
      if (operation === null) throw new StorageError("provider.operation_not_found", "Recovery operation was not found");
      if (operation.contentHash !== input.contentHash || operation.operationKind !== "credential_recovery") {
        throw new StorageError("protocol.command_id_conflict", "Recovery failure does not match its admission");
      }
      if (operation.phase === "validating") {
        this.database.prepare(
          `UPDATE provider_lifecycle_operations
           SET phase = 'failed', failure_code = ?, failure_message = ?, updated_at_ms = ?
           WHERE command_id = ? AND phase = 'validating'`,
        ).run(input.failureCode, input.failureMessage, input.updatedAtMs, input.commandId);
      }
      const failed = this.getProviderLifecycleOperation(input.commandId);
      if (failed === null) throw new StorageError("storage.corrupt", "Failed recovery admission disappeared");
      return failed;
    })();
  }

  failValidatingProviderRecoveries(updatedAtMsValue: unknown): number {
    const updatedAtMs = z.number().int().nonnegative().safe().parse(updatedAtMsValue);
    return this.database.transaction(() => {
      const result = this.database.prepare(
        `UPDATE provider_lifecycle_operations
         SET phase = 'failed', failure_code = 'credential.recovery_ref_expired',
             failure_message = 'The process-bound recovery reference expired during restart.',
             updated_at_ms = ?
         WHERE phase = 'validating' AND operation_kind = 'credential_recovery'`,
      ).run(updatedAtMs);
      return Number(result.changes);
    })();
  }

  reserveRecoveredProviderConnection(inputValue: unknown): ProviderConnectionCommandResult {
    const input = RecoveredConnectionReservationSchema.parse(inputValue);
    const identityClaim = input.identityClaim?.workspacePresence === "unknown"
      ? null
      : input.identityClaim;
    return this.database.transaction(() => {
      this.assertNoProviderMetadataCommand(input.commandId);
      const existingOperation = this.getProviderLifecycleOperation(input.commandId);
      if (existingOperation !== null) {
        if (existingOperation.contentHash !== input.contentHash || existingOperation.commandMethod !== input.commandMethod) {
          throw new StorageError("protocol.command_id_conflict", "Recovery command ID was reused with different content");
        }
        if (existingOperation.phase !== "validating") {
          const existingConnection = this.getProviderConnection(existingOperation.targetConnectionId);
          if (existingConnection === null) throw new StorageError("storage.corrupt", "Recovered connection is missing");
          return { connection: existingConnection, operation: existingOperation, catalogRevision: this.getProviderCatalogState().catalogRevision, duplicate: true };
        }
        if (
          existingOperation.targetConnectionId !== input.connectionId ||
          existingOperation.reservedGeneration !== input.generation ||
          existingOperation.recoveryEpochId !== input.recoveryEpochId
        ) {
          throw new StorageError("protocol.command_id_conflict", "Recovery preparation does not match its admission");
        }
      }
      if (this.getProviderConnection(input.connectionId) !== null) {
        throw new StorageError(
          "credential.recovery_connection_conflict",
          "The original provider connection identity is already occupied",
        );
      }
      if (identityClaim !== null) {
        const identityWinner = this.database.prepare(
          "SELECT connection_id AS connectionId FROM provider_identity_claims WHERE identity_key = ?",
        ).get(identityClaim.identityKey) as { connectionId: string } | undefined;
        if (identityWinner !== undefined && identityWinner.connectionId !== input.connectionId) {
          throw new StorageError(
            "credential.recovery_identity_conflict",
            "The authoritative provider identity is already claimed",
          );
        }
      }
      this.assertProviderConnectionCapacity();
      this.database.prepare(
        `INSERT INTO provider_connections (
           connection_id, provider_id, auth_mode, display_name,
           credential_backend_kind, credential_internal_ref, environment_variable_name,
           envelope_id, credential_generation, lifecycle_revision, metadata_revision,
           lifecycle_status, identity_json, identity_verification_status,
           capabilities_version, lifecycle_owner_command_id, lifecycle_owner_kind,
           deleted, recovery_tombstone, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 'file', ?, NULL, ?, ?, 1, 1, 'unavailable', ?, ?, NULL, ?, 'credential_recovery', 0, 0, ?, ?)`,
      ).run(
        input.connectionId, input.providerId, input.authMode, input.displayName,
        input.credentialInternalRef, input.envelopeId, input.generation,
        canonicalJson(input.identity), input.identity.status, input.commandId,
        input.createdAtMs, input.createdAtMs,
      );
      if (identityClaim !== null) {
        this.database.prepare(
          `INSERT INTO provider_identity_claims (
             identity_key, provider_id, auth_mode, stable_kind, stable_value,
             workspace_presence, workspace_value, connection_id, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          identityClaim.identityKey, input.providerId, input.authMode,
          identityClaim.stableKind, identityClaim.stableValue,
          identityClaim.workspacePresence, identityClaim.workspaceValue,
          input.connectionId, input.createdAtMs,
        );
      }
      if (existingOperation === null) {
        this.database.prepare(
          `INSERT INTO provider_lifecycle_operations (
             command_id, command_method, content_hash, operation_kind, target_connection_id,
             reserved_lifecycle_revision, reserved_generation, owner_key,
             credential_backend_kind, credential_internal_ref, envelope_id, recovery_epoch_id,
             recovery_file_identity_json, phase, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 'credential_recovery', ?, 1, ?, ?, 'file', ?, ?, ?, ?, 'prepared', ?, ?)`,
        ).run(
          input.commandId, input.commandMethod, input.contentHash, input.connectionId,
          input.generation, input.connectionId, input.credentialInternalRef,
          input.envelopeId, input.recoveryEpochId, canonicalJson(input.recoveryFileIdentity),
          input.createdAtMs, input.createdAtMs,
        );
      } else {
        this.database.prepare(
          `UPDATE provider_lifecycle_operations
           SET credential_internal_ref = ?, envelope_id = ?, recovery_file_identity_json = ?,
               phase = 'prepared', updated_at_ms = ?
           WHERE command_id = ? AND phase = 'validating'`,
        ).run(
          input.credentialInternalRef,
          input.envelopeId,
          canonicalJson(input.recoveryFileIdentity),
          input.createdAtMs,
          input.commandId,
        );
      }
      this.database.prepare(
        `INSERT INTO provider_lifecycle_owners (
           owner_key, command_id, connection_id, operation_kind,
           lifecycle_revision, generation, acquired_at_ms
         ) VALUES (?, ?, ?, 'credential_recovery', 1, ?, ?)`,
      ).run(input.connectionId, input.commandId, input.connectionId, input.generation, input.createdAtMs);
      this.database.prepare(
        `INSERT INTO provider_credential_claims (
           claim_kind, claim_id, command_id, connection_id, claimed_at_ms
         ) VALUES ('recovery', ?, ?, ?, ?)`,
      ).run(input.envelopeId, input.commandId, input.connectionId, input.createdAtMs);
      const connection = this.getProviderConnection(input.connectionId);
      const operation = this.getProviderLifecycleOperation(input.commandId);
      if (connection === null || operation === null) throw new StorageError("storage.corrupt", "Recovery reservation disappeared");
      return { connection, operation, catalogRevision: this.incrementProviderCatalogRevision(), duplicate: false };
    })();
  }

  reserveFileProviderConnection(inputValue: unknown): FileConnectionReservationResult {
    const input = FileConnectionReservationSchema.parse(inputValue);
    return this.database.transaction(() => {
      this.assertNoProviderMetadataCommand(input.commandId);
      const existingOperation = this.getProviderLifecycleOperation(input.commandId);
      if (existingOperation !== null) {
        if (existingOperation.contentHash !== input.contentHash || existingOperation.commandMethod !== input.commandMethod) {
          throw new StorageError("protocol.command_id_conflict", "Provider command ID was reused with different content");
        }
        const existingConnection = this.getProviderConnection(existingOperation.targetConnectionId);
        if (existingConnection === null) {
          if (existingOperation.phase === "failed") {
            return {
              connection: null,
              operation: existingOperation,
              catalogRevision: this.getProviderCatalogState().catalogRevision,
              duplicate: true,
            };
          }
          throw new StorageError("storage.corrupt", "Provider command target is missing");
        }
        return { connection: existingConnection, operation: existingOperation, catalogRevision: this.getProviderCatalogState().catalogRevision, duplicate: true };
      }
      const existingClaim = this.database.prepare(
        `SELECT command_id AS commandId
         FROM provider_credential_claims
         WHERE claim_kind = 'provisioning' AND claim_id = ?`,
      ).get(input.provisioningId) as { commandId: string } | undefined;
      if (existingClaim !== undefined) {
        this.database.prepare(
          `INSERT INTO provider_lifecycle_operations (
             command_id, command_method, content_hash, operation_kind, target_connection_id,
             expected_lifecycle_revision, expected_generation, reserved_lifecycle_revision,
             reserved_generation, owner_key, provisioning_id, staging_internal_ref,
             staging_file_identity_json, credential_backend_kind,
             credential_internal_ref, envelope_id, phase, failure_code, failure_message,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 'create', ?, NULL, NULL, 1, 1, ?, ?, ?, ?, 'file', ?, ?,
                     'failed', 'credential.provisioning_already_claimed',
                     'The staged credential is already claimed by another command', ?, ?)`,
        ).run(
          input.commandId,
          input.commandMethod,
          input.contentHash,
          input.connectionId,
          input.connectionId,
          input.provisioningId,
          input.stagingInternalRef,
          canonicalJson(input.stagingFileIdentity),
          input.credentialInternalRef,
          input.targetEnvelopeId,
          input.createdAtMs,
          input.createdAtMs,
        );
        const operation = this.getProviderLifecycleOperation(input.commandId);
        if (operation === null) {
          throw new StorageError("storage.corrupt", "Provisioning conflict result disappeared");
        }
        return {
          connection: null,
          operation,
          catalogRevision: this.getProviderCatalogState().catalogRevision,
          duplicate: false,
        };
      }
      if (this.getProviderConnection(input.connectionId) !== null) {
        throw new StorageError("protocol.command_id_conflict", "Provider connection identity is occupied");
      }
      this.assertProviderConnectionCapacity();
      this.database.prepare(
        `INSERT INTO provider_connections (
           connection_id, provider_id, auth_mode, display_name,
           credential_backend_kind, credential_internal_ref, environment_variable_name,
           envelope_id, credential_generation, lifecycle_revision, metadata_revision,
           lifecycle_status, identity_json, identity_verification_status,
           capabilities_version, lifecycle_owner_command_id, lifecycle_owner_kind,
           deleted, recovery_tombstone, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 'file', ?, NULL, ?, 1, 1, 1, 'unavailable', ?, ?, NULL, ?, 'create', 0, 0, ?, ?)`,
      ).run(
        input.connectionId, input.providerId, input.authMode, input.displayName,
        input.credentialInternalRef, input.targetEnvelopeId, canonicalJson(input.identity),
        input.identity.status, input.commandId, input.createdAtMs, input.createdAtMs,
      );
      this.database.prepare(
        `INSERT INTO provider_lifecycle_operations (
           command_id, command_method, content_hash, operation_kind, target_connection_id,
           expected_lifecycle_revision, expected_generation, reserved_lifecycle_revision,
           reserved_generation, owner_key, provisioning_id, staging_internal_ref,
           staging_file_identity_json, credential_backend_kind,
           credential_internal_ref, envelope_id, phase, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'create', ?, NULL, NULL, 1, 1, ?, ?, ?, ?, 'file', ?, ?, 'prepared', ?, ?)`,
      ).run(
        input.commandId, input.commandMethod, input.contentHash, input.connectionId,
        input.connectionId, input.provisioningId, input.stagingInternalRef,
        canonicalJson(input.stagingFileIdentity), input.credentialInternalRef,
        input.targetEnvelopeId, input.createdAtMs, input.createdAtMs,
      );
      this.database.prepare(
        `INSERT INTO provider_lifecycle_owners (
           owner_key, command_id, connection_id, operation_kind,
           lifecycle_revision, generation, acquired_at_ms
         ) VALUES (?, ?, ?, 'create', 1, 1, ?)`,
      ).run(input.connectionId, input.commandId, input.connectionId, input.createdAtMs);
      this.database.prepare(
        `INSERT INTO provider_credential_claims (
           claim_kind, claim_id, command_id, connection_id, claimed_at_ms
         ) VALUES ('provisioning', ?, ?, ?, ?)`,
      ).run(input.provisioningId, input.commandId, input.connectionId, input.createdAtMs);
      const connection = this.getProviderConnection(input.connectionId);
      const operation = this.getProviderLifecycleOperation(input.commandId);
      if (connection === null || operation === null) throw new StorageError("storage.corrupt", "File connection reservation disappeared");
      return { connection, operation, catalogRevision: this.incrementProviderCatalogRevision(), duplicate: false };
    })();
  }

  prepareProviderLifecycle(inputValue: unknown): ProviderConnectionCommandResult {
    const input = PrepareProviderLifecycleInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      this.assertNoProviderMetadataCommand(input.commandId);
      const existingOperation = this.getProviderLifecycleOperation(input.commandId);
      if (existingOperation !== null) {
        if (existingOperation.contentHash !== input.contentHash || existingOperation.commandMethod !== input.commandMethod) {
          throw new StorageError("protocol.command_id_conflict", "Provider command ID was reused with different content");
        }
        const existingConnection = this.getProviderConnection(existingOperation.targetConnectionId);
        if (existingConnection === null) throw new StorageError("storage.corrupt", "Provider command target is missing");
        return { connection: existingConnection, operation: existingOperation, catalogRevision: this.getProviderCatalogState().catalogRevision, duplicate: true };
      }
      const connection = this.getProviderConnection(input.connectionId);
      if (connection === null) throw new StorageError("provider.connection_not_found", "Provider connection was not found");
      if (connection.lifecycleOwnerKind !== null) {
        this.database.prepare(
          `INSERT INTO provider_lifecycle_operations (
             command_id, command_method, content_hash, operation_kind, target_connection_id,
             expected_lifecycle_revision, expected_generation, reserved_lifecycle_revision,
             reserved_generation, owner_key, credential_backend_kind, phase, result_json,
             failure_code, failure_message, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, 'provider.operation_in_progress', 'Another provider lifecycle operation is in progress', ?, ?)`,
        ).run(
          input.commandId, input.commandMethod, input.contentHash, input.operationKind,
          input.connectionId, input.expectedLifecycleRevision, input.expectedGeneration,
          connection.lifecycleRevision, connection.credentialGeneration, input.connectionId,
          input.credentialBackendKind,
          canonicalJson({ code: "provider.operation_in_progress", owningKind: connection.lifecycleOwnerKind }),
          input.createdAtMs, input.createdAtMs,
        );
        const operation = this.getProviderLifecycleOperation(input.commandId);
        if (operation === null) throw new StorageError("storage.corrupt", "Provider conflict result disappeared");
        return { connection, operation, catalogRevision: this.getProviderCatalogState().catalogRevision, duplicate: false };
      }
      if (
        input.expectedLifecycleRevision !== connection.lifecycleRevision ||
        input.expectedGeneration !== connection.credentialGeneration
      ) {
        throw new StorageError("provider.stale_revision", "Provider connection revision is stale");
      }
      if (
        input.operationKind === "enable" &&
        (
          connection.credentialBackend.kind !== "environment" ||
          connection.deleted ||
          connection.lifecycleStatus !== "unavailable"
        )
      ) {
        throw new StorageError(
          "provider.connection_unavailable",
          "Environment revalidation requires an undeleted unavailable environment connection",
        );
      }
      const incrementsRevision = input.operationKind !== "refresh";
      const incrementsGeneration = input.operationKind === "replace" || input.operationKind === "reauthenticate";
      const reservedLifecycleRevision = connection.lifecycleRevision + (incrementsRevision ? 1 : 0);
      const reservedGeneration = connection.credentialGeneration + (incrementsGeneration ? 1 : 0);
      this.database.prepare(
        `INSERT INTO provider_lifecycle_operations (
           command_id, command_method, content_hash, operation_kind, target_connection_id,
           expected_lifecycle_revision, expected_generation, reserved_lifecycle_revision,
           reserved_generation, owner_key, provisioning_id, staging_internal_ref,
           staging_file_identity_json, credential_backend_kind,
           credential_internal_ref, envelope_id, recovery_epoch_id,
           expected_safe_metadata_json, phase, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      ).run(
        input.commandId, input.commandMethod, input.contentHash, input.operationKind,
        input.connectionId, input.expectedLifecycleRevision, input.expectedGeneration,
        reservedLifecycleRevision, reservedGeneration, input.connectionId,
        input.provisioningId, input.stagingInternalRef,
        input.stagingFileIdentity === null ? null : canonicalJson(input.stagingFileIdentity),
        input.credentialBackendKind, input.credentialInternalRef,
        input.targetEnvelopeId, input.recoveryEpochId,
        input.expectedSafeMetadata === null ? null : canonicalJson(input.expectedSafeMetadata),
        input.createdAtMs, input.createdAtMs,
      );
      this.database.prepare(
        `INSERT INTO provider_lifecycle_owners (
           owner_key, command_id, connection_id, operation_kind,
           lifecycle_revision, generation, acquired_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.connectionId, input.commandId, input.connectionId, input.operationKind, reservedLifecycleRevision, reservedGeneration, input.createdAtMs);
      this.database.prepare(
        `UPDATE provider_connections SET lifecycle_revision = ?, credential_generation = ?,
           lifecycle_owner_command_id = ?, lifecycle_owner_kind = ?, updated_at_ms = ?
         WHERE connection_id = ?`,
      ).run(reservedLifecycleRevision, reservedGeneration, input.commandId, input.operationKind, input.createdAtMs, input.connectionId);
      if (input.provisioningId !== null) {
        this.database.prepare(
          `INSERT INTO provider_credential_claims (
             claim_kind, claim_id, command_id, connection_id, claimed_at_ms
           ) VALUES ('provisioning', ?, ?, ?, ?)`,
        ).run(input.provisioningId, input.commandId, input.connectionId, input.createdAtMs);
      }
      const updated = this.getProviderConnection(input.connectionId);
      const operation = this.getProviderLifecycleOperation(input.commandId);
      if (updated === null || operation === null) throw new StorageError("storage.corrupt", "Prepared provider operation disappeared");
      return { connection: updated, operation, catalogRevision: this.incrementProviderCatalogRevision(), duplicate: false };
    })();
  }

  disableProviderConnection(inputValue: unknown): ProviderConnectionCommandResult {
    const input = PrepareProviderLifecycleInputSchema.parse(inputValue);
    if (input.operationKind !== "disable") {
      throw new StorageError("storage.invalid_input", "Catalog-only disable requires disable ownership");
    }
    return this.database.transaction(() => {
      const prepared = this.prepareProviderLifecycle(input);
      if (prepared.operation.phase !== "prepared") return prepared;
      return this.completeProviderLifecycle({
        commandId: input.commandId,
        contentHash: input.contentHash,
        observedEnvelopeId: null,
        credentialInternalRef: prepared.operation.credentialInternalRef,
        terminalPhase: "succeeded",
        lifecycleStatus: "disabled",
        result: { connectionId: prepared.connection.connectionId },
        failureCode: null,
        failureMessage: null,
        diagnosticId: null,
        updatedAtMs: input.createdAtMs,
      });
    })();
  }

  observeProviderLifecycleEffect(inputValue: unknown): ProviderLifecycleOperationRecord {
    const input = ObserveProviderLifecycleEffectInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const operation = this.getProviderLifecycleOperation(input.commandId);
      if (operation === null) throw new StorageError("provider.operation_not_found", "Provider operation was not found");
      if (operation.contentHash !== input.contentHash) {
        throw new StorageError("protocol.command_id_conflict", "Provider command ID was reused with different content");
      }
      if (
        operation.credentialInternalRef !== input.credentialInternalRef ||
        operation.envelopeId !== input.observedEnvelopeId
      ) {
        throw new StorageError("provider.failed_after_effect", "Provider file-effect evidence does not match its reservation");
      }
      if (operation.phase === "file_observed" || ["succeeded", "failed_after_effect"].includes(operation.phase)) {
        return operation;
      }
      if (operation.phase !== "prepared") {
        throw new StorageError("provider.failed_after_effect", "Provider file effect was observed from an invalid phase");
      }
      const owner = this.database.prepare(
        "SELECT command_id AS commandId FROM provider_lifecycle_owners WHERE owner_key = ?",
      ).get(operation.ownerKey) as { commandId: string } | undefined;
      if (owner?.commandId !== input.commandId) {
        throw new StorageError("provider.failed_after_effect", "Provider file-effect owner could not be proven");
      }
      this.database.prepare(
        "UPDATE provider_lifecycle_operations SET phase = 'file_observed', updated_at_ms = ? WHERE command_id = ? AND phase = 'prepared'",
      ).run(input.updatedAtMs, input.commandId);
      const observed = this.getProviderLifecycleOperation(input.commandId);
      if (observed === null) throw new StorageError("storage.corrupt", "Observed provider operation disappeared");
      return observed;
    })();
  }

  failOrphanedProviderLifecycle(inputValue: unknown): ProviderLifecycleOperationRecord {
    const input = FailOrphanedProviderLifecycleInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const operation = this.getProviderLifecycleOperation(input.commandId);
      if (operation === null) {
        throw new StorageError("provider.operation_not_found", "Provider operation was not found");
      }
      if (operation.contentHash !== input.contentHash) {
        throw new StorageError(
          "protocol.command_id_conflict",
          "Provider command ID was reused with different content",
        );
      }
      if (["succeeded", "failed", "failed_after_effect"].includes(operation.phase)) {
        return operation;
      }
      if (this.getProviderConnection(operation.targetConnectionId) !== null) {
        throw new StorageError(
          "storage.corrupt",
          "An orphan provider operation still has its target connection",
        );
      }
      this.database.prepare(
        `UPDATE provider_lifecycle_operations
         SET phase = 'failed_after_effect', result_json = NULL,
             failure_code = 'provider.connection_not_found',
             failure_message = 'Provider lifecycle target is missing during restart recovery',
             diagnostic_id = ?, updated_at_ms = ?
         WHERE command_id = ?`,
      ).run(input.diagnosticId, input.updatedAtMs, input.commandId);
      this.database.prepare(
        "DELETE FROM provider_lifecycle_owners WHERE owner_key = ? AND command_id = ?",
      ).run(operation.ownerKey, input.commandId);
      this.database.prepare(
        `UPDATE provider_credential_claims
         SET consumed_at_ms = COALESCE(consumed_at_ms, ?)
         WHERE command_id = ?`,
      ).run(input.updatedAtMs, input.commandId);
      this.incrementProviderCatalogRevision();
      const failed = this.getProviderLifecycleOperation(input.commandId);
      if (failed === null) throw new StorageError("storage.corrupt", "Orphan provider operation disappeared");
      return failed;
    })();
  }

  completeProviderLifecycle(inputValue: unknown): ProviderConnectionCommandResult {
    const input = CompleteProviderLifecycleInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const operation = this.getProviderLifecycleOperation(input.commandId);
      if (operation === null) throw new StorageError("provider.operation_not_found", "Provider operation was not found");
      if (operation.contentHash !== input.contentHash) {
        throw new StorageError("protocol.command_id_conflict", "Provider command ID was reused with different content");
      }
      if (["succeeded", "failed", "failed_after_effect"].includes(operation.phase)) {
        const terminalConnection = this.getProviderConnection(operation.targetConnectionId);
        if (terminalConnection === null) throw new StorageError("storage.corrupt", "Provider operation target is missing");
        return { connection: terminalConnection, operation, catalogRevision: this.getProviderCatalogState().catalogRevision, duplicate: true };
      }
      if (
        input.recoveryTombstone &&
        (
          operation.operationKind !== "credential_recovery" ||
          input.terminalPhase !== "failed_after_effect" ||
          input.lifecycleStatus !== "unavailable" ||
          input.failureCode !== "credential.recovery_source_changed"
        )
      ) {
        throw new StorageError(
          "storage.corrupt",
          "A recovery tombstone requires an unavailable source-changed recovery failure",
        );
      }
      const requiresObservedFileEffect = operation.credentialBackendKind === "file" && [
        "create", "replace", "reauthenticate", "refresh", "credential_recovery", "logout", "delete",
      ].includes(operation.operationKind);
      if (input.terminalPhase === "succeeded" && requiresObservedFileEffect && operation.phase !== "file_observed") {
        throw new StorageError("provider.failed_after_effect", "Provider file effect was not durably observed");
      }
      const owner = this.database.prepare(
        "SELECT command_id AS commandId FROM provider_lifecycle_owners WHERE owner_key = ?",
      ).get(operation.ownerKey) as { commandId: string } | undefined;
      const ownerMatches = owner?.commandId === input.commandId;
      const terminalPhase = ownerMatches ? input.terminalPhase : "failed_after_effect";
      const lifecycleStatus = ownerMatches ? input.lifecycleStatus : "unavailable";
      this.database.prepare(
        `UPDATE provider_connections SET lifecycle_status = ?,
           credential_generation = CASE
             WHEN ? = 'failed' AND ? = 'replace' THEN COALESCE(?, credential_generation)
             ELSE credential_generation END,
           credential_backend_kind = CASE
             WHEN ? = 'succeeded' AND ? IN ('replace', 'reauthenticate') THEN ?
             ELSE credential_backend_kind END,
           environment_variable_name = CASE
             WHEN ? = 'succeeded' AND ? IN ('replace', 'reauthenticate') AND ? = 'file' THEN NULL
             ELSE environment_variable_name END,
           credential_internal_ref = CASE
             WHEN ? = 'succeeded' AND ? IN ('logout', 'delete') THEN NULL
             ELSE COALESCE(?, credential_internal_ref) END,
           envelope_id = CASE
             WHEN ? = 'succeeded' AND ? IN ('logout', 'delete') THEN NULL
             ELSE COALESCE(?, envelope_id) END,
           lifecycle_owner_command_id = NULL, lifecycle_owner_kind = NULL,
           deleted = CASE WHEN ? = 'delete' AND ? = 'succeeded' THEN 1 ELSE deleted END,
           recovery_tombstone = CASE
             WHEN ? THEN 1
             WHEN ? = 'succeeded' AND ? IN ('replace', 'reauthenticate') THEN 0
             ELSE recovery_tombstone END,
           updated_at_ms = ? WHERE connection_id = ?`,
      ).run(
        lifecycleStatus,
        terminalPhase, operation.operationKind, operation.expectedGeneration,
        terminalPhase, operation.operationKind, operation.credentialBackendKind,
        terminalPhase, operation.operationKind, operation.credentialBackendKind,
        terminalPhase, operation.operationKind, input.credentialInternalRef,
        terminalPhase, operation.operationKind, input.observedEnvelopeId,
        operation.operationKind, terminalPhase, input.recoveryTombstone ? 1 : 0,
        terminalPhase, operation.operationKind,
        input.updatedAtMs, operation.targetConnectionId,
      );
      this.database.prepare(
        `UPDATE provider_lifecycle_operations SET phase = ?, envelope_id = COALESCE(?, envelope_id),
           credential_internal_ref = COALESCE(?, credential_internal_ref), result_json = ?,
           failure_code = ?, failure_message = ?, diagnostic_id = ?, updated_at_ms = ?
         WHERE command_id = ?`,
      ).run(
        terminalPhase, input.observedEnvelopeId, input.credentialInternalRef,
        input.result === null ? null : canonicalJson(input.result),
        ownerMatches ? input.failureCode : "provider.failed_after_effect",
        ownerMatches ? input.failureMessage : "Provider operation could not prove its terminal transition",
        input.diagnosticId, input.updatedAtMs, input.commandId,
      );
      this.database.prepare("DELETE FROM provider_lifecycle_owners WHERE owner_key = ? AND command_id = ?").run(operation.ownerKey, input.commandId);
      this.database.prepare(
        "UPDATE provider_credential_claims SET consumed_at_ms = COALESCE(consumed_at_ms, ?) WHERE command_id = ?",
      ).run(input.updatedAtMs, input.commandId);
      const updatedConnection = this.getProviderConnection(operation.targetConnectionId);
      const updatedOperation = this.getProviderLifecycleOperation(input.commandId);
      if (updatedConnection === null || updatedOperation === null) throw new StorageError("storage.corrupt", "Terminal provider operation disappeared");
      return { connection: updatedConnection, operation: updatedOperation, catalogRevision: this.incrementProviderCatalogRevision(), duplicate: false };
    })();
  }

  markEnvironmentConnectionUnavailable(inputValue: unknown): ProviderConnectionRecord {
    const input = MarkEnvironmentConnectionUnavailableInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const connection = this.getProviderConnection(input.connectionId);
      if (connection === null) {
        throw new StorageError("provider.connection_not_found", "Provider connection was not found");
      }
      if (
        connection.credentialBackend.kind === "environment" &&
        connection.credentialGeneration === input.expectedGeneration &&
        connection.lifecycleRevision === input.expectedLifecycleRevision &&
        connection.lifecycleOwnerKind === null &&
        connection.lifecycleStatus === "ready"
      ) {
        this.database.prepare(
          `UPDATE provider_connections
           SET lifecycle_status = 'unavailable', lifecycle_revision = lifecycle_revision + 1,
               updated_at_ms = ?
           WHERE connection_id = ? AND credential_backend_kind = 'environment'
             AND credential_generation = ? AND lifecycle_revision = ?
             AND lifecycle_owner_command_id IS NULL AND lifecycle_status = 'ready'`,
        ).run(
          input.updatedAtMs,
          input.connectionId,
          input.expectedGeneration,
          input.expectedLifecycleRevision,
        );
        this.incrementProviderCatalogRevision();
      }
      const updated = this.getProviderConnection(input.connectionId);
      if (updated === null) throw new StorageError("storage.corrupt", "Provider connection disappeared");
      return updated;
    })();
  }

  renameProviderConnection(inputValue: unknown): ProviderMetadataCommandResult {
    const input = RenameProviderConnectionInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      this.assertNoCatalogGlobalCommand(input.commandId);
      if (this.getProviderLifecycleOperation(input.commandId) !== null) {
        throw new StorageError(
          "protocol.command_id_conflict",
          "Provider command ID is already owned by a lifecycle command",
        );
      }
      const existing = this.database.prepare(
        `SELECT command_method AS commandMethod, content_hash AS contentHash,
                connection_id AS connectionId
           FROM provider_metadata_commands WHERE command_id = ?`,
      ).get(input.commandId) as { commandMethod: string; contentHash: string; connectionId: string } | undefined;
      if (existing !== undefined) {
        if (existing.commandMethod !== "providerConnection.rename" || existing.contentHash !== input.contentHash) {
          throw new StorageError("protocol.command_id_conflict", "Provider metadata command ID was reused with different content");
        }
        const connection = this.getProviderConnection(existing.connectionId);
        if (connection === null) throw new StorageError("storage.corrupt", "Renamed provider connection is missing");
        return { connection, catalogRevision: this.getProviderCatalogState().catalogRevision, duplicate: true };
      }
      const changed = this.database.prepare(
        `UPDATE provider_connections
            SET display_name = ?, metadata_revision = metadata_revision + 1, updated_at_ms = ?
          WHERE connection_id = ? AND deleted = 0 AND metadata_revision = ?`,
      ).run(input.displayName, input.updatedAtMs, input.connectionId, input.expectedMetadataRevision);
      if (changed.changes !== 1) {
        throw new StorageError("provider.connection_unavailable", "Provider metadata revision changed");
      }
      this.database.prepare(
        `INSERT INTO provider_metadata_commands (
           command_id, command_method, content_hash, connection_id, result_json, accepted_at_ms
         ) VALUES (?, 'providerConnection.rename', ?, ?, ?, ?)`,
      ).run(input.commandId, input.contentHash, input.connectionId, canonicalJson({ connectionId: input.connectionId }), input.updatedAtMs);
      const connection = this.getProviderConnection(input.connectionId);
      if (connection === null) throw new StorageError("storage.corrupt", "Renamed provider connection disappeared");
      return { connection, catalogRevision: this.incrementProviderCatalogRevision(), duplicate: false };
    })();
  }

  putProviderCapabilities(inputValue: unknown): ProviderConnectionRecord {
    const input = PutProviderCapabilitiesInputSchema.parse(inputValue);
    return this.database.transaction(() => {
      const connection = this.getProviderConnection(input.snapshot.connectionId);
      if (connection === null) throw new StorageError("provider.connection_not_found", "Provider connection was not found");
      if (connection.metadataRevision !== input.expectedMetadataRevision) {
        throw new StorageError("provider.stale_revision", "Provider metadata revision is stale");
      }
      this.database.prepare(
        `INSERT INTO provider_capability_snapshots (
           connection_id, capabilities_version, snapshot_json, created_at_ms
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(connection_id, capabilities_version) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
      ).run(input.snapshot.connectionId, input.snapshot.capabilitiesVersion, canonicalJson(input.snapshot), input.updatedAtMs);
      this.database.prepare(
        `UPDATE provider_connections SET capabilities_version = ?, metadata_revision = metadata_revision + 1,
           updated_at_ms = ? WHERE connection_id = ?`,
      ).run(input.snapshot.capabilitiesVersion, input.updatedAtMs, input.snapshot.connectionId);
      this.incrementProviderCatalogRevision();
      const updated = this.getProviderConnection(input.snapshot.connectionId);
      if (updated === null) throw new StorageError("storage.corrupt", "Provider connection disappeared");
      return updated;
    })();
  }

  getProviderCapabilities(connectionIdValue: unknown): unknown | null {
    const connectionId = ProviderConnectionIdSchema.parse(connectionIdValue);
    const connection = this.getProviderConnection(connectionId);
    if (connection?.capabilitiesVersion === null || connection === null) return null;
    const row = this.database.prepare(
      `SELECT snapshot_json AS snapshotJson FROM provider_capability_snapshots
       WHERE connection_id = ? AND capabilities_version = ?`,
    ).get(connectionId, connection.capabilitiesVersion) as { snapshotJson: string } | undefined;
    return row === undefined
      ? null
      : decodeCatalogValue("provider capability snapshot", () =>
          ProviderCapabilitiesSnapshotSchema.parse(JSON.parse(row.snapshotJson) as unknown),
        );
  }

  isProvisioningClaimActive(provisioningIdValue: unknown): boolean {
    const provisioningId = z.string().regex(/^prov_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u).parse(provisioningIdValue);
    const row = this.database.prepare(
      `SELECT 1 AS active
       FROM provider_credential_claims claims
       JOIN provider_lifecycle_operations operations ON operations.command_id = claims.command_id
       WHERE claims.claim_kind = 'provisioning' AND claims.claim_id = ?
         AND operations.phase IN ('validating', 'prepared', 'file_observed')
       LIMIT 1`,
    ).get(provisioningId) as { active: number } | undefined;
    return row !== undefined;
  }

  markProviderStageCleaned(stagingInternalRefValue: unknown): void {
    const stagingInternalRef = z.string().regex(/^stage_[a-f0-9]{64}$/u).parse(stagingInternalRefValue);
    this.database.prepare(
      `UPDATE provider_lifecycle_operations SET staging_internal_ref = NULL
       WHERE staging_internal_ref = ? AND phase IN ('succeeded', 'failed', 'failed_after_effect')`,
    ).run(stagingInternalRef);
  }

  listTerminalProviderStages(): readonly string[] {
    const rows = this.database.prepare(
      `SELECT staging_internal_ref AS stagingInternalRef
       FROM provider_lifecycle_operations
       WHERE staging_internal_ref IS NOT NULL
         AND phase IN ('succeeded', 'failed', 'failed_after_effect')
       ORDER BY updated_at_ms, command_id LIMIT 1000`,
    ).all() as { stagingInternalRef: string }[];
    return rows.map((row) => row.stagingInternalRef);
  }

  listPreparedProviderOperations(): readonly ProviderLifecycleOperationRecord[] {
    const rows = this.database.prepare(
      `SELECT command_id AS commandId, command_method AS commandMethod,
         content_hash AS contentHash, operation_kind AS operationKind,
         target_connection_id AS targetConnectionId,
         expected_lifecycle_revision AS expectedLifecycleRevision,
         expected_generation AS expectedGeneration,
         reserved_lifecycle_revision AS reservedLifecycleRevision,
         reserved_generation AS reservedGeneration, owner_key AS ownerKey,
         provisioning_id AS provisioningId, staging_internal_ref AS stagingInternalRef,
         staging_file_identity_json AS stagingFileIdentityJson,
         credential_backend_kind AS credentialBackendKind,
         credential_internal_ref AS credentialInternalRef, envelope_id AS envelopeId,
         recovery_epoch_id AS recoveryEpochId,
         expected_safe_metadata_json AS expectedSafeMetadataJson,
         recovery_file_identity_json AS recoveryFileIdentityJson, phase,
         result_json AS resultJson, failure_code AS failureCode,
         failure_message AS failureMessage, diagnostic_id AS diagnosticId,
         created_at_ms AS createdAtMs, updated_at_ms AS updatedAtMs
       FROM provider_lifecycle_operations
       WHERE phase IN ('validating', 'prepared', 'file_observed')
       ORDER BY updated_at_ms, command_id LIMIT 1000`,
    ).all() as Record<string, unknown>[];
    return rows.map(providerOperationFromRow);
  }

  reconcileSession(inputValue: unknown): ReconcileSessionResult {
    return this.reconcileSessionInternal(inputValue, "generic");
  }

  reconcileCreationSession(inputValue: unknown): ReconcileSessionResult {
    return this.reconcileSessionInternal(inputValue, "creation");
  }

  reconcileValidatedRepairSession(inputValue: unknown): ReconcileSessionResult {
    return this.reconcileSessionInternal(inputValue, "validated-repair");
  }

  private reconcileSessionInternal(
    inputValue: unknown,
    mode: "generic" | "creation" | "validated-repair",
  ): ReconcileSessionResult {
    const input = ReconcileSessionInputSchema.parse(inputValue);
    const manifest: SessionManifest = input.manifest;
    const existing = this.getSession(manifest.sessionId);
    const validatedRepair = mode === "validated-repair";
    if (!validatedRepair) {
      if (existing === null && mode !== "creation") {
        throw new StorageError(
          "storage.corrupt",
          "Generic reconciliation requires an existing ready session",
        );
      }
      if (existing !== null && existing.status !== "ready") {
        return { summary: existing, applied: false };
      }
      if (
        input.expectedCatalogStatus !== "ready" &&
        !(mode === "creation" && existing === null && input.expectedCatalogStatus === null)
      ) {
        if (existing === null) {
          throw new StorageError(
            "storage.corrupt",
            "Creation reconciliation received an invalid catalog status",
          );
        }
        return { summary: existing, applied: false };
      }
    }
    if (existing !== null) {
      const statusChangedDuringInspection = existing.status !== input.expectedCatalogStatus;
      const newerProjectionWon =
        existing.lastEventSequence !== input.expectedCatalogSequence &&
        existing.lastEventSequence > manifest.lastEventSequence;
      if (statusChangedDuringInspection || newerProjectionWon) {
        return { summary: existing, applied: false };
      }
    }

    const summary = this.createSessionIndex({
      sessionId: manifest.sessionId,
      projectId: manifest.projectId,
      dbRelativePath: input.dbRelativePath,
      title: manifest.title,
      status: "ready",
      createdAtMs: manifest.createdAtMs,
      updatedAtMs: input.updatedAtMs,
      lastEventSequence: manifest.lastEventSequence,
      lastRunState: input.lastRunState,
      lastMessagePreview: input.lastMessagePreview,
      requiresAttention: input.pendingApprovalCount > 0 || input.pendingInputCount > 0,
      pendingApprovalCount: input.pendingApprovalCount,
      pendingInputCount: input.pendingInputCount,
      sessionSchemaVersion: manifest.schemaVersion,
      // Only an observation of canonical terminal/no-active state clears a candidate.
      recoveryCandidate: input.recoveryNeeded,
    }, {
      allowPathRepair: true,
      allowReadyPromotion: validatedRepair,
    });
    return { summary, applied: true };
  }
}
