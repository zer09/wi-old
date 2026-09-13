import { mkdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import {
  BrowserSessionSummarySchema,
  ProviderCapabilitiesSnapshotSchema,
  ProviderConnectionIdSchema,
  SessionIdSchema,
  type BrowserSessionSummary,
  type ProviderCapabilitiesSnapshot,
} from "@wi/protocol";

import { SessionStatusCoordinator } from "../common/session-status-coordinator.js";
import { StorageError, WorkerRpcClient } from "../common/worker-rpc.js";
import {
  GlobalCommandRecordSchema,
  EnvironmentConnectionRegistrationSchema,
  FileConnectionReservationSchema,
  GlobalCommandReservationSchema,
  ProjectRecordSchema,
  ProviderCatalogStateSchema,
  ProviderConnectionRecordSchema,
  ProviderLifecycleOperationRecordSchema,
  RecoveredConnectionReservationSchema,
  RecoveryAdmissionSchema,
  SessionSummarySchema,
  type EnvironmentConnectionRegistration,
  type FileConnectionReservation,
  type GlobalCommandRecord,
  type GlobalCommandReservation,
  type ProviderCatalogState,
  type ProviderConnectionRecord,
  type ProviderLifecycleOperationRecord,
  type RecoveredConnectionReservation,
  type RecoveryAdmission,
  type ProjectRecord,
  type SessionCreationRequest,
  type SessionManifest,
  type SessionSummary,
} from "../types.js";
import {
  BoundedSessionListInputSchema,
  CatalogProjectionUpdateResultSchema,
  CatalogRepairPageInputSchema,
  CatalogRepairPageSchema,
  CatalogRepairReasonSchema,
  CompleteProviderLifecycleInputSchema,
  FailOrphanedProviderLifecycleInputSchema,
  FailProviderRecoveryInputSchema,
  FileConnectionReservationResultSchema,
  MarkEnvironmentConnectionUnavailableInputSchema,
  MarkSessionsMissingInputSchema,
  MAXIMUM_BOUNDED_SESSION_LIST_LIMIT,
  MAXIMUM_CATALOG_REPAIR_PAGE_SIZE,
  ObserveProviderLifecycleEffectInputSchema,
  PrepareProviderLifecycleInputSchema,
  ProviderConnectionCommandResultSchema,
  ProviderMetadataCommandResultSchema,
  PutProviderCapabilitiesInputSchema,
  RenameProviderConnectionInputSchema,
  ReconcileSessionResultSchema,
  RepairSessionClassificationInputSchema,
  type CatalogProjectionUpdateResult,
  type CatalogRepairPage,
  type CatalogRepairReason,
  type CreateSessionIndexInput,
  type FileConnectionReservationResult,
  type ProviderConnectionCommandResult,
  type ProviderMetadataCommandResult,
  type FailGlobalCommandInput,
  type MarkSessionStatusInput,
  type ReconcileSessionResult,
  type RepairSessionClassificationInput,
  type SetGlobalCommandQuarantineInput,
  type UpdateSessionProjectionInput,
} from "./repository.js";

export interface CatalogClientOptions {
  readonly homeDirectory: string;
  readonly defaultRequestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onWorkerReplacement?: (replacementCount: number) => void;
  readonly allowRepair?: boolean;
}

export interface CatalogStartupState {
  // Retained only for RPC compatibility; durable repair state is authoritative.
  readonly created: boolean;
  readonly repairReason: CatalogRepairReason | null;
  readonly hasCompletedRepair: boolean;
}

export interface RecoveryCandidateCursor {
  readonly updatedAtMs: number;
  readonly sessionId: string;
}

export interface RecoveryCandidatePage {
  readonly sessionIds: readonly string[];
  readonly nextCursor: RecoveryCandidateCursor | null;
}

export interface ReserveGlobalCommandInput {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly reservedSessionId: string;
  readonly reservedEventId: string;
  readonly request: SessionCreationRequest;
  readonly updatedAtMs: number;
}

export interface CompleteGlobalCommandInput {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly result: unknown;
  readonly acceptedAtMs: number;
}

export interface ReconcileSessionInput {
  readonly manifest: SessionManifest;
  readonly dbRelativePath: string;
  readonly expectedCatalogSequence: number | null;
  readonly expectedCatalogStatus: SessionSummary["status"] | null;
  readonly updatedAtMs: number;
  readonly lastRunState: SessionSummary["lastRunState"];
  readonly lastMessagePreview: SessionSummary["lastMessagePreview"];
  readonly pendingApprovalCount: number;
  readonly pendingInputCount: number;
  readonly recoveryNeeded: boolean;
}

interface SharedCatalogSessionStatusCoordinator {
  readonly coordinator: SessionStatusCoordinator;
  references: number;
}

interface CatalogClientState {
  readonly rpc: WorkerRpcClient;
  readonly homeDirectory: string;
  readonly sharedCoordinator: SharedCatalogSessionStatusCoordinator;
  coordinatorReleased: boolean;
}

const sharedCatalogSessionStatusCoordinators = new Map<
  string,
  SharedCatalogSessionStatusCoordinator
>();
const catalogClients = new WeakMap<CatalogClient, CatalogClientState>();

function canonicalCatalogHomeDirectory(homeDirectory: string): string {
  try {
    const configuredHome = resolve(homeDirectory);
    // A first run has no WI_HOME yet. Create only this bounded directory chain
    // before deriving any worker path or shared coordination identity.
    mkdirSync(configuredHome, { recursive: true, mode: 0o700 });
    const canonicalHome = realpathSync.native(configuredHome);
    if (!statSync(canonicalHome).isDirectory()) {
      throw new Error("Catalog home is not a directory");
    }
    return canonicalHome;
  } catch {
    throw new StorageError("storage.operational", "Catalog storage is unavailable", true);
  }
}

function acquireCatalogSessionStatusCoordinator(
  homeDirectory: string,
): SharedCatalogSessionStatusCoordinator {
  let shared = sharedCatalogSessionStatusCoordinators.get(homeDirectory);
  if (shared === undefined) {
    shared = { coordinator: new SessionStatusCoordinator(), references: 0 };
    sharedCatalogSessionStatusCoordinators.set(homeDirectory, shared);
  }
  shared.references += 1;
  return shared;
}

function releaseCatalogSessionStatusCoordinator(state: CatalogClientState): void {
  if (state.coordinatorReleased) return;
  state.coordinatorReleased = true;
  state.sharedCoordinator.references -= 1;
  if (
    state.sharedCoordinator.references === 0 &&
    sharedCatalogSessionStatusCoordinators.get(state.homeDirectory) === state.sharedCoordinator
  ) {
    sharedCatalogSessionStatusCoordinators.delete(state.homeDirectory);
  }
}

function catalogState(client: CatalogClient): CatalogClientState {
  const state = catalogClients.get(client);
  if (state === undefined) throw new Error("Catalog client is not initialized");
  return state;
}

export function catalogHomeDirectory(client: CatalogClient): string {
  return catalogState(client).homeDirectory;
}

export function catalogSessionStatusCoordinator(
  client: CatalogClient,
): SessionStatusCoordinator {
  return catalogState(client).sharedCoordinator.coordinator;
}

function withCatalogSessionStatusTransition<T>(
  client: CatalogClient,
  sessionIds: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return catalogSessionStatusCoordinator(client).run(sessionIds, operation);
}

function catalogRpc(client: CatalogClient): WorkerRpcClient {
  return catalogState(client).rpc;
}

export class CatalogClient {
  constructor(options: CatalogClientOptions) {
    const homeDirectory = canonicalCatalogHomeDirectory(options.homeDirectory);
    const sharedCoordinator = acquireCatalogSessionStatusCoordinator(homeDirectory);
    try {
      catalogClients.set(this, {
        rpc: new WorkerRpcClient({
          workerId: "catalog",
          entryUrl: new URL("./worker-entry.js", import.meta.url),
          workerData: {
            workerId: "catalog",
            databasePath: resolve(homeDirectory, "catalog.sqlite3"),
            allowRepair: options.allowRepair === true,
          },
          ...(options.defaultRequestTimeoutMs === undefined
            ? {}
            : { defaultRequestTimeoutMs: options.defaultRequestTimeoutMs }),
          ...(options.closeTimeoutMs === undefined
            ? {}
            : { closeTimeoutMs: options.closeTimeoutMs }),
          ...(options.onWorkerReplacement === undefined
            ? {}
            : { onReplacement: options.onWorkerReplacement }),
        }),
        homeDirectory,
        sharedCoordinator,
        coordinatorReleased: false,
      });
    } catch (error) {
      sharedCoordinator.references -= 1;
      if (sharedCoordinator.references === 0) {
        sharedCatalogSessionStatusCoordinators.delete(homeDirectory);
      }
      throw error;
    }
  }

  async prepareOpen(): Promise<void> {
    await catalogRpc(this).request("catalog.prepareOpen", {}, z.null());
  }

  async openPrepared(): Promise<void> {
    await catalogRpc(this).request("catalog.openPrepared", {}, z.null());
  }

  async getStartupState(): Promise<CatalogStartupState> {
    return catalogRpc(this).request(
      "catalog.getStartupState",
      {},
      z.strictObject({
        created: z.boolean(),
        repairReason: z.union([CatalogRepairReasonSchema, z.null()]),
        hasCompletedRepair: z.boolean(),
      }),
    );
  }

  async beginRepair(reason: CatalogRepairReason): Promise<CatalogRepairReason> {
    return catalogRpc(this).request("catalog.beginRepair", { reason }, CatalogRepairReasonSchema, {
      outcome: "write",
    });
  }

  async completeRepair(): Promise<void> {
    await catalogRpc(this).request("catalog.completeRepair", {}, z.null(), { outcome: "write" });
  }

  async repair(): Promise<never> {
    return catalogRpc(this).request("catalog.repair", {}, z.never(), { outcome: "write" });
  }

  async createProject(input: ProjectRecord): Promise<ProjectRecord> {
    return catalogRpc(this).request("catalog.createProject", input, ProjectRecordSchema, {
      outcome: "write",
    });
  }

  async reserveGlobalCommand(
    input: ReserveGlobalCommandInput,
  ): Promise<GlobalCommandReservation> {
    return catalogRpc(this).request(
      "catalog.reserveGlobalCommand",
      input,
      GlobalCommandReservationSchema,
      { outcome: "write" },
    );
  }

  async completeGlobalCommand(input: CompleteGlobalCommandInput): Promise<GlobalCommandRecord> {
    return catalogRpc(this).request(
      "catalog.completeGlobalCommand",
      input,
      GlobalCommandRecordSchema,
      { outcome: "write" },
    );
  }

  async failGlobalCommand(input: FailGlobalCommandInput): Promise<GlobalCommandRecord> {
    return withCatalogSessionStatusTransition(this, [input.session.sessionId], () =>
      catalogRpc(this).request(
        "catalog.failGlobalCommand",
        input,
        GlobalCommandRecordSchema,
        { outcome: "write" },
      ),
    );
  }

  async setGlobalCommandQuarantine(
    input: SetGlobalCommandQuarantineInput,
  ): Promise<GlobalCommandRecord> {
    return catalogRpc(this).request(
      "catalog.setGlobalCommandQuarantine",
      input,
      GlobalCommandRecordSchema,
      { outcome: "write" },
    );
  }

  async getGlobalCommand(commandId: string): Promise<GlobalCommandRecord | null> {
    return catalogRpc(this).request(
      "catalog.getGlobalCommand",
      { commandId },
      z.union([GlobalCommandRecordSchema, z.null()]),
    );
  }

  async listCreatingGlobalCommands(): Promise<readonly GlobalCommandRecord[]> {
    return catalogRpc(this).request(
      "catalog.listCreatingGlobalCommands",
      {},
      z.array(GlobalCommandRecordSchema),
    );
  }

  async createSessionIndex(input: CreateSessionIndexInput): Promise<SessionSummary> {
    return withCatalogSessionStatusTransition(this, [input.sessionId], () =>
      catalogRpc(this).request("catalog.createSessionIndex", input, SessionSummarySchema, {
        outcome: "write",
      }),
    );
  }

  async countSessions(): Promise<number> {
    return catalogRpc(this).request(
      "catalog.countSessions",
      {},
      z.number().int().nonnegative().safe(),
    );
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return catalogRpc(this).request("catalog.listSessions", {}, z.array(SessionSummarySchema));
  }

  async listCatalogRepairPage(afterSessionId: string | null): Promise<CatalogRepairPage> {
    const input = CatalogRepairPageInputSchema.parse({
      afterSessionId,
      limit: MAXIMUM_CATALOG_REPAIR_PAGE_SIZE,
    });
    return catalogRpc(this).request(
      "catalog.listCatalogRepairPage",
      input,
      CatalogRepairPageSchema,
    );
  }

  async markSessionsMissing(
    sessions: readonly { readonly sessionId: string; readonly dbRelativePath: string }[],
  ): Promise<readonly string[]> {
    const input = MarkSessionsMissingInputSchema.parse({ sessions });
    return withCatalogSessionStatusTransition(
      this,
      input.sessions.map((session) => session.sessionId),
      () => catalogRpc(this).request(
        "catalog.markSessionsMissing",
        input,
        z.array(SessionIdSchema).max(MAXIMUM_CATALOG_REPAIR_PAGE_SIZE),
        { outcome: "write" },
      ),
    );
  }

  async listBrowserSessionsBounded(
    limit: number,
  ): Promise<readonly BrowserSessionSummary[]> {
    const input = BoundedSessionListInputSchema.parse({ limit });
    return catalogRpc(this).request(
      "catalog.listBrowserSessionsBounded",
      input,
      z.array(BrowserSessionSummarySchema).max(MAXIMUM_BOUNDED_SESSION_LIST_LIMIT),
    );
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    return catalogRpc(this).request(
      "catalog.getSession",
      { sessionId },
      z.union([SessionSummarySchema, z.null()]),
    );
  }

  async updateSessionProjection(
    input: UpdateSessionProjectionInput,
  ): Promise<CatalogProjectionUpdateResult> {
    return catalogRpc(this).request(
      "catalog.updateSessionProjection",
      input,
      CatalogProjectionUpdateResultSchema,
      { outcome: "write" },
    );
  }

  async listRecoveryCandidatePage(
    cursor: RecoveryCandidateCursor | null = null,
  ): Promise<RecoveryCandidatePage> {
    return catalogRpc(this).request(
      "catalog.listRecoveryCandidates",
      {
        afterUpdatedAtMs: cursor?.updatedAtMs ?? null,
        afterSessionId: cursor?.sessionId ?? null,
        limit: 1_000,
      },
      z.strictObject({
        sessionIds: z.array(SessionIdSchema).max(1_000),
        nextCursor: z
          .strictObject({
            updatedAtMs: z.number().int().nonnegative().safe(),
            sessionId: SessionIdSchema,
          })
          .nullable(),
      }),
    );
  }

  async markRecoveryCandidate(sessionId: string): Promise<void> {
    await catalogRpc(this).request("catalog.markRecoveryCandidate", { sessionId }, z.null(), {
      outcome: "write",
    });
  }

  async markSessionStatus(input: MarkSessionStatusInput): Promise<SessionSummary> {
    return withCatalogSessionStatusTransition(this, [input.sessionId], () =>
      catalogRpc(this).request("catalog.markSessionStatus", input, SessionSummarySchema, {
        outcome: "write",
      }),
    );
  }

  async repairSessionClassification(
    inputValue: RepairSessionClassificationInput,
  ): Promise<SessionSummary> {
    const input = RepairSessionClassificationInputSchema.parse(inputValue);
    return withCatalogSessionStatusTransition(this, [input.sessionId], () =>
      catalogRpc(this).request(
        "catalog.repairSessionClassification",
        input,
        SessionSummarySchema,
        { outcome: "write" },
      ),
    );
  }

  async reconcileSessionWithStatus(
    input: ReconcileSessionInput,
  ): Promise<ReconcileSessionResult> {
    return withCatalogSessionStatusTransition(this, [input.manifest.sessionId], () =>
      catalogRpc(this).request(
        "catalog.reconcileSession",
        input,
        ReconcileSessionResultSchema,
        { outcome: "write" },
      ),
    );
  }

  async reconcileSession(input: ReconcileSessionInput): Promise<SessionSummary> {
    return (await this.reconcileSessionWithStatus(input)).summary;
  }

  async getProviderCatalogState(): Promise<ProviderCatalogState> {
    return catalogRpc(this).request(
      "catalog.getProviderCatalogState",
      {},
      ProviderCatalogStateSchema,
    );
  }

  async setProviderCatalogRecoveryActive(active: boolean): Promise<ProviderCatalogState> {
    return catalogRpc(this).request(
      "catalog.setProviderCatalogRecoveryActive",
      { active },
      ProviderCatalogStateSchema,
      { outcome: "write" },
    );
  }

  async listProviderConnections(limit = 1_001): Promise<{
    readonly connections: readonly ProviderConnectionRecord[];
    readonly catalogRevision: number;
    readonly truncated: boolean;
  }> {
    return catalogRpc(this).request(
      "catalog.listProviderConnections",
      { limit },
      z.strictObject({
        connections: z.array(ProviderConnectionRecordSchema).max(1_000),
        catalogRevision: z.number().int().nonnegative().safe(),
        truncated: z.boolean(),
      }),
    );
  }

  async getProviderConnection(connectionId: string): Promise<ProviderConnectionRecord | null> {
    return catalogRpc(this).request(
      "catalog.getProviderConnection",
      { connectionId: ProviderConnectionIdSchema.parse(connectionId) },
      z.union([ProviderConnectionRecordSchema, z.null()]),
    );
  }

  async registerEnvironmentConnection(
    input: EnvironmentConnectionRegistration,
  ): Promise<ProviderConnectionCommandResult> {
    return catalogRpc(this).request(
      "catalog.registerEnvironmentConnection",
      EnvironmentConnectionRegistrationSchema.parse(input),
      ProviderConnectionCommandResultSchema,
      { outcome: "write" },
    );
  }

  async admitProviderRecovery(
    input: RecoveryAdmission,
  ): Promise<ProviderLifecycleOperationRecord> {
    return catalogRpc(this).request(
      "catalog.admitProviderRecovery",
      RecoveryAdmissionSchema.parse(input),
      ProviderLifecycleOperationRecordSchema,
      { outcome: "write" },
    );
  }

  async failProviderRecovery(
    input: z.input<typeof FailProviderRecoveryInputSchema>,
  ): Promise<ProviderLifecycleOperationRecord> {
    return catalogRpc(this).request(
      "catalog.failProviderRecovery",
      FailProviderRecoveryInputSchema.parse(input),
      ProviderLifecycleOperationRecordSchema,
      { outcome: "write" },
    );
  }

  async failValidatingProviderRecoveries(updatedAtMs: number): Promise<number> {
    return catalogRpc(this).request(
      "catalog.failValidatingProviderRecoveries",
      { updatedAtMs },
      z.number().int().nonnegative().safe(),
      { outcome: "write" },
    );
  }

  async reserveRecoveredProviderConnection(
    input: RecoveredConnectionReservation,
  ): Promise<ProviderConnectionCommandResult> {
    return catalogRpc(this).request(
      "catalog.reserveRecoveredProviderConnection",
      RecoveredConnectionReservationSchema.parse(input),
      ProviderConnectionCommandResultSchema,
      { outcome: "write" },
    );
  }

  async reserveFileProviderConnection(
    input: FileConnectionReservation,
  ): Promise<FileConnectionReservationResult> {
    return catalogRpc(this).request(
      "catalog.reserveFileProviderConnection",
      FileConnectionReservationSchema.parse(input),
      FileConnectionReservationResultSchema,
      { outcome: "write" },
    );
  }

  async prepareProviderLifecycle(
    input: z.input<typeof PrepareProviderLifecycleInputSchema>,
  ): Promise<ProviderConnectionCommandResult> {
    return catalogRpc(this).request(
      "catalog.prepareProviderLifecycle",
      PrepareProviderLifecycleInputSchema.parse(input),
      ProviderConnectionCommandResultSchema,
      { outcome: "write" },
    );
  }

  async disableProviderConnection(
    input: z.input<typeof PrepareProviderLifecycleInputSchema>,
  ): Promise<ProviderConnectionCommandResult> {
    return catalogRpc(this).request(
      "catalog.disableProviderConnection",
      PrepareProviderLifecycleInputSchema.parse(input),
      ProviderConnectionCommandResultSchema,
      { outcome: "write" },
    );
  }

  async observeProviderLifecycleEffect(
    input: z.input<typeof ObserveProviderLifecycleEffectInputSchema>,
  ): Promise<ProviderLifecycleOperationRecord> {
    return catalogRpc(this).request(
      "catalog.observeProviderLifecycleEffect",
      ObserveProviderLifecycleEffectInputSchema.parse(input),
      ProviderLifecycleOperationRecordSchema,
      { outcome: "write" },
    );
  }

  async failOrphanedProviderLifecycle(
    input: z.input<typeof FailOrphanedProviderLifecycleInputSchema>,
  ): Promise<ProviderLifecycleOperationRecord> {
    return catalogRpc(this).request(
      "catalog.failOrphanedProviderLifecycle",
      FailOrphanedProviderLifecycleInputSchema.parse(input),
      ProviderLifecycleOperationRecordSchema,
      { outcome: "write" },
    );
  }

  async completeProviderLifecycle(
    input: z.input<typeof CompleteProviderLifecycleInputSchema>,
  ): Promise<ProviderConnectionCommandResult> {
    return catalogRpc(this).request(
      "catalog.completeProviderLifecycle",
      CompleteProviderLifecycleInputSchema.parse(input),
      ProviderConnectionCommandResultSchema,
      { outcome: "write" },
    );
  }

  async hasProviderMetadataCommand(commandId: string): Promise<boolean> {
    return catalogRpc(this).request(
      "catalog.hasProviderMetadataCommand",
      { commandId },
      z.boolean(),
    );
  }

  async getProviderLifecycleOperation(
    commandId: string,
  ): Promise<ProviderLifecycleOperationRecord | null> {
    return catalogRpc(this).request(
      "catalog.getProviderLifecycleOperation",
      { commandId },
      z.union([ProviderLifecycleOperationRecordSchema, z.null()]),
    );
  }

  async isProvisioningClaimActive(provisioningId: string): Promise<boolean> {
    return catalogRpc(this).request(
      "catalog.isProvisioningClaimActive",
      { provisioningId },
      z.boolean(),
    );
  }

  async markProviderStageCleaned(stagingInternalRef: string): Promise<void> {
    await catalogRpc(this).request(
      "catalog.markProviderStageCleaned",
      { stagingInternalRef },
      z.null(),
      { outcome: "write" },
    );
  }

  async listTerminalProviderStages(): Promise<readonly string[]> {
    return catalogRpc(this).request(
      "catalog.listTerminalProviderStages",
      {},
      z.array(z.string().regex(/^stage_[a-f0-9]{64}$/u)).max(1_000),
    );
  }

  async listPreparedProviderOperations(): Promise<readonly ProviderLifecycleOperationRecord[]> {
    return catalogRpc(this).request(
      "catalog.listPreparedProviderOperations",
      {},
      z.array(ProviderLifecycleOperationRecordSchema).max(1_000),
    );
  }

  async markEnvironmentConnectionUnavailable(
    input: z.input<typeof MarkEnvironmentConnectionUnavailableInputSchema>,
  ): Promise<ProviderConnectionRecord> {
    return catalogRpc(this).request(
      "catalog.markEnvironmentConnectionUnavailable",
      MarkEnvironmentConnectionUnavailableInputSchema.parse(input),
      ProviderConnectionRecordSchema,
      { outcome: "write" },
    );
  }

  async renameProviderConnection(
    input: z.input<typeof RenameProviderConnectionInputSchema>,
  ): Promise<ProviderMetadataCommandResult> {
    return catalogRpc(this).request(
      "catalog.renameProviderConnection",
      RenameProviderConnectionInputSchema.parse(input),
      ProviderMetadataCommandResultSchema,
      { outcome: "write" },
    );
  }

  async putProviderCapabilities(
    input: z.input<typeof PutProviderCapabilitiesInputSchema>,
  ): Promise<ProviderConnectionRecord> {
    return catalogRpc(this).request(
      "catalog.putProviderCapabilities",
      PutProviderCapabilitiesInputSchema.parse(input),
      ProviderConnectionRecordSchema,
      { outcome: "write" },
    );
  }

  async getProviderCapabilities(connectionId: string): Promise<ProviderCapabilitiesSnapshot | null> {
    return catalogRpc(this).request(
      "catalog.getProviderCapabilities",
      { connectionId: ProviderConnectionIdSchema.parse(connectionId) },
      z.union([ProviderCapabilitiesSnapshotSchema, z.null()]),
    );
  }

  async close(deadlineAtMs?: number): Promise<void> {
    const state = catalogState(this);
    try {
      await state.rpc.close(deadlineAtMs);
    } finally {
      releaseCatalogSessionStatusCoordinator(state);
    }
  }
}

export function reconcileCreationSession(
  catalog: CatalogClient,
  input: ReconcileSessionInput,
): Promise<ReconcileSessionResult> {
  return withCatalogSessionStatusTransition(catalog, [input.manifest.sessionId], () =>
    catalogRpc(catalog).request(
      "catalog.reconcileCreationSession",
      input,
      ReconcileSessionResultSchema,
      { outcome: "write" },
    ),
  );
}

export function reconcileValidatedRepairSession(
  catalog: CatalogClient,
  input: ReconcileSessionInput,
): Promise<ReconcileSessionResult> {
  return withCatalogSessionStatusTransition(catalog, [input.manifest.sessionId], () =>
    catalogRpc(catalog).request(
      "catalog.reconcileValidatedRepairSession",
      input,
      ReconcileSessionResultSchema,
      { outcome: "write" },
    ),
  );
}
