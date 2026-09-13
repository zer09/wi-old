import { describe, expect, it, vi } from "vitest";

import { BrowserSessionEventSchema, type RunState, type SessionEvent } from "@wi/protocol";
import type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionInspection,
  AppendTransactionResult,
  PendingApprovalRecord,
  PendingInputRecord,
  RunRecord,
  SessionRecoveryResult,
} from "@wi/storage";

import { CommittedEventHub } from "./event-hub.js";
import { RunScheduler } from "./scheduler.js";
import { SessionActorRegistry } from "./session-registry.js";
import {
  SessionActor,
  type ForceStopRunTask,
  type CreateRunProviderSnapshot,
  type RunTask,
  type RunTaskContext,
  type RunTaskResult,
  type SessionActorIds,
  type SessionActorStorage,
  type SessionRunFailureDiagnostic,
} from "./session-actor.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface DeferredTask {
  readonly context: RunTaskContext;
  readonly resolve: (result?: RunTaskResult) => void;
  readonly reject: (error: unknown) => void;
}

class ControlledTasks {
  readonly pending = new Map<string, DeferredTask>();
  private readonly startWaiters = new Map<string, (task: DeferredTask) => void>();
  private readonly stopped = new Map<string, Promise<void>>();
  readonly task: RunTask = (context) =>
    new Promise<RunTaskResult | void>((resolve, reject) => {
      const gate = deferred<void>();
      const task = {
        context,
        resolve: (result?: RunTaskResult) => {
          gate.resolve();
          resolve(result);
        },
        reject: (error: unknown) => {
          gate.resolve();
          reject(error);
        },
      };
      this.stopped.set(context.runId, gate.promise);
      this.pending.set(context.runId, task);
      this.startWaiters.get(context.runId)?.(task);
      this.startWaiters.delete(context.runId);
    });

  readonly cancel = async (context: RunTaskContext): Promise<void> => {
    await this.stopped.get(context.runId);
  };

  waitFor(runId: string): Promise<DeferredTask> {
    const task = this.pending.get(runId);
    if (task !== undefined) return Promise.resolve(task);
    return new Promise((resolve) => this.startWaiters.set(runId, resolve));
  }
}

class FakeActorStorage implements SessionActorStorage {
  readonly runs = new Map<string, RunRecord>();
  readonly events: SessionEvent[] = [];
  readonly commands = new Map<string, AcceptedCommandResult>();
  readonly approvals = new Map<string, PendingApprovalRecord>();
  readonly inputs = new Map<string, PendingInputRecord>();
  closeCalls = 0;
  private sequence = 0;

  constructor(readonly sessionId: string) {}

  private apply(input: AppendTransactionInput): AppendTransactionResult {
    for (const projection of input.projections ?? []) {
      if (projection.kind === "run.put") {
        this.runs.set(projection.runId, {
          runId: projection.runId,
          state: projection.state,
          providerId: projection.providerId,
          providerConfig: projection.providerConfig as RunRecord["providerConfig"],
          createdAtMs: projection.createdAtMs,
          startedAtMs: projection.startedAtMs,
          completedAtMs: projection.completedAtMs,
          cancelledAtMs: projection.cancelledAtMs,
          failureCategory: projection.failureCategory,
          failureMessage: projection.failureMessage,
          activeProviderStepId: projection.activeProviderStepId,
        });
      } else if (projection.kind === "run.state") {
        const run = this.runs.get(projection.runId);
        if (run === undefined || run.state !== projection.expectedState) {
          throw Object.assign(new Error("run CAS failed"), { code: "session.invalid_transition" });
        }
        this.runs.set(projection.runId, {
          ...run,
          state: projection.nextState,
          startedAtMs: projection.startedAtMs,
          completedAtMs: projection.completedAtMs,
          cancelledAtMs: projection.cancelledAtMs,
          failureCategory: projection.failureCategory,
          failureMessage: projection.failureMessage,
          activeProviderStepId: projection.activeProviderStepId,
        });
      } else if (projection.kind === "approval.resolve") {
        if (!this.approvals.delete(projection.approvalId)) {
          throw Object.assign(new Error("approval resolved"), { code: "session.invalid_transition" });
        }
      } else if (projection.kind === "input.resolve") {
        if (!this.inputs.delete(projection.inputId)) {
          throw Object.assign(new Error("input resolved"), { code: "session.invalid_transition" });
        }
      } else if (projection.kind === "run.pendingInteractions.cancel") {
        for (const [approvalId, approval] of this.approvals) {
          if (approval.runId === projection.runId) this.approvals.delete(approvalId);
        }
        for (const [inputId, pendingInput] of this.inputs) {
          if (pendingInput.runId === projection.runId) this.inputs.delete(inputId);
        }
      }
    }
    const committed = input.events.map((value): SessionEvent => ({
      v: 1,
      kind: "event",
      sessionId: this.sessionId,
      sequence: ++this.sequence,
      eventId: value.eventId,
      eventType: value.eventType,
      createdAtMs: value.createdAtMs,
      data: value.data,
    } as SessionEvent));
    this.events.push(...committed);
    return { events: committed, headSequence: this.sequence };
  }

  async acceptCommand(input: AcceptCommandInput): Promise<AcceptedCommandResult> {
    const existing = this.commands.get(input.commandId);
    if (existing !== undefined) return { ...existing, duplicate: true, events: [] };
    const committed = this.apply(input.transaction);
    const result: AcceptedCommandResult = {
      commandId: input.commandId,
      commandMethod: input.commandMethod,
      payloadHash: input.payloadHash,
      acceptedSequence: committed.headSequence,
      runId: input.runId,
      result: input.result as AcceptedCommandResult["result"],
      acceptedAtMs: input.acceptedAtMs,
      duplicate: false,
      events: [...committed.events],
    };
    this.commands.set(input.commandId, result);
    return result;
  }

  async appendTransaction(input: AppendTransactionInput): Promise<AppendTransactionResult> {
    return this.apply(input);
  }

  async inspectAppendTransaction(
    input: AppendTransactionInput,
  ): Promise<AppendTransactionInspection> {
    const storedEvents = await Promise.all(
      input.events.map((event) => this.getEventById(event.eventId)),
    );
    return {
      storedEvents,
      headSequence: this.sequence,
      projectionsApplied: storedEvents.every((event) => event !== null),
    };
  }

  async getEventsAfter(
    afterSequence: number,
    throughSequence = Number.MAX_SAFE_INTEGER,
  ): Promise<readonly SessionEvent[]> {
    return this.events.filter(
      (event) => event.sequence > afterSequence && event.sequence <= throughSequence,
    );
  }

  async getEventById(eventId: string): Promise<SessionEvent | null> {
    return this.events.find((event) => event.eventId === eventId) ?? null;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async getProviderStep(): Promise<null> {
    return null;
  }

  async getAcceptedCommand(commandId: string): Promise<AcceptedCommandResult | null> {
    const existing = this.commands.get(commandId);
    return existing === undefined ? null : { ...existing, duplicate: true, events: [] };
  }

  async getNonterminalRuns(): Promise<readonly RunRecord[]> {
    const terminal: readonly RunState[] = ["completed", "failed", "cancelled", "interrupted"];
    return [...this.runs.values()]
      .filter((run) => !terminal.includes(run.state))
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
  }

  async getPendingApprovals(): Promise<readonly PendingApprovalRecord[]> {
    return [...this.approvals.values()];
  }

  async getPendingInputs(): Promise<readonly PendingInputRecord[]> {
    return [...this.inputs.values()];
  }

  async recover(): Promise<SessionRecoveryResult> {
    return {
      interruptedRunIds: [],
      interruptedStepIds: [],
      startedToolCalls: [],
      outcomeUnknownRunIds: [],
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function ids(prefix: string): SessionActorIds {
  let value = 0;
  const next = (): string => `${prefix}${++value}`;
  return {
    runId: () => `run_${next()}`,
    eventId: () => `evt_${next()}`,
    messageId: () => `msg_${next()}`,
    partId: () => `part_${next()}`,
    diagnosticId: () => `err_${next()}`,
  };
}

function message(sessionId: string, commandId: string, text = commandId) {
  return {
    v: 1 as const,
    kind: "command" as const,
    commandId,
    sessionId,
    method: "message.submit" as const,
    params: { text },
  };
}

class ActivityMonitor {
  private readonly waiters = new Set<() => void>();

  signal(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async waitFor(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }
}

const actorMonitors = new WeakMap<SessionActor, ActivityMonitor>();

async function actorFixture(
  name = "actor",
  options: {
    readonly createRunProviderSnapshot?: CreateRunProviderSnapshot;
    readonly onRunProviderSnapshotRejected?: (runId: string) => void | Promise<void>;
    readonly onFault?: (error: unknown) => void;
    readonly onRunFailureDiagnostic?: (diagnostic: SessionRunFailureDiagnostic) => void;
  } = {},
) {
  const storage = new FakeActorStorage(`ses_${name}`);
  const tasks = new ControlledTasks();
  let now = 1_000;
  const scheduler = new RunScheduler({ providerCapacity: 2, toolCapacity: 2 });
  const monitor = new ActivityMonitor();
  const actor = await SessionActor.create({
    storage,
    eventHub: new CommittedEventHub(),
    scheduler,
    ids: ids(name),
    now: () => ++now,
    runTask: tasks.task,
    cancelRunTask: tasks.cancel,
    forceStopRunTask: () => ({ status: "terminated" }),
    onActivity: () => monitor.signal(),
    ...(options.createRunProviderSnapshot === undefined
      ? {}
      : { createRunProviderSnapshot: options.createRunProviderSnapshot }),
    ...(options.onRunProviderSnapshotRejected === undefined
      ? {}
      : { onRunProviderSnapshotRejected: options.onRunProviderSnapshotRejected }),
    ...(options.onFault === undefined ? {} : { onFault: options.onFault }),
    ...(options.onRunFailureDiagnostic === undefined
      ? {}
      : { onRunFailureDiagnostic: options.onRunFailureDiagnostic }),
  });
  actorMonitors.set(actor, monitor);
  return { actor, storage, tasks, scheduler };
}

function waitForTask(tasks: ControlledTasks, runId: string): Promise<DeferredTask> {
  return tasks.waitFor(runId);
}

async function waitForActor(actor: SessionActor, predicate: () => boolean): Promise<void> {
  const monitor = actorMonitors.get(actor);
  if (monitor === undefined) throw new Error("Actor has no deterministic activity monitor");
  await monitor.waitFor(predicate);
}

function waitForState(actor: SessionActor, state: RunState | null): Promise<void> {
  return waitForActor(actor, () => actor.snapshot.activeRunState === state);
}

describe("SessionActor", () => {
  it("requires final isolation proof to be synchronous", () => {
    // @ts-expect-error An async hook cannot prove that isolation already happened.
    const asynchronousIsolation: ForceStopRunTask = async () => ({ status: "terminated" });
    expect(asynchronousIsolation).toBeTypeOf("function");
  });

  it("closes storage when actor initialization fails", async () => {
    const storage = new FakeActorStorage("ses_initializationFailure");
    vi.spyOn(storage, "getNonterminalRuns").mockRejectedValue(new Error("recovery read failed"));

    await expect(
      SessionActor.create({
        storage,
        eventHub: new CommittedEventHub(),
        scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
        ids: ids("initializationFailure"),
        now: () => 10,
        runTask: async () => undefined,
        cancelRunTask: async () => undefined,
        forceStopRunTask: () => ({ status: "terminated" }),
      }),
    ).rejects.toThrow("recovery read failed");
    expect(storage.closeCalls).toBe(1);
  });

  it("releases a provider snapshot reservation when durable message acceptance fails", async () => {
    const rejectedRunIds: string[] = [];
    const { actor, storage } = await actorFixture("snapshotReject", {
      createRunProviderSnapshot: () => ({ providerId: "fake", providerConfig: {} }),
      onRunProviderSnapshotRejected: (runId) => {
        rejectedRunIds.push(runId);
      },
    });
    vi.spyOn(storage, "acceptCommand").mockRejectedValueOnce(new Error("acceptance rejected"));

    await expect(actor.submitMessage(message(actor.sessionId, "cmd_snapshotReject")))
      .rejects.toThrow("acceptance rejected");
    expect(rejectedRunIds).toEqual([expect.stringMatching(/^run_snapshotReject/u)]);
    await actor.shutdown();
  });

  it("does not block its mailbox on an active task and queues follow-ups in order", async () => {
    const { actor, tasks } = await actorFixture("queue");
    const first = await actor.submitMessage(message(actor.sessionId, "cmd_queue1"));
    const second = await actor.submitMessage(message(actor.sessionId, "cmd_queue2"));
    const third = await actor.submitMessage(message(actor.sessionId, "cmd_queue3"));
    expect(actor.snapshot.activeRunId).toBe(first.runId);
    expect(actor.snapshot.queuedRunIds).toEqual([second.runId, third.runId]);

    await actor.subscriberConnected("subscriber_queue");
    await actor.subscriberDisconnected("subscriber_queue");
    expect(actor.snapshot.activeRunState).toBe("running");

    (await waitForTask(tasks, first.runId)).resolve({ state: "completed" });
    await waitForActor(actor, () => actor.snapshot.activeRunId === second.runId);
    expect(actor.snapshot.activeRunId).toBe(second.runId);
    (await waitForTask(tasks, second.runId)).resolve({ state: "completed" });
    await waitForActor(actor, () => actor.snapshot.activeRunId === third.runId);
    expect(actor.snapshot.activeRunId).toBe(third.runId);
    (await waitForTask(tasks, third.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
  });

  it("adopts a message command whose commit response is lost", async () => {
    const { actor, storage, tasks } = await actorFixture("ambiguousSubmit");
    const originalAccept = storage.acceptCommand.bind(storage);
    let injected = false;
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      const result = await originalAccept(input);
      if (!injected && input.commandMethod === "message.submit") {
        injected = true;
        throw new Error("ambiguous command result");
      }
      return result;
    });

    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_ambiguousSubmit"),
    );
    expect(submitted.acceptance.duplicate).toBe(true);
    expect(actor.snapshot.activeRunId).toBe(submitted.runId);
    (await waitForTask(tasks, submitted.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
    expect(storage.events.filter((event) => event.eventType === "run.created")).toHaveLength(1);
  });

  it("returns a durable duplicate without validating changed provider configuration", async () => {
    let providerConfig: RunRecord["providerConfig"] = {};
    const { actor, storage, tasks } = await actorFixture("duplicateChangedProvider", {
      createRunProviderSnapshot: () => ({ providerId: "fake", providerConfig }),
    });
    const command = message(actor.sessionId, "cmd_duplicateChangedProvider");
    const first = await actor.submitMessage(command);
    providerConfig = { value: "x".repeat(64 * 1024) };

    const duplicate = await actor.submitMessage(command);

    expect(duplicate).toMatchObject({
      runId: first.runId,
      acceptance: { duplicate: true, runId: first.runId },
    });
    expect(storage.runs.size).toBe(1);
    expect(storage.events.filter((event) => event.eventType === "run.created")).toHaveLength(1);
    (await waitForTask(tasks, first.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
  });

  it("retries a duplicate after its preliminary durable lookup transiently fails", async () => {
    let providerConfig: RunRecord["providerConfig"] = {};
    const { actor, storage, tasks } = await actorFixture("duplicateLookupFailure", {
      createRunProviderSnapshot: () => ({ providerId: "fake", providerConfig }),
    });
    const command = message(actor.sessionId, "cmd_duplicateLookupFailure");
    const first = await actor.submitMessage(command);
    providerConfig = { value: "x".repeat(64 * 1024) };
    const transientRead = Object.assign(new Error("accepted command lookup unavailable"), {
      code: "storage.worker_failed",
    });
    const originalGetAccepted = storage.getAcceptedCommand.bind(storage);
    let failNextLookup = true;
    vi.spyOn(storage, "getAcceptedCommand").mockImplementation(async (commandId) => {
      if (commandId === command.commandId && failNextLookup) {
        failNextLookup = false;
        throw transientRead;
      }
      return originalGetAccepted(commandId);
    });

    await expect(actor.submitMessage(command)).rejects.toBe(transientRead);
    expect(actor.snapshot.faulted).toBe(false);
    await expect(actor.submitMessage(command)).resolves.toMatchObject({
      runId: first.runId,
      acceptance: { duplicate: true, runId: first.runId },
    });
    expect(storage.runs.size).toBe(1);
    expect(storage.events.filter((event) => event.eventType === "run.created")).toHaveLength(1);
    (await waitForTask(tasks, first.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
  });

  it("faults before later mutations when ambiguous command reconciliation fails", async () => {
    const { actor, storage } = await actorFixture("unresolvedAmbiguousSubmit");
    const originalAccept = storage.acceptCommand.bind(storage);
    let reconciliationUnavailable = false;
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      await originalAccept(input);
      reconciliationUnavailable = true;
      throw Object.assign(new Error("ambiguous command result"), {
        code: "storage.ambiguous_outcome",
      });
    });
    const originalGetAccepted = storage.getAcceptedCommand.bind(storage);
    vi.spyOn(storage, "getAcceptedCommand").mockImplementation(async (commandId) => {
      if (reconciliationUnavailable) throw new Error("replacement storage unavailable");
      return originalGetAccepted(commandId);
    });

    await expect(
      actor.submitMessage(message(actor.sessionId, "cmd_unresolvedAmbiguousSubmit")),
    ).rejects.toMatchObject({ code: "storage.ambiguous_outcome" });
    expect(actor.snapshot).toMatchObject({ faulted: true, activeRunId: null });
    expect(storage.runs.size).toBe(1);
    await expect(
      actor.submitMessage(message(actor.sessionId, "cmd_rejectedAfterAmbiguousSubmit")),
    ).rejects.toMatchObject({ code: "session.unavailable" });
    expect(storage.runs.size).toBe(1);
    await actor.shutdown();
  });

  it("does not start a queued run after the actor becomes faulted", async () => {
    const { actor, storage, tasks, scheduler } = await actorFixture("faultWithQueue");
    const active = await actor.submitMessage(message(actor.sessionId, "cmd_faultWithQueueActive"));
    const activeTask = await waitForTask(tasks, active.runId);
    const queued = await actor.submitMessage(message(actor.sessionId, "cmd_faultWithQueueQueued"));
    const originalAccept = storage.acceptCommand.bind(storage);
    const originalGetAccepted = storage.getAcceptedCommand.bind(storage);
    let reconciliationUnavailable = false;
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      const result = await originalAccept(input);
      if (input.commandId === "cmd_faultWithQueueTrigger") {
        reconciliationUnavailable = true;
        throw Object.assign(new Error("ambiguous queued command result"), {
          code: "storage.ambiguous_outcome",
        });
      }
      return result;
    });
    vi.spyOn(storage, "getAcceptedCommand").mockImplementation(async (commandId) => {
      if (reconciliationUnavailable && commandId === "cmd_faultWithQueueTrigger") {
        throw new Error("replacement storage unavailable");
      }
      return originalGetAccepted(commandId);
    });

    await expect(
      actor.submitMessage(message(actor.sessionId, "cmd_faultWithQueueTrigger")),
    ).rejects.toMatchObject({ code: "storage.ambiguous_outcome" });
    expect(actor.snapshot).toMatchObject({ faulted: true, activeRunId: active.runId });

    activeTask.resolve({ state: "completed" });
    await scheduler.provider.drain();
    await Promise.resolve();
    await actor.flush();
    expect(actor.snapshot).toMatchObject({
      faulted: true,
      activeRunId: active.runId,
      queuedRunIds: [queued.runId],
    });
    expect(storage.runs.get(active.runId)?.state).toBe("running");
    expect(storage.runs.get(queued.runId)?.state).toBe("queued");
    expect(tasks.pending.has(queued.runId)).toBe(false);
    await actor.shutdown();
  });

  it("adopts run.started when its committed response is lost", async () => {
    const { actor, storage, tasks } = await actorFixture("ambiguousStart");
    const originalAppend = storage.appendTransaction.bind(storage);
    let injected = false;
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      const result = await originalAppend(input);
      if (!injected && input.events[0]?.eventType === "run.started") {
        injected = true;
        throw new Error("ambiguous start result");
      }
      return result;
    });

    const submitted = await actor.submitMessage(message(actor.sessionId, "cmd_ambiguousStart"));
    expect(actor.snapshot.activeRunId).toBe(submitted.runId);
    (await waitForTask(tasks, submitted.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
    expect(storage.events.filter((event) => event.eventType === "run.started")).toHaveLength(1);
  });

  it("keeps durable acceptance while explicitly faulting after a pre-commit run start failure", async () => {
    const { actor, storage, tasks } = await actorFixture("startFailureAfterAcceptance");
    const originalAppend = storage.appendTransaction.bind(storage);
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      if (input.events[0]?.eventType === "run.started") {
        throw new Error("transient pre-commit start failure");
      }
      return originalAppend(input);
    });

    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_startFailureAfterAcceptance"),
    );

    expect(submitted.acceptance).toMatchObject({ duplicate: false, runId: submitted.runId });
    expect(storage.commands.has("cmd_startFailureAfterAcceptance")).toBe(true);
    expect(storage.runs.get(submitted.runId)?.state).toBe("queued");
    expect(tasks.pending.has(submitted.runId)).toBe(false);
    expect(actor.snapshot).toMatchObject({
      activeRunId: null,
      queuedRunIds: [submitted.runId],
      faulted: true,
    });
    await expect(
      actor.submitMessage(message(actor.sessionId, "cmd_rejectedAfterStartFailure")),
    ).rejects.toMatchObject({ code: "session.unavailable" });
    await actor.shutdown();
  });

  it("faults before later mutations when ambiguous run start reconciliation fails", async () => {
    const { actor, storage } = await actorFixture("unresolvedAmbiguousStart");
    const originalAppend = storage.appendTransaction.bind(storage);
    const originalGetRun = storage.getRun.bind(storage);
    let reconciliationUnavailable = false;
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      const result = await originalAppend(input);
      if (input.events[0]?.eventType === "run.started") {
        reconciliationUnavailable = true;
        throw Object.assign(new Error("ambiguous start result"), {
          code: "storage.ambiguous_outcome",
        });
      }
      return result;
    });
    vi.spyOn(storage, "getRun").mockImplementation(async (runId) => {
      if (reconciliationUnavailable) throw new Error("replacement storage unavailable");
      return originalGetRun(runId);
    });

    await expect(
      actor.submitMessage(message(actor.sessionId, "cmd_unresolvedAmbiguousStart")),
    ).resolves.toMatchObject({ acceptance: { duplicate: false } });
    expect(actor.snapshot).toMatchObject({ faulted: true, activeRunId: null });
    expect([...storage.runs.values()]).toMatchObject([{ state: "running" }]);
    await expect(
      actor.submitMessage(message(actor.sessionId, "cmd_rejectedAfterAmbiguousStart")),
    ).rejects.toMatchObject({ code: "session.unavailable" });
    expect(storage.runs.size).toBe(1);
    await actor.shutdown();
  });

  it("signals cancellation when its committed acceptance response is lost", async () => {
    const { actor, storage, tasks } = await actorFixture("ambiguousCancel");
    const submitted = await actor.submitMessage(message(actor.sessionId, "cmd_ambiguousCancelSubmit"));
    const task = await waitForTask(tasks, submitted.runId);
    const originalAccept = storage.acceptCommand.bind(storage);
    let injected = false;
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      const result = await originalAccept(input);
      if (!injected && input.commandMethod === "run.cancel") {
        injected = true;
        throw new Error("ambiguous cancel result");
      }
      return result;
    });

    await expect(
      actor.cancelRun({
        v: 1,
        kind: "command",
        commandId: "cmd_ambiguousCancel",
        sessionId: actor.sessionId,
        method: "run.cancel",
        params: { runId: submitted.runId },
      }),
    ).resolves.toMatchObject({ state: "cancelling" });
    expect(task.context.signal.aborted).toBe(true);
    expect(actor.snapshot.activeRunState).toBe("cancelling");
    task.resolve({ state: "completed" });
    await waitForState(actor, null);
    expect(storage.events.filter((event) => event.eventType === "run.cancelled")).toHaveLength(1);
  });

  it("faults on a reconciled non-message command with a mismatched run identity", async () => {
    const { actor, storage, tasks } = await actorFixture("mismatchedCancelRunIdentity");
    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_mismatchedCancelRunIdentitySubmit"),
    );
    const activeTask = await waitForTask(tasks, submitted.runId);
    const originalAccept = storage.acceptCommand.bind(storage);
    const originalGetAccepted = storage.getAcceptedCommand.bind(storage);
    let cancellationCommitted = false;
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      const result = await originalAccept(input);
      if (input.commandMethod === "run.cancel") {
        cancellationCommitted = true;
        throw Object.assign(new Error("ambiguous cancellation result"), {
          code: "storage.ambiguous_outcome",
        });
      }
      return result;
    });
    vi.spyOn(storage, "getAcceptedCommand").mockImplementation(async (commandId) => {
      const accepted = await originalGetAccepted(commandId);
      if (cancellationCommitted && commandId === "cmd_mismatchedCancelRunIdentity") {
        if (accepted === null) throw new Error("Committed cancellation disappeared");
        return { ...accepted, runId: "run_conflictingCancellationIdentity" };
      }
      return accepted;
    });

    await expect(
      actor.cancelRun({
        v: 1,
        kind: "command",
        commandId: "cmd_mismatchedCancelRunIdentity",
        sessionId: actor.sessionId,
        method: "run.cancel",
        params: { runId: submitted.runId },
      }),
    ).rejects.toMatchObject({ code: "session.invalid_transition" });

    expect(actor.snapshot).toMatchObject({
      activeRunId: submitted.runId,
      activeRunState: "running",
      faulted: true,
    });
    expect(storage.runs.get(submitted.runId)?.state).toBe("cancelling");
    expect(storage.events.filter((event) => event.eventType === "run.cancel.requested")).toHaveLength(1);
    activeTask.resolve({ state: "completed" });
    await actor.shutdown();
  });

  it("signals cancellation promptly, is idempotent, and records one terminal outcome", async () => {
    const { actor, storage, tasks, scheduler } = await actorFixture("cancel");
    const submitted = await actor.submitMessage(message(actor.sessionId, "cmd_cancelSubmit"));
    const task = await waitForTask(tasks, submitted.runId);
    const cancel = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_cancelRun",
      sessionId: actor.sessionId,
      method: "run.cancel" as const,
      params: { runId: submitted.runId },
    };
    await expect(actor.cancelRun(cancel)).resolves.toMatchObject({ state: "cancelling" });
    expect(task.context.signal.aborted).toBe(true);
    await expect(actor.cancelRun(cancel)).resolves.toMatchObject({
      state: "cancelling",
      acceptance: { duplicate: true },
    });
    expect(scheduler.state.provider).toMatchObject({ active: 1, available: 1 });
    task.resolve({ state: "completed" });
    await waitForState(actor, null);
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 2 });
    await actor.flush();
    expect(storage.events.filter((value) => value.eventType === "run.cancelled")).toHaveLength(1);
    expect(storage.events.filter((value) => value.eventType === "run.completed")).toHaveLength(0);
  });

  it("retains its permit until cancelled work acknowledges cancellation", async () => {
    const { actor, scheduler, tasks } = await actorFixture("cooperativeCancel");
    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_cooperativeSubmit"),
    );
    const task = await waitForTask(tasks, submitted.runId);
    await actor.cancelRun({
      v: 1,
      kind: "command",
      commandId: "cmd_cooperativeCancel",
      sessionId: actor.sessionId,
      method: "run.cancel",
      params: { runId: submitted.runId },
    });
    expect(actor.snapshot.activeRunState).toBe("cancelling");
    expect(scheduler.state.provider).toMatchObject({ active: 1, available: 1 });
    task.resolve({ state: "completed" });
    await waitForState(actor, null);
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 2 });
    await expect(actor.shutdown()).resolves.toBeUndefined();
  });

  it("releases its permit after confirmed cancellation when the result promise never settles", async () => {
    const storage = new FakeActorStorage("ses_confirmedCancellation");
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const monitor = new ActivityMonitor();
    let stopped = false;
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("confirmedCancellation"),
      now: () => 10,
      runTask: async () => new Promise<RunTaskResult>(() => {}),
      cancelRunTask: async () => {
        stopped = true;
      },
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => monitor.signal(),
    });
    actorMonitors.set(actor, monitor);
    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_confirmedCancellationSubmit"),
    );
    await actor.cancelRun({
      v: 1,
      kind: "command",
      commandId: "cmd_confirmedCancellationCancel",
      sessionId: actor.sessionId,
      method: "run.cancel",
      params: { runId: submitted.runId },
    });
    await scheduler.provider.drain();
    await waitForState(actor, null);

    expect(stopped).toBe(true);
    expect(actor.snapshot.activeRunId).toBeNull();
    expect(storage.runs.get(submitted.runId)?.state).toBe("cancelled");
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 1 });
    await actor.shutdown();
  });

  it.each([
    ["thrown exception", "provider.protocol_error", "The provider returned an invalid response."],
    [
      "returned failure",
      "storage.worker_failed",
      "A storage operation failed while processing the run.",
    ],
  ] as const)(
    "persists only server-authored text for a generic run-task %s",
    async (outcome, code, expectedMessage) => {
      const secret = `Bearer AUDIT_RUN_TASK_${outcome.replaceAll(" ", "_").toUpperCase()}`;
      const suffix = outcome === "thrown exception" ? "Thrown" : "Returned";
      const diagnostics: SessionRunFailureDiagnostic[] = [];
      const { actor, storage, tasks } = await actorFixture(`safeRunTask${suffix}`, {
        onRunFailureDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      const submitted = await actor.submitMessage(
        message(actor.sessionId, `cmd_safeRunTask${suffix}`),
      );
      const task = await waitForTask(tasks, submitted.runId);
      if (outcome === "thrown exception") task.reject(new Error(secret));
      else task.resolve({ state: "failed", code, message: secret });
      await waitForState(actor, null);

      const terminal = storage.events.find(
        (event) => event.eventType === "run.failed" && event.data.runId === submitted.runId,
      );
      if (terminal?.eventType !== "run.failed") throw new Error("Run failure event is missing");
      const browserEvent = BrowserSessionEventSchema.parse(terminal);
      if (browserEvent.eventType !== "run.failed") {
        throw new Error("Browser run failure projection is missing");
      }
      expect(browserEvent.data.message).toBe(expectedMessage);
      expect(JSON.stringify(storage.events)).not.toContain(secret);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          diagnosticId: terminal.data.diagnosticId,
          sessionId: actor.sessionId,
          runId: submitted.runId,
          state: "failed",
          code,
        }),
      ]);
      await actor.shutdown();
    },
  );

  it("releases its permit and remains usable when cancellation cleanup rejects after stop", async () => {
    const storage = new FakeActorStorage("ses_cancellationCleanupError");
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const monitor = new ActivityMonitor();
    const secondTask = deferred<RunTaskResult>();
    const secondTaskStarted = deferred<void>();
    const diagnostics: SessionRunFailureDiagnostic[] = [];
    const cleanupSecret = "Bearer AUDIT_CANCELLATION_CLEANUP_SECRET";
    let taskCalls = 0;
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("cancellationCleanupError"),
      now: () => 10,
      runTask: async () => {
        taskCalls += 1;
        if (taskCalls === 1) return new Promise<RunTaskResult>(() => {});
        secondTaskStarted.resolve();
        return secondTask.promise;
      },
      cancelRunTask: async () => {
        throw new Error(cleanupSecret);
      },
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => monitor.signal(),
      onRunFailureDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    actorMonitors.set(actor, monitor);

    const first = await actor.submitMessage(
      message(actor.sessionId, "cmd_cancellationCleanupErrorSubmit1"),
    );
    await actor.cancelRun({
      v: 1,
      kind: "command",
      commandId: "cmd_cancellationCleanupErrorCancel",
      sessionId: actor.sessionId,
      method: "run.cancel",
      params: { runId: first.runId },
    });
    await waitForActor(actor, () => actor.snapshot.activeRunId === null);

    expect(storage.runs.get(first.runId)?.state).toBe("interrupted");
    const interrupted = storage.events.find(
      (event) => event.eventType === "run.interrupted" && event.data.runId === first.runId,
    );
    if (interrupted?.eventType !== "run.interrupted") {
      throw new Error("Cancellation interruption event is missing");
    }
    expect(interrupted.data.message).toBe("The provider operation was cancelled.");
    expect(JSON.stringify(storage.events)).not.toContain(cleanupSecret);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        diagnosticId: interrupted.data.diagnosticId,
        runId: first.runId,
        state: "interrupted",
        code: "provider.cancelled",
      }),
    );
    expect(actor.snapshot.faulted).toBe(false);
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 1 });

    const second = await actor.submitMessage(
      message(actor.sessionId, "cmd_cancellationCleanupErrorSubmit2"),
    );
    await secondTaskStarted.promise;
    expect(actor.snapshot.activeRunId).toBe(second.runId);
    secondTask.resolve({ state: "completed" });
    await waitForState(actor, null);

    expect(storage.runs.get(second.runId)?.state).toBe("completed");
    expect(
      storage.events.filter((event) =>
        ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(
          event.eventType,
        ),
      ),
    ).toHaveLength(2);
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 1 });
    await actor.shutdown();
  });

  it("retains cancellation cleanup until shutdown before closing storage", async () => {
    const storage = new FakeActorStorage("ses_retainedCancellationCleanup");
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const monitor = new ActivityMonitor();
    const taskStarted = deferred<void>();
    const cleanup = deferred<void>();
    let forceStopCalls = 0;
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("retainedCancellationCleanup"),
      now: () => 10,
      runTask: async (context) => {
        taskStarted.resolve();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { state: "completed" };
      },
      cancelRunTask: async () => cleanup.promise,
      forceStopRunTask: () => {
        forceStopCalls += 1;
        return { status: "terminated" };
      },
      cancellationWait: async (completion) => {
        await completion;
        return true;
      },
      onActivity: () => monitor.signal(),
    });
    actorMonitors.set(actor, monitor);

    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_retainedCancellationCleanupSubmit"),
    );
    await taskStarted.promise;
    await actor.cancelRun({
      v: 1,
      kind: "command",
      commandId: "cmd_retainedCancellationCleanupCancel",
      sessionId: actor.sessionId,
      method: "run.cancel",
      params: { runId: submitted.runId },
    });
    await waitForState(actor, null);

    expect(storage.runs.get(submitted.runId)?.state).toBe("cancelled");
    expect(actor.snapshot).toMatchObject({
      cancellationCleanupCount: 1,
      idle: false,
    });
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 1 });

    const shutdown = actor.shutdown();
    expect(storage.closeCalls).toBe(0);
    cleanup.resolve();
    await shutdown;

    expect(actor.snapshot.cancellationCleanupCount).toBe(0);
    expect(storage.closeCalls).toBe(1);
    expect(forceStopCalls).toBe(0);
    expect(
      storage.events.filter((event) =>
        ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(
          event.eventType,
        ),
      ),
    ).toHaveLength(1);
  });

  it("isolates unknown cancellation before restoring capacity for another session", async () => {
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const firstStorage = new FakeActorStorage("ses_forcedCancellationA");
    const secondStorage = new FakeActorStorage("ses_forcedCancellationB");
    const firstMonitor = new ActivityMonitor();
    const secondMonitor = new ActivityMonitor();
    const secondStarted = deferred<void>();
    const secondResult = deferred<RunTaskResult>();
    let forceStopCalls = 0;
    const first = await SessionActor.create({
      storage: firstStorage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("forcedCancellationA"),
      now: () => 10,
      runTask: async () => new Promise<RunTaskResult>(() => {}),
      cancelRunTask: async () => new Promise<void>(() => {}),
      cancellationWait: async () => false,
      forceStopRunTask: () => {
        forceStopCalls += 1;
        return { status: "quarantined" };
      },
      onActivity: () => firstMonitor.signal(),
    });
    const second = await SessionActor.create({
      storage: secondStorage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("forcedCancellationB"),
      now: () => 10,
      runTask: async () => {
        secondStarted.resolve();
        return secondResult.promise;
      },
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => secondMonitor.signal(),
    });
    actorMonitors.set(first, firstMonitor);
    actorMonitors.set(second, secondMonitor);

    const firstRun = await first.submitMessage(
      message(first.sessionId, "cmd_forcedCancellationA"),
    );
    const secondRun = await second.submitMessage(
      message(second.sessionId, "cmd_forcedCancellationB"),
    );
    expect(scheduler.state.provider).toMatchObject({ active: 1, queued: 1 });

    await first.cancelRun({
      v: 1,
      kind: "command",
      commandId: "cmd_cancelForcedCancellationA",
      sessionId: first.sessionId,
      method: "run.cancel",
      params: { runId: firstRun.runId },
    });
    await secondStarted.promise;
    await waitForState(first, null);

    expect(forceStopCalls).toBe(1);
    expect(firstStorage.runs.get(firstRun.runId)?.state).toBe("interrupted");
    expect(second.snapshot.activeRunId).toBe(secondRun.runId);
    expect(scheduler.state.provider).toMatchObject({ active: 1, queued: 0 });

    secondResult.resolve({ state: "completed" });
    await waitForState(second, null);
    await Promise.all([first.shutdown(), second.shutdown()]);
  });

  it("releases shared capacity after forced isolation while cleanup remains unsettled", async () => {
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const firstStorage = new FakeActorStorage("ses_forcedIsolationA");
    const secondStorage = new FakeActorStorage("ses_forcedIsolationB");
    const firstMonitor = new ActivityMonitor();
    const secondMonitor = new ActivityMonitor();
    const cancellationDeadline = deferred<boolean>();
    const forceStopEntered = deferred<void>();
    const forceStop = deferred<void>();
    const secondStarted = deferred<void>();
    const secondResult = deferred<RunTaskResult>();
    let secondDidStart = false;
    const first = await SessionActor.create({
      storage: firstStorage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("forcedIsolationA"),
      now: () => 10,
      runTask: async () => new Promise<RunTaskResult>(() => {}),
      cancelRunTask: async () => new Promise<void>(() => {}),
      cancellationWait: async () => cancellationDeadline.promise,
      forceStopRunTask: () => {
        forceStopEntered.resolve();
        return { status: "detached", cleanup: forceStop.promise };
      },
      onActivity: () => firstMonitor.signal(),
    });
    const second = await SessionActor.create({
      storage: secondStorage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("forcedIsolationB"),
      now: () => 10,
      runTask: async () => {
        secondDidStart = true;
        secondStarted.resolve();
        return secondResult.promise;
      },
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => secondMonitor.signal(),
    });
    actorMonitors.set(first, firstMonitor);
    actorMonitors.set(second, secondMonitor);

    const firstRun = await first.submitMessage(message(first.sessionId, "cmd_forcedIsolationA"));
    const secondRun = await second.submitMessage(message(second.sessionId, "cmd_forcedIsolationB"));
    expect(scheduler.state.provider).toMatchObject({
      capacity: 1,
      active: 1,
      available: 0,
      queued: 1,
    });

    await first.cancelRun({
      v: 1,
      kind: "command",
      commandId: "cmd_cancelForcedIsolationA",
      sessionId: first.sessionId,
      method: "run.cancel",
      params: { runId: firstRun.runId },
    });
    expect(first.snapshot).toMatchObject({
      activeRunState: "cancelling",
      cancellationCleanupCount: 1,
    });
    expect(secondDidStart).toBe(false);
    expect(scheduler.state.provider).toMatchObject({ active: 1, queued: 1 });
    expect(
      firstStorage.events.filter((event) => event.eventType === "run.interrupted"),
    ).toHaveLength(0);

    cancellationDeadline.resolve(false);
    await forceStopEntered.promise;
    await secondStarted.promise;
    await waitForState(first, null);

    try {
      expect(firstStorage.runs.get(firstRun.runId)?.state).toBe("interrupted");
      expect(first.snapshot.cancellationCleanupCount).toBe(0);
      expect(secondDidStart).toBe(true);
      expect(second.snapshot.activeRunId).toBe(secondRun.runId);
      expect(scheduler.state.provider).toMatchObject({ active: 1, queued: 0 });
      expect(
        firstStorage.events.filter((event) => event.eventType === "run.interrupted"),
      ).toHaveLength(1);
      forceStop.reject(new Error("late best-effort cleanup failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(first.snapshot.faulted).toBe(false);
      expect(scheduler.state.provider).toMatchObject({ active: 1, queued: 0 });
    } finally {
      forceStop.resolve();
      secondResult.resolve({ state: "completed" });
      await waitForState(second, null);
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  });

  it("preserves completion when cancellation arrives after terminal commit", async () => {
    const { actor, storage, tasks } = await actorFixture("race");
    const submitted = await actor.submitMessage(message(actor.sessionId, "cmd_raceSubmit"));
    const task = await waitForTask(tasks, submitted.runId);
    task.resolve({ state: "completed" });
    await waitForState(actor, null);
    const cancel = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_raceCancel",
      sessionId: actor.sessionId,
      method: "run.cancel" as const,
      params: { runId: submitted.runId },
    };
    await expect(actor.cancelRun(cancel)).resolves.toMatchObject({
      state: "completed",
      acceptance: { duplicate: false, events: [] },
    });
    await expect(actor.cancelRun(cancel)).resolves.toMatchObject({
      state: "completed",
      acceptance: { duplicate: true, events: [] },
    });
    await expect(
      actor.cancelRun({ ...cancel, params: { runId: "run_different" } }),
    ).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    const terminal = storage.events.filter((value) =>
      ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(value.eventType),
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.eventType).toBe("run.completed");
  });

  it("ignores stale old-run callbacks after starting a later run", async () => {
    const { actor, storage, tasks } = await actorFixture("stale");
    const first = await actor.submitMessage(message(actor.sessionId, "cmd_stale1"));
    const firstTask = await waitForTask(tasks, first.runId);
    const second = await actor.submitMessage(message(actor.sessionId, "cmd_stale2"));
    firstTask.resolve({ state: "completed" });
    await waitForActor(actor, () => actor.snapshot.activeRunId === second.runId);
    await actor.notifyTaskOutcome(first.runId, firstTask.context.generation, { state: "failed" });
    expect(actor.snapshot.activeRunId).toBe(second.runId);
    expect(storage.events.filter((value) => value.eventType === "run.failed")).toHaveLength(0);
    (await waitForTask(tasks, second.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
  });

  it("does not launch a task when shutdown races the run.started commit", async () => {
    const storage = new FakeActorStorage("ses_shutdownStartRace");
    const originalAppend = storage.appendTransaction.bind(storage);
    let signalStarted = (): void => {};
    let releaseStart = (): void => {};
    const startCalled = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      if (input.events[0]?.eventType === "run.started") {
        signalStarted();
        await startGate;
      }
      return originalAppend(input);
    });
    const tasks = new ControlledTasks();
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("shutdownStartRace"),
      now: () => 10,
      runTask: tasks.task,
      cancelRunTask: tasks.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
    });

    const submitting = actor.submitMessage(message(actor.sessionId, "cmd_shutdownStartRace"));
    await startCalled;
    const shuttingDown = actor.shutdown();
    releaseStart();
    const submitted = await submitting;
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(tasks.pending.has(submitted.runId)).toBe(false);
    expect(storage.runs.get(submitted.runId)?.state).toBe("interrupted");
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 1 });
  });

  it("waits for active task cancellation before releasing its permit during shutdown", async () => {
    const storage = new FakeActorStorage("ses_shutdown");
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    let context: RunTaskContext | undefined;
    let signalTaskStarted = (): void => {};
    const taskStarted = new Promise<void>((resolve) => {
      signalTaskStarted = resolve;
    });
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("shutdown"),
      now: () => 10,
      runTask: (value) => {
        context = value;
        signalTaskStarted();
        return new Promise((resolve) => {
          value.signal.addEventListener("abort", () => resolve({ state: "completed" }), {
            once: true,
          });
        });
      },
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });
    const submitted = await actor.submitMessage(message(actor.sessionId, "cmd_shutdown"));
    await taskStarted;
    expect(scheduler.state.provider.active).toBe(1);
    await actor.shutdown();
    expect(context?.signal.aborted).toBe(true);
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 1 });
    expect(storage.runs.get(submitted.runId)?.state).toBe("interrupted");
    expect(storage.closeCalls).toBe(1);
  });

  it("bounds shutdown while an accepted mailbox handler is blocked", async () => {
    const storage = new FakeActorStorage("ses_shutdownMailboxTimeout");
    const originalAccept = storage.acceptCommand.bind(storage);
    const entered = deferred<void>();
    const gate = deferred<void>();
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      entered.resolve();
      await gate.promise;
      return originalAccept(input);
    });
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: ids("shutdownMailboxTimeout"),
      now: () => 10,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
      shutdownWait: async () => false,
    });
    const submitting = actor.submitMessage(
      message(actor.sessionId, "cmd_shutdownMailboxTimeout"),
    );
    await entered.promise;

    await expect(actor.shutdown()).rejects.toMatchObject({ name: "ShutdownTimeoutError" });
    expect(storage.closeCalls).toBe(0);
    gate.resolve();
    await submitting;
  });

  it("bounds shutdown when active work ignores cancellation", async () => {
    const storage = new FakeActorStorage("ses_shutdownTimeout");
    const tasks = new ControlledTasks();
    const scheduler = new RunScheduler({ providerCapacity: 1, toolCapacity: 1 });
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler,
      ids: ids("shutdownTimeout"),
      now: () => 10,
      runTask: tasks.task,
      cancelRunTask: tasks.cancel,
      forceStopRunTask: () => ({ status: "terminated" }),
      shutdownWait: async () => false,
    });
    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_shutdownTimeout"),
    );
    const task = await waitForTask(tasks, submitted.runId);

    await expect(actor.shutdown()).rejects.toMatchObject({ name: "ShutdownTimeoutError" });
    expect(actor.snapshot.closed).toBe(true);
    expect(storage.closeCalls).toBe(0);
    expect(scheduler.state.provider.active).toBe(1);

    task.resolve({ state: "completed" });
    await scheduler.provider.drain();
    expect(scheduler.state.provider.active).toBe(0);
  });

  it("quarantines an ambiguous task write when event reconciliation cannot be read", async () => {
    let faultCount = 0;
    const { actor, storage, tasks, scheduler } = await actorFixture("taskEventReadFailure", {
      onFault: () => {
        faultCount += 1;
      },
    });
    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_taskEventReadFailure"),
    );
    const task = await waitForTask(tasks, submitted.runId);
    const ambiguity = Object.assign(new Error("ambiguous task append"), {
      code: "storage.ambiguous_outcome",
    });
    const eventId = "evt_taskEventReadFailure";
    const originalAppend = storage.appendTransaction.bind(storage);
    let taskAppendCalls = 0;
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      if (input.events[0]?.eventId === eventId) {
        taskAppendCalls += 1;
        throw ambiguity;
      }
      return originalAppend(input);
    });
    const originalGetEvent = storage.getEventById.bind(storage);
    vi.spyOn(storage, "getEventById").mockImplementation(async (candidateEventId) => {
      if (candidateEventId === eventId) throw new Error("event reconciliation unavailable");
      return originalGetEvent(candidateEventId);
    });
    const transaction: AppendTransactionInput = {
      events: [
        {
          eventId,
          eventType: "provider.step.started",
          createdAtMs: 2_000,
          data: {
            eventVersion: 1,
            runId: submitted.runId,
            stepId: "step_taskEventReadFailure",
            stepIndex: 0,
          },
        },
      ],
    };

    await expect(task.context.commitTransaction(transaction)).rejects.toBe(ambiguity);
    expect(actor.snapshot.faulted).toBe(true);
    expect(faultCount).toBe(1);
    await expect(task.context.commitTransaction(transaction)).rejects.toMatchObject({
      code: "session.unavailable",
    });
    expect(taskAppendCalls).toBe(1);

    task.resolve({ state: "failed", code: "provider.protocol_error" });
    await scheduler.provider.drain();
    await Promise.resolve();
    expect(storage.runs.get(submitted.runId)?.state).toBe("running");
    expect(
      storage.events.filter((event) =>
        ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(
          event.eventType,
        ),
      ),
    ).toEqual([]);
  });

  it.each(["failure", "missing"] as const)(
    "quarantines an ambiguous task write when the reconciled run read is %s",
    async (runReadOutcome) => {
      let faultCount = 0;
      const { actor, storage, tasks, scheduler } = await actorFixture(
        `taskRunRead${runReadOutcome}`,
        {
          onFault: () => {
            faultCount += 1;
          },
        },
      );
      const submitted = await actor.submitMessage(
        message(actor.sessionId, `cmd_taskRunRead${runReadOutcome}`),
      );
      const task = await waitForTask(tasks, submitted.runId);
      const ambiguity = Object.assign(new Error("ambiguous committed task append"), {
        code: "storage.ambiguous_outcome",
      });
      const eventId = `evt_taskRunRead${runReadOutcome}`;
      const originalAppend = storage.appendTransaction.bind(storage);
      let taskAppendCalls = 0;
      vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
        if (input.events[0]?.eventId === eventId) {
          taskAppendCalls += 1;
          await originalAppend(input);
          throw ambiguity;
        }
        return originalAppend(input);
      });
      const originalGetRun = storage.getRun.bind(storage);
      vi.spyOn(storage, "getRun").mockImplementation(async (runId) => {
        if (runId === submitted.runId) {
          if (runReadOutcome === "failure") throw new Error("run reconciliation unavailable");
          return null;
        }
        return originalGetRun(runId);
      });
      const transaction: AppendTransactionInput = {
        events: [
          {
            eventId,
            eventType: "provider.step.started",
            createdAtMs: 2_000,
            data: {
              eventVersion: 1,
              runId: submitted.runId,
              stepId: `step_taskRunRead${runReadOutcome}`,
              stepIndex: 0,
            },
          },
        ],
      };

      if (runReadOutcome === "failure") {
        await expect(task.context.commitTransaction(transaction)).rejects.toBe(ambiguity);
      } else {
        await expect(task.context.commitTransaction(transaction)).rejects.toMatchObject({
          code: "storage.corrupt",
          name: "EventReconciliationIntegrityError",
        });
      }
      expect(storage.events.some((event) => event.eventId === eventId)).toBe(true);
      expect(actor.snapshot.faulted).toBe(true);
      expect(faultCount).toBe(1);
      await expect(task.context.commitTransaction(transaction)).rejects.toMatchObject({
        code: "session.unavailable",
      });
      expect(taskAppendCalls).toBe(1);

      task.resolve({ state: "failed", code: "provider.protocol_error" });
      await scheduler.provider.drain();
      await Promise.resolve();
      expect(storage.runs.get(submitted.runId)?.state).toBe("running");
      expect(
        storage.events.filter((event) =>
          ["run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(
            event.eventType,
          ),
        ),
      ).toEqual([]);
    },
  );

  it("reconciles an ambiguous terminal commit and publishes its committed event once", async () => {
    const { actor, storage, tasks } = await actorFixture("ambiguousTerminal");
    const originalAppend = storage.appendTransaction.bind(storage);
    let injected = false;
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      const result = await originalAppend(input);
      if (!injected && input.events[0]?.eventType === "run.completed") {
        injected = true;
        throw new Error("ambiguous worker result");
      }
      return result;
    });
    const submitted = await actor.submitMessage(
      message(actor.sessionId, "cmd_ambiguousTerminal"),
    );
    (await waitForTask(tasks, submitted.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
    expect(storage.events.filter((event) => event.eventType === "run.completed")).toHaveLength(1);
    expect(actor.snapshot.faulted).toBe(false);
  });

  it("retries a terminal transition that definitely did not commit", async () => {
    const { actor, storage, tasks } = await actorFixture("retryTerminal");
    const originalAppend = storage.appendTransaction.bind(storage);
    let attempts = 0;
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      if (input.events[0]?.eventType === "run.completed" && attempts++ === 0) {
        throw new Error("injected pre-commit failure");
      }
      return originalAppend(input);
    });
    const submitted = await actor.submitMessage(message(actor.sessionId, "cmd_retryTerminal"));
    (await waitForTask(tasks, submitted.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
    expect(attempts).toBe(2);
    expect(storage.events.filter((event) => event.eventType === "run.completed")).toHaveLength(1);
  });

  it("faults inside the mailbox before a queued command can mutate the session", async () => {
    const { actor, storage, tasks, scheduler } = await actorFixture("faultTerminal");
    const terminalEntered = deferred<void>();
    const releaseTerminal = deferred<void>();
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      if (input.events[0]?.eventType === "run.completed") {
        terminalEntered.resolve();
        await releaseTerminal.promise;
        throw new Error("persistent terminal failure");
      }
      return FakeActorStorage.prototype.appendTransaction.call(storage, input);
    });
    const submitted = await actor.submitMessage(message(actor.sessionId, "cmd_faultTerminal"));
    (await waitForTask(tasks, submitted.runId)).resolve({ state: "completed" });
    await terminalEntered.promise;
    const queued = actor.submitMessage(message(actor.sessionId, "cmd_queuedBeforeFault"));
    releaseTerminal.resolve();

    await expect(queued).rejects.toMatchObject({ code: "session.unavailable" });
    await waitForActor(actor, () => actor.snapshot.faulted);
    expect(actor.snapshot.faulted).toBe(true);
    expect(actor.snapshot.activeRunId).toBe(submitted.runId);
    expect(scheduler.state.provider).toMatchObject({ active: 0, available: 2 });
    expect(storage.events.filter((event) => event.eventType === "run.created")).toHaveLength(1);
    await expect(
      actor.submitMessage(message(actor.sessionId, "cmd_rejectedAfterFault")),
    ).rejects.toMatchObject({ code: "session.unavailable" });
    await actor.shutdown();
  });

  it("keeps an active run alive with zero subscribers and isolates sessions", async () => {
    const left = await actorFixture("left");
    const right = await actorFixture("right");
    const leftRun = await left.actor.submitMessage(message(left.actor.sessionId, "cmd_left"));
    const rightRun = await right.actor.submitMessage(message(right.actor.sessionId, "cmd_right"));
    (await waitForTask(left.tasks, leftRun.runId)).reject(new Error("left failed"));
    await waitForState(left.actor, null);
    expect(right.actor.snapshot).toMatchObject({
      activeRunId: rightRun.runId,
      activeRunState: "running",
      subscriberCount: 0,
    });
    expect(right.storage.events.some((value) => value.eventType === "run.failed")).toBe(false);
    (await waitForTask(right.tasks, rightRun.runId)).resolve({ state: "completed" });
    await waitForState(right.actor, null);
  });

  it("retires a registry-managed actor faulted after durable acceptance and resumes its queued run", async () => {
    const sessionId = "ses_faultRetirement";
    const storage = new FakeActorStorage(sessionId);
    const originalAppend = storage.appendTransaction.bind(storage);
    const originalRecover = storage.recover.bind(storage);
    let recoverCalls = 0;
    vi.spyOn(storage, "recover").mockImplementation(async () => {
      recoverCalls += 1;
      return originalRecover();
    });
    let startAttempts = 0;
    vi.spyOn(storage, "appendTransaction").mockImplementation(async (input) => {
      if (input.events[0]?.eventType === "run.started") {
        startAttempts += 1;
        if (startAttempts === 1) {
          throw Object.assign(new Error("injected ambiguous pre-commit start failure"), {
            code: "storage.ambiguous_outcome",
          });
        }
        expect(recoverCalls).toBe(2);
      }
      return originalAppend(input);
    });
    let factoryCount = 0;
    let faultNotificationCount = 0;
    let originalRunStartCount = 0;
    const createActor: (
      sessionId: string,
      onActivity: () => void,
      onFault: (error: unknown) => void,
    ) => Promise<SessionActor> = async (_sessionId, onActivity, onFault) => {
      factoryCount += 1;
      const actor = await SessionActor.create({
        storage,
        eventHub: new CommittedEventHub(),
        scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
        ids: ids(`faultRetirement${factoryCount}`),
        now: () => 10,
        runTask: ({ signal }) => {
          originalRunStartCount += 1;
          return new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ state: "interrupted" }), { once: true });
          });
        },
        cancelRunTask: async () => undefined,
        forceStopRunTask: () => ({ status: "terminated" }),
        onActivity,
        onFault: (error) => {
          faultNotificationCount += 1;
          onFault(error);
        },
      });
      return actor;
    };
    const registry = new SessionActorRegistry({
      createActor,
      now: () => 10,
      idleTimeoutMs: 10,
    });
    const firstLease = await registry.acquire(sessionId);
    const accepted = await firstLease.actor.submitMessage(
      message(sessionId, "cmd_faultRetirement"),
    );

    expect(accepted.acceptance.duplicate).toBe(false);
    expect(firstLease.actor.snapshot.faulted).toBe(true);
    expect(faultNotificationCount).toBe(1);
    expect(storage.runs.get(accepted.runId)?.state).toBe("queued");
    expect(originalRunStartCount).toBe(0);

    firstLease.release();
    const secondLease = await registry.acquire(sessionId);

    expect(secondLease.actor).not.toBe(firstLease.actor);
    expect(factoryCount).toBe(2);
    expect(storage.closeCalls).toBe(1);
    expect(secondLease.actor.snapshot).toMatchObject({
      activeRunId: accepted.runId,
      activeRunState: "running",
      faulted: false,
    });
    expect(originalRunStartCount).toBe(1);
    expect(recoverCalls).toBe(2);
    expect(startAttempts).toBe(2);
    expect(storage.events.filter((event) => event.eventType === "run.created")).toHaveLength(1);
    expect(storage.events.filter((event) => event.eventType === "run.started")).toHaveLength(1);

    secondLease.release();
    await registry.close();
  });

  it("prevents idle eviction when a concrete message is submitted during the decision", async () => {
    let clock = 0;
    let actor!: SessionActor;
    let submittedRunId: string | undefined;
    let raced = false;
    const tasks = new ControlledTasks();
    const monitor = new ActivityMonitor();
    const registry = new SessionActorRegistry({
      createActor: async (_sessionId, onActivity) => {
        actor = await SessionActor.create({
          storage: new FakeActorStorage("ses_evictionMessageRace"),
          eventHub: new CommittedEventHub(),
          scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
          ids: ids("evictionMessageRace"),
          now: () => clock,
          runTask: tasks.task,
          cancelRunTask: tasks.cancel,
          forceStopRunTask: () => ({ status: "terminated" }),
          onActivity: () => {
            onActivity();
            monitor.signal();
          },
        });
        actorMonitors.set(actor, monitor);
        return actor;
      },
      now: () => clock,
      idleTimeoutMs: 10,
      beforeEvict: async () => {
        if (!raced) {
          raced = true;
          submittedRunId = (
            await actor.submitMessage(
              message("ses_evictionMessageRace", "cmd_evictionMessageRace"),
            )
          ).runId;
        }
      },
    });
    const lease = await registry.acquire("ses_evictionMessageRace");
    lease.release();
    clock = 20;

    await expect(registry.evictIdle()).resolves.toEqual([]);
    expect(actor.snapshot).toMatchObject({
      activeRunId: submittedRunId,
      activeRunState: "running",
      closed: false,
    });

    if (submittedRunId === undefined) throw new Error("Eviction race did not submit a run");
    (await waitForTask(tasks, submittedRunId)).resolve({ state: "completed" });
    await waitForState(actor, null);
    await actor.flush();
    clock = 40;
    await expect(registry.evictIdle()).resolves.toEqual(["ses_evictionMessageRace"]);
    await registry.close();
  });

  it("prevents idle eviction when a concrete subscriber connects during the decision", async () => {
    let clock = 0;
    let actor: SessionActor | undefined;
    let raced = false;
    const registry = new SessionActorRegistry({
      createActor: async (_sessionId, onActivity) => {
        actor = await SessionActor.create({
          storage: new FakeActorStorage("ses_evictionSubscriberRace"),
          eventHub: new CommittedEventHub(),
          scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
          ids: ids("evictionSubscriberRace"),
          now: () => clock,
          runTask: async () => undefined,
          cancelRunTask: async () => undefined,
          forceStopRunTask: () => ({ status: "terminated" }),
          onActivity,
        });
        return actor;
      },
      now: () => clock,
      idleTimeoutMs: 10,
      beforeEvict: async () => {
        if (!raced) {
          raced = true;
          await actor?.subscriberConnected("subscriber_race");
        }
      },
    });
    const lease = await registry.acquire("ses_evictionSubscriberRace");
    lease.release();
    clock = 20;

    await expect(registry.evictIdle()).resolves.toEqual([]);
    expect(actor?.snapshot.subscriberCount).toBe(1);
    expect(actor?.snapshot.closed).toBe(false);

    await actor?.subscriberDisconnected("subscriber_race");
    clock = 40;
    await expect(registry.evictIdle()).resolves.toEqual(["ses_evictionSubscriberRace"]);
    await registry.close();
  });

  it("tracks subscriber identity so duplicate disconnect cannot remove another subscriber", async () => {
    const { actor } = await actorFixture("subscribers");
    await actor.subscriberConnected("subscriber_a");
    await actor.subscriberConnected("subscriber_b");
    await actor.subscriberConnected("subscriber_a");
    expect(actor.snapshot.subscriberCount).toBe(2);

    await actor.subscriberDisconnected("subscriber_a");
    await actor.subscriberDisconnected("subscriber_a");
    expect(actor.snapshot).toMatchObject({ subscriberCount: 1, idle: false });

    await actor.subscriberDisconnected("subscriber_b");
    expect(actor.snapshot).toMatchObject({ subscriberCount: 0, idle: true });
    await actor.shutdown();
  });

  it("cancels pending interactions when a waiting run is cancelled", async () => {
    const storage = new FakeActorStorage("ses_cancelWaiting");
    storage.runs.set("run_cancelWaiting", {
      runId: "run_cancelWaiting",
      state: "waiting_for_user",
      providerId: "fake",
      providerConfig: {},
      createdAtMs: 1,
      startedAtMs: 2,
      completedAtMs: null,
      cancelledAtMs: null,
      failureCategory: null,
      failureMessage: null,
      activeProviderStepId: null,
    });
    storage.approvals.set("approval_cancelWaiting", {
      approvalId: "approval_cancelWaiting",
      runId: "run_cancelWaiting",
      callId: "call_cancelWaiting",
      state: "pending",
      actionDigest: "a".repeat(64),
      requestedAtMs: 3,
    });
    storage.inputs.set("input_cancelWaiting", {
      inputId: "input_cancelWaiting",
      runId: "run_cancelWaiting",
      state: "pending",
      prompt: "Continue?",
      requestedAtMs: 3,
    });
    const monitor = new ActivityMonitor();
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: ids("cancelWaiting"),
      now: () => 4,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
      onActivity: () => monitor.signal(),
    });
    actorMonitors.set(actor, monitor);

    await actor.cancelRun({
      v: 1,
      kind: "command",
      commandId: "cmd_cancelWaiting",
      sessionId: actor.sessionId,
      method: "run.cancel",
      params: { runId: "run_cancelWaiting" },
    });
    await waitForState(actor, null);

    expect(storage.runs.get("run_cancelWaiting")?.state).toBe("cancelled");
    expect(storage.approvals.size).toBe(0);
    expect(storage.inputs.size).toBe(0);
    expect(actor.snapshot).toMatchObject({ pendingApprovalCount: 0, pendingInputCount: 0 });
    await expect(
      actor.resolveApproval(
        {
          v: 1,
          kind: "command",
          commandId: "cmd_staleApproval",
          sessionId: actor.sessionId,
          method: "approval.resolve",
          params: { approvalId: "approval_cancelWaiting", resolution: "approved" },
        },
        "client_actor",
      ),
    ).rejects.toMatchObject({ code: "approval.already_resolved" });
    await expect(
      actor.respondToInput({
        v: 1,
        kind: "command",
        commandId: "cmd_staleInput",
        sessionId: actor.sessionId,
        method: "input.respond",
        params: { inputId: "input_cancelWaiting", value: "yes" },
      }),
    ).rejects.toMatchObject({ code: "input.already_resolved" });
    await actor.shutdown();
  });

  it("resolves a durable approval exactly once", async () => {
    const storage = new FakeActorStorage("ses_approval");
    storage.runs.set("run_approval", {
      runId: "run_approval",
      state: "waiting_for_user",
      providerId: "fake",
      providerConfig: {},
      createdAtMs: 1,
      startedAtMs: 2,
      completedAtMs: null,
      cancelledAtMs: null,
      failureCategory: null,
      failureMessage: null,
      activeProviderStepId: null,
    });
    storage.approvals.set("approval_actor", {
      approvalId: "approval_actor",
      runId: "run_approval",
      callId: "call_actor",
      state: "pending",
      actionDigest: "a".repeat(64),
      requestedAtMs: 3,
    });
    const actor = await SessionActor.create({
      storage,
      eventHub: new CommittedEventHub(),
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: ids("approval"),
      now: () => 4,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });
    const originalAccept = storage.acceptCommand.bind(storage);
    let injected = false;
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      const result = await originalAccept(input);
      if (!injected && input.commandMethod === "approval.resolve") {
        injected = true;
        throw new Error("ambiguous approval result");
      }
      return result;
    });
    const command = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_approvalResolve",
      sessionId: actor.sessionId,
      method: "approval.resolve" as const,
      params: { approvalId: "approval_actor", resolution: "approved" as const },
    };
    await expect(actor.resolveApproval(command, "client_actor")).resolves.toMatchObject({
      duplicate: true,
    });
    await expect(actor.resolveApproval(command, "client_actor")).resolves.toMatchObject({
      duplicate: true,
    });
    await expect(
      actor.resolveApproval(
        { ...command, params: { ...command.params, resolution: "denied" } },
        "client_actor",
      ),
    ).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    expect(storage.events.filter((value) => value.eventType === "tool.approval.resolved")).toHaveLength(1);
    expect(actor.snapshot.pendingApprovalCount).toBe(0);
  });

  it("returns the original queued result for a duplicate message", async () => {
    const { actor } = await actorFixture("duplicateMessage");
    const command = message(actor.sessionId, "cmd_duplicateMessage");
    const first = await actor.submitMessage(command);
    const duplicate = await actor.submitMessage(command);
    expect(first.queued).toBe(false);
    expect(duplicate).toMatchObject({ runId: first.runId, queued: false });
    expect(duplicate.acceptance.duplicate).toBe(true);
  });

  it("returns a durable duplicate message result when its worker response is ambiguous", async () => {
    const { actor, storage, tasks } = await actorFixture("ambiguousDuplicateMessage");
    const command = message(actor.sessionId, "cmd_ambiguousDuplicateMessage");
    const first = await actor.submitMessage(command);
    const originalAccept = storage.acceptCommand.bind(storage);
    let injected = false;
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      const result = await originalAccept(input);
      if (!injected && input.commandId === command.commandId && result.duplicate) {
        injected = true;
        throw Object.assign(new Error("ambiguous duplicate command result"), {
          code: "storage.ambiguous_outcome",
        });
      }
      return result;
    });

    const duplicate = await actor.submitMessage(command);

    expect(injected).toBe(true);
    expect(duplicate).toMatchObject({ runId: first.runId, queued: false });
    expect(duplicate.acceptance.duplicate).toBe(true);
    expect(storage.runs.size).toBe(1);
    expect(storage.events.filter((event) => event.eventType === "run.created")).toHaveLength(1);
    (await waitForTask(tasks, first.runId)).resolve({ state: "completed" });
    await waitForState(actor, null);
  });

  it("faults after a post-commit publication conflict without rejecting durable acceptance", async () => {
    const storage = new FakeActorStorage("ses_publicationConflict");
    const hub = new CommittedEventHub();
    hub.publishCommitted({
      v: 1,
      kind: "event",
      sessionId: storage.sessionId,
      sequence: 100,
      eventId: "evt_publicationConflictPrimed",
      eventType: "run.started",
      createdAtMs: 1,
      data: { eventVersion: 1, runId: "run_publicationConflictPrimed" },
    } satisfies SessionEvent);
    const actor = await SessionActor.create({
      storage,
      eventHub: hub,
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: ids("publicationConflict"),
      now: () => 10,
      runTask: async () => undefined,
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });

    const accepted = await actor.submitMessage(
      message(actor.sessionId, "cmd_publicationConflict"),
    );

    expect(accepted.acceptance.duplicate).toBe(false);
    expect(storage.events.map((event) => event.eventType)).toEqual([
      "user.message.appended",
      "run.created",
    ]);
    expect(actor.snapshot).toMatchObject({
      activeRunId: null,
      queuedRunIds: [accepted.runId],
      faulted: true,
    });
    await expect(
      actor.submitMessage(message(actor.sessionId, "cmd_afterPublicationConflict")),
    ).rejects.toMatchObject({ code: "session.unavailable" });
    await actor.shutdown();
  });

  it("quarantines a recovery publication conflict before the first actor is acquired", async () => {
    const sessionId = "ses_registryRecoveryPublicationConflict";
    const recoveringRunId = "run_registryRecoveryPublicationConflict";
    const queuedRunId = "run_registryRecoveryPublicationQueued";
    const storage = new FakeActorStorage(sessionId);
    storage.runs.set(recoveringRunId, {
      runId: recoveringRunId,
      state: "running",
      providerId: "fake",
      providerConfig: {},
      createdAtMs: 1,
      startedAtMs: 2,
      completedAtMs: null,
      cancelledAtMs: null,
      failureCategory: null,
      failureMessage: null,
      activeProviderStepId: null,
    });
    storage.runs.set(queuedRunId, {
      runId: queuedRunId,
      state: "queued",
      providerId: "fake",
      providerConfig: {},
      createdAtMs: 3,
      startedAtMs: null,
      completedAtMs: null,
      cancelledAtMs: null,
      failureCategory: null,
      failureMessage: null,
      activeProviderStepId: null,
    });
    vi.spyOn(storage, "recover").mockResolvedValue({
      interruptedRunIds: [recoveringRunId],
      interruptedStepIds: [],
      startedToolCalls: [],
      outcomeUnknownRunIds: [],
    });
    const hub = new CommittedEventHub();
    hub.publishCommitted({
      v: 1,
      kind: "event",
      sessionId,
      sequence: 100,
      eventId: "evt_registryRecoveryPublicationConflictPrimed",
      eventType: "run.started",
      createdAtMs: 1,
      data: { eventVersion: 1, runId: "run_registryRecoveryPublicationConflictPrimed" },
    } satisfies SessionEvent);
    const tasks = new ControlledTasks();
    let constructions = 0;
    const registry = new SessionActorRegistry({
      createActor: async (_sessionId, onActivity, onFault) => {
        constructions += 1;
        return SessionActor.create({
          storage,
          eventHub: hub,
          scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
          ids: ids(`registryRecoveryPublication${constructions}`),
          now: () => 10,
          runTask: tasks.task,
          cancelRunTask: tasks.cancel,
          forceStopRunTask: () => ({ status: "terminated" }),
          onActivity,
          onFault,
        });
      },
      now: () => 10,
      idleTimeoutMs: 10,
    });

    await expect(registry.acquire(sessionId)).rejects.toMatchObject({
      code: "session.unavailable",
      name: "SessionRegistryUnavailableError",
    });
    await expect(registry.acquire(sessionId)).rejects.toMatchObject({
      code: "session.unavailable",
    });

    expect(constructions).toBe(1);
    expect(storage.closeCalls).toBe(1);
    expect(storage.runs.get(recoveringRunId)?.state).toBe("interrupted");
    expect(storage.runs.get(queuedRunId)?.state).toBe("queued");
    expect(storage.events.filter((event) => event.eventType === "run.interrupted")).toHaveLength(1);
    expect(storage.events.some((event) => event.eventType === "run.started")).toBe(false);
    expect(tasks.pending.has(queuedRunId)).toBe(false);
    expect(registry.states()[0]).toMatchObject({
      faulted: true,
      retiring: true,
      constructing: true,
    });
    await expect(registry.close()).rejects.toThrow("failed to shut down");
  });

  it("quarantines a registry-managed publication conflict without resetting it", async () => {
    const faultedSessionId = "ses_registryPublicationConflict";
    const healthySessionId = "ses_registryPublicationHealthy";
    const faultedStorage = new FakeActorStorage(faultedSessionId);
    const healthyStorage = new FakeActorStorage(healthySessionId);
    const hub = new CommittedEventHub();
    hub.publishCommitted({
      v: 1,
      kind: "event",
      sessionId: faultedSessionId,
      sequence: 100,
      eventId: "evt_registryPublicationConflictPrimed",
      eventType: "run.started",
      createdAtMs: 1,
      data: { eventVersion: 1, runId: "run_registryPublicationConflictPrimed" },
    } satisfies SessionEvent);
    const scheduler = new RunScheduler({ providerCapacity: 2, toolCapacity: 1 });
    const tasks = new ControlledTasks();
    const constructions = new Map<string, number>();
    const registry = new SessionActorRegistry({
      createActor: async (sessionId, onActivity, onFault) => {
        constructions.set(sessionId, (constructions.get(sessionId) ?? 0) + 1);
        const monitor = new ActivityMonitor();
        const actor = await SessionActor.create({
          storage: sessionId === faultedSessionId ? faultedStorage : healthyStorage,
          eventHub: hub,
          scheduler,
          ids: ids(`registryPublication${sessionId}${constructions.get(sessionId)}`),
          now: () => 10,
          runTask: tasks.task,
          cancelRunTask: tasks.cancel,
          forceStopRunTask: () => ({ status: "terminated" }),
          onActivity: () => {
            monitor.signal();
            onActivity();
          },
          onFault,
        });
        actorMonitors.set(actor, monitor);
        return actor;
      },
      now: () => 10,
      idleTimeoutMs: 10,
    });
    const faultedLease = await registry.acquire(faultedSessionId);
    const healthyLease = await registry.acquire(healthySessionId);
    const accepted = await faultedLease.actor.submitMessage(
      message(faultedSessionId, "cmd_registryPublicationConflict"),
    );

    expect(accepted.acceptance.duplicate).toBe(false);
    expect(faultedLease.actor.snapshot).toMatchObject({
      activeRunId: null,
      queuedRunIds: [accepted.runId],
      faulted: true,
    });
    expect(faultedStorage.runs.get(accepted.runId)?.state).toBe("queued");
    expect(tasks.pending.has(accepted.runId)).toBe(false);

    faultedLease.release();
    await expect(registry.acquire(faultedSessionId)).rejects.toMatchObject({
      code: "session.unavailable",
      name: "SessionRegistryUnavailableError",
    });
    await expect(registry.acquire(faultedSessionId)).rejects.toMatchObject({
      code: "session.unavailable",
    });
    expect(constructions.get(faultedSessionId)).toBe(1);
    expect(faultedStorage.closeCalls).toBe(1);
    expect(registry.states().find((state) => state.sessionId === faultedSessionId)).toMatchObject({
      faulted: true,
      retiring: true,
      constructing: false,
    });

    const healthy = await healthyLease.actor.submitMessage(
      message(healthySessionId, "cmd_registryPublicationHealthy"),
    );
    (await waitForTask(tasks, healthy.runId)).resolve({ state: "completed" });
    await waitForState(healthyLease.actor, null);
    expect(healthyStorage.runs.get(healthy.runId)?.state).toBe("completed");

    healthyLease.release();
    await expect(registry.close()).rejects.toThrow("failed to shut down");
  });

  it("publishes only events returned by a resolved committed storage operation", async () => {
    const storage = new FakeActorStorage("ses_commit");
    const original = storage.acceptCommand.bind(storage);
    let release = (): void => {};
    let signalEntered = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    vi.spyOn(storage, "acceptCommand").mockImplementation(async (input) => {
      signalEntered();
      await gate;
      return original(input);
    });
    const hub = new CommittedEventHub();
    const published: SessionEvent[] = [];
    let signalPublished = (): void => {};
    const threePublished = new Promise<void>((resolve) => {
      signalPublished = resolve;
    });
    hub.subscribe(storage.sessionId, (value) => {
      published.push(value);
      if (published.length === 3) signalPublished();
    });
    const actor = await SessionActor.create({
      storage,
      eventHub: hub,
      scheduler: new RunScheduler({ providerCapacity: 1, toolCapacity: 1 }),
      ids: ids("commit"),
      now: () => 10,
      runTask: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ state: "interrupted" }), { once: true });
        }),
      cancelRunTask: async () => undefined,
      forceStopRunTask: () => ({ status: "terminated" }),
    });
    const submitting = actor.submitMessage(message(actor.sessionId, "cmd_commit"));
    await entered;
    expect(published).toEqual([]);
    release();
    await submitting;
    await threePublished;
    expect(published.map((value) => value.eventType)).toEqual([
      "user.message.appended",
      "run.created",
      "run.started",
    ]);
    await actor.shutdown();
  });
});
