import { decodeProviderConfiguration } from "@wi/provider-contract";
import {
  hashCommandContent,
  type ApprovalResolveCommand,
  type CanonicalJsonValue,
  type ErrorCode,
  type InputRespondCommand,
  type MessageSubmitCommand,
  type RunCancelCommand,
  type RunProviderSelectionSnapshot,
  type RunState,
  type SessionProviderDefault,
  type SessionProviderDefaultSetCommand,
  RunStateSchema,
  type SessionEvent,
  type ToolEffectClass,
} from "@wi/protocol";
import type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionInspection,
  AppendTransactionResult,
  InputRecord,
  PendingApprovalRecord,
  PendingInputRecord,
  ProviderStepRecord,
  RunMessageRecord,
  RunRecord,
  SessionRecoveryResult,
  ToolExecutionRecord,
} from "@wi/storage";

import { ActorMailbox, MailboxClosedError } from "./actor-mailbox.js";
import { CancellationController } from "./cancellation.js";
import type { CommittedEventHub } from "./event-hub.js";
import {
  EventReconciliationIntegrityError,
  reconcileCommittedEventBatch,
} from "./event-reconciliation.js";
import { safeRunFailureMessage } from "./failure-messages.js";
import { recoverSession, type RecoveryFailureDiagnostic } from "./recovery.js";
import { assertCurrentToolEffectClass } from "./run-policy.js";
import {
  isTerminalRunState,
  terminalStateForTask,
  type RunTaskTerminalState,
} from "./run-state.js";
import type { RunScheduler } from "./scheduler.js";
import {
  defaultShutdownWait,
  ShutdownTimeoutError,
  type ShutdownWait,
} from "./shutdown.js";

export type ResolvedSessionProviderDefaultCommand = Omit<
  SessionProviderDefaultSetCommand,
  "params"
> & {
  readonly params: { readonly default: SessionProviderDefault };
};

export class SessionActorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SessionActorError";
  }
}

export class SessionActorHandoffError extends Error {
  constructor() {
    super("Session actor is handing durable work to a replacement actor");
    this.name = "SessionActorHandoffError";
  }
}

export function isSessionActorHandoffSignal(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof SessionActorHandoffError;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

export interface SessionActorStorage {
  readonly sessionId: string;
  acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult>;
  appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult>;
  inspectAppendTransaction(input: AppendTransactionInput): Promise<AppendTransactionInspection>;
  getEventById(eventId: string): Promise<SessionEvent | null>;
  getRun(runId: string): Promise<RunRecord | null>;
  getAcceptedCommand(commandId: string): Promise<AcceptedCommandResult | null>;
  getProviderStep(stepId: string): Promise<ProviderStepRecord | null>;
  getToolExecution?(callId: string): Promise<ToolExecutionRecord | null>;
  getToolExecutionsForStep?(stepId: string): Promise<readonly ToolExecutionRecord[]>;
  getStreamingMessagesForStep?(stepId: string): Promise<readonly RunMessageRecord[]>;
  getNonterminalRuns(): Promise<readonly RunRecord[]>;
  getPendingApprovals(): Promise<readonly PendingApprovalRecord[]>;
  getPendingInputs(): Promise<readonly PendingInputRecord[]>;
  getInput?(inputId: string): Promise<InputRecord | null>;
  recover(): Promise<SessionRecoveryResult>;
  close?(): Promise<void>;
}

export interface SessionActorIds {
  readonly runId: () => string;
  readonly eventId: () => string;
  readonly messageId: () => string;
  readonly partId: () => string;
  readonly diagnosticId: () => string;
}

export type SessionActorTestFailpoint =
  | "after_command_event_insert_before_commit"
  | "after_event_commit_before_publish"
  | "after_tool_requested_commit"
  | "after_tool_started_commit"
  | "after_tool_result_commit_before_provider_continue"
  | "after_provider_text_commit"
  | "after_run_terminal_commit"
  | "after_environment_run_acceptance_before_request";

export interface SessionActorTestFailpoints {
  readonly matches: (
    name: SessionActorTestFailpoint,
    fields?: Readonly<Record<string, unknown>>,
  ) => boolean;
  readonly takeRunIdForCommand: (
    sessionId: string,
    commandId: string,
  ) => string | null;
  readonly hit: (
    name: SessionActorTestFailpoint,
    fields?: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface SessionToolFailureDiagnostic {
  readonly diagnosticId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly state: "failed";
  readonly code: ErrorCode;
  readonly error: unknown;
}

export interface SessionRunFailureDiagnostic {
  readonly diagnosticId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly state: "failed" | "interrupted";
  readonly code: ErrorCode;
  readonly error: unknown;
}

export interface RunTaskCommitOptions {
  /** Actor-validated terminal cleanup may finish after run.cancel is committed. */
  readonly cancellationCleanup?: "provider_text" | "provider_step" | "tool_execution";
}

function eventIdentity(event: AppendTransactionInput["events"][number]): {
  readonly runId: string | null;
  readonly stepId: string | null;
  readonly callId: string | null;
} {
  if (event.data === null || typeof event.data !== "object") {
    return { runId: null, stepId: null, callId: null };
  }
  const data = event.data as { readonly runId?: unknown; readonly stepId?: unknown; readonly callId?: unknown };
  return {
    runId: typeof data.runId === "string" ? data.runId : null,
    stepId: typeof data.stepId === "string" ? data.stepId : null,
    callId: typeof data.callId === "string" ? data.callId : null,
  };
}

function isProviderTextCancellationCleanup(
  runId: string,
  input: AppendTransactionInput,
): boolean {
  if (input.events.length !== 1 || (input.projections ?? []).length !== 2) return false;
  const event = input.events[0];
  if (event?.eventType !== "provider.text.delta") return false;
  const identity = eventIdentity(event);
  if (identity.runId !== runId || identity.stepId === null) return false;
  const data = event.data as {
    readonly messageId?: unknown;
    readonly partId?: unknown;
  };
  const message = input.projections?.find((projection) => projection.kind === "message.put");
  const part = input.projections?.find((projection) => projection.kind === "messagePart.put");
  return (
    typeof data.messageId === "string" &&
    typeof data.partId === "string" &&
    message?.kind === "message.put" &&
    message.messageId === data.messageId &&
    message.runId === runId &&
    message.role === "assistant" &&
    message.state === "streaming" &&
    part?.kind === "messagePart.put" &&
    part.partId === data.partId &&
    part.messageId === data.messageId
  );
}

function isProviderCancellationCleanup(
  runId: string,
  input: AppendTransactionInput,
): boolean {
  if (input.events.length !== 1) return false;
  const event = input.events[0];
  if (
    event === undefined ||
    (event.eventType !== "provider.step.failed" &&
      event.eventType !== "provider.step.interrupted")
  ) {
    return false;
  }
  const identity = eventIdentity(event);
  if (identity.runId !== runId || identity.stepId === null) return false;

  let providerStepCount = 0;
  let activeStepCount = 0;
  let messageId: string | null = null;
  let partMessageId: string | null = null;
  for (const projection of input.projections ?? []) {
    switch (projection.kind) {
      case "providerStep.put":
        providerStepCount += 1;
        if (
          projection.runId !== runId ||
          projection.stepId !== identity.stepId ||
          projection.expectedState !== "streaming" ||
          (event.eventType === "provider.step.failed"
            ? projection.state !== "failed"
            : projection.state !== "interrupted") ||
          projection.completedAtMs !== event.createdAtMs
        ) {
          return false;
        }
        break;
      case "toolExecution.put":
        if (
          projection.runId !== runId ||
          projection.stepId !== identity.stepId ||
          projection.expectedState !== "staged" ||
          projection.state !== "discarded" ||
          projection.completedAtMs !== event.createdAtMs
        ) {
          return false;
        }
        break;
      case "run.activeProviderStep":
        activeStepCount += 1;
        if (
          projection.runId !== runId ||
          projection.expectedActiveProviderStepId !== identity.stepId ||
          projection.activeProviderStepId !== null
        ) {
          return false;
        }
        break;
      case "message.put":
        if (
          messageId !== null ||
          projection.runId !== runId ||
          projection.role !== "assistant" ||
          projection.state !== "interrupted" ||
          projection.completedAtMs !== event.createdAtMs
        ) {
          return false;
        }
        messageId = projection.messageId;
        break;
      case "messagePart.put":
        if (partMessageId !== null) return false;
        partMessageId = projection.messageId;
        break;
      default:
        return false;
    }
  }
  return (
    providerStepCount === 1 &&
    activeStepCount === 1 &&
    ((messageId === null && partMessageId === null) || messageId === partMessageId)
  );
}

function isToolCancellationCleanup(runId: string, input: AppendTransactionInput): boolean {
  if (input.events.length !== 1 || (input.projections ?? []).length !== 1) return false;
  const event = input.events[0];
  const projection = input.projections?.[0];
  if (
    event === undefined ||
    projection?.kind !== "toolExecution.put" ||
    (event.eventType !== "tool.execution.failed" &&
      event.eventType !== "tool.execution.outcome_unknown")
  ) {
    return false;
  }
  const identity = eventIdentity(event);
  const validState =
    event.eventType === "tool.execution.outcome_unknown"
      ? projection.state === "outcome_unknown"
      : projection.state === "failed" || projection.state === "cancelled";
  return (
    identity.runId === runId &&
    identity.callId === projection.callId &&
    projection.runId === runId &&
    projection.expectedState === "started" &&
    validState &&
    projection.completedAtMs === event.createdAtMs
  );
}

function isAuthorizedCancellationCleanup(
  runId: string,
  input: AppendTransactionInput,
  options: RunTaskCommitOptions,
): boolean {
  if (options.cancellationCleanup === "provider_text") {
    return isProviderTextCancellationCleanup(runId, input);
  }
  if (options.cancellationCleanup === "provider_step") {
    return isProviderCancellationCleanup(runId, input);
  }
  if (options.cancellationCleanup === "tool_execution") {
    return isToolCancellationCleanup(runId, input);
  }
  return false;
}

export interface RunTaskContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly scheduler: RunScheduler;
  readonly now: () => number;
  readonly commitTransaction: (
    input: AppendTransactionInput,
    options?: RunTaskCommitOptions,
  ) => Promise<AppendTransactionResult>;
  readonly waitForApproval: (approvalId: string) => Promise<void>;
  readonly waitForInput: (inputId: string) => Promise<CanonicalJsonValue>;
}

export interface RunProviderSnapshot {
  readonly providerId: string;
  readonly providerConfig: CanonicalJsonValue;
  readonly providerSelection?: RunProviderSelectionSnapshot | null;
}

export type CreateRunProviderSnapshot = (
  command: MessageSubmitCommand,
  runId: string,
) => RunProviderSnapshot | Promise<RunProviderSnapshot>;

export interface RunTaskResult {
  readonly state: RunTaskTerminalState;
  readonly code?: ErrorCode;
  readonly message?: string;
  readonly diagnosticId?: string;
  readonly failureCause?: unknown;
  readonly cancellationFailure?: boolean;
}

export type RunTask = (context: RunTaskContext) => Promise<RunTaskResult | void>;

// Resolution confirms the underlying operation has stopped. Returning its terminal result keeps
// causal diagnostics intact; void means the stopper has proof of termination but no task result.
export type CancelRunTask = (
  context: RunTaskContext,
  reason: unknown,
) => void | RunTaskResult | Promise<void | RunTaskResult>;

export interface RunTaskIsolation {
  readonly status: "terminated" | "detached" | "quarantined";
  readonly cleanup?: Promise<void>;
}

// This synchronous result is proof that the execution resource is already isolated. Optional
// best-effort cleanup happens after isolation and cannot retain the scheduler permit.
export type ForceStopRunTask = (
  context: RunTaskContext,
  reason: unknown,
) => RunTaskIsolation;

function assertRunTaskIsolation(value: unknown): asserts value is RunTaskIsolation {
  if (value === null || typeof value !== "object" || "then" in value) {
    throw new SessionActorError(
      "session.invalid_isolation_proof",
      "Forced run-task isolation must return synchronous proof",
    );
  }
  if (
    !("status" in value) ||
    (value.status !== "terminated" &&
      value.status !== "detached" &&
      value.status !== "quarantined")
  ) {
    throw new SessionActorError(
      "session.invalid_isolation_proof",
      "Forced run-task isolation returned an invalid status",
    );
  }
  if (
    "cleanup" in value &&
    value.cleanup !== undefined &&
    (value.cleanup === null ||
      typeof value.cleanup !== "object" ||
      !("then" in value.cleanup) ||
      typeof value.cleanup.then !== "function")
  ) {
    throw new SessionActorError(
      "session.invalid_isolation_proof",
      "Forced run-task isolation cleanup must be a promise",
    );
  }
}

interface ApprovalWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface InputWaiter {
  readonly resolve: (value: CanonicalJsonValue) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface ResolvedInputValue {
  readonly runId: string;
  readonly value: CanonicalJsonValue;
}

interface ActiveRun {
  readonly runId: string;
  readonly generation: number;
  readonly scope: CancellationController;
  record: RunRecord;
  context: RunTaskContext | null;
  confirmStopped: ((result: RunTaskResult) => void) | null;
  cancellation: Promise<void> | null;
  task: Promise<void> | null;
}

export interface SessionActorSnapshot {
  readonly sessionId: string;
  readonly activeRunId: string | null;
  readonly activeRunState: RunState | null;
  readonly queuedRunIds: readonly string[];
  readonly subscriberCount: number;
  readonly pendingApprovalCount: number;
  readonly pendingInputCount: number;
  readonly cancellationCleanupCount: number;
  readonly mailboxQueued: number;
  readonly mailboxRunning: boolean;
  readonly recovering: boolean;
  readonly faulted: boolean;
  readonly closed: boolean;
  readonly idle: boolean;
}

export interface SubmitMessageResult {
  readonly acceptance: AcceptedCommandResult;
  readonly runId: string;
  readonly queued: boolean;
}

export interface CancelRunResult {
  readonly state: RunState;
  readonly acceptance?: AcceptedCommandResult;
}

export class SessionActor {
  readonly sessionId: string;
  readonly mailbox = new ActorMailbox();
  private readonly storage: SessionActorStorage;
  private readonly eventHub: CommittedEventHub;
  private readonly scheduler: RunScheduler;
  private readonly ids: SessionActorIds;
  private readonly now: () => number;
  private readonly runTask: RunTask;
  private readonly createRunProviderSnapshot: CreateRunProviderSnapshot;
  private readonly onRunProviderSnapshotAccepted: ((runId: string) => void) | undefined;
  private readonly onRunProviderSnapshotRejected:
    | ((runId: string) => void | Promise<void>)
    | undefined;
  private readonly runTaskOwnsSchedulerPermits: boolean;
  private readonly resumeRestoredRuns: boolean;
  private readonly currentToolEffectClass:
    | ((toolName: string) => ToolEffectClass | null)
    | undefined;
  private readonly shouldInterruptRestoredRun:
    | ((run: RunRecord) => boolean)
    | undefined;
  private readonly cancelRunTask: CancelRunTask;
  private readonly forceStopRunTask: ForceStopRunTask;
  private readonly cancellationWait: ShutdownWait;
  private readonly onActivity: (() => void) | undefined;
  private readonly onFault: ((error: unknown) => void) | undefined;
  private readonly onToolFailureDiagnostic:
    | ((diagnostic: SessionToolFailureDiagnostic) => void)
    | undefined;
  private readonly onRunFailureDiagnostic:
    | ((diagnostic: SessionRunFailureDiagnostic) => void)
    | undefined;
  private readonly onRecoveryFailureDiagnostic:
    | ((diagnostic: RecoveryFailureDiagnostic) => void)
    | undefined;
  private readonly testFailpoints: SessionActorTestFailpoints | undefined;
  private readonly shutdownWait: ShutdownWait;
  private readonly queuedRuns: RunRecord[] = [];
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>();
  private readonly pendingInputs = new Map<string, PendingInputRecord>();
  private readonly approvalWaiters = new Map<string, Set<ApprovalWaiter>>();
  private readonly inputWaiters = new Map<string, Set<InputWaiter>>();
  private readonly deferredApprovalRunIds = new Map<string, string>();
  private readonly deferredInputValues = new Map<string, ResolvedInputValue>();
  private readonly resolvedInputValues = new Map<string, ResolvedInputValue>();
  private readonly subscribers = new Set<string>();
  // A run may terminalize first, so the actor retains cleanup until shutdown can safely drain it.
  private readonly cancellationCleanups = new Set<Promise<void>>();
  private activeRun: ActiveRun | null = null;
  private generation = 0;
  private recovering = true;
  private fault: unknown | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(options: {
    readonly storage: SessionActorStorage;
    readonly eventHub: CommittedEventHub;
    readonly scheduler: RunScheduler;
    readonly ids: SessionActorIds;
    readonly now: () => number;
    readonly runTask: RunTask;
    readonly createRunProviderSnapshot?: CreateRunProviderSnapshot;
    readonly onRunProviderSnapshotAccepted?: (runId: string) => void;
    readonly onRunProviderSnapshotRejected?: (runId: string) => void | Promise<void>;
    readonly runTaskOwnsSchedulerPermits?: boolean;
    readonly resumeRestoredRuns?: boolean;
    readonly currentToolEffectClass?: (toolName: string) => ToolEffectClass | null;
    readonly shouldInterruptRestoredRun?: (run: RunRecord) => boolean;
    readonly cancelRunTask: CancelRunTask;
    readonly forceStopRunTask: ForceStopRunTask;
    readonly cancellationWait?: ShutdownWait;
    readonly onActivity?: () => void;
    readonly onFault?: (error: unknown) => void;
    readonly onToolFailureDiagnostic?: (diagnostic: SessionToolFailureDiagnostic) => void;
    readonly onRunFailureDiagnostic?: (diagnostic: SessionRunFailureDiagnostic) => void;
    readonly onRecoveryFailureDiagnostic?: (diagnostic: RecoveryFailureDiagnostic) => void;
    readonly testFailpoints?: SessionActorTestFailpoints;
    readonly shutdownWait?: ShutdownWait;
  }) {
    this.sessionId = options.storage.sessionId;
    this.storage = options.storage;
    this.eventHub = options.eventHub;
    this.scheduler = options.scheduler;
    this.ids = options.ids;
    this.now = options.now;
    this.runTask = options.runTask;
    this.createRunProviderSnapshot =
      options.createRunProviderSnapshot ??
      (() => ({ providerId: "milestone-3-task", providerConfig: { milestone: 3 } }));
    this.onRunProviderSnapshotAccepted = options.onRunProviderSnapshotAccepted;
    this.onRunProviderSnapshotRejected = options.onRunProviderSnapshotRejected;
    this.runTaskOwnsSchedulerPermits = options.runTaskOwnsSchedulerPermits === true;
    this.resumeRestoredRuns = options.resumeRestoredRuns === true;
    this.currentToolEffectClass = options.currentToolEffectClass;
    this.shouldInterruptRestoredRun = options.shouldInterruptRestoredRun;
    this.cancelRunTask = options.cancelRunTask;
    this.forceStopRunTask = options.forceStopRunTask;
    this.cancellationWait = options.cancellationWait ?? defaultShutdownWait;
    this.onActivity = options.onActivity;
    this.onFault = options.onFault;
    this.onToolFailureDiagnostic = options.onToolFailureDiagnostic;
    this.onRunFailureDiagnostic = options.onRunFailureDiagnostic;
    this.onRecoveryFailureDiagnostic = options.onRecoveryFailureDiagnostic;
    this.testFailpoints = options.testFailpoints;
    this.shutdownWait = options.shutdownWait ?? defaultShutdownWait;
  }

  static async create(options: {
    readonly storage: SessionActorStorage;
    readonly eventHub: CommittedEventHub;
    readonly scheduler: RunScheduler;
    readonly ids: SessionActorIds;
    readonly now: () => number;
    readonly runTask: RunTask;
    readonly createRunProviderSnapshot?: CreateRunProviderSnapshot;
    readonly onRunProviderSnapshotAccepted?: (runId: string) => void;
    readonly onRunProviderSnapshotRejected?: (runId: string) => void | Promise<void>;
    readonly runTaskOwnsSchedulerPermits?: boolean;
    readonly resumeRestoredRuns?: boolean;
    readonly currentToolEffectClass?: (toolName: string) => ToolEffectClass | null;
    readonly shouldInterruptRestoredRun?: (run: RunRecord) => boolean;
    readonly cancelRunTask: CancelRunTask;
    readonly forceStopRunTask: ForceStopRunTask;
    readonly cancellationWait?: ShutdownWait;
    readonly onActivity?: () => void;
    readonly onFault?: (error: unknown) => void;
    readonly onToolFailureDiagnostic?: (diagnostic: SessionToolFailureDiagnostic) => void;
    readonly onRunFailureDiagnostic?: (diagnostic: SessionRunFailureDiagnostic) => void;
    readonly onRecoveryFailureDiagnostic?: (diagnostic: RecoveryFailureDiagnostic) => void;
    readonly testFailpoints?: SessionActorTestFailpoints;
    readonly shutdownWait?: ShutdownWait;
  }): Promise<SessionActor> {
    const actor = new SessionActor(options);
    try {
      await actor.initialize();
      return actor;
    } catch (error) {
      try {
        await actor.shutdown();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Session actor ${actor.sessionId} initialization and cleanup failed`,
        );
      }
      throw error;
    }
  }

  private hitCommittedFailpoints(
    events: readonly SessionEvent[],
    runId?: string,
  ): void {
    if (events.length === 0) return;
    const fields = {
      sessionId: this.sessionId,
      ...(runId === undefined ? {} : { runId }),
      headSequence: events.at(-1)?.sequence,
    };
    this.testFailpoints?.hit("after_event_commit_before_publish", fields);
    if (events.some((event) => event.eventType === "provider.text.delta")) {
      this.testFailpoints?.hit("after_provider_text_commit", fields);
    }
    if (events.some((event) => event.eventType === "tool.call.requested")) {
      this.testFailpoints?.hit("after_tool_requested_commit", fields);
    }
    if (events.some((event) => event.eventType === "tool.execution.started")) {
      this.testFailpoints?.hit("after_tool_started_commit", fields);
    }
    if (
      events.some(
        (event) =>
          event.eventType === "tool.execution.completed" ||
          event.eventType === "tool.execution.failed" ||
          event.eventType === "tool.execution.outcome_unknown",
      )
    ) {
      this.testFailpoints?.hit("after_tool_result_commit_before_provider_continue", fields);
    }
  }

  private publishOrThrow(events: readonly SessionEvent[]): void {
    try {
      for (const event of events) this.eventHub.publishCommitted(event);
    } catch (error) {
      // The write is already committed. Quarantine this actor instead of reporting rollback
      // or allowing later commands to mutate a session with an inconsistent live stream.
      this.recordFault(error);
      throw error;
    }
  }

  private publish(events: readonly SessionEvent[]): boolean {
    try {
      for (const event of events) this.eventHub.publishCommitted(event);
      return true;
    } catch (error) {
      this.recordFault(error);
      return false;
    }
  }

  private touch(): void {
    this.onActivity?.();
  }

  private reportToolFailure(diagnostic: SessionToolFailureDiagnostic): void {
    try {
      this.onToolFailureDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics must never replace an already accepted approval outcome.
    }
  }

  private reportRunFailure(diagnostic: SessionRunFailureDiagnostic): void {
    try {
      this.onRunFailureDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics must never replace an already committed run outcome.
    }
  }

  private rejectUnavailable<T>(): Promise<T> | null {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    if (this.fault !== null) {
      return Promise.reject(
        new SessionActorError("session.unavailable", `Session ${this.sessionId} actor is faulted`),
      );
    }
    return null;
  }

  private assertNotFaulted(): void {
    if (this.fault !== null) {
      throw new SessionActorError(
        "session.unavailable",
        `Session ${this.sessionId} actor is faulted`,
      );
    }
  }

  private recordFault(error: unknown): void {
    const firstFault = this.fault === null;
    if (firstFault) this.fault = error;
    if (this.activeRun !== null) this.stopActiveTask(this.activeRun, error);
    if (firstFault) this.onFault?.(error);
    this.touch();
  }

  private postFault(error: unknown): void {
    this.mailbox.post(
      () => this.recordFault(error),
      (mailboxError: unknown) => {
        if (!(mailboxError instanceof MailboxClosedError)) this.recordFault(mailboxError);
      },
    );
  }

  private acceptedRunState(acceptance: AcceptedCommandResult, fallback: RunState): RunState {
    const result = acceptance.result;
    if (result !== null && typeof result === "object" && !Array.isArray(result) && "state" in result) {
      const parsed = RunStateSchema.safeParse(result.state);
      if (parsed.success) return parsed.data;
    }
    return fallback;
  }

  private faultUnresolvedAmbiguousWrite(error: unknown): void {
    if (hasErrorCode(error, "storage.ambiguous_outcome")) this.recordFault(error);
  }

  private async acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult> {
    try {
      return await this.storage.acceptCommand(input);
    } catch (operationError) {
      let accepted: AcceptedCommandResult | null;
      try {
        accepted = await this.storage.getAcceptedCommand(input.commandId);
      } catch {
        // The durable result is unknown, so later commands must wait for actor reconstruction.
        this.faultUnresolvedAmbiguousWrite(operationError);
        throw operationError;
      }
      if (
        accepted === null ||
        accepted.commandMethod !== input.commandMethod ||
        accepted.payloadHash !== input.payloadHash
      ) {
        throw operationError;
      }
      if (accepted.runId !== input.runId) {
        if (input.commandMethod === "message.submit" && accepted.runId !== null) {
          // A duplicate message predates this retry, so its fresh proposed event IDs never applied.
          return accepted;
        }
        const identityError = new SessionActorError(
          "session.invalid_transition",
          `Accepted command ${input.commandId} has an inconsistent run identity`,
        );
        this.recordFault(identityError);
        throw identityError;
      }

      const events: SessionEvent[] = [];
      for (const expected of input.transaction.events) {
        let event: SessionEvent | null;
        try {
          event = await this.storage.getEventById(expected.eventId);
        } catch {
          this.faultUnresolvedAmbiguousWrite(operationError);
          throw operationError;
        }
        if (event === null || event.eventType !== expected.eventType) {
          if (accepted.runId === input.runId) this.faultUnresolvedAmbiguousWrite(operationError);
          throw operationError;
        }
        events.push(event);
      }
      return { ...accepted, events };
    }
  }

  private async acceptNoopCancellation(
    command: RunCancelCommand,
    payloadHash: string,
    run: RunRecord,
  ): Promise<CancelRunResult> {
    const acceptance = await this.acceptCommand({
      commandId: command.commandId,
      commandMethod: command.method,
      payloadHash,
      result: { runId: run.runId, state: run.state },
      acceptedAtMs: this.now(),
      runId: run.runId,
      transaction: { events: [], projections: [] },
    });
    this.publish(acceptance.events);
    return { state: this.acceptedRunState(acceptance, run.state), acceptance };
  }

  private async commandIdentity(
    command: RunCancelCommand | ApprovalResolveCommand | InputRespondCommand,
  ): Promise<{ readonly payloadHash: string; readonly duplicate: AcceptedCommandResult | null }> {
    const payloadHash = await hashCommandContent(command);
    const duplicate = await this.storage.getAcceptedCommand(command.commandId);
    if (
      duplicate !== null &&
      (duplicate.commandMethod !== command.method || duplicate.payloadHash !== payloadHash)
    ) {
      throw new SessionActorError(
        "protocol.command_id_conflict",
        `Command ${command.commandId} was reused with different content`,
      );
    }
    return { payloadHash, duplicate };
  }

  private settleApprovalWaiters(approvalId: string): void {
    const waiters = this.approvalWaiters.get(approvalId);
    if (waiters === undefined) return;
    this.approvalWaiters.delete(approvalId);
    for (const waiter of waiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }

  private waitForApproval(approvalId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // A resolved approval remains gated until the last interaction commits run.started.
    if (
      !this.pendingApprovals.has(approvalId) &&
      !this.deferredApprovalRunIds.has(approvalId)
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiters = this.approvalWaiters.get(approvalId) ?? new Set<ApprovalWaiter>();
      const waiter: ApprovalWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.approvalWaiters.delete(approvalId);
          reject(signal.reason ?? new DOMException("Approval wait aborted", "AbortError"));
        },
      };
      waiters.add(waiter);
      this.approvalWaiters.set(approvalId, waiters);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private releaseDeferredInteractionWaiters(runId: string): void {
    for (const [approvalId, deferredRunId] of this.deferredApprovalRunIds) {
      if (deferredRunId !== runId) continue;
      this.deferredApprovalRunIds.delete(approvalId);
      this.settleApprovalWaiters(approvalId);
    }
    for (const [inputId, resolved] of this.deferredInputValues) {
      if (resolved.runId !== runId) continue;
      this.deferredInputValues.delete(inputId);
      this.settleInputWaiters(inputId, resolved.runId, resolved.value);
    }
  }

  private settleInputWaiters(
    inputId: string,
    runId: string,
    value: CanonicalJsonValue,
  ): void {
    const waiters = this.inputWaiters.get(inputId);
    if (waiters === undefined) {
      // The command may commit just before the task registers its waiter.
      this.resolvedInputValues.set(inputId, { runId, value });
      return;
    }
    this.inputWaiters.delete(inputId);
    for (const waiter of waiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(value);
    }
  }

  private registerInputWaiter(
    inputId: string,
    signal: AbortSignal,
  ): Promise<CanonicalJsonValue> {
    return new Promise<CanonicalJsonValue>((resolve, reject) => {
      const waiters = this.inputWaiters.get(inputId) ?? new Set<InputWaiter>();
      const waiter: InputWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.inputWaiters.delete(inputId);
          reject(signal.reason ?? new DOMException("Input wait aborted", "AbortError"));
        },
      };
      waiters.add(waiter);
      this.inputWaiters.set(inputId, waiters);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  private async waitForInput(
    inputId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<CanonicalJsonValue> {
    signal.throwIfAborted();
    const resolved = this.resolvedInputValues.get(inputId);
    if (resolved !== undefined) {
      this.resolvedInputValues.delete(inputId);
      if (resolved.runId !== runId) {
        throw new SessionActorError(
          "session.invalid_transition",
          `Input ${inputId} does not belong to run ${runId}`,
        );
      }
      return resolved.value;
    }

    const deferred = this.deferredInputValues.get(inputId);
    if (deferred !== undefined) {
      if (deferred.runId !== runId) {
        throw new SessionActorError(
          "session.invalid_transition",
          `Input ${inputId} does not belong to run ${runId}`,
        );
      }
      return this.registerInputWaiter(inputId, signal);
    }

    const pending = this.pendingInputs.get(inputId);
    if (pending !== undefined) {
      if (pending.runId !== runId) {
        throw new SessionActorError(
          "session.invalid_transition",
          `Input ${inputId} does not belong to run ${runId}`,
        );
      }
      return this.registerInputWaiter(inputId, signal);
    }

    const stored = await this.storage.getInput?.(inputId);
    signal.throwIfAborted();
    const resolvedDuringRead = this.resolvedInputValues.get(inputId);
    if (resolvedDuringRead !== undefined) {
      this.resolvedInputValues.delete(inputId);
      if (resolvedDuringRead.runId !== runId) {
        throw new SessionActorError(
          "session.invalid_transition",
          `Input ${inputId} does not belong to run ${runId}`,
        );
      }
      return resolvedDuringRead.value;
    }
    const deferredDuringRead = this.deferredInputValues.get(inputId);
    if (deferredDuringRead !== undefined) {
      if (deferredDuringRead.runId !== runId) {
        throw new SessionActorError(
          "session.invalid_transition",
          `Input ${inputId} does not belong to run ${runId}`,
        );
      }
      return this.registerInputWaiter(inputId, signal);
    }
    if (stored === undefined || stored === null || stored.runId !== runId) {
      throw new SessionActorError(
        "session.invalid_transition",
        `Input ${inputId} does not belong to run ${runId}`,
      );
    }
    if (stored.state === "resolved") return stored.value;
    if (stored.state === "pending") {
      this.pendingInputs.set(inputId, {
        inputId: stored.inputId,
        runId: stored.runId,
        state: "pending",
        prompt: stored.prompt,
        requestedAtMs: stored.requestedAtMs,
      });
      return this.registerInputWaiter(inputId, signal);
    }
    throw new SessionActorError(
      "session.invalid_transition",
      `Input ${inputId} cannot continue from state ${stored.state}`,
    );
  }

  private applyProjectionMemory(input: AppendTransactionInput): void {
    for (const projection of input.projections ?? []) {
      const active = this.activeRun;
      if (projection.kind === "run.state" && active?.runId === projection.runId) {
        active.record = {
          ...active.record,
          state: projection.nextState,
          startedAtMs: projection.startedAtMs,
          completedAtMs: projection.completedAtMs,
          cancelledAtMs: projection.cancelledAtMs,
          failureCategory: projection.failureCategory,
          failureMessage: projection.failureMessage,
          activeProviderStepId: projection.activeProviderStepId,
        };
      } else if (
        projection.kind === "run.activeProviderStep" &&
        active?.runId === projection.runId
      ) {
        active.record = {
          ...active.record,
          activeProviderStepId: projection.activeProviderStepId,
        };
      } else if (projection.kind === "approval.put") {
        this.pendingApprovals.set(projection.approvalId, {
          approvalId: projection.approvalId,
          runId: projection.runId,
          callId: projection.callId,
          state: "pending",
          actionDigest: projection.actionDigest,
          requestedAtMs: projection.requestedAtMs,
        });
      } else if (projection.kind === "approval.resolve") {
        this.pendingApprovals.delete(projection.approvalId);
      } else if (projection.kind === "input.put") {
        this.pendingInputs.set(projection.inputId, {
          inputId: projection.inputId,
          runId: projection.runId,
          state: "pending",
          prompt: projection.prompt,
          requestedAtMs: projection.requestedAtMs,
        });
      } else if (projection.kind === "input.resolve") {
        this.pendingInputs.delete(projection.inputId);
      } else if (projection.kind === "run.pendingInteractions.cancel") {
        for (const [approvalId, approval] of this.pendingApprovals) {
          if (approval.runId === projection.runId) {
            this.pendingApprovals.delete(approvalId);
            this.settleApprovalWaiters(approvalId);
          }
        }
        for (const [inputId, input] of this.pendingInputs) {
          if (input.runId === projection.runId) this.pendingInputs.delete(inputId);
        }
      }
    }
  }

  private async commitTaskTransaction(
    runId: string,
    generation: number,
    input: AppendTransactionInput,
    options: RunTaskCommitOptions = {},
  ): Promise<AppendTransactionResult> {
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      const active = this.activeRun;
      if (active === null || active.runId !== runId || active.generation !== generation) {
        throw new SessionActorError("session.invalid_transition", "Run task is stale");
      }
      if (
        (active.scope.signal.aborted || active.record.state === "cancelling") &&
        !isAuthorizedCancellationCleanup(runId, input, options)
      ) {
        throw new SessionActorError("provider.cancelled", "Run cancellation prevents this mutation");
      }

      let committed: AppendTransactionResult;
      try {
        committed = await this.storage.appendTransaction(input);
      } catch (operationError) {
        let inspection: AppendTransactionInspection;
        try {
          inspection = await this.storage.inspectAppendTransaction(input);
        } catch (inspectionError) {
          if (hasErrorCode(inspectionError, "storage.corrupt")) {
            this.recordFault(inspectionError);
            throw inspectionError;
          }
          this.faultUnresolvedAmbiguousWrite(operationError);
          throw operationError;
        }
        try {
          const reconciled = reconcileCommittedEventBatch(
            this.sessionId,
            input.events,
            inspection.storedEvents,
            inspection.headSequence,
            inspection.projectionsApplied,
          );
          if (reconciled === null) throw operationError;
          committed = reconciled;
        } catch (error) {
          if (error instanceof EventReconciliationIntegrityError) this.recordFault(error);
          else this.faultUnresolvedAmbiguousWrite(operationError);
          throw error;
        }

        let current: RunRecord | null;
        try {
          current = await this.storage.getRun(runId);
        } catch {
          this.faultUnresolvedAmbiguousWrite(operationError);
          throw operationError;
        }
        if (current === null) {
          const integrityError = new EventReconciliationIntegrityError(
            `Reconciled task transaction has no run ${runId}`,
          );
          this.recordFault(integrityError);
          throw integrityError;
        }
        active.record = current;
      }
      this.hitCommittedFailpoints(committed.events, runId);
      this.publishOrThrow(committed.events);
      this.applyProjectionMemory(input);
      this.touch();
      return committed;
    });
  }

  private async interruptRestoredRun(run: RunRecord): Promise<void> {
    const interruptedAtMs = this.now();
    const diagnosticId = this.ids.diagnosticId();
    const projections: AppendTransactionInput["projections"] = [
      ...(run.state === "queued"
        ? [{
            kind: "run.state" as const,
            runId: run.runId,
            expectedState: "queued" as const,
            nextState: "running" as const,
            startedAtMs: run.startedAtMs ?? interruptedAtMs,
            completedAtMs: null,
            cancelledAtMs: run.cancelledAtMs,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: run.activeProviderStepId,
          }]
        : []),
      {
        kind: "run.state",
        runId: run.runId,
        expectedState: run.state === "queued" ? "running" : run.state,
        nextState: "interrupted",
        startedAtMs: run.startedAtMs ?? interruptedAtMs,
        completedAtMs: interruptedAtMs,
        cancelledAtMs: run.cancelledAtMs,
        failureCategory: "provider.incomplete",
        failureMessage: "Environment-backed provider work cannot resume after backend restart.",
        activeProviderStepId: null,
      },
      { kind: "run.pendingInteractions.cancel", runId: run.runId, cancelledAtMs: interruptedAtMs },
    ];
    const committed = await this.storage.appendTransaction({
      events: [{
        eventId: this.ids.eventId(),
        eventType: "run.interrupted",
        createdAtMs: interruptedAtMs,
        data: {
          eventVersion: 2,
          runId: run.runId,
          code: "provider.incomplete",
          message: "Environment-backed provider work cannot resume after backend restart.",
          diagnosticId,
        },
      }],
      projections,
    });
    this.publish(committed.events);
  }

  private async initialize(): Promise<void> {
    try {
      await recoverSession({
        sessionId: this.sessionId,
        storage: this.storage,
        now: this.now,
        eventId: this.ids.eventId,
        diagnosticId: this.ids.diagnosticId,
        publishCommitted: (event) => this.publishOrThrow([event]),
        ...(this.onRecoveryFailureDiagnostic === undefined
          ? {}
          : { onFailureDiagnostic: this.onRecoveryFailureDiagnostic }),
        resumeToolLoop: this.resumeRestoredRuns,
        ...(this.currentToolEffectClass === undefined
          ? {}
          : { currentToolEffectClass: this.currentToolEffectClass }),
      });
      let runs = await this.storage.getNonterminalRuns();
      for (const run of runs) {
        if (this.shouldInterruptRestoredRun?.(run) === true) {
          await this.interruptRestoredRun(run);
        }
      }
      const restoredState = await Promise.all([
        this.storage.getNonterminalRuns(),
        this.storage.getPendingApprovals(),
        this.storage.getPendingInputs(),
      ]);
      runs = restoredState[0];
      const approvals = restoredState[1];
      const inputs = restoredState[2];
      for (const approval of approvals) this.pendingApprovals.set(approval.approvalId, approval);
      for (const input of inputs) this.pendingInputs.set(input.inputId, input);

      const active = runs.filter(
        (run) => run.state === "running" || run.state === "waiting_for_user" || run.state === "cancelling",
      );
      if (active.length > 1) {
        throw new SessionActorError(
          "session.run_already_active",
          `Session ${this.sessionId} has more than one durable active run`,
        );
      }
      const restored = active[0];
      if (restored !== undefined) {
        this.activeRun = {
          runId: restored.runId,
          generation: ++this.generation,
          scope: new CancellationController(),
          record: restored,
          context: null,
          confirmStopped: null,
          cancellation: null,
          task: null,
        };
      }
      for (const run of runs) {
        if (run.runId !== restored?.runId) this.queuedRuns.push(run);
      }
    } finally {
      this.recovering = false;
    }

    if (this.activeRun !== null && this.resumeRestoredRuns) {
      const waitsForInput =
        this.activeRun.record.state === "waiting_for_user" &&
        [...this.pendingInputs.values()].some((input) => input.runId === this.activeRun?.runId);
      // A restored input wait has no live task to wake. Keep it dormant until the durable
      // response transitions the run back to running, then launch reconstruction.
      if (!waitsForInput) this.launchTask(this.activeRun);
    } else if (this.activeRun === null && this.queuedRuns.length > 0) {
      await this.mailbox.enqueue(async () => this.startNextRun());
    }
  }

  get snapshot(): SessionActorSnapshot {
    const mailbox = this.mailbox.state;
    const idle =
      this.activeRun === null &&
      this.queuedRuns.length === 0 &&
      this.subscribers.size === 0 &&
      this.pendingApprovals.size === 0 &&
      this.pendingInputs.size === 0 &&
      this.cancellationCleanups.size === 0 &&
      mailbox.idle &&
      !this.recovering &&
      this.fault === null &&
      !this.closed;
    return {
      sessionId: this.sessionId,
      activeRunId: this.activeRun?.runId ?? null,
      activeRunState: this.activeRun?.record.state ?? null,
      queuedRunIds: this.queuedRuns.map((run) => run.runId),
      subscriberCount: this.subscribers.size,
      pendingApprovalCount: this.pendingApprovals.size,
      pendingInputCount: this.pendingInputs.size,
      cancellationCleanupCount: this.cancellationCleanups.size,
      mailboxQueued: mailbox.queued,
      mailboxRunning: mailbox.running,
      recovering: this.recovering,
      faulted: this.fault !== null,
      closed: this.closed,
      idle,
    };
  }

  isIdle(): boolean {
    return this.snapshot.idle;
  }

  setProviderDefault(
    command: SessionProviderDefaultSetCommand,
    resolveDefault: () => ResolvedSessionProviderDefaultCommand["params"]["default"] | Promise<ResolvedSessionProviderDefaultCommand["params"]["default"]>,
  ): Promise<AcceptedCommandResult> {
    const unavailable = this.rejectUnavailable<AcceptedCommandResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const payloadHash = await hashCommandContent(command);
      const duplicate = await this.storage.getAcceptedCommand(command.commandId);
      if (duplicate !== null) {
        if (
          duplicate.commandMethod !== command.method ||
          duplicate.payloadHash !== payloadHash
        ) {
          throw new SessionActorError(
            "protocol.command_id_conflict",
            `Command ${command.commandId} was reused with different content`,
          );
        }
        return duplicate;
      }
      const resolvedDefault = await resolveDefault();
      const createdAtMs = this.now();
      const eventId = this.ids.eventId();
      const acceptance = await this.acceptCommand({
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash,
        result: {
          connectionId: resolvedDefault.policy.connectionId,
          modelId: resolvedDefault.modelId,
        },
        acceptedAtMs: createdAtMs,
        runId: null,
        transaction: {
          events: [{
            eventId,
            eventType: "session.provider_default.set",
            createdAtMs,
            data: { eventVersion: 1, default: resolvedDefault },
          }],
          projections: [{
            kind: "session.providerDefault.put",
            default: resolvedDefault,
            eventId,
          }],
        },
      });
      this.publish(acceptance.events);
      return acceptance;
    });
  }

  submitMessage(command: MessageSubmitCommand): Promise<SubmitMessageResult> {
    const unavailable = this.rejectUnavailable<SubmitMessageResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const generatedRunId = this.ids.runId();
      const messageId = this.ids.messageId();
      const createdAtMs = this.now();
      const wasQueued = this.activeRun !== null || this.queuedRuns.length > 0;
      const payloadHash = await hashCommandContent(command);
      const existingCommand = await this.storage.getAcceptedCommand(command.commandId);
      const runId = existingCommand === null
        ? this.testFailpoints?.takeRunIdForCommand(
            this.sessionId,
            command.commandId,
          ) ?? generatedRunId
        : generatedRunId;
      let providerSnapshot: RunProviderSnapshot = {
        providerId: "duplicate",
        providerConfig: {},
        providerSelection: null,
      };
      let providerSnapshotCreated = false;
      if (existingCommand === null) {
        const createdProviderSnapshot = await this.createRunProviderSnapshot(command, runId);
        providerSnapshotCreated = true;
        if (createdProviderSnapshot.providerId.length === 0) {
          throw new SessionActorError("provider.protocol_error", "Run provider ID is empty");
        }
        providerSnapshot = {
          providerId: createdProviderSnapshot.providerId,
          providerConfig: decodeProviderConfiguration(createdProviderSnapshot.providerConfig),
          providerSelection: createdProviderSnapshot.providerSelection ?? null,
        };
      }
      const failpointFields = {
        sessionId: this.sessionId,
        commandId: command.commandId,
        runId,
      };
      const crashBeforeCommandCommit =
        this.testFailpoints?.matches(
          "after_command_event_insert_before_commit",
          failpointFields,
        ) === true;
      const input: AcceptCommandInput = {
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash,
        result: { runId, queued: wasQueued },
        acceptedAtMs: createdAtMs,
        runId,
        transaction: {
          ...(crashBeforeCommandCommit
            ? { testFailpoint: "after_command_event_insert_before_commit" as const }
            : {}),
          events: [
            {
              eventId: this.ids.eventId(),
              eventType: "user.message.appended",
              createdAtMs,
              data: { eventVersion: 1, messageId, runId, text: command.params.text },
            },
            {
              eventId: this.ids.eventId(),
              eventType: "run.created",
              createdAtMs,
              data: providerSnapshot.providerSelection === null
                ? { eventVersion: 1, runId }
                : {
                    eventVersion: 2,
                    runId,
                    providerSelection: providerSnapshot.providerSelection,
                  },
            },
          ],
          projections: [
            {
              kind: "run.put",
              runId,
              state: "queued",
              providerId: providerSnapshot.providerId,
              providerConfig: providerSnapshot.providerConfig,
              providerSelection: providerSnapshot.providerSelection,
              createdAtMs,
              startedAtMs: null,
              completedAtMs: null,
              cancelledAtMs: null,
              failureCategory: null,
              failureMessage: null,
              activeProviderStepId: null,
            },
            {
              kind: "message.put",
              messageId,
              runId,
              role: "user",
              state: "completed",
              createdAtMs,
              completedAtMs: createdAtMs,
            },
            {
              kind: "messagePart.put",
              partId: this.ids.partId(),
              messageId,
              partIndex: 0,
              partType: "text",
              textContent: command.params.text,
              data: null,
            },
          ],
        },
      };
      let acceptance: AcceptedCommandResult;
      try {
        acceptance = await this.acceptCommand(input);
      } catch (error) {
        if (crashBeforeCommandCommit) {
          this.testFailpoints?.hit(
            "after_command_event_insert_before_commit",
            failpointFields,
          );
        }
        if (providerSnapshotCreated) {
          try {
            await this.onRunProviderSnapshotRejected?.(runId);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `Run provider snapshot cleanup failed for ${runId}`,
            );
          }
        }
        throw error;
      }
      if (providerSnapshotCreated) this.onRunProviderSnapshotAccepted?.(runId);
      this.hitCommittedFailpoints(acceptance.events, runId);
      if (providerSnapshot.providerSelection?.credentialBackend.kind === "environment") {
        this.testFailpoints?.hit(
          "after_environment_run_acceptance_before_request",
          failpointFields,
        );
      }
      this.publish(acceptance.events);
      const acceptedRunId = acceptance.runId;
      if (acceptedRunId === null) {
        throw new SessionActorError("session.invalid_transition", "Accepted message has no run ID");
      }
      const knownRun =
        this.activeRun?.runId === acceptedRunId ||
        this.queuedRuns.some((record) => record.runId === acceptedRunId);
      if (!knownRun) {
        const record = await this.storage.getRun(acceptedRunId);
        if (record === null) throw new SessionActorError("session.not_found", "Accepted run disappeared");
        if (!isTerminalRunState(record.state)) this.queuedRuns.push(record);
      }
      if (this.activeRun === null) {
        try {
          await this.startNextRun();
        } catch (error) {
          // Acceptance is already durable. Fault explicitly instead of rejecting the accepted
          // command or leaving an apparently healthy queue with no future wake-up.
          this.recordFault(error);
        }
      }
      const queuedResult =
        typeof acceptance.result === "object" && acceptance.result !== null
          ? (acceptance.result as { readonly queued?: unknown })
          : {};
      const acceptedQueued =
        typeof queuedResult.queued === "boolean" ? queuedResult.queued : wasQueued;
      return { acceptance, runId: acceptedRunId, queued: acceptedQueued };
    });
  }

  private async startNextRun(): Promise<void> {
    if (
      this.activeRun !== null ||
      this.queuedRuns.length === 0 ||
      this.closed ||
      this.fault !== null
    ) {
      return;
    }
    const queued = this.queuedRuns[0];
    if (queued === undefined) return;
    const startedAtMs = this.now();
    const startEvent = {
      eventId: this.ids.eventId(),
      eventType: "run.started" as const,
      createdAtMs: startedAtMs,
      data: { eventVersion: 1 as const, runId: queued.runId },
    };
    let committed: AppendTransactionResult;
    let startedRecord: RunRecord;
    try {
      committed = await this.storage.appendTransaction({
        events: [startEvent],
        projections: [
          {
            kind: "run.state",
            runId: queued.runId,
            expectedState: queued.state,
            nextState: "running",
            startedAtMs,
            completedAtMs: null,
            cancelledAtMs: null,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: queued.activeProviderStepId,
          },
        ],
      });
      startedRecord = { ...queued, state: "running", startedAtMs };
    } catch (operationError) {
      let current: RunRecord | null;
      let event: SessionEvent | null;
      try {
        [current, event] = await Promise.all([
          this.storage.getRun(queued.runId),
          this.storage.getEventById(startEvent.eventId),
        ]);
      } catch {
        this.faultUnresolvedAmbiguousWrite(operationError);
        throw operationError;
      }
      if (current === null || current.state !== "running" || event === null) {
        const definitelyNotCommitted = current?.state === queued.state && event === null;
        if (!definitelyNotCommitted) this.faultUnresolvedAmbiguousWrite(operationError);
        throw operationError;
      }
      committed = { events: [event], headSequence: event.sequence };
      startedRecord = current;
    }
    const published = this.publish(committed.events);
    this.queuedRuns.shift();
    const active: ActiveRun = {
      runId: queued.runId,
      generation: ++this.generation,
      scope: new CancellationController(),
      record: startedRecord,
      context: null,
      confirmStopped: null,
      cancellation: null,
      task: null,
    };
    this.activeRun = active;
    this.touch();
    if (this.closed) {
      await this.finishRun(active.runId, active.generation, {
        state: "interrupted",
        code: "provider.cancelled",
        message: "Run start completed while the actor was shutting down.",
      });
      return;
    }
    if (!published) return;
    this.launchTask(active);
  }

  private launchTask(active: ActiveRun): void {
    const context: RunTaskContext = {
      sessionId: this.sessionId,
      runId: active.runId,
      generation: active.generation,
      signal: active.scope.signal,
      scheduler: this.scheduler,
      now: this.now,
      commitTransaction: (input, options) =>
        this.commitTaskTransaction(active.runId, active.generation, input, options),
      waitForApproval: (approvalId) => this.waitForApproval(approvalId, active.scope.signal),
      waitForInput: (inputId) =>
        this.waitForInput(inputId, active.runId, active.scope.signal),
    };
    let confirmStopped!: (result: RunTaskResult) => void;
    const stopped = new Promise<RunTaskResult>((resolve) => {
      confirmStopped = resolve;
    });
    active.context = context;
    active.confirmStopped = confirmStopped;
    const task = (): Promise<RunTaskResult | void> =>
      Promise.race([this.runTask(context), stopped]);
    const scheduled = this.runTaskOwnsSchedulerPermits
      ? task()
      : this.scheduler.withProviderPermit(active.scope.signal, task);
    active.task = scheduled
      .then((result): RunTaskResult => {
        if (result !== undefined && result.state !== "completed") return result;
        if (active.scope.cancelled && active.record.state === "running") {
          return {
            state: "interrupted",
            code: "provider.cancelled",
            message: "Run task stopped during actor shutdown.",
          };
        }
        return result ?? { state: "completed" };
      })
      .then(
        (result) => {
          // Handoff leaves durable state for recovery instead of inventing a terminal run.
          if (!isSessionActorHandoffSignal(active.scope.signal)) {
            this.postTaskOutcome(active.runId, active.generation, result);
          }
        },
        (error: unknown) => {
          if (isSessionActorHandoffSignal(active.scope.signal)) return;
          this.postTaskOutcome(active.runId, active.generation, {
            state: active.scope.cancelled ? "interrupted" : "failed",
            code: active.scope.cancelled ? "provider.cancelled" : "provider.protocol_error",
            failureCause: error,
          });
        },
      )
      .catch((error: unknown) => this.postFault(error));
  }

  private stopActiveTask(active: ActiveRun, reason: unknown): void {
    active.scope.cancel(reason);
    if (active.context === null || active.confirmStopped === null || active.cancellation !== null) {
      return;
    }
    const context = active.context;
    const confirmStopped = active.confirmStopped;
    let cancellationRequest: ReturnType<CancelRunTask>;
    try {
      // Capture the task's completion promise before an abort can settle and unregister it.
      cancellationRequest = this.cancelRunTask(context, reason);
    } catch (error) {
      cancellationRequest = Promise.reject(error);
    }
    const gracefulStop = Promise.resolve(cancellationRequest).then(
      (terminalResult) => ({
        stopped: true as const,
        terminalResult: terminalResult ?? null,
        cleanupError: null,
      }),
      (cleanupError: unknown) => ({
        stopped: true as const,
        terminalResult: null,
        cleanupError,
      }),
    );
    const cancellation = this.finishTaskCancellation(
      context,
      reason,
      gracefulStop,
      confirmStopped,
    ).catch((error: unknown) => this.postFault(error));
    active.cancellation = cancellation;
    this.cancellationCleanups.add(cancellation);
    void cancellation.then(() => {
      this.cancellationCleanups.delete(cancellation);
      this.touch();
    });
  }

  private isolateRunTask(context: RunTaskContext, reason: unknown): RunTaskIsolation {
    const isolation: unknown = this.forceStopRunTask(context, reason);
    assertRunTaskIsolation(isolation);
    if (isolation.cleanup !== undefined) {
      void Promise.resolve(isolation.cleanup).catch(() => {
        // Isolation already succeeded; later best-effort cleanup cannot affect run or permit state.
      });
    }
    return isolation;
  }

  private async finishTaskCancellation(
    context: RunTaskContext,
    reason: unknown,
    gracefulStop: Promise<{
      readonly stopped: true;
      readonly terminalResult: RunTaskResult | null;
      readonly cleanupError: unknown | null;
    }>,
    confirmStopped: (result: RunTaskResult) => void,
  ): Promise<void> {
    const stoppedBeforeDeadline = await this.cancellationWait(
      gracefulStop.then(() => undefined),
    );
    if (stoppedBeforeDeadline) {
      const result = await gracefulStop;
      if (result.cleanupError === null) {
        confirmStopped(
          result.terminalResult ?? {
            state: "interrupted",
            code: "provider.cancelled",
            message: "Run task cancellation completed.",
          },
        );
        return;
      }
      this.isolateRunTask(context, reason);
      confirmStopped({
        state: "interrupted",
        code: "provider.cancelled",
        failureCause: result.cleanupError,
        cancellationFailure: true,
      });
      return;
    }

    const isolation = this.isolateRunTask(context, reason);
    confirmStopped({
      state: "interrupted",
      code: "provider.cancelled",
      message: `Run task exceeded its cancellation deadline and its execution resource was ${isolation.status}.`,
      cancellationFailure: true,
    });
  }

  private async applyTaskOutcome(
    runId: string,
    generation: number,
    result: RunTaskResult,
  ): Promise<void> {
    try {
      await this.finishRun(runId, generation, result);
    } catch (error) {
      // Fault the actor before the mailbox can run another command.
      this.recordFault(error);
    }
  }

  private postTaskOutcome(runId: string, generation: number, result: RunTaskResult): void {
    this.mailbox.post(
      () => this.applyTaskOutcome(runId, generation, result),
      (error: unknown) => {
        if (!(error instanceof MailboxClosedError)) this.recordFault(error);
      },
    );
  }

  notifyTaskOutcome(
    runId: string,
    generation: number,
    result: RunTaskResult,
  ): Promise<void> {
    return this.mailbox.enqueue(() => this.applyTaskOutcome(runId, generation, result));
  }

  private async finishRun(
    runId: string,
    generation: number,
    result: RunTaskResult,
  ): Promise<void> {
    const active = this.activeRun;
    if (active === null || active.runId !== runId || active.generation !== generation) return;
    // Once durable state is ambiguous, reconstruction must decide the outcome.
    if (this.fault !== null) return;
    const terminal =
      result.cancellationFailure === true && active.record.state === "cancelling"
        ? "interrupted"
        : terminalStateForTask(active.record.state, result.state);
    if (terminal === null) return;
    const atMs = this.now();
    const isFailure = terminal === "failed" || terminal === "interrupted";
    const errorCode =
      result.code ?? (terminal === "interrupted" ? "provider.incomplete" : "provider.protocol_error");
    const message = safeRunFailureMessage(errorCode);
    const diagnosticId = isFailure
      ? (result.diagnosticId ?? this.ids.diagnosticId())
      : null;
    const event =
      isFailure
        ? {
            eventId: this.ids.eventId(),
            eventType: terminal === "failed" ? ("run.failed" as const) : ("run.interrupted" as const),
            createdAtMs: atMs,
            data: {
              eventVersion: 2 as const,
              runId,
              code: errorCode,
              message,
              diagnosticId: diagnosticId as string,
            },
          }
        : {
            eventId: this.ids.eventId(),
            eventType: terminal === "completed" ? ("run.completed" as const) : ("run.cancelled" as const),
            createdAtMs: atMs,
            data: { eventVersion: 1 as const, runId },
          };
    const transaction: AppendTransactionInput = {
      events: [event],
      projections: [
        {
          kind: "run.state",
          runId,
          expectedState: active.record.state,
          nextState: terminal,
          startedAtMs: active.record.startedAtMs,
          completedAtMs: terminal === "cancelled" ? active.record.completedAtMs : atMs,
          cancelledAtMs: terminal === "cancelled" ? atMs : active.record.cancelledAtMs,
          failureCategory: terminal === "failed" || terminal === "interrupted" ? errorCode : null,
          failureMessage: terminal === "failed" || terminal === "interrupted" ? message : null,
          activeProviderStepId: active.record.activeProviderStepId,
        },
        {
          kind: "run.pendingInteractions.cancel",
          runId,
          cancelledAtMs: atMs,
        },
      ],
    };
    let committed: AppendTransactionResult | null = null;
    let terminalRecord: RunRecord | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        committed = await this.storage.appendTransaction(transaction);
        terminalRecord = {
          ...active.record,
          state: terminal,
          completedAtMs: terminal === "cancelled" ? active.record.completedAtMs : atMs,
          cancelledAtMs: terminal === "cancelled" ? atMs : active.record.cancelledAtMs,
          failureCategory: terminal === "failed" || terminal === "interrupted" ? errorCode : null,
          failureMessage: terminal === "failed" || terminal === "interrupted" ? message : null,
        };
        break;
      } catch (error) {
        lastError = error;
        const current = await this.storage.getRun(runId);
        if (current !== null && isTerminalRunState(current.state)) {
          const recoveredEvent = await this.storage.getEventById(event.eventId);
          committed = {
            events: recoveredEvent === null ? [] : [recoveredEvent],
            headSequence: recoveredEvent?.sequence ?? 0,
          };
          terminalRecord = current;
          break;
        }
        if (current === null || current.state !== active.record.state || attempt === 1) throw error;
      }
    }
    if (committed === null || terminalRecord === null) throw lastError;
    this.testFailpoints?.hit("after_run_terminal_commit", {
      sessionId: this.sessionId,
      runId,
      headSequence: committed.events.at(-1)?.sequence,
    });
    this.publish(committed.events);
    if (isFailure && result.diagnosticId === undefined) {
      this.reportRunFailure({
        diagnosticId: diagnosticId as string,
        sessionId: this.sessionId,
        runId,
        state: terminal,
        code: errorCode,
        error:
          result.failureCause ??
          result.message ??
          new SessionActorError(errorCode, message),
      });
    }
    active.record = terminalRecord;
    for (const [approvalId, approval] of this.pendingApprovals) {
      if (approval.runId === runId) {
        this.pendingApprovals.delete(approvalId);
        this.settleApprovalWaiters(approvalId);
      }
    }
    for (const [inputId, input] of this.pendingInputs) {
      if (input.runId === runId) this.pendingInputs.delete(inputId);
    }
    for (const [approvalId, deferredRunId] of this.deferredApprovalRunIds) {
      if (deferredRunId === runId) this.deferredApprovalRunIds.delete(approvalId);
    }
    for (const [inputId, deferred] of this.deferredInputValues) {
      if (deferred.runId === runId) this.deferredInputValues.delete(inputId);
    }
    for (const [inputId, resolved] of this.resolvedInputValues) {
      if (resolved.runId === runId) this.resolvedInputValues.delete(inputId);
    }
    this.activeRun = null;
    this.touch();
    await this.startNextRun();
  }

  cancelRun(command: RunCancelCommand): Promise<CancelRunResult> {
    const unavailable = this.rejectUnavailable<CancelRunResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const identity = await this.commandIdentity(command);
      if (identity.duplicate !== null) {
        const current = await this.storage.getRun(command.params.runId);
        if (
          current !== null &&
          this.activeRun?.runId === current.runId &&
          current.state === "cancelling"
        ) {
          this.activeRun.record = current;
          this.stopActiveTask(this.activeRun, new Error("Run cancellation requested"));
        }
        return {
          state: this.acceptedRunState(identity.duplicate, "cancelling"),
          acceptance: identity.duplicate,
        };
      }
      const active = this.activeRun;
      if (active === null || active.runId !== command.params.runId) {
        const run = await this.storage.getRun(command.params.runId);
        if (run === null) throw new SessionActorError("session.not_found", "Run was not found");
        return this.acceptNoopCancellation(command, identity.payloadHash, run);
      }
      if (active.record.state === "cancelling") {
        return this.acceptNoopCancellation(command, identity.payloadHash, active.record);
      }
      if (active.record.state !== "running" && active.record.state !== "waiting_for_user") {
        return this.acceptNoopCancellation(command, identity.payloadHash, active.record);
      }

      const atMs = this.now();
      const acceptance = await this.acceptCommand({
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash: identity.payloadHash,
        result: { runId: active.runId, state: "cancelling" },
        acceptedAtMs: atMs,
        runId: active.runId,
        transaction: {
          events: [
            {
              eventId: this.ids.eventId(),
              eventType: "run.cancel.requested",
              createdAtMs: atMs,
              data: { eventVersion: 1, runId: active.runId },
            },
          ],
          projections: [
            {
              kind: "run.state",
              runId: active.runId,
              expectedState: active.record.state,
              nextState: "cancelling",
              startedAtMs: active.record.startedAtMs,
              completedAtMs: active.record.completedAtMs,
              cancelledAtMs: active.record.cancelledAtMs,
              failureCategory: active.record.failureCategory,
              failureMessage: active.record.failureMessage,
              activeProviderStepId: active.record.activeProviderStepId,
            },
          ],
        },
      });
      this.publish(acceptance.events);
      active.record = { ...active.record, state: "cancelling" };
      this.stopActiveTask(active, new Error("Run cancellation requested"));
      if (active.task === null) {
        void this.postTaskOutcome(active.runId, active.generation, {
          state: "interrupted",
          code: "provider.cancelled",
          message: "Run was cancelled.",
        });
      }
      return { state: "cancelling", acceptance };
    });
  }

  resolveApproval(command: ApprovalResolveCommand, clientId: string): Promise<AcceptedCommandResult> {
    const unavailable = this.rejectUnavailable<AcceptedCommandResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const identity = await this.commandIdentity(command);
      if (identity.duplicate !== null) {
        this.pendingApprovals.delete(command.params.approvalId);
        if (this.runTaskOwnsSchedulerPermits && identity.duplicate.runId !== null) {
          const current = await this.storage.getRun(identity.duplicate.runId);
          if (current !== null && this.activeRun?.runId === current.runId) {
            this.activeRun.record = current;
            this.deferredApprovalRunIds.set(command.params.approvalId, current.runId);
            if (current.state === "running") {
              this.releaseDeferredInteractionWaiters(current.runId);
              if (this.activeRun.task === null && this.resumeRestoredRuns) {
                this.launchTask(this.activeRun);
              }
            }
          }
        }
        return identity.duplicate;
      }
      const approval = this.pendingApprovals.get(command.params.approvalId);
      if (approval === undefined) {
        throw new SessionActorError(
          "approval.already_resolved",
          `Approval ${command.params.approvalId} is missing or already resolved`,
        );
      }
      const active = this.activeRun;
      if (active?.runId !== approval.runId || active.record.state !== "waiting_for_user") {
        throw new SessionActorError(
          "session.invalid_transition",
          `Approval ${approval.approvalId} does not belong to the active waiting run`,
        );
      }
      const atMs = this.now();
      const hasOtherPendingInteraction =
        [...this.pendingApprovals.values()].some(
          (pending) =>
            pending.runId === approval.runId && pending.approvalId !== approval.approvalId,
        ) ||
        [...this.pendingInputs.values()].some((input) => input.runId === approval.runId);
      const resumesRun = this.runTaskOwnsSchedulerPermits && !hasOtherPendingInteraction;
      const resolvedEvent = {
        eventId: this.ids.eventId(),
        eventType: "tool.approval.resolved" as const,
        createdAtMs: atMs,
        data: {
          eventVersion: 1 as const,
          runId: approval.runId,
          callId: approval.callId,
          approvalId: approval.approvalId,
          resolution: command.params.resolution,
        },
      };

      let transaction: AcceptCommandInput["transaction"];
      let denialDiagnostic: SessionToolFailureDiagnostic | null = null;
      if (this.runTaskOwnsSchedulerPermits) {
        const tool = await this.storage.getToolExecution?.(approval.callId);
        if (tool === null || tool === undefined || tool.effectClass === null) {
          throw new SessionActorError(
            "session.invalid_transition",
            `Approval ${approval.approvalId} has no classified tool execution`,
          );
        }
        if (tool.state !== "awaiting_approval") {
          throw new SessionActorError(
            "approval.already_resolved",
            `Approval ${approval.approvalId} tool is already resolved`,
          );
        }
        assertCurrentToolEffectClass(
          tool,
          this.currentToolEffectClass?.(tool.toolName) ?? null,
        );
        const denied = command.params.resolution === "denied";
        const denialMessage = "The user denied this tool call.";
        const denialEvent = denied
          ? (() => {
              const diagnosticId = this.ids.diagnosticId();
              denialDiagnostic = {
                diagnosticId,
                sessionId: this.sessionId,
                runId: approval.runId,
                stepId: tool.stepId,
                callId: tool.callId,
                toolName: tool.toolName,
                state: "failed",
                code: "tool.approval_denied",
                error: new SessionActorError("tool.approval_denied", denialMessage),
              };
              return {
                eventId: this.ids.eventId(),
                eventType: "tool.execution.failed" as const,
                createdAtMs: atMs,
                data: {
                  eventVersion: 2 as const,
                  runId: approval.runId,
                  callId: approval.callId,
                  code: "tool.approval_denied" as const,
                  message: denialMessage,
                  diagnosticId,
                },
              };
            })()
          : null;
        transaction = {
          events: [
            resolvedEvent,
            ...(denialEvent === null ? [] : [denialEvent]),
            ...(resumesRun
              ? [
                  {
                    eventId: this.ids.eventId(),
                    eventType: "run.started" as const,
                    createdAtMs: atMs,
                    data: { eventVersion: 1 as const, runId: approval.runId },
                  },
                ]
              : []),
          ],
          projections: [
            {
              kind: "approval.resolve",
              approvalId: approval.approvalId,
              resolution: command.params.resolution,
              resolvedAtMs: atMs,
              resolvedByClientId: clientId,
            },
            {
              kind: "toolExecution.put",
              callId: tool.callId,
              expectedState: "awaiting_approval",
              runId: tool.runId,
              stepId: tool.stepId,
              toolName: tool.toolName,
              argumentsJson: tool.argumentsJson,
              argumentsHash: tool.argumentsHash,
              effectClass: tool.effectClass,
              state: denied ? "denied" : "approved",
              attemptCount: tool.attemptCount,
              requestedAtMs: tool.requestedAtMs,
              startedAtMs: tool.startedAtMs,
              completedAtMs: denied ? atMs : tool.completedAtMs,
              result: tool.result,
              error: denied
                ? { code: "tool.approval_denied", message: denialMessage }
                : tool.error,
            },
            ...(resumesRun
              ? [
                  {
                    kind: "run.state" as const,
                    runId: approval.runId,
                    expectedState: "waiting_for_user" as const,
                    nextState: "running" as const,
                    startedAtMs: active.record.startedAtMs,
                    completedAtMs: null,
                    cancelledAtMs: null,
                    failureCategory: null,
                    failureMessage: null,
                    activeProviderStepId: active.record.activeProviderStepId,
                  },
                ]
              : []),
          ],
        };
      } else {
        transaction = {
          events: [resolvedEvent],
          projections: [
            {
              kind: "approval.resolve",
              approvalId: approval.approvalId,
              resolution: command.params.resolution,
              resolvedAtMs: atMs,
              resolvedByClientId: clientId,
            },
          ],
        };
      }

      const acceptance = await this.acceptCommand({
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash: identity.payloadHash,
        result: { approvalId: approval.approvalId, resolution: command.params.resolution },
        acceptedAtMs: atMs,
        runId: approval.runId,
        transaction,
      });
      this.publish(acceptance.events);
      this.applyProjectionMemory(transaction);
      if (denialDiagnostic !== null) this.reportToolFailure(denialDiagnostic);
      this.pendingApprovals.delete(approval.approvalId);
      if (this.runTaskOwnsSchedulerPermits) {
        this.deferredApprovalRunIds.set(approval.approvalId, approval.runId);
        if (resumesRun) this.releaseDeferredInteractionWaiters(approval.runId);
      }
      if (resumesRun && active.task === null && this.resumeRestoredRuns) {
        this.launchTask(active);
      }
      return acceptance;
    });
  }

  respondToInput(command: InputRespondCommand): Promise<AcceptedCommandResult> {
    const unavailable = this.rejectUnavailable<AcceptedCommandResult>();
    if (unavailable !== null) return unavailable;
    return this.mailbox.enqueue(async () => {
      this.assertNotFaulted();
      this.touch();
      const identity = await this.commandIdentity(command);
      if (identity.duplicate !== null) {
        this.pendingInputs.delete(command.params.inputId);
        const resolved = identity.duplicate.events.find(
          (
            event,
          ): event is Extract<SessionEvent, { readonly eventType: "input.resolved" }> =>
            event.eventType === "input.resolved" &&
            event.data.inputId === command.params.inputId,
        );
        if (resolved !== undefined) {
          const current = await this.storage.getRun(resolved.data.runId);
          if (current !== null && this.activeRun?.runId === current.runId) {
            this.activeRun.record = current;
            this.deferredInputValues.set(resolved.data.inputId, {
              runId: resolved.data.runId,
              value: resolved.data.value,
            });
            if (current.state === "running") {
              this.releaseDeferredInteractionWaiters(current.runId);
              if (this.activeRun.task === null && this.resumeRestoredRuns) {
                this.launchTask(this.activeRun);
              }
            }
          }
        }
        return identity.duplicate;
      }
      const input = this.pendingInputs.get(command.params.inputId);
      if (input === undefined) {
        throw new SessionActorError(
          "input.already_resolved",
          `Input ${command.params.inputId} is missing or already resolved`,
        );
      }
      const active = this.activeRun;
      if (active?.runId !== input.runId || active.record.state !== "waiting_for_user") {
        throw new SessionActorError(
          "session.invalid_transition",
          `Input ${input.inputId} does not belong to the active waiting run`,
        );
      }
      const atMs = this.now();
      const resolvedEvent = {
        eventId: this.ids.eventId(),
        eventType: "input.resolved" as const,
        createdAtMs: atMs,
        data: {
          eventVersion: 1 as const,
          runId: input.runId,
          inputId: input.inputId,
          value: command.params.value,
        },
      };
      const hasOtherPendingInteraction =
        [...this.pendingApprovals.values()].some((approval) => approval.runId === input.runId) ||
        [...this.pendingInputs.values()].some(
          (pending) => pending.runId === input.runId && pending.inputId !== input.inputId,
        );
      const resumesRun = !hasOtherPendingInteraction;
      const inputResolution = {
        kind: "input.resolve" as const,
        inputId: input.inputId,
        resolvedAtMs: atMs,
        value: command.params.value,
      };
      const transaction: AcceptCommandInput["transaction"] = resumesRun
        ? {
            events: [
              resolvedEvent,
              {
                eventId: this.ids.eventId(),
                eventType: "run.started",
                createdAtMs: atMs,
                data: { eventVersion: 1, runId: input.runId },
              },
            ],
            projections: [
              inputResolution,
              {
                kind: "run.state",
                runId: input.runId,
                expectedState: "waiting_for_user",
                nextState: "running",
                startedAtMs: active.record.startedAtMs,
                completedAtMs: null,
                cancelledAtMs: null,
                failureCategory: null,
                failureMessage: null,
                activeProviderStepId: active.record.activeProviderStepId,
              },
            ],
          }
        : { events: [resolvedEvent], projections: [inputResolution] };
      const acceptance = await this.acceptCommand({
        commandId: command.commandId,
        commandMethod: command.method,
        payloadHash: identity.payloadHash,
        result: { inputId: input.inputId },
        acceptedAtMs: atMs,
        runId: input.runId,
        transaction,
      });
      this.publish(acceptance.events);
      this.applyProjectionMemory(transaction);
      this.pendingInputs.delete(input.inputId);
      this.deferredInputValues.set(input.inputId, {
        runId: input.runId,
        value: command.params.value,
      });
      if (resumesRun) this.releaseDeferredInteractionWaiters(input.runId);
      if (resumesRun && active.task === null && this.resumeRestoredRuns) {
        this.launchTask(active);
      }
      return acceptance;
    });
  }

  subscriberConnected(subscriberId: string): Promise<void> {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    if (subscriberId.length === 0) return Promise.reject(new TypeError("Subscriber ID is required"));
    return this.mailbox.enqueue(() => {
      this.subscribers.add(subscriberId);
      this.touch();
    });
  }

  subscriberDisconnected(subscriberId: string): Promise<void> {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    if (subscriberId.length === 0) return Promise.reject(new TypeError("Subscriber ID is required"));
    return this.mailbox.enqueue(() => {
      this.subscribers.delete(subscriberId);
      this.touch();
    });
  }

  postSubscriberDisconnected(subscriberId: string): Promise<void> {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    if (subscriberId.length === 0) return Promise.reject(new TypeError("Subscriber ID is required"));
    return new Promise<void>((resolve, reject) => {
      // Publication callbacks inherit this actor's mailbox context, so queue cleanup without
      // creating a reentrant await cycle. The event publisher never awaits this callback.
      this.mailbox.post(() => {
        this.subscribers.delete(subscriberId);
        this.touch();
        resolve();
      }, reject);
    });
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.reject(new MailboxClosedError());
    return this.mailbox.enqueue(() => undefined);
  }

  shutdown(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = this.finishClose(
      new Error("Session actor is shutting down"),
      `Session actor ${this.sessionId}`,
    );
    return this.closePromise;
  }

  handoff(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.closePromise = this.finishClose(
      new SessionActorHandoffError(),
      `Session actor handoff ${this.sessionId}`,
    );
    return this.closePromise;
  }

  private async finishClose(reason: unknown, component: string): Promise<void> {
    const completion = this.completeClose(reason);
    if (!(await this.shutdownWait(completion))) {
      // The caller can now escalate without waiting forever. Keep late cleanup contained.
      void completion.catch(() => undefined);
      throw new ShutdownTimeoutError(component);
    }
    await completion;
  }

  private async completeClose(reason: unknown): Promise<void> {
    if (this.activeRun !== null) this.stopActiveTask(this.activeRun, reason);
    // Drain commands accepted before close. One may be committing run.started, so inspect
    // activeRun again after the barrier and stop the newly installed task as well.
    await this.mailbox.enqueue(() => undefined);
    if (this.activeRun !== null) this.stopActiveTask(this.activeRun, reason);
    const activeTask = this.activeRun?.task ?? null;
    if (activeTask !== null) await activeTask;
    while (this.cancellationCleanups.size > 0) {
      await Promise.all(this.cancellationCleanups);
    }
    await this.mailbox.shutdown();
    try {
      await this.storage.close?.();
    } finally {
      this.eventHub.releaseSession(this.sessionId);
    }
  }
}
