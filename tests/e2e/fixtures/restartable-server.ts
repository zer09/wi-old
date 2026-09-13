import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BoundedIpcRetention,
  BoundedProcessOutput,
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
  PROCESS_IPC_PENDING_MAX_MESSAGES,
  type ServerProcessMessage,
} from "@wi/test-support";

type FixtureMessage = ServerProcessMessage;

interface RunningChild {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly output: () => string;
  send(message: Readonly<Record<string, unknown>>): void;
  waitFor(predicate: (message: FixtureMessage) => boolean, timeoutMs?: number): Promise<FixtureMessage>;
}

export interface AcceptedMessage {
  readonly commandId: string;
  readonly runId: string;
}

export interface ToolExecutionEvidence {
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
}

export interface AcceptanceStorageSnapshot {
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly dbRelativePath: string;
    readonly title: string;
  }[];
  readonly openSessionIds: readonly string[];
}

export interface ConnectionSnapshotEvidence {
  readonly subscriptions: number;
  readonly closed: boolean;
}

export type ProviderRecoveryFailpoint =
  | "after_recovery_admission"
  | "after_recovery_prepare"
  | "after_provider_file_observed"
  | "after_provider_lifecycle_terminal_before_ack";

export interface RestartableServer {
  readonly origin: string;
  readonly homeDirectory: string;
  restart(): Promise<void>;
  restartAfterCrash(): Promise<void>;
  restoreProviderEnvironment(): Promise<void>;
  stageProviderKey(label: string): Promise<string>;
  armProviderFailpoint(name: ProviderRecoveryFailpoint): Promise<void>;
  armLifecyclePrepare(): Promise<void>;
  waitForLifecyclePrepareBlock(): Promise<{ readonly commandId: string; readonly connectionId: string }>;
  releaseLifecyclePrepare(commandId: string): void;
  providerRequestCount(): Promise<number>;
  waitForProviderCommand(method: string): Promise<string>;
  providerOperation(commandId: string): Promise<{
    readonly phase: string;
    readonly targetConnectionId: string;
    readonly result: unknown;
    readonly failureCode: string | null;
  }>;
  disconnect(code: number, reason: string): Promise<number>;
  armReplay(sessionId: string): Promise<void>;
  waitForReplayBlock(sessionId: string): Promise<void>;
  releaseReplay(sessionId: string): Promise<void>;
  connectionSnapshots(): Promise<readonly ConnectionSnapshotEvidence[]>;
  waitForProviderRequest(count?: number): Promise<void>;
  waitForProviderScenario(scenario: string): Promise<void>;
  releaseProvider(gate: "slow" | "partial"): Promise<void>;
  acceptedMessage(text: string): Promise<AcceptedMessage>;
  createIdleSession(title: string): Promise<string>;
  sessionHead(sessionId: string): Promise<number>;
  toolExecutions(): Promise<readonly ToolExecutionEvidence[]>;
  acceptanceStorage(): Promise<AcceptanceStorageSnapshot>;
  mutateEvent(sessionId: string, action: "update" | "delete"): Promise<string | null>;
  securityAudit(sessionIds: readonly string[], credentials: readonly string[]): Promise<{
    readonly logsContainAuditSecret: boolean;
    readonly exportsContainCredential: boolean;
    readonly retainedArtifactsContainCredential: boolean;
  }>;
  close(): Promise<void>;
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", finish);
      reject(new Error("Restartable Wi server did not exit before the deadline"));
    }, timeoutMs);
    child.once("exit", finish);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send({ type: "close" });
  try {
    await waitForExit(child);
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child).catch((killError: unknown) => {
      throw new AggregateError([error, killError], "Restartable Wi server cleanup failed");
    });
  }
  if (child.exitCode !== 0) {
    throw new Error(`Restartable Wi server exited with code ${String(child.exitCode)}`);
  }
}

async function launch(
  homeDirectory: string,
  fixedPort?: number,
  replayLiveEvents?: number,
  providerRecovery = false,
  providerScenario?: string,
): Promise<RunningChild> {
  const script = fileURLToPath(new URL("./server-process.mjs", import.meta.url));
  const child = fork(
    script,
    [
      homeDirectory,
      "-",
      fixedPort === undefined ? "-" : String(fixedPort),
      "-",
      replayLiveEvents === undefined ? "-" : String(replayLiveEvents),
      providerRecovery ? "recovery" : "-",
      providerScenario ?? "-",
    ],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        ...(providerRecovery || providerScenario !== undefined
          ? {
              WI_ALLOW_TEST_FAILPOINTS: "1",
              WI_E2E_PROVIDER_CONNECTION_FIXTURE: "1",
            }
          : {}),
      },
    },
  );
  const stdout = new BoundedProcessOutput();
  const stderr = new BoundedProcessOutput();
  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  const messages = new BoundedIpcRetention(
    PROCESS_IPC_PENDING_MAX_MESSAGES,
    PROCESS_IPC_HISTORY_MAX_MESSAGES,
    () => false,
  );
  const wakeups = new Set<() => void>();
  child.on("message", (message) => {
    if (message !== null && typeof message === "object" && "type" in message) {
      messages.accept(message);
      for (const wake of wakeups) wake();
      wakeups.clear();
    }
  });
  child.on("exit", () => {
    for (const wake of wakeups) wake();
    wakeups.clear();
  });

  const waitFor = async (
    predicate: (message: FixtureMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<FixtureMessage> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const retained = messages.takeWhere(predicate);
      if (retained !== null) return structuredClone(retained);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Restartable Wi server exited early (${String(child.exitCode ?? child.signalCode)})\n${stdout.snapshot().tail}\n${stderr.snapshot().tail}`,
        );
      }
      await Promise.race([
        new Promise<void>((resolve) => wakeups.add(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
      ]);
    }
    throw new Error(
      `Timed out waiting for restartable Wi server message\n${stdout.snapshot().tail}\n${stderr.snapshot().tail}`,
    );
  };

  try {
    const ready = await waitFor((message) => message.type === "ready", 30_000);
    if (typeof ready.origin !== "string") throw new Error("Restartable Wi server returned no origin");
    return {
      child,
      origin: ready.origin,
      output: () => `${stdout.snapshot().tail}\n${stderr.snapshot().tail}`,
      send(message) {
        child.send(message);
      },
      waitFor,
    };
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child).catch(() => undefined);
    throw error;
  }
}

export async function startRestartableServer(
  options: {
    readonly replayLiveEvents?: number;
    readonly providerRecovery?: boolean;
    readonly providerScenario?: string;
  } = {},
): Promise<RestartableServer> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-e2e-restart-"));
  let current: RunningChild;
  try {
    current = await launch(
      homeDirectory,
      undefined,
      options.replayLiveEvents,
      options.providerRecovery ?? false,
      options.providerScenario,
    );
  } catch (error) {
    await Promise.all([
      rm(homeDirectory, { recursive: true, force: true }),
      rm(`${homeDirectory}-credential-state`, { recursive: true, force: true }),
    ]);
    throw error;
  }
  const origin = current.origin;
  const port = Number(new URL(origin).port);
  let closed = false;
  let requestNumber = 0;

  const request = async (
    type: string,
    fields: Readonly<Record<string, unknown>>,
    responseType: string,
  ): Promise<FixtureMessage> => {
    requestNumber += 1;
    const requestId = `restartable-${requestNumber}`;
    current.send({ type, requestId, ...fields });
    const response = await current.waitFor(
      (message) =>
        message.requestId === requestId &&
        (message.type === responseType || message.type === "control-error"),
    );
    if (response.type === "control-error") {
      throw new Error(
        typeof response.message === "string" ? response.message : `Control request ${type} failed`,
      );
    }
    return response;
  };

  return {
    origin,
    homeDirectory,
    async restart() {
      if (closed) throw new Error("Restartable Wi server is closed");
      const previous = current;
      await stopChild(previous.child).catch((error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${previous.output()}`,
        );
      });
      current = await launch(
        homeDirectory,
        port,
        options.replayLiveEvents,
        false,
        options.providerScenario,
      );
      if (current.origin !== origin) {
        throw new Error(`Restart changed origin from ${origin} to ${current.origin}`);
      }
    },
    async restartAfterCrash() {
      if (closed) throw new Error("Restartable Wi server is closed");
      await waitForExit(current.child);
      current = await launch(
        homeDirectory,
        port,
        options.replayLiveEvents,
        false,
        options.providerScenario,
      );
      if (current.origin !== origin) {
        throw new Error(`Restart changed origin from ${origin} to ${current.origin}`);
      }
    },
    async restoreProviderEnvironment() {
      await request(
        "restore-provider-environment",
        {},
        "provider-environment-restored",
      );
    },
    async stageProviderKey(label) {
      const response = await request("stage-provider-key", { label }, "provider-key-staged");
      if (typeof response.provisioningRef !== "string") {
        throw new Error("Provider stage fixture returned no provisioning reference");
      }
      return response.provisioningRef;
    },
    async armProviderFailpoint(name) {
      const response = await request(
        "arm-provider-failpoint",
        { name },
        "provider-failpoint-armed",
      );
      if (response.name !== name) throw new Error("Provider failpoint fixture armed the wrong phase");
    },
    async armLifecyclePrepare() {
      await request("arm-lifecycle-prepare", {}, "lifecycle-prepare-armed");
    },
    async waitForLifecyclePrepareBlock() {
      const response = await current.waitFor(
        (message) => message.type === "lifecycle-prepare-blocked",
      );
      if (typeof response.commandId !== "string" || typeof response.connectionId !== "string") {
        throw new Error("Lifecycle prepare fixture returned invalid command identity");
      }
      return { commandId: response.commandId, connectionId: response.connectionId };
    },
    releaseLifecyclePrepare(commandId) {
      current.send({ type: "release-lifecycle-prepare", commandId });
    },
    async providerRequestCount() {
      const response = await request("provider-request-count", {}, "provider-request-count");
      if (typeof response.count !== "number") throw new Error("Provider request count is missing");
      return response.count;
    },
    async waitForProviderCommand(method) {
      const response = await current.waitFor(
        (message) => message.type === "provider-command-routed" && message.method === method,
      );
      if (typeof response.commandId !== "string") {
        throw new Error("Routed provider command identity is missing");
      }
      return response.commandId;
    },
    async providerOperation(commandId) {
      const response = await request(
        "provider-operation",
        { commandId },
        "provider-operation",
      );
      if (
        typeof response.phase !== "string" ||
        typeof response.targetConnectionId !== "string" ||
        !(typeof response.failureCode === "string" || response.failureCode === null)
      ) {
        throw new Error("Provider operation evidence is missing");
      }
      return {
        phase: response.phase,
        targetConnectionId: response.targetConnectionId,
        result: response.result,
        failureCode: response.failureCode,
      };
    },
    async disconnect(code, reason) {
      const response = await request("disconnect", { code, reason }, "disconnected");
      if (typeof response.count !== "number") throw new Error("Disconnect count is missing");
      return response.count;
    },
    async armReplay(sessionId) {
      await request("arm-replay", { sessionId }, "replay-armed");
    },
    async waitForReplayBlock(sessionId) {
      await current.waitFor(
        (message) => message.type === "replay-blocked" && message.sessionId === sessionId,
      );
    },
    async releaseReplay(sessionId) {
      await request("release-replay", { sessionId }, "replay-released");
    },
    async connectionSnapshots() {
      const response = await request("connection-snapshots", {}, "connection-snapshots");
      if (!Array.isArray(response.snapshots)) throw new Error("Connection snapshots are missing");
      return response.snapshots as unknown as readonly ConnectionSnapshotEvidence[];
    },
    async waitForProviderRequest(count = 1) {
      for (let index = 0; index < count; index += 1) {
        await current.waitFor((message) => message.type === "provider-request");
      }
    },
    async waitForProviderScenario(scenario) {
      await current.waitFor(
        (message) => message.type === "provider-request" && message.scenario === scenario,
      );
    },
    async releaseProvider(gate) {
      await request("release-provider", { gate }, "provider-released");
    },
    async acceptedMessage(text) {
      const response = await request("accepted-message", { text }, "accepted-message");
      if (
        response.value === null ||
        typeof response.value !== "object" ||
        !("commandId" in response.value) ||
        !("runId" in response.value) ||
        typeof response.value.commandId !== "string" ||
        typeof response.value.runId !== "string"
      ) {
        throw new Error(`No accepted message was recorded for ${text}`);
      }
      return { commandId: response.value.commandId, runId: response.value.runId };
    },
    async createIdleSession(title) {
      const response = await request(
        "create-idle-session",
        { commandId: "cmd_finalAcceptanceCatalogSentinel", title },
        "idle-session-created",
      );
      if (typeof response.sessionId !== "string") throw new Error("Idle session ID is missing");
      return response.sessionId;
    },
    async sessionHead(sessionId) {
      const response = await request("session-head", { sessionId }, "session-head");
      if (typeof response.sequence !== "number") throw new Error("Session head is missing");
      return response.sequence;
    },
    async toolExecutions() {
      const response = await request("tool-executions", {}, "tool-executions");
      if (!Array.isArray(response.executions)) throw new Error("Tool execution evidence is missing");
      return response.executions as unknown as readonly ToolExecutionEvidence[];
    },
    async acceptanceStorage() {
      const response = await request("acceptance-storage", {}, "acceptance-storage");
      if (!Array.isArray(response.sessions) || !Array.isArray(response.openSessionIds)) {
        throw new Error("Acceptance storage evidence is missing");
      }
      return {
        sessions: response.sessions as AcceptanceStorageSnapshot["sessions"],
        openSessionIds: response.openSessionIds as readonly string[],
      };
    },
    async mutateEvent(sessionId, action) {
      const response = await request("mutate-event", { sessionId, action }, "event-mutation");
      if (response.errorMessage !== null && typeof response.errorMessage !== "string") {
        throw new Error("Mutation result is missing");
      }
      return response.errorMessage as string | null;
    },
    async securityAudit(sessionIds, credentials) {
      const response = await request(
        "security-audit",
        { sessionIds, credentials },
        "security-audit",
      );
      if (
        typeof response.logsContainAuditSecret !== "boolean" ||
        typeof response.exportsContainCredential !== "boolean" ||
        typeof response.retainedArtifactsContainCredential !== "boolean"
      ) {
        throw new Error("Security audit result is missing");
      }
      return {
        logsContainAuditSecret: response.logsContainAuditSecret,
        exportsContainCredential: response.exportsContainCredential,
        retainedArtifactsContainCredential: response.retainedArtifactsContainCredential,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      await stopChild(current.child).catch((error: unknown) => errors.push(error));
      await Promise.all([
        rm(homeDirectory, { recursive: true, force: true }),
        rm(`${homeDirectory}-credential-state`, { recursive: true, force: true }),
      ]).catch((error: unknown) => errors.push(error));
      if (errors.length > 0) throw new AggregateError(errors, "Restartable Wi cleanup failed");
    },
  };
}
