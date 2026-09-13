import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PROVIDER_LIMITS,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderRequest,
} from "@wi/provider-contract";
import type { CanonicalJsonValue, SessionEvent } from "@wi/protocol";
import {
  SessionStoreManager,
  type BoundedProviderRequestData,
  type SessionClient,
} from "@wi/storage";
import { ToolExecutor, createBuiltinToolRegistry } from "@wi/tools";
import {
  AgentRunLoop,
  CommittedEventHub,
  RunScheduler,
  SessionActor,
  type AgentRunLoopIds,
  type SessionActorIds,
} from "../../packages/harness-core/src/index.js";

const homes: string[] = [];
const managers: SessionStoreManager[] = [];
const actors: SessionActor[] = [];
let fixtureNumber = 0;

function next(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}${++value}`;
}

function ids(prefix: string): { readonly actor: SessionActorIds; readonly loop: AgentRunLoopIds } {
  return {
    actor: {
      runId: next(`run_${prefix}`),
      eventId: next(`evt_${prefix}Actor`),
      messageId: next(`msg_${prefix}Actor`),
      partId: next(`part_${prefix}Actor`),
      diagnosticId: next(`err_${prefix}Actor`),
    },
    loop: {
      eventId: next(`evt_${prefix}Loop`),
      stepId: next(`step_${prefix}`),
      messageId: next(`msg_${prefix}Loop`),
      partId: next(`part_${prefix}Loop`),
      approvalId: next(`approval_${prefix}`),
      diagnosticId: next(`err_${prefix}Loop`),
    },
  };
}

class UntrustedProvider implements ProviderAdapter {
  readonly requests: ProviderRequest[] = [];

  constructor(
    private readonly values: (
      request: ProviderRequest,
      context: ProviderContext,
    ) => readonly unknown[],
    readonly id = "untrusted-test",
  ) {}

  async *stream(
    request: ProviderRequest,
    context: ProviderContext,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    signal.throwIfAborted();
    this.requests.push(request);
    for (const value of this.values(request, context)) yield value;
  }
}

async function runBoundaryFixture(options: {
  readonly values: (request: ProviderRequest, context: ProviderContext) => readonly unknown[];
  readonly messageText?: string;
  readonly providerConfig?: CanonicalJsonValue;
  readonly expectedRun?: {
    readonly state: "completed" | "failed" | "interrupted";
    readonly failureCategory: string | null;
  };
  readonly baseProviderId?: string;
  readonly selectedProviderId?: string;
  readonly onFailureProviderId?: (providerId: string) => void;
}): Promise<{
  readonly runId: string | null;
  readonly submissionError: unknown | null;
  readonly executions: readonly string[];
  readonly provider: UntrustedProvider;
  readonly events: readonly SessionEvent[];
}> {
  const number = ++fixtureNumber;
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m4-provider-boundary-"));
  homes.push(homeDirectory);
  const manager = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: {
      sessionId: () => `ses_providerBoundary${number}`,
      eventId: () => `evt_providerBoundarySession${number}`,
    },
    sessionWorkers: { size: 1 },
  });
  managers.push(manager);
  const created = await manager.createSession({
    v: 1,
    kind: "command",
    commandId: `cmd_providerBoundaryCreate${number}`,
    method: "session.create",
    params: {},
  });
  const session = await manager.openSession(created.session.sessionId);
  const provider = new UntrustedProvider(
    options.values,
    options.selectedProviderId ?? "untrusted-test",
  );
  const baseProvider = options.baseProviderId === undefined
    ? provider
    : new UntrustedProvider(() => [], options.baseProviderId);
  const executions: string[] = [];
  const generated = ids(`providerBoundary${number}`);
  const loop = new AgentRunLoop({
    storage: session,
    provider: baseProvider,
    ...(baseProvider === provider ? {} : { providerForRun: () => provider }),
    onFailureDiagnostic: (diagnostic) => {
      if (diagnostic.operation === "provider") {
        options.onFailureProviderId?.(diagnostic.providerId);
      }
    },
    registry: createBuiltinToolRegistry(),
    executor: new ToolExecutor({ onExecutionStart: ({ callId }) => executions.push(callId) }),
    ids: generated.loop,
  });
  let signalTerminal = (): void => {};
  const terminal = new Promise<void>((resolve) => {
    signalTerminal = resolve;
  });
  const published: SessionEvent[] = [];
  const hub = new CommittedEventHub();
  hub.subscribe(session.sessionId, (event) => {
    published.push(event);
    if (
      event.eventType === "run.failed" ||
      event.eventType === "run.interrupted" ||
      event.eventType === "run.completed" ||
      event.eventType === "run.cancelled"
    ) {
      signalTerminal();
    }
  });
  let now = 2_000;
  const actor = await SessionActor.create({
    storage: session,
    eventHub: hub,
    scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
    ids: generated.actor,
    now: () => ++now,
    runTask: loop.task,
    currentToolEffectClass: loop.currentToolEffectClass,
    cancelRunTask: loop.cancel,
    forceStopRunTask: () => ({ status: "terminated" }),
    createRunProviderSnapshot: () => ({
      providerId: provider.id,
      providerConfig: options.providerConfig ?? {},
    }),
    runTaskOwnsSchedulerPermits: true,
    resumeRestoredRuns: true,
  });
  actors.push(actor);
  let submitted: Awaited<ReturnType<SessionActor["submitMessage"]>>;
  try {
    submitted = await actor.submitMessage({
      v: 1,
      kind: "command",
      commandId: `cmd_providerBoundarySubmit${number}`,
      sessionId: session.sessionId,
      method: "message.submit",
      params: { text: options.messageText ?? "provider boundary" },
    });
  } catch (submissionError) {
    return {
      runId: null,
      submissionError,
      executions,
      provider,
      events: await session.getEventsAfter(0),
    };
  }
  await terminal;
  await expect(session.getRun(submitted.runId)).resolves.toMatchObject({
    ...(options.expectedRun ?? {
      state: "failed",
      failureCategory: "provider.protocol_error",
    }),
    activeProviderStepId: null,
  });
  return {
    runId: submitted.runId,
    submissionError: null,
    executions,
    provider,
    events: await session.getEventsAfter(0),
  };
}

async function seedProviderHistory(
  messageTexts: readonly string[],
  providerConfig: CanonicalJsonValue = {},
): Promise<{ readonly runId: string; readonly session: SessionClient }> {
  const number = ++fixtureNumber;
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m4-provider-byte-history-"));
  homes.push(homeDirectory);
  const manager = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: {
      sessionId: () => `ses_providerByteHistory${number}`,
      eventId: () => `evt_providerByteHistorySession${number}`,
    },
    sessionWorkers: { size: 1 },
  });
  managers.push(manager);
  const created = await manager.createSession({
    v: 1,
    kind: "command",
    commandId: `cmd_providerByteHistoryCreate${number}`,
    method: "session.create",
    params: {},
  });
  const session = await manager.openSession(created.session.sessionId);
  const runId = `run_providerByteHistory${number}`;
  await session.appendTransaction({
    events: [
      {
        eventId: `evt_providerByteHistoryRun${number}`,
        eventType: "run.created",
        createdAtMs: 2_000,
        data: { eventVersion: 1, runId },
      },
    ],
    projections: [
      {
        kind: "run.put",
        runId,
        state: "queued",
        providerId: "untrusted-test",
        providerConfig,
        createdAtMs: 2_000,
        startedAtMs: null,
        completedAtMs: null,
        cancelledAtMs: null,
        failureCategory: null,
        failureMessage: null,
        activeProviderStepId: null,
      },
      ...messageTexts.flatMap((textContent, index) => {
        const messageId = `msg_providerByteHistory${number}_${index}`;
        return [
          {
            kind: "message.put" as const,
            messageId,
            runId,
            role: "user" as const,
            state: "completed" as const,
            createdAtMs: 2_001 + index,
            completedAtMs: 2_001 + index,
          },
          {
            kind: "messagePart.put" as const,
            partId: `part_providerByteHistory${number}_${index}`,
            messageId,
            partIndex: 0,
            partType: "text" as const,
            textContent,
            data: null,
          },
        ];
      }),
    ],
  });
  return { runId, session };
}

afterEach(async () => {
  await Promise.allSettled(actors.splice(0).map((actor) => actor.shutdown()));
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("Milestone 4 provider runtime boundary", () => {
  it.each([
    ["unknown event type", (request: ProviderRequest) => [{ type: "unknown", runId: request.runId }]],
    ["missing identity", () => [{ type: "response.started", responseId: "response_missing" }]],
    [
      "wrong field type",
      (request: ProviderRequest) => [
        { type: "response.started", ...request, responseId: 42 },
      ],
    ],
    [
      "extra field",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_extra",
          extra: true,
        },
      ],
    ],
    [
      "invalid step index",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: -1,
          responseId: "response_badIndex",
        },
      ],
    ],
    [
      "invalid retry data",
      (request: ProviderRequest) => [
        {
          type: "response.failed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          category: "terminal",
          message: "terminal cannot retry",
          retryable: true,
        },
      ],
    ],
    [
      "malformed terminal",
      (request: ProviderRequest) => [
        {
          type: "response.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
        },
      ],
    ],
    [
      "oversized text delta",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_oversizedDelta",
        },
        {
          type: "text.delta",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          delta: "x".repeat(PROVIDER_LIMITS.textDeltaMaxBytes + 1),
        },
      ],
    ],
    [
      "oversized failure message",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_oversizedFailure",
        },
        {
          type: "response.failed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          category: "transport",
          message: "x".repeat(PROVIDER_LIMITS.failureMessageMaxBytes + 1),
          retryable: false,
        },
      ],
    ],
    [
      "oversized tool name",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_oversizedName",
        },
        {
          type: "tool_call.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          callId: "call_oversizedName",
          name: "x".repeat(PROVIDER_LIMITS.toolNameMaxBytes + 1),
          argumentsJson: "{}",
        },
      ],
    ],
    [
      "oversized tool arguments",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_oversizedArguments",
        },
        {
          type: "tool_call.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          callId: "call_oversizedArguments",
          name: "echo",
          argumentsJson: "x".repeat(PROVIDER_LIMITS.toolArgumentsMaxBytes + 1),
        },
      ],
    ],
    [
      "nonterminal event after completion",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_postTerminal",
        },
        {
          type: "response.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_postTerminal",
        },
        {
          type: "text.delta",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          delta: "late",
        },
      ],
    ],
    [
      "malformed tool call followed by completion",
      (request: ProviderRequest) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_malformedTool",
        },
        {
          type: "tool_call.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          callId: "call_malformedBoundary",
          name: "echo",
          argumentsJson: 42,
        },
        {
          type: "response.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_malformedTool",
        },
      ],
    ],
  ] as const)("rejects %s before any tool effect", async (_name, values) => {
    const value = await runBoundaryFixture({ values });
    expect(value.submissionError).toBeNull();
    expect(value.executions).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "provider.tool_call.staged"),
    ).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "tool.execution.started"),
    ).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "provider.step.failed"),
    ).toHaveLength(1);
  });

  it("accepts cumulative assistant text at the per-step byte limit", async () => {
    const chunk = "x".repeat(PROVIDER_LIMITS.responseTextMaxBytes / 16);
    const value = await runBoundaryFixture({
      expectedRun: { state: "completed", failureCategory: null },
      values: (request) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_cumulativeExact",
        },
        ...Array.from({ length: 16 }, () => ({
          type: "text.delta",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          delta: chunk,
        })),
        {
          type: "response.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_cumulativeExact",
        },
      ],
    });

    const committedText = value.events
      .flatMap((event) => event.eventType === "provider.text.delta" ? [event.data.text] : [])
      .join("");
    expect(Buffer.byteLength(committedText)).toBe(PROVIDER_LIMITS.responseTextMaxBytes);
  });

  it("rejects many valid deltas before cumulative assistant text exceeds its limit", async () => {
    const chunk = "x".repeat(PROVIDER_LIMITS.responseTextMaxBytes / 16);
    const value = await runBoundaryFixture({
      values: (request) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: "response_cumulativeOver",
        },
        ...Array.from({ length: 16 }, () => ({
          type: "text.delta",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          delta: chunk,
        })),
        {
          type: "text.delta",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          delta: "x",
        },
      ],
    });

    const committedText = value.events
      .flatMap((event) => event.eventType === "provider.text.delta" ? [event.data.text] : [])
      .join("");
    expect(Buffer.byteLength(committedText)).toBe(PROVIDER_LIMITS.responseTextMaxBytes);
    expect(value.executions).toEqual([]);
  });

  it.each([
    {
      count: PROVIDER_LIMITS.toolCallMaxCountPerStep,
      expectedRun: {
        state: "interrupted" as const,
        failureCategory: "provider.transport_after_output",
      },
    },
    {
      count: PROVIDER_LIMITS.toolCallMaxCountPerStep + 1,
      expectedRun: { state: "failed" as const, failureCategory: "provider.protocol_error" },
    },
  ])(
    "bounds one provider step at $count completed tool calls",
    async ({ count, expectedRun }) => {
      const value = await runBoundaryFixture({
      expectedRun,
      values: (request) => [
        {
          type: "response.started",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          responseId: `response_toolCount${count}`,
        },
        ...Array.from({ length: count }, (_, index) => ({
          type: "tool_call.completed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          callId: `call_toolCount_${index}`,
          name: "echo",
          argumentsJson: "{}",
        })),
        {
          type: "response.failed",
          runId: request.runId,
          stepId: request.stepId,
          stepIndex: request.stepIndex,
          category: "terminal",
          message: "stop after count probe",
          retryable: false,
        },
      ],
    });

      expect(
        value.events.filter((event) => event.eventType === "provider.tool_call.staged"),
      ).toHaveLength(PROVIDER_LIMITS.toolCallMaxCountPerStep);
      expect(value.executions).toEqual([]);
    },
    30_000,
  );

  it("rejects oversized request history before invoking the provider", async () => {
    const value = await runBoundaryFixture({
      values: () => [],
      messageText: "x".repeat(PROVIDER_LIMITS.messageTextMaxBytes + 1),
    });
    expect(value.submissionError).toBeNull();
    expect(value.provider.requests).toEqual([]);
    expect(value.executions).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "provider.step.started"),
    ).toEqual([]);
  });

  it("bounds durable history acquisition before constructing all provider items", async () => {
    const number = ++fixtureNumber;
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-m4-provider-history-"));
    homes.push(homeDirectory);
    const manager = new SessionStoreManager({
      homeDirectory,
      now: () => 1_000,
      ids: {
        sessionId: () => `ses_providerHistory${number}`,
        eventId: () => `evt_providerHistorySession${number}`,
      },
      sessionWorkers: { size: 1 },
    });
    managers.push(manager);
    const created = await manager.createSession({
      v: 1,
      kind: "command",
      commandId: `cmd_providerHistoryCreate${number}`,
      method: "session.create",
      params: {},
    });
    const session = await manager.openSession(created.session.sessionId);
    const runId = `run_providerHistory${number}`;
    const messageCount = PROVIDER_LIMITS.inputItemMaxCount + 1;
    await session.appendTransaction({
      events: [
        {
          eventId: `evt_providerHistoryRun${number}`,
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId,
          state: "queued",
          providerId: "untrusted-test",
          providerConfig: {},
          createdAtMs: 2_000,
          startedAtMs: null,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        ...Array.from({ length: messageCount }, (_, index) => {
          const messageId = `msg_providerHistory${number}_${index}`;
          return [
            {
              kind: "message.put" as const,
              messageId,
              runId,
              role: "user" as const,
              state: "completed",
              createdAtMs: 2_001 + index,
              completedAtMs: 2_001 + index,
            },
            {
              kind: "messagePart.put" as const,
              partId: `part_providerHistory${number}_${index}`,
              messageId,
              partIndex: 0,
              partType: "text",
              textContent: "x",
              data: null,
            },
          ];
        }).flat(),
      ],
    });

    let boundedReads = 0;
    let fullHistoryReads = 0;
    let boundedResult: BoundedProviderRequestData | null = null;
    const storage = new Proxy(session, {
      get(target, property) {
        if (property === "getBoundedProviderRequestData") {
          return async (input: Parameters<SessionClient["getBoundedProviderRequestData"]>[0]) => {
            boundedReads += 1;
            boundedResult = await target.getBoundedProviderRequestData(input);
            return boundedResult;
          };
        }
        if (property === "getRunMessages" || property === "getToolExecutionsForRun") {
          return () => {
            fullHistoryReads += 1;
            throw new Error("Run loop attempted an unbounded provider-history read");
          };
        }
        const member = Reflect.get(target, property) as unknown;
        return typeof member === "function" ? member.bind(target) : member;
      },
    }) as SessionClient;
    const provider = new UntrustedProvider(() => []);
    const generated = ids(`providerHistory${number}`);
    const loop = new AgentRunLoop({
      storage,
      provider,
      registry: createBuiltinToolRegistry(),
      executor: new ToolExecutor(),
      ids: generated.loop,
    });
    let signalTerminal = (): void => {};
    const terminal = new Promise<void>((resolve) => {
      signalTerminal = resolve;
    });
    const events: SessionEvent[] = [];
    const hub = new CommittedEventHub();
    hub.subscribe(session.sessionId, (event) => {
      events.push(event);
      if (event.eventType === "run.failed" && event.data.runId === runId) signalTerminal();
    });
    const actor = await SessionActor.create({
      storage,
      eventHub: hub,
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: generated.actor,
      now: () => 3_000,
      runTask: loop.task,
      currentToolEffectClass: loop.currentToolEffectClass,
      cancelRunTask: loop.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      runTaskOwnsSchedulerPermits: true,
      resumeRestoredRuns: true,
    });
    actors.push(actor);
    await terminal;

    expect(boundedReads).toBe(1);
    expect(fullHistoryReads).toBe(0);
    expect(boundedResult).toEqual({ status: "limit_exceeded", boundary: "input_items" });
    expect(provider.requests).toEqual([]);
    expect(events.filter((event) => event.eventType === "provider.step.started")).toEqual([]);
    await expect(session.getRun(runId)).resolves.toMatchObject({
      state: "failed",
      failureCategory: "provider.protocol_error",
      activeProviderStepId: null,
    });
  });

  it("bounds the complete worker-built request at its exact byte size", async () => {
    const { runId, session } = await seedProviderHistory(
      Array.from({ length: 8 }, (_, index) => `row-${index}:"\\\n`.repeat(16)),
      { endpoint: "x".repeat(1_024) },
    );
    const acquisition = {
      runId,
      stepId: "step_providerByteHistory",
      stepIndex: 0,
      expectedProviderId: "untrusted-test",
      maxProviderConfigBytes: PROVIDER_LIMITS.providerConfigMaxBytes,
      maxMessageTextBytes: PROVIDER_LIMITS.messageTextMaxBytes,
      maxToolNameBytes: PROVIDER_LIMITS.toolNameMaxBytes,
      maxInputItems: PROVIDER_LIMITS.inputItemMaxCount,
      maxRequestBytes: 1024 * 1024,
    };
    const initial = await session.getBoundedProviderRequestData(acquisition);
    if (initial.status !== "ready") throw new Error("Expected bounded provider request data");
    const exactBytes = Buffer.byteLength(initial.requestJson);

    await expect(
      session.getBoundedProviderRequestData({ ...acquisition, maxRequestBytes: exactBytes }),
    ).resolves.toEqual(initial);
    await expect(
      session.getBoundedProviderRequestData({ ...acquisition, maxRequestBytes: exactBytes - 1 }),
    ).resolves.toEqual({ status: "limit_exceeded", boundary: "request_bytes" });
    const request = JSON.parse(initial.requestJson) as ProviderRequest;
    expect(request.providerConfig).toEqual({ endpoint: "x".repeat(1_024) });
    expect(request.input).toHaveLength(8);
  });

  it("rejects one oversized durable message before JSON escaping", async () => {
    const { runId, session } = await seedProviderHistory([
      "x".repeat(PROVIDER_LIMITS.messageTextMaxBytes + 1),
    ]);

    await expect(
      session.getBoundedProviderRequestData({
        runId,
        stepId: "step_providerRawTextPreflight",
        stepIndex: 0,
        expectedProviderId: "untrusted-test",
        maxProviderConfigBytes: PROVIDER_LIMITS.providerConfigMaxBytes,
        maxMessageTextBytes: PROVIDER_LIMITS.messageTextMaxBytes,
        maxToolNameBytes: PROVIDER_LIMITS.toolNameMaxBytes,
        maxInputItems: PROVIDER_LIMITS.inputItemMaxCount,
        maxRequestBytes: PROVIDER_LIMITS.requestMaxBytes,
      }),
    ).resolves.toEqual({ status: "limit_exceeded", boundary: "message_text" });
  });

  it("attributes selected-provider failures to the durable run provider", async () => {
    const providerIds: string[] = [];
    await runBoundaryFixture({
      values: () => [{ type: "not-a-provider-event" }],
      baseProviderId: "fake",
      selectedProviderId: "openai_platform",
      onFailureProviderId: (providerId) => providerIds.push(providerId),
      expectedRun: { state: "failed", failureCategory: "provider.protocol_error" },
    });
    expect(providerIds).toEqual(["openai_platform"]);
  });

  it("rejects oversized provider configuration before invoking the provider", async () => {
    const value = await runBoundaryFixture({
      values: () => [],
      providerConfig: { value: "x".repeat(PROVIDER_LIMITS.providerConfigMaxBytes) },
    });
    expect(value.submissionError).toMatchObject({ code: "provider.protocol_error" });
    expect(value.runId).toBeNull();
    expect(value.provider.requests).toEqual([]);
    expect(value.executions).toEqual([]);
    expect(
      value.events.filter((event) => event.eventType === "provider.step.started"),
    ).toEqual([]);
  });
});
