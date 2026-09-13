import { availableParallelism } from "node:os";

import { z } from "zod";

import { SessionEventSchema, SessionIdSchema } from "@wi/protocol";

import {
  StorageError,
  WorkerRpcClient,
  type WorkerRequestOutcome,
} from "../common/worker-rpc.js";
import { stableSessionWorkerIndex } from "../manager/paths.js";
import {
  AcceptedCommandResultSchema,
  AppendTransactionInspectionSchema,
  AppendTransactionResultSchema,
  BoundedProviderRequestDataSchema,
  InputRecordSchema,
  PendingApprovalRecordSchema,
  PendingInputRecordSchema,
  ProviderStepRecordSchema,
  RunMessageRecordSchema,
  RunProviderMatchSchema,
  RunRecordSchema,
  ToolExecutionRecordSchema,
  SessionCatalogObservationSchema,
  SessionEventPageSchema,
  SessionCatalogProjectionSchema,
  SessionManifestSchema,
  SessionProviderDefaultRecordSchema,
  SessionRecoveryResultSchema,
  CreationProvenanceSchema,
  type AcceptCommandInput,
  type AcceptedCommandResult,
  type AppendTransactionInput,
  type AppendTransactionInspection,
  type AppendTransactionResult,
  type BoundedProviderRequestData,
  type BoundedProviderRequestDataInput,
  type InputRecord,
  type PendingApprovalRecord,
  type PendingInputRecord,
  type ProviderStepRecord,
  type RunMessageRecord,
  type RunRecord,
  type ToolExecutionRecord,
  type SessionCatalogObservation,
  type SessionEventPage,
  type SessionEventPageInput,
  type SessionCatalogProjection,
  type SessionManifest,
  type SessionProviderDefaultRecord,
  type SessionRecoveryResult,
  type CreationProvenance,
} from "../types.js";
import {
  SessionClient,
  type SessionCommitExecutor,
  type SessionUseExecutor,
} from "./client.js";
import {
  DISCOVERY_ERROR_CODE_MAXIMUM_UNITS,
  DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS,
} from "./discovery-limits.js";

export interface SessionWorkerPoolOptions {
  readonly size?: number;
  readonly maxOpenHandlesPerWorker?: number;
  readonly allowTestOperations?: boolean;
  readonly defaultRequestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onWorkerReplacement?: (workerIndex: number, replacementCount: number) => void;
  readonly onSessionError?: (sessionId: string, error: unknown) => void | Promise<void>;
}

export interface InitializeSessionInput {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly createdAtMs: number;
  readonly eventId: string;
  readonly creation?: CreationProvenance;
}

export interface SessionWorkerStats {
  readonly workerIndex: number;
  readonly openSessionIds: readonly string[];
}

export interface SessionWorkerBarrier {
  readonly release: () => Promise<void>;
}

const DiscoveredSessionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("valid"),
    sessionId: SessionIdSchema,
    manifest: SessionManifestSchema,
    observation: SessionCatalogObservationSchema,
    creationProvenance: z.union([CreationProvenanceSchema, z.null()]),
  }),
  z.strictObject({
    kind: z.literal("corrupt"),
    sessionId: SessionIdSchema,
    code: z.string().min(1).max(DISCOVERY_ERROR_CODE_MAXIMUM_UNITS),
    message: z.string().max(DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS).optional(),
  }),
  z.strictObject({
    kind: z.literal("transient"),
    sessionId: SessionIdSchema,
    code: z.string().min(1).max(DISCOVERY_ERROR_CODE_MAXIMUM_UNITS),
    message: z.string().max(DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS).optional(),
  }),
  z.strictObject({
    kind: z.literal("oversized"),
    sessionId: SessionIdSchema,
    code: z.literal("storage.resource_limit"),
    message: z.string().max(DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS).optional(),
  }),
  z.strictObject({
    kind: z.literal("unsupported"),
    sessionId: SessionIdSchema,
    code: z.literal("storage.migration_failed"),
    message: z.string().max(DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS).optional(),
    schemaVersion: z.number().int().positive().safe(),
  }),
  z.strictObject({
    kind: z.literal("missing"),
    sessionId: SessionIdSchema,
    code: z.literal("storage.session_missing"),
    message: z.string().max(DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS).optional(),
  }),
]);

export type DiscoveredSession = z.infer<typeof DiscoveredSessionSchema>;

export interface SessionDiscoveryInventory {
  readonly sessionIds: readonly string[];
  readonly inspectedEntries: number;
  readonly ignoredEntries: number;
}

export interface SessionDiscoveryPage {
  readonly records: readonly DiscoveredSession[];
  readonly processedCount: number;
}

export interface SessionSqlitePragmas {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly trustedSchema: number;
  readonly sqliteVersion: string;
}

function defaultPoolSize(): number {
  return Math.min(4, Math.max(2, availableParallelism() - 1));
}

export class SessionWorkerPool {
  readonly size: number;
  private readonly workers: readonly WorkerRpcClient[];
  private readonly paths = new Map<string, string>();
  private readonly activeCommitOperations = new Set<Promise<void>>();
  private readonly allowTestOperations: boolean;
  private acceptingCommits = true;
  private closePromise: Promise<void> | null = null;
  private readonly onSessionError:
    | ((sessionId: string, error: unknown) => void | Promise<void>)
    | undefined;

  constructor(options: SessionWorkerPoolOptions = {}) {
    this.size = options.size ?? defaultPoolSize();
    if (!Number.isSafeInteger(this.size) || this.size < 1) {
      throw new RangeError("Session worker pool size must be a positive safe integer");
    }
    const maxOpenHandles = options.maxOpenHandlesPerWorker ?? 32;
    if (!Number.isSafeInteger(maxOpenHandles) || maxOpenHandles < 1) {
      throw new RangeError("Session worker handle limit must be a positive safe integer");
    }
    this.allowTestOperations =
      options.allowTestOperations === true && process.env.NODE_ENV === "test";
    const allowTestFailpoints =
      this.allowTestOperations && process.env.WI_ALLOW_TEST_FAILPOINTS === "1";
    this.onSessionError = options.onSessionError;
    const workers: WorkerRpcClient[] = [];
    try {
      for (let workerIndex = 0; workerIndex < this.size; workerIndex += 1) {
        workers.push(
          new WorkerRpcClient({
            workerId: `session-${workerIndex}`,
            entryUrl: new URL("./worker-entry.js", import.meta.url),
            workerData: {
              workerId: `session-${workerIndex}`,
              maxOpenHandles,
              allowTestOperations: this.allowTestOperations,
              allowTestFailpoints,
            },
            ...(options.defaultRequestTimeoutMs === undefined
              ? {}
              : { defaultRequestTimeoutMs: options.defaultRequestTimeoutMs }),
            ...(options.closeTimeoutMs === undefined
              ? {}
              : { closeTimeoutMs: options.closeTimeoutMs }),
            ...(options.onWorkerReplacement === undefined
              ? {}
              : {
                  onReplacement: (replacementCount) =>
                    options.onWorkerReplacement?.(workerIndex, replacementCount),
                }),
          }),
        );
      }
    } catch (error) {
      for (const worker of workers) void worker.close().catch(() => undefined);
      throw error;
    }
    this.workers = workers;
  }

  async discoverSessionInventory(
    homeDirectory: string,
    maximumSessions = 1_000,
  ): Promise<SessionDiscoveryInventory> {
    if (!Number.isSafeInteger(maximumSessions) || maximumSessions < 1 || maximumSessions > 10_000) {
      throw new RangeError("Session discovery limit must be between 1 and 10000");
    }
    const worker = this.workers[0];
    if (worker === undefined) throw new Error("Session discovery requires a worker");
    return worker.request(
      "session.discoverInventory",
      { homeDirectory, maximumSessions },
      z.strictObject({
        sessionIds: z.array(SessionIdSchema).max(maximumSessions),
        inspectedEntries: z.number().int().nonnegative().safe(),
        ignoredEntries: z.number().int().nonnegative().safe(),
      }),
      { timeoutMs: Math.min(120_000, Math.max(10_000, maximumSessions * 250)) },
    );
  }

  async discoverSessionPage(
    homeDirectory: string,
    sessionIds: readonly string[],
    startIndex: number,
  ): Promise<SessionDiscoveryPage> {
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= sessionIds.length) {
      throw new RangeError("Session discovery page index is outside the inventory");
    }
    const worker = this.workers[0];
    if (worker === undefined) throw new Error("Session discovery requires a worker");
    const candidates = sessionIds.slice(startIndex, startIndex + 64);
    return worker.request(
      "session.discoverPage",
      { homeDirectory, sessionIds: candidates },
      z.strictObject({
        records: z.array(DiscoveredSessionSchema).min(1).max(candidates.length),
        processedCount: z.number().int().positive().max(candidates.length),
      }),
      { timeoutMs: 120_000 },
    );
  }

  workerIndexFor(sessionId: string): number {
    return stableSessionWorkerIndex(sessionId, this.size);
  }

  registerSession(
    sessionId: string,
    databasePath: string,
    executeUse?: SessionUseExecutor,
    afterCommit?: (
      events: readonly z.infer<typeof SessionEventSchema>[],
      headSequence: number,
    ) => void,
    executeCommit?: SessionCommitExecutor,
  ): SessionClient {
    const existing = this.paths.get(sessionId);
    if (existing !== undefined && existing !== databasePath) {
      throw new Error("Session database path cannot change within a pool");
    }
    this.paths.set(sessionId, databasePath);
    return new SessionClient(this, sessionId, executeUse, afterCommit, executeCommit);
  }

  session(sessionId: string): SessionClient {
    if (!this.paths.has(sessionId)) throw new Error(`Session ${sessionId} is not registered`);
    return new SessionClient(this, sessionId);
  }

  private location(sessionId: string): { sessionId: string; databasePath: string } {
    const databasePath = this.paths.get(sessionId);
    if (databasePath === undefined) throw new Error(`Session ${sessionId} is not registered`);
    return { sessionId, databasePath };
  }

  private worker(sessionId: string): WorkerRpcClient {
    const worker = this.workers[this.workerIndexFor(sessionId)];
    if (worker === undefined) throw new Error("Stable routing selected a missing worker");
    return worker;
  }

  private async request<T>(
    sessionId: string,
    operation: string,
    payload: object,
    resultSchema: z.ZodType<T>,
    outcome: WorkerRequestOutcome = "read",
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.worker(sessionId).request(
        operation,
        { ...this.location(sessionId), ...payload },
        resultSchema,
        { outcome, ...(signal === undefined ? {} : { signal }) },
      );
    } catch (error) {
      if (!(error instanceof StorageError && error.code === "storage.request_aborted")) {
        try {
          await this.onSessionError?.(sessionId, error);
        } catch {
          // Preserve the operation error even if diagnostic catalog handling fails.
        }
      }
      throw error;
    }
  }

  async initialize(input: InitializeSessionInput, databasePath: string): Promise<{
    manifest: SessionManifest;
    events: readonly z.infer<typeof SessionEventSchema>[];
  }> {
    this.registerSession(input.sessionId, databasePath);
    return this.request(
      input.sessionId,
      "session.initialize",
      input,
      z.strictObject({ manifest: SessionManifestSchema, events: z.array(SessionEventSchema) }),
      "write",
    );
  }

  async getManifest(sessionId: string): Promise<SessionManifest> {
    return this.request(sessionId, "session.getManifest", {}, SessionManifestSchema);
  }

  stopAcceptingCommits(): void {
    this.acceptingCommits = false;
  }

  private async runCommitOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acceptingCommits) {
      throw new StorageError("storage.worker_failed", "Session worker pool is closing");
    }
    const running = operation();
    const completion = running.then(
      () => undefined,
      () => undefined,
    );
    this.activeCommitOperations.add(completion);
    try {
      return await running;
    } finally {
      this.activeCommitOperations.delete(completion);
    }
  }

  private async drainCommitOperations(deadlineAtMs?: number): Promise<void> {
    while (this.activeCommitOperations.size > 0) {
      const drain = Promise.all(this.activeCommitOperations);
      if (deadlineAtMs === undefined) {
        await drain;
        continue;
      }
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) {
        throw new StorageError("storage.worker_timeout", "Session commit drain exceeded shutdown deadline", true);
      }
      await Promise.race([
        drain,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new StorageError("storage.worker_timeout", "Session commit drain exceeded shutdown deadline", true)), remaining);
          timer.unref();
        }),
      ]);
    }
  }

  async acceptCommand(
    sessionId: string,
    input: AcceptCommandInput,
  ): Promise<AcceptedCommandResult> {
    return this.runCommitOperation(() =>
      this.request(
        sessionId,
        "session.acceptCommand",
        { input },
        AcceptedCommandResultSchema,
        "write",
      ),
    );
  }

  async appendTransaction(
    sessionId: string,
    input: AppendTransactionInput,
  ): Promise<AppendTransactionResult> {
    return this.runCommitOperation(() =>
      this.request(
        sessionId,
        "session.appendTransaction",
        { input },
        AppendTransactionResultSchema,
        "write",
      ),
    );
  }

  async inspectAppendTransaction(
    sessionId: string,
    input: AppendTransactionInput,
  ): Promise<AppendTransactionInspection> {
    return this.request(
      sessionId,
      "session.inspectAppendTransaction",
      { input },
      AppendTransactionInspectionSchema,
    );
  }

  async getEventsAfter(
    sessionId: string,
    afterSequence: number,
    throughSequence?: number,
  ): Promise<readonly z.infer<typeof SessionEventSchema>[]> {
    const payload =
      throughSequence === undefined ? { afterSequence } : { afterSequence, throughSequence };
    return this.request(
      sessionId,
      "session.getEventsAfter",
      payload,
      z.array(SessionEventSchema),
    );
  }

  async getEventPageAfter(
    sessionId: string,
    input: SessionEventPageInput,
    signal?: AbortSignal,
  ): Promise<SessionEventPage> {
    return this.request(
      sessionId,
      "session.getEventPageAfter",
      { input },
      SessionEventPageSchema,
      "read",
      signal,
    );
  }

  async getHeadSequence(sessionId: string, signal?: AbortSignal): Promise<number> {
    return this.request(
      sessionId,
      "session.getHeadSequence",
      {},
      z.number().int().nonnegative().safe(),
      "read",
      signal,
    );
  }

  async getEventById(
    sessionId: string,
    eventId: string,
  ): Promise<z.infer<typeof SessionEventSchema> | null> {
    return this.request(
      sessionId,
      "session.getEventById",
      { eventId },
      z.union([SessionEventSchema, z.null()]),
    );
  }

  async getRun(sessionId: string, runId: string): Promise<RunRecord | null> {
    return this.request(
      sessionId,
      "session.getRun",
      { runId },
      z.union([RunRecordSchema, z.null()]),
    );
  }

  async getProviderDefault(sessionId: string): Promise<SessionProviderDefaultRecord | null> {
    return this.request(
      sessionId,
      "session.getProviderDefault",
      {},
      z.union([SessionProviderDefaultRecordSchema, z.null()]),
    );
  }

  async getRunProviderMatch(
    sessionId: string,
    runId: string,
    expectedProviderId: string,
  ): Promise<"missing" | "match" | "mismatch"> {
    return this.request(
      sessionId,
      "session.getRunProviderMatch",
      { runId, expectedProviderId },
      RunProviderMatchSchema,
    );
  }

  async getBoundedProviderRequestData(
    sessionId: string,
    input: BoundedProviderRequestDataInput,
  ): Promise<BoundedProviderRequestData> {
    return this.request(
      sessionId,
      "session.getBoundedProviderRequestData",
      { input },
      BoundedProviderRequestDataSchema,
    );
  }

  async getAcceptedCommand(
    sessionId: string,
    commandId: string,
  ): Promise<AcceptedCommandResult | null> {
    return this.request(
      sessionId,
      "session.getAcceptedCommand",
      { commandId },
      z.union([AcceptedCommandResultSchema, z.null()]),
    );
  }

  async getProviderStep(sessionId: string, stepId: string): Promise<ProviderStepRecord | null> {
    return this.request(
      sessionId,
      "session.getProviderStep",
      { stepId },
      z.union([ProviderStepRecordSchema, z.null()]),
    );
  }

  async getProviderStepsForRun(
    sessionId: string,
    runId: string,
  ): Promise<readonly ProviderStepRecord[]> {
    return this.request(
      sessionId,
      "session.getProviderStepsForRun",
      { runId },
      z.array(ProviderStepRecordSchema),
    );
  }

  async getRecentProviderStepsForRun(
    sessionId: string,
    runId: string,
    limit: number,
  ): Promise<readonly ProviderStepRecord[]> {
    return this.request(
      sessionId,
      "session.getRecentProviderStepsForRun",
      { runId, limit },
      z.array(ProviderStepRecordSchema).max(1024),
    );
  }

  async getToolExecution(sessionId: string, callId: string): Promise<ToolExecutionRecord | null> {
    return this.request(
      sessionId,
      "session.getToolExecution",
      { callId },
      z.union([ToolExecutionRecordSchema, z.null()]),
    );
  }

  async getToolExecutionsForStep(
    sessionId: string,
    stepId: string,
  ): Promise<readonly ToolExecutionRecord[]> {
    return this.request(
      sessionId,
      "session.getToolExecutionsForStep",
      { stepId },
      z.array(ToolExecutionRecordSchema),
    );
  }

  async getToolExecutionsForRun(
    sessionId: string,
    runId: string,
  ): Promise<readonly ToolExecutionRecord[]> {
    return this.request(
      sessionId,
      "session.getToolExecutionsForRun",
      { runId },
      z.array(ToolExecutionRecordSchema),
    );
  }

  async getRunMessages(sessionId: string, runId: string): Promise<readonly RunMessageRecord[]> {
    return this.request(
      sessionId,
      "session.getRunMessages",
      { runId },
      z.array(RunMessageRecordSchema),
    );
  }

  async getStreamingMessagesForStep(
    sessionId: string,
    stepId: string,
  ): Promise<readonly RunMessageRecord[]> {
    return this.request(
      sessionId,
      "session.getStreamingMessagesForStep",
      { stepId },
      z.array(RunMessageRecordSchema),
    );
  }

  async getNonterminalRuns(sessionId: string): Promise<readonly RunRecord[]> {
    return this.request(
      sessionId,
      "session.getNonterminalRuns",
      {},
      z.array(RunRecordSchema),
    );
  }

  async getCatalogProjection(sessionId: string): Promise<SessionCatalogProjection> {
    return this.request(
      sessionId,
      "session.getCatalogProjection",
      {},
      SessionCatalogProjectionSchema,
    );
  }

  async getCatalogObservation(sessionId: string): Promise<SessionCatalogObservation> {
    return this.request(
      sessionId,
      "session.getCatalogObservation",
      {},
      SessionCatalogObservationSchema,
    );
  }

  async getPendingApprovals(sessionId: string): Promise<readonly PendingApprovalRecord[]> {
    return this.request(
      sessionId,
      "session.getPendingApprovals",
      {},
      z.array(PendingApprovalRecordSchema),
    );
  }

  async getPendingInputs(sessionId: string): Promise<readonly PendingInputRecord[]> {
    return this.request(
      sessionId,
      "session.getPendingInputs",
      {},
      z.array(PendingInputRecordSchema),
    );
  }

  async getInput(sessionId: string, inputId: string): Promise<InputRecord | null> {
    return this.request(
      sessionId,
      "session.getInput",
      { inputId },
      z.union([InputRecordSchema, z.null()]),
    );
  }

  async getPendingInputCount(sessionId: string): Promise<number> {
    return this.request(
      sessionId,
      "session.getPendingInputCount",
      {},
      z.number().int().nonnegative().safe(),
    );
  }

  async recover(sessionId: string): Promise<SessionRecoveryResult> {
    return this.request(sessionId, "session.recover", {}, SessionRecoveryResultSchema);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request(sessionId, "session.close", {}, z.null());
  }

  async getStats(): Promise<readonly SessionWorkerStats[]> {
    return Promise.all(
      this.workers.map(async (worker, workerIndex) => {
        const result = await worker.request(
          "session.getStats",
          {},
          z.strictObject({ openSessionIds: z.array(z.string()) }),
        );
        return { workerIndex, openSessionIds: result.openSessionIds };
      }),
    );
  }

  async initializeSchemaOnlyForTest(sessionId: string, databasePath: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    this.registerSession(sessionId, databasePath);
    await this.request(sessionId, "session.testInitializeSchemaOnly", {}, z.null());
  }

  async getProjectionIdentityForTest(
    sessionId: string,
    kind: "run" | "message" | "messagePart" | "providerStep" | "toolExecution" | "approval" | "input",
    id: string,
  ): Promise<Readonly<Record<string, string | number | null>>> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    return this.request(
      sessionId,
      "session.testGetProjectionIdentity",
      { kind, id },
      z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
    );
  }

  async getPragmasForTest(sessionId: string): Promise<SessionSqlitePragmas> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    return this.request(
      sessionId,
      "session.testGetPragmas",
      {},
      z.strictObject({
        journalMode: z.string(),
        synchronous: z.number().int(),
        foreignKeys: z.number().int(),
        busyTimeout: z.number().int(),
        trustedSchema: z.number().int(),
        sqliteVersion: z.string(),
      }),
    );
  }

  async malformedResponseForTest(sessionId: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testMalformedResponse", {}, z.null());
  }

  async malformedResultForTest(sessionId: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testMalformedResult", {}, z.null());
  }

  async blockWorkerForTest(sessionId: string): Promise<SessionWorkerBarrier> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const view = new Int32Array(barrier);
    const request = this.request(sessionId, "session.testBarrier", { barrier }, z.null());
    // Observe rejection immediately so shutdown can reject the blocked RPC
    // without creating an unhandled-rejection process exit in the test fixture.
    const observedRequest = request.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const deadline = Date.now() + 5_000;
    while (Atomics.load(view, 0) < 1) {
      if (Date.now() >= deadline) {
        Atomics.store(view, 1, 1);
        Atomics.notify(view, 1);
        await observedRequest;
        throw new Error("Session worker did not reach the barrier");
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        Atomics.store(view, 1, 1);
        Atomics.notify(view, 1);
        const outcome = await observedRequest;
        if (!outcome.ok) throw outcome.error;
      },
    };
  }

  async proveConcurrentWorkersForTest(sessionIds: readonly string[]): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    const workerIndices = new Set(sessionIds.map((sessionId) => this.workerIndexFor(sessionId)));
    if (workerIndices.size !== sessionIds.length) {
      throw new Error("Barrier sessions must route to different workers");
    }

    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const view = new Int32Array(barrier);
    const requests = sessionIds.map((sessionId) =>
      this.request(sessionId, "session.testBarrier", { barrier }, z.null()),
    );
    const deadline = Date.now() + 5_000;
    while (Atomics.load(view, 0) < sessionIds.length) {
      if (Date.now() >= deadline) {
        Atomics.store(view, 1, 1);
        Atomics.notify(view, 1, sessionIds.length);
        await Promise.allSettled(requests);
        throw new Error("Session workers did not reach the barrier");
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    Atomics.store(view, 1, 1);
    Atomics.notify(view, 1, sessionIds.length);
    await Promise.all(requests);
  }

  async corruptManifestForTest(sessionId: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testCorruptManifest", {}, z.null());
  }

  async testMutateEvent(
    sessionId: string,
    action: "update" | "delete",
    sequence: number,
  ): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testMutateEvent", { action, sequence }, z.null());
  }

  async crashWorkerForTest(sessionId: string): Promise<void> {
    if (!this.allowTestOperations) throw new Error("Test operations are disabled");
    await this.request(sessionId, "session.testCrashWorker", {}, z.null());
  }

  private async finishClose(deadlineAtMs?: number): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.drainCommitOperations(deadlineAtMs);
    } catch (error) {
      errors.push(error);
    }
    // Force every worker boundary even when draining commits timed out. This
    // prevents an abandoned write from keeping subsequent storage cleanup open.
    const results = await Promise.allSettled(this.workers.map((worker) => worker.close(deadlineAtMs)));
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    if (errors.length > 0) throw new AggregateError(errors, "Session worker shutdown failed");
  }

  close(deadlineAtMs?: number): Promise<void> {
    this.stopAcceptingCommits();
    this.closePromise ??= this.finishClose(deadlineAtMs);
    return this.closePromise;
  }
}
