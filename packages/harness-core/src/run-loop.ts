import {
  PROVIDER_LIMITS,
  ProviderAdapterError,
  decodeProviderEvent,
  decodeProviderRequest,
  utf8ByteLength,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderRequest,
} from "@wi/provider-contract";
import {
  canonicalJsonHash,
  ToolCallIdSchema,
  type CanonicalJsonValue,
  type ErrorCode,
  type ToolEffectClass,
} from "@wi/protocol";
import type {
  BoundedProviderRequestData,
  BoundedProviderRequestDataInput,
  PendingApprovalRecord,
  ProviderStepRecord,
  RunRecord,
  ToolExecutionRecord,
} from "@wi/storage";
import {
  parseBoundedToolArgumentsJson,
  ToolArgumentsJsonError,
  ToolRegistryError,
  ToolTimeoutError,
  type ToolExecutor,
  type ToolRegistry,
  type ValidatedToolCall,
} from "@wi/tools";

import { safeRunFailureMessage } from "./failure-messages.js";
import {
  assertCurrentToolEffectClass,
  canRetryProviderStep,
  sameToolCallIdentity,
} from "./run-policy.js";
import {
  isSessionActorHandoffSignal,
  type CancelRunTask,
  type RunTask,
  type RunTaskContext,
  type RunTaskResult,
} from "./session-actor.js";
import {
  TextDeltaCoalescer,
  type CoalescerClock,
} from "./text-delta-coalescer.js";

export interface AgentRunStorage {
  readonly sessionId: string;
  getRun(runId: string): Promise<RunRecord | null>;
  getRunProviderMatch(
    runId: string,
    expectedProviderId: string,
  ): Promise<"missing" | "match" | "mismatch">;
  getBoundedProviderRequestData(
    input: BoundedProviderRequestDataInput,
  ): Promise<BoundedProviderRequestData>;
  getRecentProviderStepsForRun(
    runId: string,
    limit: number,
  ): Promise<readonly ProviderStepRecord[]>;
  getToolExecution(callId: string): Promise<ToolExecutionRecord | null>;
  getToolExecutionsForStep(stepId: string): Promise<readonly ToolExecutionRecord[]>;
  getPendingApprovals(): Promise<readonly PendingApprovalRecord[]>;
}

export interface AgentRunLoopIds {
  readonly eventId: () => string;
  readonly stepId: () => string;
  readonly messageId: () => string;
  readonly partId: () => string;
  readonly approvalId: () => string;
  readonly diagnosticId: () => string;
}

interface StepOutcome {
  readonly kind: "final" | "tools" | "retry" | "failed" | "interrupted";
  readonly code?: ErrorCode;
  readonly message?: string;
  readonly diagnosticId?: string;
}

interface AgentRunFailureDiagnosticBase {
  readonly diagnosticId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly state: "failed" | "interrupted";
  readonly code: ErrorCode;
  readonly error: unknown;
}

export type AgentRunFailureDiagnostic =
  | (AgentRunFailureDiagnosticBase & {
      readonly operation: "provider";
      readonly providerId: string;
    })
  | (AgentRunFailureDiagnosticBase & {
      readonly operation: "tool";
      readonly callId: string;
      readonly toolName: string;
    });

type AcceptedProviderTerminal =
  | { readonly type: "completed"; readonly responseId: string }
  | {
      readonly type: "failed";
      readonly category: "transient" | "transport" | "terminal" | "protocol";
      readonly message: string;
      readonly retryable: boolean;
    };

class RunLoopFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly interrupted: boolean,
    readonly diagnosticId?: string,
  ) {
    super(message);
    this.name = "RunLoopFailure";
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function toolError(
  code: ErrorCode,
  message: string,
): CanonicalJsonValue {
  return { code, message };
}

export class AgentRunLoop {
  readonly task: RunTask;
  readonly cancel: CancelRunTask;
  readonly currentToolEffectClass: (toolName: string) => ToolEffectClass | null;
  private readonly storage: AgentRunStorage;
  private readonly provider: ProviderAdapter;
  private readonly providerForRun: ((run: RunRecord) => ProviderAdapter | null) | undefined;
  private readonly registry: ToolRegistry;
  private readonly executor: ToolExecutor;
  private readonly ids: AgentRunLoopIds;
  private readonly coalescerClock: CoalescerClock | undefined;
  private readonly textMaxChars: number;
  private readonly textMaxDelayMs: number;
  private readonly retryBudget: number;
  private readonly onFailureDiagnostic:
    | ((diagnostic: AgentRunFailureDiagnostic) => void)
    | undefined;
  private readonly stopped = new Map<string, Promise<RunTaskResult | null>>();

  constructor(options: {
    readonly storage: AgentRunStorage;
    readonly provider: ProviderAdapter;
    readonly providerForRun?: (run: RunRecord) => ProviderAdapter | null;
    readonly registry: ToolRegistry;
    readonly executor: ToolExecutor;
    readonly ids: AgentRunLoopIds;
    readonly coalescerClock?: CoalescerClock;
    readonly textMaxChars?: number;
    readonly textMaxDelayMs?: number;
    readonly retryBudget?: number;
    readonly onFailureDiagnostic?: (diagnostic: AgentRunFailureDiagnostic) => void;
  }) {
    this.storage = options.storage;
    this.provider = options.provider;
    this.providerForRun = options.providerForRun;
    this.registry = options.registry;
    this.currentToolEffectClass =
      (toolName) => this.registry.get(toolName)?.effectClass ?? null;
    this.executor = options.executor;
    this.ids = options.ids;
    this.coalescerClock = options.coalescerClock;
    this.textMaxChars = options.textMaxChars ?? 256;
    this.textMaxDelayMs = options.textMaxDelayMs ?? 25;
    this.retryBudget = options.retryBudget ?? 1;
    this.onFailureDiagnostic = options.onFailureDiagnostic;
    if (
      !Number.isSafeInteger(this.retryBudget) ||
      this.retryBudget < 0 ||
      this.retryBudget > 1022
    ) {
      throw new RangeError("Provider retry budget must be a safe integer between 0 and 1022");
    }

    this.task = async (context) => {
      let resolveStopped: (result: RunTaskResult | null) => void = () => {};
      const stopped = new Promise<RunTaskResult | null>((resolve) => {
        resolveStopped = resolve;
      });
      this.stopped.set(context.runId, stopped);
      try {
        const result = await this.execute(context);
        resolveStopped(result);
        return result;
      } finally {
        resolveStopped(null);
        this.stopped.delete(context.runId);
      }
    };
    this.cancel = async (context) => (await this.stopped.get(context.runId)) ?? undefined;
  }

  private reportFailure(
    context: RunTaskContext,
    state: "failed" | "interrupted",
    code: ErrorCode,
    error: unknown,
    stepId: string | null,
    providerId: string,
  ): string {
    const diagnosticId = this.ids.diagnosticId();
    try {
      this.onFailureDiagnostic?.({
        operation: "provider",
        diagnosticId,
        sessionId: context.sessionId,
        runId: context.runId,
        stepId,
        providerId,
        state,
        code,
        error,
      });
    } catch {
      // Diagnostics must never replace the durable run outcome.
    }
    return diagnosticId;
  }

  private reportToolFailure(
    context: RunTaskContext,
    state: "failed" | "interrupted",
    code: ErrorCode,
    error: unknown,
    tool: Pick<ToolExecutionRecord, "stepId" | "callId" | "toolName">,
  ): string {
    const diagnosticId = this.ids.diagnosticId();
    try {
      this.onFailureDiagnostic?.({
        operation: "tool",
        diagnosticId,
        sessionId: context.sessionId,
        runId: context.runId,
        stepId: tool.stepId,
        callId: tool.callId,
        toolName: tool.toolName,
        state,
        code,
        error,
      });
    } catch {
      // Diagnostics must never replace the durable tool outcome.
    }
    return diagnosticId;
  }

  private failureResult(
    context: RunTaskContext,
    state: "failed" | "interrupted",
    code: ErrorCode,
    error: unknown,
    diagnosticId?: string,
    providerId = this.provider.id,
  ): RunTaskResult {
    return {
      state,
      code,
      message: safeRunFailureMessage(code),
      diagnosticId: diagnosticId ?? this.reportFailure(
        context,
        state,
        code,
        error,
        null,
        providerId,
      ),
    };
  }

  private async execute(context: RunTaskContext): Promise<RunTaskResult> {
    let selectedProviderId = this.provider.id;
    try {
      const selectedRun = await this.storage.getRun(context.runId);
      if (selectedRun === null) {
        throw new RunLoopFailure("session.not_found", "Run was not found.", false);
      }
      selectedProviderId = selectedRun.providerId;
      const provider = this.providerForRun?.(selectedRun) ??
        (selectedRun.providerId === this.provider.id ? this.provider : null);
      if (provider === null || provider.id !== selectedRun.providerId) {
        throw new RunLoopFailure(
          "provider.not_implemented",
          "The selected provider adapter is not available.",
          false,
        );
      }

      let retryAttempt = 0;
      while (true) {
        context.signal.throwIfAborted();
        const steps = await this.storage.getRecentProviderStepsForRun(
          context.runId,
          this.retryBudget + 2,
        );
        const latest = steps.at(-1);
        let stepIndex = latest === undefined ? 0 : latest.stepIndex + 1;

        if (latest !== undefined) {
          if (latest.state === "completed") {
            const calls = await this.storage.getToolExecutionsForStep(latest.stepId);
            if (calls.length === 0) return { state: "completed" };
            await this.processToolCalls(context, calls);
            retryAttempt = 0;
          } else if (
            latest.state === "failed" &&
            latest.errorCategory === "provider.transient_before_output"
          ) {
            retryAttempt = 0;
            // A successful provider step starts a new continuation with its own retry budget.
            for (let index = steps.length - 1; index >= 0; index -= 1) {
              const step = steps[index];
              if (
                step?.state !== "failed" ||
                step.errorCategory !== "provider.transient_before_output"
              ) {
                break;
              }
              retryAttempt += 1;
            }
            if (retryAttempt > this.retryBudget) {
              return this.failureResult(
                context,
                "failed",
                "provider.transient_before_output",
                latest.errorMessage,
                latest.diagnosticId ?? undefined,
              );
            }
          } else if (latest.state === "failed") {
            const code =
              (latest.errorCategory as ErrorCode | null) ?? "provider.protocol_error";
            return this.failureResult(
              context,
              "failed",
              code,
              latest.errorMessage,
              latest.diagnosticId ?? undefined,
            );
          } else if (latest.state === "interrupted" || latest.state === "cancelled") {
            return this.failureResult(
              context,
              "interrupted",
              "provider.incomplete",
              latest.errorMessage,
              latest.diagnosticId ?? undefined,
            );
          } else if (latest.state === "streaming" || latest.state === "created") {
            throw new RunLoopFailure(
              "provider.incomplete",
              "A live provider step cannot be adopted without recovery.",
              true,
            );
          }
          stepIndex = latest.stepIndex + 1;
        }

        const outcome = await this.runProviderStep(
          context,
          context.runId,
          stepIndex,
          retryAttempt,
          provider,
        );
        switch (outcome.kind) {
          case "final":
            return { state: "completed" };
          case "tools":
            retryAttempt = 0;
            continue;
          case "retry": {
            retryAttempt += 1;
            if (retryAttempt <= this.retryBudget) continue;
            const code = outcome.code ?? "provider.transient_before_output";
            return this.failureResult(
              context,
              "failed",
              code,
              outcome.message,
              outcome.diagnosticId,
            );
          }
          case "failed": {
            const code = outcome.code ?? "provider.protocol_error";
            return this.failureResult(
              context,
              "failed",
              code,
              outcome.message,
              outcome.diagnosticId,
            );
          }
          case "interrupted": {
            const code = outcome.code ?? "provider.incomplete";
            return this.failureResult(
              context,
              "interrupted",
              code,
              outcome.message,
              outcome.diagnosticId,
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof RunLoopFailure && error.code === "tool.outcome_unknown") {
        return this.failureResult(
          context,
          "interrupted",
          error.code,
          error,
          error.diagnosticId,
          selectedProviderId,
        );
      }
      if (isAborted(context.signal)) {
        return this.failureResult(
          context,
          "interrupted",
          "provider.cancelled",
          error,
          error instanceof RunLoopFailure ? error.diagnosticId : undefined,
          selectedProviderId,
        );
      }
      if (error instanceof RunLoopFailure) {
        return this.failureResult(
          context,
          error.interrupted ? "interrupted" : "failed",
          error.code,
          error,
          error.diagnosticId,
          selectedProviderId,
        );
      }
      return this.failureResult(
        context,
        "failed",
        "provider.protocol_error",
        error,
        undefined,
        selectedProviderId,
      );
    }
  }

  private async providerRequest(
    runId: string,
    stepId: string,
    stepIndex: number,
    provider: ProviderAdapter,
  ): Promise<ProviderRequest> {
    const snapshot = await this.storage.getBoundedProviderRequestData({
      runId,
      stepId,
      stepIndex,
      expectedProviderId: provider.id,
      maxProviderConfigBytes: PROVIDER_LIMITS.providerConfigMaxBytes,
      maxMessageTextBytes: PROVIDER_LIMITS.messageTextMaxBytes,
      maxToolNameBytes: PROVIDER_LIMITS.toolNameMaxBytes,
      maxInputItems: PROVIDER_LIMITS.inputItemMaxCount,
      maxRequestBytes: PROVIDER_LIMITS.requestMaxBytes,
    });
    if (snapshot.status === "missing") {
      throw new RunLoopFailure("session.not_found", "Run was not found.", false);
    }
    if (snapshot.status === "provider_mismatch") {
      throw new RunLoopFailure(
        "provider.protocol_error",
        "Run provider identity changed while acquiring provider input.",
        false,
      );
    }
    if (snapshot.status === "unsafe_outcome_unknown") {
      throw new RunLoopFailure(
        "tool.outcome_unknown",
        "A durable tool outcome is unknown, so provider continuation is unsafe.",
        true,
      );
    }
    if (snapshot.status === "limit_exceeded") {
      throw new RunLoopFailure(
        "provider.protocol_error",
        `Provider request acquisition exceeded its ${snapshot.boundary} limit.`,
        false,
      );
    }
    return decodeProviderRequest(JSON.parse(snapshot.requestJson) as unknown);
  }

  private assertEventIdentity(event: ProviderEvent, request: ProviderRequest): void {
    if (
      event.runId !== request.runId ||
      event.stepId !== request.stepId ||
      event.stepIndex !== request.stepIndex
    ) {
      throw new RunLoopFailure(
        "provider.protocol_error",
        "Provider emitted a stale event for another run or step.",
        false,
      );
    }
  }

  private async runProviderStep(
    context: RunTaskContext,
    runId: string,
    stepIndex: number,
    attempt: number,
    provider: ProviderAdapter,
  ): Promise<StepOutcome> {
    const stepId = this.ids.stepId();
    const startedAtMs = context.now();
    let request: ProviderRequest;
    try {
      request = await this.providerRequest(runId, stepId, stepIndex, provider);
    } catch (error) {
      if (error instanceof RunLoopFailure) throw error;
      throw new RunLoopFailure(
        "provider.protocol_error",
        "Provider request does not match the runtime contract or limits.",
        false,
      );
    }
    const run = { runId };
    const current = await this.storage.getRun(run.runId);
    if (current === null) throw new RunLoopFailure("session.not_found", "Run disappeared.", false);
    await context.commitTransaction({
      events: [
        {
          eventId: this.ids.eventId(),
          eventType: "provider.step.started",
          createdAtMs: startedAtMs,
          data: { eventVersion: 1, runId: run.runId, stepId, stepIndex },
        },
      ],
      projections: [
        {
          kind: "run.activeProviderStep",
          runId: run.runId,
          expectedActiveProviderStepId: current.activeProviderStepId,
          activeProviderStepId: stepId,
        },
        {
          kind: "providerStep.put",
          stepId,
          runId: run.runId,
          stepIndex,
          state: "created",
          startedAtMs,
          completedAtMs: null,
          responseId: null,
          errorCategory: null,
          errorMessage: null,
        },
        {
          kind: "providerStep.put",
          stepId,
          expectedState: "created",
          runId: run.runId,
          stepIndex,
          state: "streaming",
          startedAtMs,
          completedAtMs: null,
          responseId: null,
          errorCategory: null,
          errorMessage: null,
        },
      ],
    });

    const messageId = this.ids.messageId();
    const partId = this.ids.partId();
    let fullText = "";
    let acceptedTextBytes = 0;
    let visibleText = false;
    let semanticOutput = false;
    let responseId: string | null = null;
    let terminal: AcceptedProviderTerminal | null = null;
    const seenCallIds = new Set<string>();

    const coalescer = new TextDeltaCoalescer({
      maxChars: this.textMaxChars,
      maxDelayMs: this.textMaxDelayMs,
      onFlush: async (text) => {
        const nextText = fullText + text;
        const atMs = context.now();
        try {
          await context.commitTransaction(
            {
              events: [
                {
                  eventId: this.ids.eventId(),
                  eventType: "provider.text.delta",
                  createdAtMs: atMs,
                  data: { eventVersion: 1, runId: run.runId, stepId, messageId, partId, text },
                },
              ],
              projections: [
                {
                  kind: "message.put",
                  messageId,
                  runId: run.runId,
                  role: "assistant",
                  state: "streaming",
                  createdAtMs: startedAtMs,
                  completedAtMs: null,
                },
                {
                  kind: "messagePart.put",
                  partId,
                  messageId,
                  partIndex: 0,
                  partType: "text",
                  textContent: nextText,
                  data: null,
                },
              ],
            },
            { cancellationCleanup: "provider_text" },
          );
        } catch {
          throw new RunLoopFailure(
            "storage.worker_failed",
            "Provider text could not be persisted.",
            false,
          );
        }
        // Only committed text may influence later terminal message projections.
        fullText = nextText;
        visibleText = true;
      },
      ...(this.coalescerClock === undefined ? {} : { clock: this.coalescerClock }),
    });

    try {
      await context.scheduler.withProviderPermit(context.signal, async () => {
        for await (const value of provider.stream(
          request,
          { sessionId: context.sessionId, attempt, now: context.now },
          context.signal,
        )) {
          let event: ProviderEvent;
          try {
            event = decodeProviderEvent(value);
          } catch {
            throw new RunLoopFailure(
              "provider.protocol_error",
              "Provider event does not match the runtime contract or limits.",
              false,
            );
          }
          this.assertEventIdentity(event, request);
          if (terminal !== null) {
            // An identical terminal marker is harmless; all other post-terminal data is invalid.
            const duplicateCompletion =
              terminal.type === "completed" &&
              event.type === "response.completed" &&
              terminal.responseId === event.responseId;
            const duplicateFailure =
              terminal.type === "failed" &&
              event.type === "response.failed" &&
              terminal.category === event.category &&
              terminal.message === event.message &&
              terminal.retryable === event.retryable;
            if (duplicateCompletion || duplicateFailure) continue;
            throw new RunLoopFailure(
              "provider.protocol_error",
              "Provider emitted conflicting data after a terminal event.",
              false,
            );
          }
          switch (event.type) {
            case "response.started":
              if (responseId !== null) {
                throw new RunLoopFailure(
                  "provider.protocol_error",
                  "Provider emitted response.started more than once.",
                  false,
                );
              }
              responseId = event.responseId;
              break;
            case "text.delta": {
              if (responseId === null) {
                throw new RunLoopFailure(
                  "provider.protocol_error",
                  "Provider text arrived before response.started.",
                  false,
                );
              }
              semanticOutput = true;
              const deltaBytes = utf8ByteLength(event.delta);
              if (acceptedTextBytes > PROVIDER_LIMITS.responseTextMaxBytes - deltaBytes) {
                throw new RunLoopFailure(
                  "provider.protocol_error",
                  "Provider response text exceeded its cumulative limit.",
                  false,
                );
              }
              acceptedTextBytes += deltaBytes;
              await coalescer.push(event.delta);
              break;
            }
            case "tool_call.completed":
              if (responseId === null) {
                throw new RunLoopFailure(
                  "provider.protocol_error",
                  "Provider tool call arrived before response.started.",
                  false,
                );
              }
              await coalescer.flush();
              semanticOutput = true;
              await this.stageToolCall(context, run.runId, stepId, event, seenCallIds);
              break;
            case "response.completed":
              if (responseId === null || event.responseId !== responseId) {
                throw new RunLoopFailure(
                  "provider.protocol_error",
                  "Provider completion response identity changed.",
                  false,
                );
              }
              terminal = { type: "completed", responseId: event.responseId };
              break;
            case "response.failed":
              if (responseId === null) {
                throw new RunLoopFailure(
                  "provider.protocol_error",
                  "Provider failure arrived before response.started.",
                  false,
                );
              }
              terminal = {
                type: "failed",
                category: event.category,
                message: event.message,
                retryable: event.retryable,
              };
              break;
          }
        }
      });
      await coalescer.flush();
    } catch (error) {
      await coalescer.flush().catch(() => undefined);
      if (isAborted(context.signal)) {
        const code = "provider.cancelled" as const;
        const diagnosticId = await this.finishInterruptedStep(
          context,
          run.runId,
          stepId,
          stepIndex,
          startedAtMs,
          responseId,
          visibleText ? { messageId, partId, fullText } : null,
          code,
          context.signal.reason,
          "interrupted",
          provider.id,
        );
        return {
          kind: "interrupted",
          code,
          message: safeRunFailureMessage(code),
          diagnosticId,
        };
      }
      const adapterError = error instanceof ProviderAdapterError ? error : null;
      const transientBeforeOutput =
        adapterError?.category === "transient" &&
        adapterError.retryable &&
        !semanticOutput &&
        !visibleText;
      const retryable = canRetryProviderStep({
        transient: transientBeforeOutput,
        semanticOutputCommitted: semanticOutput || visibleText,
        completedToolCallAccepted: semanticOutput && !visibleText,
        toolStarted: false,
        cancelled: false,
        attempt,
        budget: this.retryBudget,
      });
      let code: ErrorCode = "provider.protocol_error";
      if (transientBeforeOutput) code = "provider.transient_before_output";
      else if (error instanceof RunLoopFailure) code = error.code;
      else if (semanticOutput || visibleText) code = "provider.transport_after_output";
      const stepState =
        code !== "provider.protocol_error" && (semanticOutput || visibleText)
          ? "interrupted"
          : "failed";
      const diagnosticId = await this.finishInterruptedStep(
        context,
        run.runId,
        stepId,
        stepIndex,
        startedAtMs,
        responseId,
        visibleText ? { messageId, partId, fullText } : null,
        code,
        error,
        stepState,
        provider.id,
      );
      const message = safeRunFailureMessage(code);
      if (retryable) return { kind: "retry", code, message, diagnosticId };
      return {
        kind: stepState === "interrupted" ? "interrupted" : "failed",
        code,
        message,
        diagnosticId,
      };
    } finally {
      await coalescer.close().catch(() => undefined);
    }

    const acceptedTerminal = terminal as AcceptedProviderTerminal | null;
    if (acceptedTerminal === null) {
      const code = "provider.incomplete" as const;
      const detail = "Provider stream closed without a terminal event.";
      const diagnosticId = await this.finishInterruptedStep(
        context,
        run.runId,
        stepId,
        stepIndex,
        startedAtMs,
        responseId,
        visibleText ? { messageId, partId, fullText } : null,
        code,
        detail,
        "interrupted",
        provider.id,
      );
      return {
        kind: "interrupted",
        code,
        message: safeRunFailureMessage(code),
        diagnosticId,
      };
    }

    if (acceptedTerminal.type === "failed") {
      const transientBeforeOutput =
        acceptedTerminal.retryable &&
        acceptedTerminal.category === "transient" &&
        !semanticOutput &&
        !visibleText;
      const retryable = canRetryProviderStep({
        transient: transientBeforeOutput,
        semanticOutputCommitted: semanticOutput || visibleText,
        completedToolCallAccepted: semanticOutput && !visibleText,
        toolStarted: false,
        cancelled: isAborted(context.signal),
        attempt,
        budget: this.retryBudget,
      });
      let code: ErrorCode = "provider.protocol_error";
      if (transientBeforeOutput) code = "provider.transient_before_output";
      else if (semanticOutput) code = "provider.transport_after_output";
      const stepState = semanticOutput ? "interrupted" : "failed";
      const diagnosticId = await this.finishInterruptedStep(
        context,
        run.runId,
        stepId,
        stepIndex,
        startedAtMs,
        responseId,
        visibleText ? { messageId, partId, fullText } : null,
        code,
        acceptedTerminal.message,
        stepState,
        provider.id,
      );
      const message = safeRunFailureMessage(code);
      if (retryable) return { kind: "retry", code, message, diagnosticId };
      return {
        kind: semanticOutput ? "interrupted" : "failed",
        code,
        message,
        diagnosticId,
      };
    }

    try {
      return await this.promoteCompletedStep(
        context,
        run.runId,
        stepId,
        stepIndex,
        startedAtMs,
        acceptedTerminal.responseId,
        visibleText ? { messageId, partId, fullText } : null,
      );
    } catch (error) {
      const cancelled = isAborted(context.signal);
      const code: ErrorCode = cancelled ? "provider.cancelled" : "provider.protocol_error";
      const stepState = cancelled ? "interrupted" : "failed";
      const diagnosticId = await this.finishInterruptedStep(
        context,
        run.runId,
        stepId,
        stepIndex,
        startedAtMs,
        responseId,
        visibleText ? { messageId, partId, fullText } : null,
        code,
        error,
        stepState,
        provider.id,
      );
      return {
        kind: stepState,
        code,
        message: safeRunFailureMessage(code),
        diagnosticId,
      };
    }
  }

  private async stageToolCall(
    context: RunTaskContext,
    runId: string,
    stepId: string,
    event: Extract<ProviderEvent, { readonly type: "tool_call.completed" }>,
    seenCallIds: Set<string>,
  ): Promise<void> {
    ToolCallIdSchema.parse(event.callId);
    if (!seenCallIds.has(event.callId) && seenCallIds.size >= PROVIDER_LIMITS.toolCallMaxCountPerStep) {
      throw new RunLoopFailure(
        "provider.protocol_error",
        "Provider step emitted too many tool calls.",
        false,
      );
    }
    if (event.name.length === 0) {
      throw new RunLoopFailure("provider.protocol_error", "Provider tool name is empty.", false);
    }
    let argumentsJson: string;
    let argumentsValue: CanonicalJsonValue;
    try {
      const bounded = parseBoundedToolArgumentsJson(event.argumentsJson);
      argumentsJson = bounded.argumentsJson;
      argumentsValue = bounded.value;
    } catch (error) {
      const message =
        error instanceof ToolArgumentsJsonError
          ? error.message
          : "Completed provider tool arguments are not valid JSON.";
      throw new RunLoopFailure("provider.protocol_error", message, false);
    }
    const argumentsHash = await canonicalJsonHash(argumentsValue);
    const existing = await this.storage.getToolExecution(event.callId);
    if (existing !== null) {
      if (
        !sameToolCallIdentity(existing, {
          runId,
          toolName: event.name,
          argumentsJson,
          argumentsHash,
          effectClass: this.currentToolEffectClass(event.name),
        })
      ) {
        throw new RunLoopFailure(
          "provider.protocol_error",
          `Provider reused tool call ${event.callId} with different identity.`,
          false,
        );
      }
      if (existing.stepId !== stepId && !seenCallIds.has(event.callId)) {
        const atMs = context.now();
        await context.commitTransaction({
          events: [
            {
              eventId: this.ids.eventId(),
              eventType: "provider.tool_call.reused",
              createdAtMs: atMs,
              data: {
                eventVersion: 1,
                runId,
                stepId,
                callId: event.callId,
                originalStepId: existing.stepId,
              },
            },
          ],
          projections: [
            {
              kind: "toolCallOccurrence.put",
              runId,
              stepId,
              callId: event.callId,
              occurredAtMs: atMs,
            },
          ],
        });
      }
      seenCallIds.add(event.callId);
      return;
    }
    const atMs = context.now();
    await context.commitTransaction({
      events: [
        {
          eventId: this.ids.eventId(),
          eventType: "provider.tool_call.staged",
          createdAtMs: atMs,
          data: {
            eventVersion: 1,
            runId,
            stepId,
            callId: event.callId,
            name: event.name,
            argumentsJson,
          },
        },
      ],
      projections: [
        {
          kind: "toolExecution.put",
          callId: event.callId,
          runId,
          stepId,
          toolName: event.name,
          argumentsJson,
          argumentsHash,
          effectClass: null,
          state: "staged",
          attemptCount: 0,
          requestedAtMs: atMs,
          startedAtMs: null,
          completedAtMs: null,
          result: null,
          error: null,
        },
        {
          kind: "toolCallOccurrence.put",
          runId,
          stepId,
          callId: event.callId,
          occurredAtMs: atMs,
        },
      ],
    });
    seenCallIds.add(event.callId);
  }

  private async finishInterruptedStep(
    context: RunTaskContext,
    runId: string,
    stepId: string,
    stepIndex: number,
    startedAtMs: number,
    responseId: string | null,
    message: { readonly messageId: string; readonly partId: string; readonly fullText: string } | null,
    code: ErrorCode,
    diagnosticError: unknown,
    stepState: "failed" | "interrupted",
    providerId: string,
  ): Promise<string> {
    const atMs = context.now();
    const failureMessage = safeRunFailureMessage(code);
    const diagnosticId = this.reportFailure(
      context,
      stepState,
      code,
      diagnosticError,
      stepId,
      providerId,
    );
    const staged = (await this.storage.getToolExecutionsForStep(stepId)).filter(
      (tool) => tool.state === "staged",
    );
    await context.commitTransaction(
      {
        events: [
          {
            eventId: this.ids.eventId(),
            eventType:
              stepState === "failed" ? "provider.step.failed" : "provider.step.interrupted",
            createdAtMs: atMs,
            data: {
              eventVersion: 2,
              runId,
              stepId,
              code,
              message: failureMessage,
              diagnosticId,
            },
          },
        ],
        projections: [
          {
            kind: "providerStep.put",
            stepId,
            expectedState: "streaming",
            runId,
            stepIndex,
            state: stepState,
            startedAtMs,
            completedAtMs: atMs,
            responseId,
            errorCategory: code,
            errorMessage: failureMessage,
            diagnosticId,
          },
          ...staged.map((tool) => ({
            kind: "toolExecution.put" as const,
            callId: tool.callId,
            expectedState: "staged" as const,
            runId: tool.runId,
            stepId: tool.stepId,
            toolName: tool.toolName,
            argumentsJson: tool.argumentsJson,
            argumentsHash: tool.argumentsHash,
            effectClass: tool.effectClass,
            state: "discarded" as const,
            attemptCount: tool.attemptCount,
            requestedAtMs: tool.requestedAtMs,
            startedAtMs: tool.startedAtMs,
            completedAtMs: atMs,
            result: tool.result,
            error: toolError(code, failureMessage),
          })),
          {
            kind: "run.activeProviderStep",
            runId,
            expectedActiveProviderStepId: stepId,
            activeProviderStepId: null,
          },
          ...(message === null
            ? []
            : [
                {
                  kind: "message.put" as const,
                  messageId: message.messageId,
                  runId,
                  role: "assistant" as const,
                  state: "interrupted",
                  createdAtMs: startedAtMs,
                  completedAtMs: atMs,
                },
                {
                  kind: "messagePart.put" as const,
                  partId: message.partId,
                  messageId: message.messageId,
                  partIndex: 0,
                  partType: "text",
                  textContent: message.fullText,
                  data: null,
                },
              ]),
        ],
      },
      { cancellationCleanup: "provider_step" },
    );
    return diagnosticId;
  }

  private async promoteCompletedStep(
    context: RunTaskContext,
    runId: string,
    stepId: string,
    stepIndex: number,
    startedAtMs: number,
    responseId: string,
    message: { readonly messageId: string; readonly partId: string; readonly fullText: string } | null,
  ): Promise<StepOutcome> {
    const atMs = context.now();
    const calls = await this.storage.getToolExecutionsForStep(stepId);
    const staged = calls.filter((tool) => tool.state === "staged");
    const toolEvents: Parameters<RunTaskContext["commitTransaction"]>[0]["events"][number][] = [];
    const toolProjections: Parameters<RunTaskContext["commitTransaction"]>[0]["projections"] = [];

    for (const tool of staged) {
      try {
        const validated = this.registry.validate(tool.toolName, tool.argumentsJson);
        const canonicalHash = await canonicalJsonHash(validated.arguments);
        if (canonicalHash !== tool.argumentsHash) {
          throw new RunLoopFailure(
            "provider.protocol_error",
            `Tool call ${tool.callId} arguments changed before promotion.`,
            false,
          );
        }
        toolEvents.push({
          eventId: this.ids.eventId(),
          eventType: "tool.call.requested",
          createdAtMs: atMs,
          data: {
            eventVersion: 1,
            runId,
            stepId,
            callId: tool.callId,
            name: tool.toolName,
            argumentsJson: tool.argumentsJson,
            argumentsHash: tool.argumentsHash,
            effectClass: validated.definition.effectClass,
          },
        });
        toolProjections.push({
          kind: "toolExecution.put",
          callId: tool.callId,
          expectedState: "staged",
          runId: tool.runId,
          stepId: tool.stepId,
          toolName: tool.toolName,
          argumentsJson: tool.argumentsJson,
          argumentsHash: tool.argumentsHash,
          effectClass: validated.definition.effectClass,
          state: "requested",
          attemptCount: tool.attemptCount,
          requestedAtMs: tool.requestedAtMs,
          startedAtMs: null,
          completedAtMs: null,
          result: null,
          error: null,
        });
      } catch (error) {
        if (error instanceof RunLoopFailure) throw error;
        const code: ErrorCode =
          error instanceof ToolRegistryError && error.code === "tool.unknown"
            ? "tool.unknown"
            : "tool.invalid_arguments";
        const failure = safeRunFailureMessage(code);
        const diagnosticId = this.reportToolFailure(
          context,
          "failed",
          code,
          error,
          tool,
        );
        toolEvents.push({
          eventId: this.ids.eventId(),
          eventType: "tool.execution.failed",
          createdAtMs: atMs,
          data: {
            eventVersion: 2,
            runId,
            callId: tool.callId,
            code,
            message: failure,
            diagnosticId,
          },
        });
        toolProjections.push({
          kind: "toolExecution.put",
          callId: tool.callId,
          expectedState: "staged",
          runId: tool.runId,
          stepId: tool.stepId,
          toolName: tool.toolName,
          argumentsJson: tool.argumentsJson,
          argumentsHash: tool.argumentsHash,
          effectClass: tool.effectClass,
          state: "failed",
          attemptCount: tool.attemptCount,
          requestedAtMs: tool.requestedAtMs,
          startedAtMs: null,
          completedAtMs: atMs,
          result: null,
          error: toolError(code, failure),
        });
      }
    }

    await context.commitTransaction({
      events: [
        {
          eventId: this.ids.eventId(),
          eventType: "provider.step.completed",
          createdAtMs: atMs,
          data: { eventVersion: 1, runId, stepId },
        },
        ...toolEvents,
        ...(message === null
          ? []
          : [
              {
                eventId: this.ids.eventId(),
                eventType: "assistant.message.completed" as const,
                createdAtMs: atMs,
                data: { eventVersion: 1 as const, runId, messageId: message.messageId },
              },
            ]),
      ],
      projections: [
        {
          kind: "providerStep.put",
          stepId,
          expectedState: "streaming",
          runId,
          stepIndex,
          state: "completed",
          startedAtMs,
          completedAtMs: atMs,
          responseId,
          errorCategory: null,
          errorMessage: null,
        },
        ...toolProjections,
        {
          kind: "run.activeProviderStep",
          runId,
          expectedActiveProviderStepId: stepId,
          activeProviderStepId: null,
        },
        ...(message === null
          ? []
          : [
              {
                kind: "message.put" as const,
                messageId: message.messageId,
                runId,
                role: "assistant" as const,
                state: "completed",
                createdAtMs: startedAtMs,
                completedAtMs: atMs,
              },
              {
                kind: "messagePart.put" as const,
                partId: message.partId,
                messageId: message.messageId,
                partIndex: 0,
                partType: "text",
                textContent: message.fullText,
                data: null,
              },
            ]),
      ],
    });
    return { kind: calls.length === 0 ? "final" : "tools" };
  }

  private validateCompatibleTool(tool: ToolExecutionRecord): ValidatedToolCall {
    assertCurrentToolEffectClass(tool, this.currentToolEffectClass(tool.toolName));
    return this.registry.validate(tool.toolName, tool.argumentsJson);
  }

  private async processToolCalls(
    context: RunTaskContext,
    initialCalls: readonly ToolExecutionRecord[],
  ): Promise<void> {
    for (const initial of initialCalls) {
      let tool = await this.storage.getToolExecution(initial.callId);
      if (tool === null) throw new RunLoopFailure("session.not_found", "Tool ledger row disappeared.", false);
      if (tool.state === "outcome_unknown") {
        throw new RunLoopFailure(
          "tool.outcome_unknown",
          "A durable tool outcome is unknown, so provider continuation is unsafe.",
          true,
        );
      }
      let validated: ValidatedToolCall | null = null;
      if (tool.effectClass !== null) {
        validated = this.validateCompatibleTool(tool);
      } else if (tool.state !== "failed" && tool.state !== "discarded") {
        throw new RunLoopFailure(
          "session.invalid_transition",
          `Tool call ${tool.callId} is unclassified in state ${tool.state}.`,
          false,
        );
      }

      if (tool.state === "requested") {
        if (validated === null) {
          throw new RunLoopFailure("session.invalid_transition", "Requested tool is unclassified.", false);
        }
        if (validated.definition.approval === "always") {
          await this.requestApproval(context, tool, validated);
          tool = await this.storage.getToolExecution(tool.callId);
          if (tool === null) throw new RunLoopFailure("session.not_found", "Tool ledger row disappeared.", false);
          validated = this.validateCompatibleTool(tool);
        }
      }

      if (tool.state === "awaiting_approval") {
        const approval = (await this.storage.getPendingApprovals()).find(
          (candidate) => candidate.callId === tool?.callId,
        );
        if (approval !== undefined) await context.waitForApproval(approval.approvalId);
        tool = await this.storage.getToolExecution(tool.callId);
        if (tool === null) throw new RunLoopFailure("session.not_found", "Tool ledger row disappeared.", false);
      }

      if (tool.state === "requested" || tool.state === "approved") {
        if (validated === null) {
          throw new RunLoopFailure("session.invalid_transition", "Executable tool is unclassified.", false);
        }
        await this.executeTool(context, tool, validated);
        tool = await this.storage.getToolExecution(tool.callId);
        if (tool === null) throw new RunLoopFailure("session.not_found", "Tool ledger row disappeared.", false);
      }

      if (tool.state === "staged" || tool.state === "started" || tool.state === "awaiting_approval") {
        throw new RunLoopFailure(
          "session.invalid_transition",
          `Tool call ${tool.callId} remained in nonterminal state ${tool.state}.`,
          false,
        );
      }
      context.signal.throwIfAborted();
    }
  }

  private async requestApproval(
    context: RunTaskContext,
    tool: ToolExecutionRecord,
    validated: ValidatedToolCall,
  ): Promise<void> {
    if (tool.effectClass === null) {
      throw new RunLoopFailure("session.invalid_transition", "Tool effect is not classified.", false);
    }
    const approvalId = this.ids.approvalId();
    const actionDigest = await canonicalJsonHash({
      callId: tool.callId,
      toolName: tool.toolName,
      argumentsHash: tool.argumentsHash,
    });
    const atMs = context.now();
    const run = await this.storage.getRun(context.runId);
    if (run === null || run.state !== "running") {
      throw new RunLoopFailure("session.invalid_transition", "Run cannot request approval.", false);
    }
    await context.commitTransaction({
      events: [
        {
          eventId: this.ids.eventId(),
          eventType: "tool.approval.requested",
          createdAtMs: atMs,
          data: {
            eventVersion: 1,
            runId: context.runId,
            callId: tool.callId,
            approvalId,
            toolName: tool.toolName,
            actionDigest,
            summary: `${validated.definition.name}: ${tool.argumentsJson}`.slice(0, 200),
          },
        },
        {
          eventId: this.ids.eventId(),
          eventType: "run.waiting_for_user",
          createdAtMs: atMs,
          data: { eventVersion: 1, runId: context.runId, reason: "approval", approvalId },
        },
      ],
      projections: [
        {
          kind: "toolExecution.put",
          callId: tool.callId,
          expectedState: "requested",
          runId: tool.runId,
          stepId: tool.stepId,
          toolName: tool.toolName,
          argumentsJson: tool.argumentsJson,
          argumentsHash: tool.argumentsHash,
          effectClass: tool.effectClass,
          state: "awaiting_approval",
          attemptCount: tool.attemptCount,
          requestedAtMs: tool.requestedAtMs,
          startedAtMs: tool.startedAtMs,
          completedAtMs: tool.completedAtMs,
          result: tool.result,
          error: tool.error,
        },
        {
          kind: "approval.put",
          approvalId,
          runId: context.runId,
          callId: tool.callId,
          state: "pending",
          actionDigest,
          requestedAtMs: atMs,
        },
        {
          kind: "run.state",
          runId: context.runId,
          expectedState: "running",
          nextState: "waiting_for_user",
          startedAtMs: run.startedAtMs,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: run.activeProviderStepId,
        },
      ],
    });
    await context.waitForApproval(approvalId);
  }

  private async executeTool(
    context: RunTaskContext,
    tool: ToolExecutionRecord,
    validated: ValidatedToolCall,
  ): Promise<void> {
    if (tool.effectClass === null) {
      throw new RunLoopFailure("session.invalid_transition", "Tool effect is not classified.", false);
    }
    assertCurrentToolEffectClass(tool, validated.definition.effectClass);
    const expectedState = tool.state;
    await context.scheduler.withToolPermit(context.signal, async () => {
      const startedAtMs = context.now();
      await context.commitTransaction({
        events: [
          {
            eventId: this.ids.eventId(),
            eventType: "tool.execution.started",
            createdAtMs: startedAtMs,
            data: { eventVersion: 1, runId: tool.runId, callId: tool.callId },
          },
        ],
        projections: [
          {
            kind: "toolExecution.put",
            callId: tool.callId,
            expectedState,
            runId: tool.runId,
            stepId: tool.stepId,
            toolName: tool.toolName,
            argumentsJson: tool.argumentsJson,
            argumentsHash: tool.argumentsHash,
            effectClass: tool.effectClass,
            state: "started",
            attemptCount: tool.attemptCount + 1,
            requestedAtMs: tool.requestedAtMs,
            startedAtMs,
            completedAtMs: null,
            result: null,
            error: null,
          },
        ],
      });

      try {
        const result = await this.executor.execute(
          validated,
          {
            sessionId: context.sessionId,
            runId: tool.runId,
            stepId: tool.stepId,
            callId: tool.callId,
            now: context.now,
          },
          context.signal,
        );
        const completedAtMs = context.now();
        await context.commitTransaction({
          events: [
            {
              eventId: this.ids.eventId(),
              eventType: "tool.execution.completed",
              createdAtMs: completedAtMs,
              data: { eventVersion: 1, runId: tool.runId, callId: tool.callId, result },
            },
          ],
          projections: [
            {
              kind: "toolExecution.put",
              callId: tool.callId,
              expectedState: "started",
              runId: tool.runId,
              stepId: tool.stepId,
              toolName: tool.toolName,
              argumentsJson: tool.argumentsJson,
              argumentsHash: tool.argumentsHash,
              effectClass: tool.effectClass,
              state: "completed",
              attemptCount: tool.attemptCount + 1,
              requestedAtMs: tool.requestedAtMs,
              startedAtMs,
              completedAtMs,
              result,
              error: null,
            },
          ],
        });
      } catch (error) {
        if (isSessionActorHandoffSignal(context.signal)) throw error;
        const durableStarted = await this.storage.getToolExecution(tool.callId);
        if (
          durableStarted === null ||
          durableStarted.state !== "started" ||
          durableStarted.runId !== tool.runId ||
          durableStarted.stepId !== tool.stepId ||
          durableStarted.toolName !== tool.toolName ||
          durableStarted.argumentsHash !== tool.argumentsHash ||
          durableStarted.effectClass !== tool.effectClass ||
          durableStarted.attemptCount !== tool.attemptCount + 1
        ) {
          throw new RunLoopFailure(
            "session.invalid_transition",
            "Tool terminal cleanup no longer matches its durable started execution.",
            true,
          );
        }
        const cancelled = isAborted(context.signal);
        const outcomeUnknown = tool.effectClass !== "pure";
        let code: ErrorCode = "tool.execution_failed";
        if (outcomeUnknown) code = "tool.outcome_unknown";
        else if (cancelled) code = "provider.cancelled";
        else if (error instanceof ToolTimeoutError) code = "tool.timeout";
        const message = safeRunFailureMessage(code);
        let failureState: "cancelled" | "failed" | "outcome_unknown" = "failed";
        if (outcomeUnknown) failureState = "outcome_unknown";
        else if (cancelled) failureState = "cancelled";
        const diagnosticId = this.reportToolFailure(
          context,
          outcomeUnknown || cancelled ? "interrupted" : "failed",
          code,
          error,
          tool,
        );
        const completedAtMs = context.now();
        await context.commitTransaction(
          {
            events: [
              outcomeUnknown
                ? {
                    eventId: this.ids.eventId(),
                    eventType: "tool.execution.outcome_unknown",
                    createdAtMs: completedAtMs,
                    data: {
                      eventVersion: 2,
                      runId: tool.runId,
                      callId: tool.callId,
                      code: "tool.outcome_unknown",
                      message,
                      diagnosticId,
                    },
                  }
                : {
                    eventId: this.ids.eventId(),
                    eventType: "tool.execution.failed",
                    createdAtMs: completedAtMs,
                    data: {
                      eventVersion: 2,
                      runId: tool.runId,
                      callId: tool.callId,
                      code,
                      message,
                      diagnosticId,
                    },
                  },
            ],
            projections: [
              {
                kind: "toolExecution.put",
                callId: tool.callId,
                expectedState: "started",
                runId: tool.runId,
                stepId: tool.stepId,
                toolName: tool.toolName,
                argumentsJson: tool.argumentsJson,
                argumentsHash: tool.argumentsHash,
                effectClass: tool.effectClass,
                state: failureState,
                attemptCount: tool.attemptCount + 1,
                requestedAtMs: tool.requestedAtMs,
                startedAtMs,
                completedAtMs,
                result: null,
                error: toolError(code, message),
              },
            ],
          },
          { cancellationCleanup: "tool_execution" },
        );
        if (outcomeUnknown) {
          throw new RunLoopFailure("tool.outcome_unknown", message, true, diagnosticId);
        }
        if (cancelled) {
          throw new RunLoopFailure("provider.cancelled", message, true, diagnosticId);
        }
      }
    });
  }
}
