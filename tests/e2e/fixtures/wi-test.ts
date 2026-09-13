import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import {
  BoundedIpcRetention,
  BoundedProcessOutput,
  PROCESS_IPC_HISTORY_MAX_MESSAGES,
  PROCESS_IPC_PENDING_MAX_MESSAGES,
  type ServerProcessMessage,
} from "@wi/test-support";

type FixtureMessage = ServerProcessMessage;

export interface WiTestServer {
  readonly origin: string;
  disconnect(code?: number, reason?: string): Promise<number>;
  releaseProvider(gate: "slow"): Promise<void>;
  waitForProviderRequest(count?: number): Promise<readonly FixtureMessage[]>;
  waitForAcknowledgementBlock(): Promise<string>;
  releaseAcknowledgement(commandId: string): void;
  waitForBeforeRouteBlock(): Promise<string>;
  waitForBeforeRouteRetry(commandId: string): Promise<void>;
  releaseBeforeRoute(commandId: string): void;
  armReplay(sessionId: string): Promise<void>;
  waitForReplayBlock(sessionId: string): Promise<void>;
  releaseReplay(sessionId: string): void;
  armApprovalAcknowledgement(): Promise<void>;
  waitForApprovalAcknowledgementBlock(): Promise<string>;
  releaseApprovalAcknowledgement(commandId: string): void;
  armApprovalRace(): Promise<void>;
  waitForApprovalRace(count?: number): Promise<readonly string[]>;
  releaseApprovalRace(): void;
  seedBoundedSessionIndex(): Promise<{ readonly omittedSessionId: string; readonly title: string }>;
  commandRouteCount(): Promise<number>;
  seedUnavailableSession(): Promise<{
    readonly sessionId: string;
    readonly title: string;
    readonly fallbackSessionId: string;
    readonly fallbackTitle: string;
  }>;
  sessionHead(sessionId: string): Promise<number>;
  stageProviderKey(label: string): Promise<string>;
  armRecoveryBeforeRoute(): Promise<void>;
  waitForRecoveryBeforeRouteBlock(): Promise<string>;
}

export interface RunningServer {
  readonly api: WiTestServer;
  close(): Promise<void>;
}

export interface StartServerOptions {
  readonly childScript?: URL;
  readonly childArguments?: readonly string[];
  readonly readyTimeoutMs?: number;
  readonly temporaryDirectory?: string;
  readonly onChildStarted?: (child: ChildProcess) => void;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", finish);
      reject(new Error("Wi E2E server did not exit before the cleanup deadline"));
    }, timeoutMs);
    child.once("exit", finish);
  });
}

async function forceKillAndReap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child, 10_000);
}

async function startServerCleanup(child: ChildProcess | null, homeDirectory: string): Promise<void> {
  const errors: unknown[] = [];
  if (child !== null) {
    try {
      await forceKillAndReap(child);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await Promise.all([
      rm(homeDirectory, { recursive: true, force: true }),
      rm(`${homeDirectory}-credential-state`, { recursive: true, force: true }),
    ]);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "Wi E2E startup cleanup failed");
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const homeDirectory = await mkdtemp(
    join(options.temporaryDirectory ?? tmpdir(), "wi-e2e-"),
  );
  const script = fileURLToPath(
    options.childScript ?? new URL("./server-process.mjs", import.meta.url),
  );
  let child: ChildProcess | null = null;
  try {
    child = fork(script, [homeDirectory, ...(options.childArguments ?? [])], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_E2E_PROVIDER_CONNECTION_FIXTURE: "1",
      },
    });
    options.onChildStarted?.(child);
  } catch (error) {
    await startServerCleanup(child, homeDirectory).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "Wi E2E server startup and cleanup failed");
    });
    throw error;
  }
  const runningChild = child;
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
  child.on("exit", () => {
    for (const wake of wakeups) wake();
    wakeups.clear();
  });
  child.on("message", (message) => {
    if (message !== null && typeof message === "object" && "type" in message) {
      messages.accept(message);
      for (const wake of wakeups) wake();
      wakeups.clear();
    }
  });

  async function waitFor(
    predicate: (message: FixtureMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<FixtureMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const retained = messages.takeWhere(predicate);
      if (retained !== null) return structuredClone(retained);
      if (runningChild.exitCode !== null) {
        throw new Error(
          `Wi E2E server exited early (${runningChild.exitCode})\n${stdout.snapshot().tail}\n${stderr.snapshot().tail}`,
        );
      }
      await Promise.race([
        new Promise<void>((resolve) => wakeups.add(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, deadline - Date.now()))),
      ]);
    }
    throw new Error(
      `Timed out waiting for Wi E2E server message\n${stdout.snapshot().tail}\n${stderr.snapshot().tail}`,
    );
  }

  let ready: FixtureMessage;
  try {
    ready = await waitFor(
      (message) => message.type === "ready",
      options.readyTimeoutMs ?? 30_000,
    );
    if (typeof ready.origin !== "string") throw new Error("Wi E2E server returned no origin");
  } catch (error) {
    await startServerCleanup(child, homeDirectory).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "Wi E2E server startup and cleanup failed");
    });
    throw error;
  }
  let requestId = 0;
  const api: WiTestServer = {
    origin: ready.origin,
    async armRecoveryBeforeRoute() {
      requestId += 1;
      const currentRequestId = `recovery-before-route-${requestId}`;
      child.send({ type: "arm-recovery-before-route", requestId: currentRequestId });
      await waitFor(
        (candidate) =>
          candidate.type === "recovery-before-route-armed" &&
          candidate.requestId === currentRequestId,
      );
    },
    async waitForRecoveryBeforeRouteBlock() {
      const message = await waitFor(
        (candidate) => candidate.type === "recovery-before-route-blocked",
      );
      if (typeof message.commandId !== "string") {
        throw new Error("Blocked recovery command has no ID");
      }
      return message.commandId;
    },
    async stageProviderKey(label) {
      requestId += 1;
      const currentRequestId = `provider-stage-${requestId}`;
      child.send({ type: "stage-provider-key", requestId: currentRequestId, label });
      const message = await waitFor(
        (candidate) =>
          candidate.type === "provider-key-staged" &&
          candidate.requestId === currentRequestId,
      );
      if (typeof message.provisioningRef !== "string") {
        throw new Error("Provider stage fixture returned no provisioning reference");
      }
      return message.provisioningRef;
    },
    async disconnect(code, reason) {
      child.send({
        type: "disconnect",
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      });
      const result = await waitFor((message) => message.type === "disconnected");
      return typeof result.count === "number" ? result.count : 0;
    },
    async releaseProvider(gate) {
      requestId += 1;
      const currentRequestId = `provider-${requestId}`;
      child.send({ type: "release-provider", gate, requestId: currentRequestId });
      await waitFor(
        (candidate) =>
          candidate.type === "provider-released" && candidate.requestId === currentRequestId,
      );
    },
    async waitForProviderRequest(count = 1) {
      const requests: FixtureMessage[] = [];
      while (requests.length < count) {
        requests.push(await waitFor((message) => message.type === "provider-request"));
      }
      return requests;
    },
    async waitForAcknowledgementBlock() {
      const message = await waitFor((candidate) => candidate.type === "acknowledgement-blocked");
      if (typeof message.commandId !== "string") throw new Error("Blocked command has no ID");
      return message.commandId;
    },
    releaseAcknowledgement(commandId) {
      child.send({ type: "release-ack", commandId });
    },
    async waitForBeforeRouteBlock() {
      const message = await waitFor((candidate) => candidate.type === "before-route-blocked");
      if (typeof message.commandId !== "string") throw new Error("Blocked command has no ID");
      return message.commandId;
    },
    async waitForBeforeRouteRetry(commandId) {
      await waitFor(
        (candidate) =>
          candidate.type === "before-route-retried" && candidate.commandId === commandId,
      );
    },
    releaseBeforeRoute(commandId) {
      child.send({ type: "release-before-route", commandId });
    },
    async armReplay(sessionId) {
      requestId += 1;
      const currentRequestId = `replay-arm-${requestId}`;
      child.send({ type: "arm-replay", requestId: currentRequestId, sessionId });
      await waitFor(
        (candidate) =>
          candidate.type === "replay-armed" && candidate.requestId === currentRequestId,
      );
    },
    async waitForReplayBlock(sessionId) {
      await waitFor(
        (candidate) => candidate.type === "replay-blocked" && candidate.sessionId === sessionId,
      );
    },
    releaseReplay(sessionId) {
      child.send({ type: "release-replay", sessionId });
    },
    async armApprovalAcknowledgement() {
      requestId += 1;
      const currentRequestId = `approval-ack-arm-${requestId}`;
      child.send({ type: "arm-approval-acknowledgement", requestId: currentRequestId });
      await waitFor(
        (candidate) =>
          candidate.type === "approval-acknowledgement-armed" &&
          candidate.requestId === currentRequestId,
      );
    },
    async waitForApprovalAcknowledgementBlock() {
      const message = await waitFor(
        (candidate) => candidate.type === "approval-acknowledgement-blocked",
      );
      if (typeof message.commandId !== "string") {
        throw new Error("Blocked approval command has no ID");
      }
      return message.commandId;
    },
    releaseApprovalAcknowledgement(commandId) {
      child.send({ type: "release-approval-acknowledgement", commandId });
    },
    async armApprovalRace() {
      requestId += 1;
      const currentRequestId = `approval-race-arm-${requestId}`;
      child.send({ type: "arm-approval-race", requestId: currentRequestId });
      await waitFor(
        (candidate) =>
          candidate.type === "approval-race-armed" && candidate.requestId === currentRequestId,
      );
    },
    async waitForApprovalRace(count = 2) {
      const commandIds: string[] = [];
      while (commandIds.length < count) {
        const message = await waitFor((candidate) => candidate.type === "approval-race-blocked");
        if (typeof message.commandId !== "string") {
          throw new Error("Blocked approval race command has no ID");
        }
        commandIds.push(message.commandId);
      }
      return commandIds;
    },
    releaseApprovalRace() {
      child.send({ type: "release-approval-race" });
    },
    async seedBoundedSessionIndex() {
      requestId += 1;
      const currentRequestId = `bounded-index-${requestId}`;
      child.send({ type: "seed-bounded-session-index", requestId: currentRequestId });
      const message = await waitFor(
        (candidate) =>
          candidate.type === "bounded-session-index-seeded" &&
          candidate.requestId === currentRequestId,
      );
      if (typeof message.omittedSessionId !== "string" || typeof message.title !== "string") {
        throw new Error("Bounded session-index fixture returned invalid session data");
      }
      return { omittedSessionId: message.omittedSessionId, title: message.title };
    },
    async commandRouteCount() {
      requestId += 1;
      const currentRequestId = `command-route-count-${requestId}`;
      child.send({ type: "command-route-count", requestId: currentRequestId });
      const message = await waitFor(
        (candidate) =>
          candidate.type === "command-route-count" && candidate.requestId === currentRequestId,
      );
      if (typeof message.count !== "number") {
        throw new Error("Command route-count fixture returned invalid data");
      }
      return message.count;
    },
    async seedUnavailableSession() {
      requestId += 1;
      const currentRequestId = `unavailable-index-${requestId}`;
      child.send({ type: "seed-unavailable-session", requestId: currentRequestId });
      const message = await waitFor(
        (candidate) =>
          candidate.type === "unavailable-session-seeded" &&
          candidate.requestId === currentRequestId,
      );
      if (
        typeof message.sessionId !== "string" ||
        typeof message.title !== "string" ||
        typeof message.fallbackSessionId !== "string" ||
        typeof message.fallbackTitle !== "string"
      ) {
        throw new Error("Unavailable session fixture returned invalid session data");
      }
      return {
        sessionId: message.sessionId,
        title: message.title,
        fallbackSessionId: message.fallbackSessionId,
        fallbackTitle: message.fallbackTitle,
      };
    },
    async sessionHead(sessionId) {
      requestId += 1;
      const currentRequestId = `head-${requestId}`;
      child.send({ type: "session-head", requestId: currentRequestId, sessionId });
      const message = await waitFor(
        (candidate) =>
          candidate.type === "session-head" && candidate.requestId === currentRequestId,
      );
      if (typeof message.sequence !== "number") throw new Error("Session head is missing");
      return message.sequence;
    },
  };

  return {
    api,
    async close() {
      if (child.exitCode === null && child.connected) child.send({ type: "close" });
      let cleanupError: unknown = null;
      try {
        await waitForExit(child, 10_000);
      } catch (error) {
        cleanupError = error;
        await forceKillAndReap(child).catch((killError: unknown) => {
          cleanupError = new AggregateError(
            [error, killError],
            "Wi E2E server did not terminate during cleanup",
          );
        });
      } finally {
        await Promise.all([
          rm(homeDirectory, { recursive: true, force: true }),
          rm(`${homeDirectory}-credential-state`, { recursive: true, force: true }),
        ]);
      }
      if (cleanupError !== null) throw cleanupError;
      if (child.exitCode !== 0) {
        throw new Error(
          `Wi E2E server cleanup failed (${child.exitCode})\n${stdout.snapshot().tail}\n${stderr.snapshot().tail}`,
        );
      }
    },
  };
}

export const test = base.extend<{ readonly wi: WiTestServer }>({
  wi: async ({ browserName }, use) => {
    void browserName;
    const running = await startServer();
    try {
      await use(running.api);
    } finally {
      await running.close();
    }
  },
});

export { expect };
