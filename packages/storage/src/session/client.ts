import type { SessionEvent } from "@wi/protocol";

import type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionInspection,
  AppendTransactionResult,
  BoundedProviderRequestData,
  BoundedProviderRequestDataInput,
  InputRecord,
  PendingApprovalRecord,
  PendingInputRecord,
  ProviderStepRecord,
  RunMessageRecord,
  RunRecord,
  ToolExecutionRecord,
  SessionCatalogProjection,
  SessionEventPage,
  SessionEventPageInput,
  SessionManifest,
  SessionProviderDefaultRecord,
  SessionRecoveryResult,
} from "../types.js";
import type { SessionWorkerPool } from "./worker-pool.js";

export type SessionUseExecutor = <T>(operation: () => Promise<T>) => Promise<T>;
export type SessionCommitExecutor = <T>(
  input: AcceptCommandInput | AppendTransactionInput,
  operation: () => Promise<T>,
) => Promise<T>;

export class SessionClient {
  readonly #pool: SessionWorkerPool;
  readonly #executeUse: SessionUseExecutor | undefined;
  readonly #afterCommit:
    | ((events: readonly SessionEvent[], headSequence: number) => void)
    | undefined;
  readonly #executeCommit: SessionCommitExecutor | undefined;

  constructor(
    pool: SessionWorkerPool,
    readonly sessionId: string,
    executeUse?: SessionUseExecutor,
    afterCommit?: (events: readonly SessionEvent[], headSequence: number) => void,
    executeCommit?: SessionCommitExecutor,
  ) {
    this.#pool = pool;
    this.#executeUse = executeUse;
    this.#afterCommit = afterCommit;
    this.#executeCommit = executeCommit;
  }

  private runUse<T>(operation: () => Promise<T>): Promise<T> {
    return this.#executeUse === undefined ? operation() : this.#executeUse(operation);
  }

  private runCommit<T>(
    input: AcceptCommandInput | AppendTransactionInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#executeCommit === undefined ? operation() : this.#executeCommit(input, operation);
  }

  private observeCommit(events: readonly SessionEvent[], headSequence: number): void {
    try {
      this.#afterCommit?.(events, headSequence);
    } catch {
      // The session commit is already durable; later reconciliation can repair observation.
    }
  }

  getManifest(): Promise<SessionManifest> {
    return this.runUse(() => this.#pool.getManifest(this.sessionId));
  }

  async acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult> {
    const result = await this.runCommit(input, () =>
      this.#pool.acceptCommand(this.sessionId, input),
    );
    this.observeCommit(result.events, result.acceptedSequence ?? 0);
    return result;
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult> {
    const result = await this.runCommit(input, () =>
      this.#pool.appendTransaction(this.sessionId, input),
    );
    this.observeCommit(result.events, result.headSequence);
    return result;
  }

  inspectAppendTransaction(
    input: AppendTransactionInput,
  ): Promise<AppendTransactionInspection> {
    return this.runUse(() => this.#pool.inspectAppendTransaction(this.sessionId, input));
  }

  getEventsAfter(
    afterSequence: number,
    throughSequence?: number,
  ): Promise<readonly SessionEvent[]> {
    return this.runUse(() =>
      this.#pool.getEventsAfter(this.sessionId, afterSequence, throughSequence),
    );
  }

  async getEventPageAfter(
    input: SessionEventPageInput,
    signal?: AbortSignal,
  ): Promise<SessionEventPage> {
    signal?.throwIfAborted();
    return this.runUse(() => {
      signal?.throwIfAborted();
      return this.#pool.getEventPageAfter(this.sessionId, input, signal);
    });
  }

  async getHeadSequence(signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    return this.runUse(() => {
      signal?.throwIfAborted();
      return this.#pool.getHeadSequence(this.sessionId, signal);
    });
  }

  getEventById(eventId: string): Promise<SessionEvent | null> {
    return this.runUse(() => this.#pool.getEventById(this.sessionId, eventId));
  }

  getRun(runId: string): Promise<RunRecord | null> {
    return this.runUse(() => this.#pool.getRun(this.sessionId, runId));
  }

  getProviderDefault(): Promise<SessionProviderDefaultRecord | null> {
    return this.runUse(() => this.#pool.getProviderDefault(this.sessionId));
  }

  getRunProviderMatch(
    runId: string,
    expectedProviderId: string,
  ): Promise<"missing" | "match" | "mismatch"> {
    return this.runUse(() =>
      this.#pool.getRunProviderMatch(this.sessionId, runId, expectedProviderId),
    );
  }

  getBoundedProviderRequestData(
    input: BoundedProviderRequestDataInput,
  ): Promise<BoundedProviderRequestData> {
    return this.runUse(() => this.#pool.getBoundedProviderRequestData(this.sessionId, input));
  }

  getAcceptedCommand(commandId: string): Promise<AcceptedCommandResult | null> {
    return this.runUse(() => this.#pool.getAcceptedCommand(this.sessionId, commandId));
  }

  getProviderStep(stepId: string): Promise<ProviderStepRecord | null> {
    return this.runUse(() => this.#pool.getProviderStep(this.sessionId, stepId));
  }

  getProviderStepsForRun(runId: string): Promise<readonly ProviderStepRecord[]> {
    return this.runUse(() => this.#pool.getProviderStepsForRun(this.sessionId, runId));
  }

  getRecentProviderStepsForRun(
    runId: string,
    limit: number,
  ): Promise<readonly ProviderStepRecord[]> {
    return this.runUse(() =>
      this.#pool.getRecentProviderStepsForRun(this.sessionId, runId, limit),
    );
  }

  getToolExecution(callId: string): Promise<ToolExecutionRecord | null> {
    return this.runUse(() => this.#pool.getToolExecution(this.sessionId, callId));
  }

  getToolExecutionsForStep(stepId: string): Promise<readonly ToolExecutionRecord[]> {
    return this.runUse(() => this.#pool.getToolExecutionsForStep(this.sessionId, stepId));
  }

  getToolExecutionsForRun(runId: string): Promise<readonly ToolExecutionRecord[]> {
    return this.runUse(() => this.#pool.getToolExecutionsForRun(this.sessionId, runId));
  }

  getRunMessages(runId: string): Promise<readonly RunMessageRecord[]> {
    return this.runUse(() => this.#pool.getRunMessages(this.sessionId, runId));
  }

  getStreamingMessagesForStep(stepId: string): Promise<readonly RunMessageRecord[]> {
    return this.runUse(() => this.#pool.getStreamingMessagesForStep(this.sessionId, stepId));
  }

  getNonterminalRuns(): Promise<readonly RunRecord[]> {
    return this.runUse(() => this.#pool.getNonterminalRuns(this.sessionId));
  }

  getCatalogProjection(): Promise<SessionCatalogProjection> {
    return this.runUse(() => this.#pool.getCatalogProjection(this.sessionId));
  }

  getPendingApprovals(): Promise<readonly PendingApprovalRecord[]> {
    return this.runUse(() => this.#pool.getPendingApprovals(this.sessionId));
  }

  getPendingInputs(): Promise<readonly PendingInputRecord[]> {
    return this.runUse(() => this.#pool.getPendingInputs(this.sessionId));
  }

  getInput(inputId: string): Promise<InputRecord | null> {
    return this.runUse(() => this.#pool.getInput(this.sessionId, inputId));
  }

  getPendingInputCount(): Promise<number> {
    return this.runUse(() => this.#pool.getPendingInputCount(this.sessionId));
  }

  recover(): Promise<SessionRecoveryResult> {
    return this.runUse(() => this.#pool.recover(this.sessionId));
  }

  close(): Promise<void> {
    return this.#pool.closeSession(this.sessionId);
  }
}
