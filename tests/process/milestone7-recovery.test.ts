import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { ServerMessageSchema, type ServerMessage } from "@wi/protocol";
import {
  resolveStoragePath,
  sessionDatabaseRelativePath,
  SessionStoreManager,
  type AppendTransactionInput,
} from "@wi/storage";
import { RealServerHarness, type RealServerProcess } from "@wi/test-support";

import { FixtureProcessRunner } from "./fixture-process.js";

const fixturePath = fileURLToPath(new URL("./milestone7-server-fixture.mjs", import.meta.url));
const catalogFixturePath = fileURLToPath(new URL("./catalog-v1-fixture.mjs", import.meta.url));
const provenanceMutationFixturePath = fileURLToPath(
  new URL("./milestone7-provenance-mutation-fixture.mjs", import.meta.url),
);
const storageCloseFixturePath = fileURLToPath(
  new URL("./milestone7-storage-close-fixture.mjs", import.meta.url),
);
const harnesses = new Set<RealServerHarness>();
const externalHomes = new Set<string>();
const fixtureProcesses = new FixtureProcessRunner(2_000);

class TestSocket {
  readonly all: ServerMessage[] = [];
  private readonly inbox: ServerMessage[] = [];
  private expectedCrashReset = false;
  private transportError: Error | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("error", (error) => {
      // Deliberate failpoint process exits can reset the TCP connection. Keep
      // this narrow: every other transport error remains visible to assertions.
      if (this.expectedCrashReset && (error as NodeJS.ErrnoException).code === "ECONNRESET") return;
      this.transportError = error;
    });
    socket.on("message", (data) => {
      const message = ServerMessageSchema.parse(JSON.parse(data.toString()) as unknown);
      this.all.push(message);
      this.inbox.push(message);
    });
  }

  allowExpectedCrashReset(): void {
    this.expectedCrashReset = true;
  }

  send(value: unknown): void {
    try {
      this.socket.send(JSON.stringify(value));
    } catch (error) {
      if (this.expectedCrashReset && (error as NodeJS.ErrnoException).code === "ECONNRESET") return;
      throw error;
    }
  }

  async take(predicate: (message: ServerMessage) => boolean, timeoutMs = 10_000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.transportError !== null) throw this.transportError;
      const index = this.inbox.findIndex(predicate);
      if (index >= 0) return this.inbox.splice(index, 1)[0] as ServerMessage;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for server message: ${JSON.stringify(this.all)}`);
  }

  close(): void {
    this.socket.close();
  }
}

function isConnectionReset(error: unknown): boolean {
  if (error !== null && typeof error === "object") {
    if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return true;
    if ("cause" in error) return isConnectionReset(error.cause);
  }
  return false;
}

async function connect(origin: string, allowExpectedCrashReset = false): Promise<TestSocket> {
  let bootstrap: Response;
  try {
    bootstrap = await fetch(`${origin}/bootstrap`);
  } catch (error) {
    if (!allowExpectedCrashReset || !isConnectionReset(error)) throw error;
    // The immediately preceding fixture deliberately died with an open socket.
    // Retry only this known stale keep-alive reset; all other bootstrap failures
    // remain test failures.
    await new Promise((resolve) => setTimeout(resolve, 10));
    bootstrap = await fetch(`${origin}/bootstrap`);
  }
  const setCookie = bootstrap.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Bootstrap cookie is missing");
  const openSocket = async (): Promise<WebSocket> => {
    const candidate = new WebSocket(`${origin.replace("http:", "ws:")}/ws`, "wi.v1", {
      origin,
      headers: { Cookie: setCookie.split(";", 1)[0] },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once("open", resolve);
        candidate.once("error", reject);
      });
      return candidate;
    } catch (error) {
      candidate.terminate();
      throw error;
    }
  };
  let socket: WebSocket;
  try {
    socket = await openSocket();
  } catch (error) {
    if (!allowExpectedCrashReset || !isConnectionReset(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket = await openSocket();
  }
  const client = new TestSocket(socket);
  client.send({ v: 1, kind: "hello", clientId: "client_milestone7", resume: [] });
  await client.take((message) => message.kind === "welcome");
  return client;
}

function command(client: TestSocket, value: unknown): void {
  client.send(value);
}

async function replay(client: TestSocket, sessionId: string): Promise<readonly ServerMessage[]> {
  client.send({
    v: 1,
    kind: "subscribe",
    requestId: `req_m7_${Date.now()}`,
    sessionId,
    afterSequence: 0,
  });
  await client.take(
    (message) => message.kind === "replay.complete" && message.sessionId === sessionId,
  );
  return client.all.filter(
    (message) => message.kind === "event" && message.sessionId === sessionId,
  );
}

type FailpointSelectorEnvironment = Readonly<
  Partial<
    Record<
      | "WI_TEST_FAILPOINT_SESSION_ID"
      | "WI_TEST_FAILPOINT_COMMAND_ID"
      | "WI_TEST_FAILPOINT_RUN_ID"
      | "WI_TEST_FAILPOINT_CATALOG_GLOBAL",
      string
    >
  >
>;

async function start(
  harness: RealServerHarness,
  scenario = "plain-text",
  failpoint?: string,
  repairMode = "auto",
  selector: FailpointSelectorEnvironment = {},
  blockCommandSessionId?: string,
): Promise<{ readonly process: RealServerProcess; readonly origin: string; readonly ready: Record<string, unknown> }> {
  const processHandle = await harness.start({
    fixturePath,
    arguments: [scenario, repairMode],
    environment:
      failpoint === undefined
        ? {}
        : {
            NODE_ENV: "test",
            WI_ALLOW_TEST_FAILPOINTS: "1",
            WI_TEST_FAILPOINT: failpoint,
            ...selector,
            ...(blockCommandSessionId === undefined
              ? {}
              : { WI_M7_BLOCK_COMMAND_SESSION_ID: blockCommandSessionId }),
          },
  });
  const portRecord = await findServerOrigin(processHandle);
  return { process: processHandle, origin: portRecord.origin, ready: portRecord };
}

async function findServerOrigin(processHandle: RealServerProcess): Promise<{ origin: string; [key: string]: unknown }> {
  processHandle.send({ type: "report-ready" });
  const message = await processHandle.waitForMessage("ready-report");
  if (typeof message.origin !== "string") throw new Error("Server ready report has no origin");
  return { ...message, origin: message.origin };
}

async function stop(processHandle: RealServerProcess): Promise<void> {
  processHandle.send("shutdown");
  await processHandle.waitForExit();
}

async function seedSession(
  homeDirectory: string,
  suffix: string,
  projectId?: string,
  explicitSessionId = `ses_m7${suffix}`,
  title = `Milestone 7 ${suffix}`,
): Promise<string> {
  const storage = new SessionStoreManager({
    homeDirectory,
    ids: {
      sessionId: () => explicitSessionId,
      eventId: () => `evt_m7${suffix}created`,
    },
    now: () => 1_000,
  });
  try {
    const created = await storage.createSession({
      v: 1,
      kind: "command",
      commandId: `cmd_m7${suffix}create`,
      method: "session.create",
      params: {
        title,
        ...(projectId === undefined ? {} : { projectId }),
      },
    });
    return created.session.sessionId;
  } finally {
    await storage.close();
  }
}

async function mutateCreationProvenance(
  homeDirectory: string,
  sessionId: string,
  mutation:
    | "result-session"
    | "payload-hash"
    | "event-id"
    | "accepted-at"
    | "command-id"
    | "user-version",
  value: string,
): Promise<void> {
  const databasePath = resolveStoragePath(
    homeDirectory,
    sessionDatabaseRelativePath(sessionId),
  );
  const result = await fixtureProcesses.run(
    process.execPath,
    [provenanceMutationFixturePath, databasePath, mutation, value],
  );
  expect(result).toMatchObject({ code: 0, signal: null });
}

async function mutateCatalogSession(
  homeDirectory: string,
  sessionId: string,
  mutation: "catalog-session-stale" | "catalog-session-path",
): Promise<void> {
  const result = await fixtureProcesses.run(
    process.execPath,
    [
      provenanceMutationFixturePath,
      join(homeDirectory, "catalog.sqlite3"),
      mutation,
      sessionId,
    ],
  );
  expect(result).toMatchObject({ code: 0, signal: null });
}

async function makeCatalogSessionStale(
  homeDirectory: string,
  sessionId: string,
): Promise<void> {
  await mutateCatalogSession(homeDirectory, sessionId, "catalog-session-stale");
}

function maximumLengthSessionId(index: number): string {
  const unique = `a${String(index).padStart(5, "0")}`;
  return `ses_${unique}${"x".repeat(120 - unique.length)}`;
}

async function seedMaximumCatalog(homeDirectory: string, count: number): Promise<void> {
  const result = await fixtureProcesses.run(
    process.execPath,
    [
      provenanceMutationFixturePath,
      join(homeDirectory, "catalog.sqlite3"),
      "catalog-seed-maximum",
      String(count),
    ],
    15_000,
  );
  expect(result).toMatchObject({ code: 0, signal: null });
}

async function readSessionUserVersion(
  homeDirectory: string,
  sessionId: string,
): Promise<number> {
  const databasePath = resolveStoragePath(
    homeDirectory,
    sessionDatabaseRelativePath(sessionId),
  );
  const result = await fixtureProcesses.run(
    process.execPath,
    [provenanceMutationFixturePath, databasePath, "read-user-version", "unused"],
  );
  expect(result).toMatchObject({ code: 0, signal: null });
  return Number.parseInt(result.stdout.trim(), 10);
}

async function readSessionEventHead(
  homeDirectory: string,
  sessionId: string,
): Promise<number> {
  const databasePath = resolveStoragePath(
    homeDirectory,
    sessionDatabaseRelativePath(sessionId),
  );
  const result = await fixtureProcesses.run(
    process.execPath,
    [provenanceMutationFixturePath, databasePath, "read-event-head", "unused"],
  );
  expect(result).toMatchObject({ code: 0, signal: null });
  return Number.parseInt(result.stdout.trim(), 10);
}

async function expectUnavailableSessionIsolation(
  homeDirectory: string,
  sessionIds: readonly string[],
  healthySessionId?: string,
): Promise<void> {
  const before = new Map<
    string,
    { readonly head: number; readonly device: number; readonly inode: number; readonly size: number }
  >();
  for (const sessionId of sessionIds) {
    const databasePath = resolveStoragePath(
      homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    const identity = await stat(databasePath);
    before.set(sessionId, {
      head: await readSessionEventHead(homeDirectory, sessionId),
      device: identity.dev,
      inode: identity.ino,
      size: identity.size,
    });
  }

  const storage = new SessionStoreManager({ homeDirectory });
  try {
    await storage.ready();
    for (const [index, sessionId] of sessionIds.entries()) {
      const suffix = `isolated${String(index)}`;
      const append: AppendTransactionInput = {
        events: [
          {
            eventId: `evt_m7${suffix}`,
            eventType: "run.created",
            createdAtMs: 9_000 + index,
            data: { eventVersion: 1 as const, runId: `run_m7${suffix}` },
          },
        ],
        projections: [],
      };
      await expect(storage.openSession(sessionId)).rejects.toMatchObject({
        code: "storage.corrupt",
      });
      await expect(
        storage.acceptCommand(sessionId, {
          commandId: `cmd_m7${suffix}`,
          commandMethod: "message.submit",
          payloadHash: String(index).repeat(64),
          result: { runId: `run_m7${suffix}` },
          acceptedAtMs: 9_000 + index,
          runId: `run_m7${suffix}`,
          transaction: append,
        }),
      ).rejects.toMatchObject({ code: "storage.corrupt" });
      await expect(storage.appendTransaction(sessionId, append)).rejects.toMatchObject({
        code: "storage.corrupt",
      });
      await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
        status: "unavailable",
      });
    }
    if (healthySessionId !== undefined) {
      await expect(
        (await storage.openSession(healthySessionId)).getManifest(),
      ).resolves.toMatchObject({ sessionId: healthySessionId });
    }
  } finally {
    await storage.close();
  }

  for (const sessionId of sessionIds) {
    const databasePath = resolveStoragePath(
      homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    const identity = await stat(databasePath);
    expect({
      head: await readSessionEventHead(homeDirectory, sessionId),
      device: identity.dev,
      inode: identity.ino,
      size: identity.size,
    }).toEqual(before.get(sessionId));
  }
}

async function deleteCatalog(homeDirectory: string): Promise<void> {
  await Promise.all(
    ["", "-wal", "-shm"].map((suffix) =>
      rm(join(homeDirectory, `catalog.sqlite3${suffix}`), { force: true }),
    ),
  );
}

async function seedPendingInput(homeDirectory: string): Promise<{
  readonly sessionId: string;
  readonly inputId: string;
}> {
  const sessionId = await seedSession(homeDirectory, "pendinginput");
  const storage = new SessionStoreManager({ homeDirectory });
  const runId = "run_m7PendingInput";
  const inputId = "input_m7PendingInput";
  try {
    const session = await storage.openSession(sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_m7PendingInputRunCreated",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId },
        },
        {
          eventId: "evt_m7PendingInputRunStarted",
          eventType: "run.started",
          createdAtMs: 2_001,
          data: { eventVersion: 1, runId },
        },
        {
          eventId: "evt_m7PendingInputRequested",
          eventType: "input.requested",
          createdAtMs: 2_002,
          data: { eventVersion: 1, runId, inputId, prompt: "Continue?" },
        },
        {
          eventId: "evt_m7PendingInputWaiting",
          eventType: "run.waiting_for_user",
          createdAtMs: 2_003,
          data: { eventVersion: 1, runId, reason: "input", inputId },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId,
          state: "waiting_for_user",
          providerId: "fake",
          providerConfig: { scenario: "plain-text" },
          createdAtMs: 2_000,
          startedAtMs: 2_001,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        {
          kind: "input.put",
          inputId,
          runId,
          state: "pending",
          prompt: "Continue?",
          requestedAtMs: 2_002,
        },
      ],
    });
    await storage.drainCatalogObservations();
  } finally {
    await storage.close();
  }
  return { sessionId, inputId };
}

afterEach(async () => {
  await fixtureProcesses.terminateAll();
  await Promise.all([
    ...[...harnesses].map((harness) => harness.cleanup()),
    ...[...externalHomes].map((directory) => rm(directory, { recursive: true, force: true })),
  ]);
  harnesses.clear();
  externalHomes.clear();
});

const workflowFailpoints = [
  ["after_command_event_insert_before_commit", "plain-text", 90, "command"],
  ["after_command_commit_before_ack", "plain-text", 91, "command"],
  ["after_event_commit_before_publish", "plain-text", 92, "run"],
  ["after_tool_requested_commit", "echo-tool-round-trip", 93, "run"],
  ["after_tool_started_commit", "echo-tool-round-trip", 94, "run"],
  ["after_tool_result_commit_before_provider_continue", "echo-tool-round-trip", 95, "run"],
  ["after_provider_text_commit", "staged-tool-then-text-without-terminal", 96, "run"],
  ["after_run_terminal_commit", "plain-text", 97, "run"],
] as const;

function workflowSelector(
  kind: "command" | "session" | "run",
  sessionId: string,
  commandId: string,
  runId: string,
): FailpointSelectorEnvironment {
  if (kind === "command") {
    return {
      WI_TEST_FAILPOINT_SESSION_ID: sessionId,
      WI_TEST_FAILPOINT_COMMAND_ID: commandId,
    };
  }
  if (kind === "run") {
    return {
      WI_TEST_FAILPOINT_SESSION_ID: sessionId,
      WI_TEST_FAILPOINT_COMMAND_ID: commandId,
      WI_TEST_FAILPOINT_RUN_ID: runId,
    };
  }
  return { WI_TEST_FAILPOINT_SESSION_ID: sessionId };
}

function unrelatedBoundaryEvent(failpoint: string): string | null {
  switch (failpoint) {
    case "after_tool_requested_commit":
    case "after_tool_started_commit":
    case "after_tool_result_commit_before_provider_continue":
      return "run.completed";
    case "after_provider_text_commit":
      return "provider.text.delta";
    case "after_run_terminal_commit":
      return "run.completed";
    default:
      return null;
  }
}

describe("Milestone 7 real server crash recovery", () => {
  it.each(workflowFailpoints)(
    "recovers %s through the real WebSocket server",
    async (failpoint, scenario, exitCode, selectorKind) => {
      const harness = await RealServerHarness.create(`wi-m7-${failpoint}-`);
      harnesses.add(harness);
      const sessionId = await seedSession(harness.homeDirectory, failpoint.replaceAll("_", "").slice(0, 20));
      const unrelatedSessionId = await seedSession(
        harness.homeDirectory,
        `other${String(exitCode)}`,
      );
      const commandId = `cmd_m7_submit_${exitCode}`;
      const targetRunId = `run_m7_target_${exitCode}`;
      const selector = workflowSelector(
        selectorKind,
        sessionId,
        commandId,
        targetRunId,
      );
      const crashedServer = await start(
        harness,
        scenario,
        failpoint,
        "auto",
        selector,
        sessionId,
      );
      const socket = await connect(crashedServer.origin);
      command(socket, {
        v: 1,
        kind: "command",
        commandId,
        sessionId,
        method: "message.submit",
        params: { text: `Trigger ${failpoint}` },
      });
      await expect(
        crashedServer.process.waitForMessage("command-blocked"),
      ).resolves.toMatchObject({ sessionId, commandId });

      const unrelatedSocket = await connect(crashedServer.origin);
      await replay(unrelatedSocket, unrelatedSessionId);
      const unrelatedCommandId = `cmd_m7_unrelated_${exitCode}`;
      command(unrelatedSocket, {
        v: 1,
        kind: "command",
        commandId: unrelatedCommandId,
        sessionId: unrelatedSessionId,
        method: "message.submit",
        params: { text: `Unrelated operation before ${failpoint}` },
      });
      await expect(
        unrelatedSocket.take(
          (message) =>
            message.kind === "command.accepted" &&
            message.commandId === unrelatedCommandId,
        ),
      ).resolves.toMatchObject({ duplicate: false });
      const boundaryEvent = unrelatedBoundaryEvent(failpoint);
      if (boundaryEvent !== null) {
        await expect(
          unrelatedSocket.take(
            (message) =>
              message.kind === "event" &&
              message.sessionId === unrelatedSessionId &&
              message.eventType === boundaryEvent,
          ),
        ).resolves.toMatchObject({ kind: "event" });
      }
      await expect(findServerOrigin(crashedServer.process)).resolves.toMatchObject({
        origin: crashedServer.origin,
      });

      crashedServer.process.send({ type: "release-command" });
      const crashed = await crashedServer.process.waitForExit(15_000);
      expect(crashed).toMatchObject({ code: exitCode, signal: null });

      const restarted = await start(harness, scenario);
      const recoveredSocket = await connect(restarted.origin);
      const events = [...(await replay(recoveredSocket, sessionId))];
      if (
        scenario === "echo-tool-round-trip" &&
        !events.some(
          (message) => message.kind === "event" && message.eventType === "run.completed",
        )
      ) {
        events.push(
          await recoveredSocket.take(
            (message) => message.kind === "event" && message.eventType === "run.completed",
          ),
        );
      }
      let eventTypes = events.flatMap((message) =>
        message.kind === "event" ? [message.eventType] : [],
      );
      if (failpoint === "after_command_event_insert_before_commit") {
        expect(eventTypes).not.toContain("user.message.appended");
        command(recoveredSocket, {
          v: 1,
          kind: "command",
          commandId: `cmd_m7_submit_${exitCode}`,
          sessionId,
          method: "message.submit",
          params: { text: `Trigger ${failpoint}` },
        });
        await expect(
          recoveredSocket.take(
            (message) => message.kind === "command.accepted" && message.commandId === `cmd_m7_submit_${exitCode}`,
          ),
        ).resolves.toMatchObject({ kind: "command.accepted", duplicate: false });
      } else {
        expect(eventTypes).toContain("user.message.appended");
      }
      if (failpoint !== "after_command_event_insert_before_commit") {
        command(recoveredSocket, {
          v: 1,
          kind: "command",
          commandId: `cmd_m7_submit_${exitCode}`,
          sessionId,
          method: "message.submit",
          params: { text: `Trigger ${failpoint}` },
        });
        await expect(
          recoveredSocket.take(
            (message) => message.kind === "command.accepted" && message.commandId === `cmd_m7_submit_${exitCode}`,
          ),
        ).resolves.toMatchObject({ kind: "command.accepted", duplicate: true });
      }
      const terminalEventTypes = [
        "run.completed",
        "run.failed",
        "run.cancelled",
        "run.interrupted",
      ];
      if (!eventTypes.some((type) => terminalEventTypes.includes(type))) {
        events.push(
          await recoveredSocket.take(
            (message) =>
              message.kind === "event" && terminalEventTypes.includes(message.eventType),
          ),
        );
        eventTypes = events.flatMap((message) =>
          message.kind === "event" ? [message.eventType] : [],
        );
      }
      const terminalTypes = eventTypes.filter((type) => terminalEventTypes.includes(type));
      expect(terminalTypes).toEqual([
        failpoint === "after_provider_text_commit" ? "run.interrupted" : "run.completed",
      ]);
      const durableEvents = events.filter((message) => message.kind === "event");
      expect(new Set(durableEvents.map((event) => event.eventId)).size).toBe(durableEvents.length);
      if (failpoint === "after_provider_text_commit") {
        expect(eventTypes).toContain("provider.tool_call.staged");
        expect(eventTypes).toContain("provider.text.delta");
        expect(eventTypes).not.toContain("assistant.message.completed");
      }
      if (failpoint === "after_run_terminal_commit") {
        expect(eventTypes).toContain("assistant.message.completed");
        expect(eventTypes).not.toContain("run.interrupted");
      }
      recoveredSocket.close();
      await stop(restarted.process);
      if (
        scenario === "echo-tool-round-trip" ||
        scenario === "staged-tool-then-text-without-terminal"
      ) {
        const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
        try {
          const session = await storage.openSession(sessionId);
          const durableEvents = await session.getEventsAfter(0);
          const created = durableEvents.find((event) => event.eventType === "run.created");
          if (created?.eventType !== "run.created") throw new Error("Recovered run is missing");
          if (selectorKind === "run") expect(created.data.runId).toBe(targetRunId);
          const tools = await session.getToolExecutionsForRun(created.data.runId);
          expect(tools).toHaveLength(1);
          if (failpoint === "after_provider_text_commit") {
            expect(tools[0]).toMatchObject({ state: "discarded", attemptCount: 0 });
            await expect(
              readFile(join(harness.homeDirectory, "milestone7-tool-executions.log"), "utf8"),
            ).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect(tools[0]).toMatchObject({
              state: "completed",
              attemptCount: failpoint === "after_tool_started_commit" ? 2 : 1,
            });
            const executionLines = (await readFile(
              join(harness.homeDirectory, "milestone7-tool-executions.log"),
              "utf8",
            )).trim().split("\n").filter(Boolean);
            // The deterministic fake provider reuses its call ID across sessions.
            // One execution belongs to unrelated B and one to recovered target A.
            expect(executionLines).toHaveLength(2);
          }
        } finally {
          await storage.close();
        }
      }
    },
    30_000,
  );

  it("rejects an impossible failpoint selector before server readiness", async () => {
    const harness = await RealServerHarness.create("wi-m7-invalid-failpoint-selector-");
    harnesses.add(harness);
    const processHandle = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_catalog_session_repair",
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_impossible",
      },
      waitForReady: false,
    });
    const exited = await processHandle.waitForExit();
    expect(exited).toMatchObject({ code: 1, signal: null });
    expect(exited.stderr).toContain("Invalid test failpoint selector");
  });

  it("survives two consecutive crashes with the same publication failpoint", async () => {
    const harness = await RealServerHarness.create("wi-m7-double-crash-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "doublecrash");
    const first = await start(
      harness,
      "plain-text",
      "after_event_commit_before_publish",
      "auto",
      {
        WI_TEST_FAILPOINT_SESSION_ID: sessionId,
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_m7_double_crash",
        WI_TEST_FAILPOINT_RUN_ID: "run_m7_double_crash",
      },
    );
    const firstSocket = await connect(first.origin);
    // This socket is intentionally reset by the crash failpoint immediately
    // after the command is accepted; do not mask errors outside this window.
    firstSocket.allowExpectedCrashReset();
    command(firstSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_double_crash",
      sessionId,
      method: "message.submit",
      params: { text: "Crash twice at publication boundaries." },
    });
    await expect(first.process.waitForExit()).resolves.toMatchObject({ code: 92, signal: null });

    // Startup actor adoption owns the second recovery attempt. Do not race a
    // browser connection against the deliberate process exit.
    const second = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_event_commit_before_publish",
        WI_TEST_FAILPOINT_SESSION_ID: sessionId,
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_m7_double_crash",
        WI_TEST_FAILPOINT_RUN_ID: "run_m7_double_crash",
      },
      waitForReady: false,
    });
    await expect(second.waitForExit()).resolves.toMatchObject({ code: 92, signal: null });

    const third = await start(harness);
    const thirdSocket = await connect(third.origin, true);
    const events = await replay(thirdSocket, sessionId);
    expect(events.filter((message) => message.kind === "event" && message.eventType === "run.interrupted"))
      .toHaveLength(1);
    await stop(third.process);
  }, 30_000);

  it("gracefully interrupts a provider stream on SIGTERM and replays it", async () => {
    const harness = await RealServerHarness.create("wi-m7-sigterm-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "sigterm");
    const server = await start(harness, "provider-never-completes-until-aborted");
    const socket = await connect(server.origin);
    await replay(socket, sessionId);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_sigterm_submit",
      sessionId,
      method: "message.submit",
      params: { text: "Remain active until SIGTERM." },
    });
    await socket.take(
      (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_sigterm_submit",
    );
    await server.process.signal("SIGTERM");
    await expect(server.process.waitForExit(15_000)).resolves.toMatchObject({ code: 0, signal: null });

    const restarted = await start(harness);
    const replaySocket = await connect(restarted.origin);
    const events = await replay(replaySocket, sessionId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "event", eventType: "run.interrupted" }),
      ]),
    );
    await stop(restarted.process);
  }, 30_000);

  it("adopts and recovers a catalog candidate before any browser reconnects", async () => {
    const harness = await RealServerHarness.create("wi-m7-no-browser-recovery-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "nobrowser");
    const crashed = await harness.start({
      fixturePath,
      arguments: ["provider-never-completes-until-aborted", "auto"],
      environment: { WI_M7_BLOCK_CATALOG_OBSERVATION: "1" },
    });
    const ready = await findServerOrigin(crashed);
    const socket = await connect(ready.origin);
    await replay(socket, sessionId);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_no_browser_recovery",
      sessionId,
      method: "message.submit",
      params: { text: "Recover this without a browser." },
    });
    await crashed.waitForMessage("catalog-observation-blocked");
    await socket.take(
      (message) => message.kind === "event" && message.eventType === "provider.step.started",
    );
    await crashed.signal("SIGKILL");
    await crashed.waitForExit();

    // start() returns only after runtime.ready(), including candidate adoption.
    // No HTTP bootstrap or WebSocket connection occurs on this restart.
    const adopted = await start(harness);
    await adopted.process.signal("SIGKILL");
    await adopted.process.waitForExit();

    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      const session = await storage.openSession(sessionId);
      const events = await session.getEventsAfter(0);
      expect(events.filter((event) => event.eventType === "run.interrupted")).toHaveLength(1);
      await expect(session.getNonterminalRuns()).resolves.toHaveLength(0);
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("shuts down cleanly while historical replay is in flight", async () => {
    const harness = await RealServerHarness.create("wi-m7-replay-sigterm-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "replaysigterm");
    const processHandle = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: { WI_M7_BLOCK_REPLAY: "1" },
    });
    const ready = await findServerOrigin(processHandle);
    const socket = await connect(ready.origin);
    socket.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_m7_replay_sigterm",
      sessionId,
      afterSequence: 0,
    });
    await processHandle.waitForMessage("replay-blocked");
    await processHandle.signal("SIGTERM");
    await expect(processHandle.waitForExit()).resolves.toMatchObject({ code: 0, signal: null });

    const restarted = await start(harness);
    const restartedSocket = await connect(restarted.origin);
    const events = await replay(restartedSocket, sessionId);
    expect(events.filter((message) => message.kind === "event" && message.eventType === "session.created"))
      .toHaveLength(1);
    await stop(restarted.process);
  }, 30_000);

  it("shuts down cleanly while a committed catalog observation is in flight", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-observation-sigterm-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "catalogobservationsigterm");
    const processHandle = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: { WI_M7_BLOCK_CATALOG_OBSERVATION: "1" },
    });
    const ready = await findServerOrigin(processHandle);
    const socket = await connect(ready.origin);
    await replay(socket, sessionId);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_catalog_observation_sigterm",
      sessionId,
      method: "message.submit",
      params: { text: "Commit while catalog observation is blocked." },
    });
    await processHandle.waitForMessage("catalog-observation-blocked");
    await processHandle.signal("SIGTERM");
    await expect(processHandle.waitForExit(15_000)).resolves.toMatchObject({ code: 0, signal: null });

    const restarted = await start(harness);
    const restartedSocket = await connect(restarted.origin);
    const events = await replay(restartedSocket, sessionId);
    const eventTypes = events.flatMap((message) => message.kind === "event" ? [message.eventType] : []);
    expect(eventTypes).toContain("user.message.appended");
    expect(eventTypes.filter((type) => ["run.completed", "run.interrupted"].includes(type)))
      .toHaveLength(1);
    await stop(restarted.process);
  }, 30_000);

  it.each(["replay", "catalog-observation"] as const)(
    "bounds shutdown when a noncooperative %s gate is retained",
    async (kind) => {
      const harness = await RealServerHarness.create(`wi-m7-${kind}-noncooperative-`);
      harnesses.add(harness);
      const sessionId = await seedSession(harness.homeDirectory, `${kind}noncooperative`);
      const processHandle = await harness.start({
        fixturePath,
        arguments: ["plain-text", "auto"],
        environment: {
          WI_M7_RETAIN_BLOCKS_ON_SHUTDOWN: "1",
          ...(kind === "replay"
            ? { WI_M7_BLOCK_REPLAY: "1" }
            : { WI_M7_BLOCK_CATALOG_OBSERVATION: "1" }),
        },
      });
      const ready = await findServerOrigin(processHandle);
      const socket = await connect(ready.origin);
      if (kind === "replay") {
        socket.send({
          v: 1,
          kind: "subscribe",
          requestId: "req_m7_noncooperative_replay",
          sessionId,
          afterSequence: 0,
        });
        await processHandle.waitForMessage("replay-blocked");
      } else {
        await replay(socket, sessionId);
        command(socket, {
          v: 1,
          kind: "command",
          commandId: "cmd_m7_noncooperative_catalog",
          sessionId,
          method: "message.submit",
          params: { text: "Remain blocked through shutdown." },
        });
        await processHandle.waitForMessage("catalog-observation-blocked");
      }

      const shutdownStartedAt = Date.now();
      await processHandle.signal("SIGTERM");
      const exit = await processHandle.waitForExit(10_000);
      expect(Date.now() - shutdownStartedAt).toBeLessThan(5_000);
      expect(exit).toMatchObject({ code: kind === "replay" ? 0 : 1, signal: null });
      if (kind === "replay") {
        expect(exit.stderr).not.toContain("Error");
      } else {
        expect(exit.stderr).toContain("shutdown");
      }

      const restarted = await start(harness);
      const restartedSocket = await connect(restarted.origin);
      const events = await replay(restartedSocket, sessionId);
      if (kind === "catalog-observation") {
        expect(events.some(
          (message) => message.kind === "event" && message.eventType === "user.message.appended",
        )).toBe(true);
      }
      await stop(restarted.process);
    },
    30_000,
  );

  it("bounds shutdown when a session worker request is blocked and times out", async () => {
    const harness = await RealServerHarness.create("wi-m7-storage-request-sigterm-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "storagerequestsigterm");
    const processHandle = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: {
        NODE_ENV: "test",
        WI_M7_BLOCK_STORAGE_REQUEST: "1",
      },
    });
    processHandle.send({ type: "block-storage", sessionId });
    await processHandle.waitForMessage("storage-request-blocked");
    const shutdownStartedAt = Date.now();
    await processHandle.signal("SIGTERM");
    const blockedExit = await processHandle.waitForExit(15_000);
    expect(Date.now() - shutdownStartedAt).toBeLessThan(5_000);
    expect(blockedExit).toMatchObject({ code: 1, signal: null });
    const records = blockedExit.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "server_shutdown_diagnostic",
          diagnosticId: expect.stringMatching(/^err_/u),
          classification: "server_shutdown_failure",
          elapsedMs: expect.any(Number),
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              component: "storage",
              classification: expect.stringMatching(/timeout|failure/u),
            }),
          ]),
        }),
      ]),
    );

    const restarted = await start(harness);
    const restartedSocket = await connect(restarted.origin);
    const events = await replay(restartedSocket, sessionId);
    expect(events.filter((message) => message.kind === "event" && message.eventType === "session.created"))
      .toHaveLength(1);
    await stop(restarted.process);
  }, 30_000);

  it("lets a successful deadline-based storage close exit naturally", async () => {
    const harness = await RealServerHarness.create("wi-m7-storage-close-");
    harnesses.add(harness);

    const result = await fixtureProcesses.run(
      process.execPath,
      [storageCloseFixturePath, harness.homeDirectory],
    );

    expect(result).toMatchObject({
      code: 0,
      signal: null,
      stdout: "close-returned\n",
    });
  });

  it("recovers session creation committed before catalog readiness", async () => {
    const harness = await RealServerHarness.create("wi-m7-session-create-");
    harnesses.add(harness);
    const crashedServer = await start(
      harness,
      "plain-text",
      "after_session_create_before_catalog_ready",
      "auto",
      { WI_TEST_FAILPOINT_COMMAND_ID: "cmd_m7_session_create_crash" },
    );
    const socket = await connect(crashedServer.origin);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_session_create_crash",
      method: "session.create",
      params: { title: "Recovered creation" },
    });
    await expect(crashedServer.process.waitForExit()).resolves.toMatchObject({ code: 98, signal: null });

    const restarted = await start(harness);
    const bootstrap = await fetch(`${restarted.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string; title: string }[];
    };
    expect(bootstrap.sessions).toEqual([
      expect.objectContaining({ title: "Recovered creation" }),
    ]);
    const retrySocket = await connect(restarted.origin);
    command(retrySocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_session_create_crash",
      method: "session.create",
      params: { title: "Recovered creation" },
    });
    await expect(
      retrySocket.take(
        (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_session_create_crash",
      ),
    ).resolves.toMatchObject({ kind: "command.accepted", duplicate: true });
    await stop(restarted.process);
  }, 30_000);

  it("restores a pending approval after force kill and resolves it exactly once", async () => {
    const harness = await RealServerHarness.create("wi-m7-approval-recovery-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "approval");
    const first = await start(harness, "approval-round-trip");
    const firstSocket = await connect(first.origin);
    await replay(firstSocket, sessionId);
    command(firstSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_approval_submit",
      sessionId,
      method: "message.submit",
      params: { text: "Wait for durable approval." },
    });
    await firstSocket.take(
      (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_approval_submit",
    );
    const approvalEvent = await firstSocket.take(
      (message) => message.kind === "event" && message.eventType === "tool.approval.requested",
    );
    if (approvalEvent.kind !== "event" || approvalEvent.eventType !== "tool.approval.requested") {
      throw new Error("Approval event was not returned");
    }
    const approvalId = approvalEvent.data.approvalId;
    await first.process.signal("SIGKILL");
    const forcedExit = await first.process.waitForExit();
    expect(forcedExit).toMatchObject({ code: null, signal: "SIGKILL" });

    const pendingRestart = await start(harness, "approval-round-trip");
    const pendingSocket = await connect(pendingRestart.origin);
    const restored = await replay(pendingSocket, sessionId);
    expect(restored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "event", eventType: "tool.approval.requested" }),
      ]),
    );
    await stop(pendingRestart.process);

    const resolutionCrash = await start(
      harness,
      "approval-round-trip",
      "after_command_commit_before_ack",
      "auto",
      {
        WI_TEST_FAILPOINT_SESSION_ID: sessionId,
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_m7_approval_resolve",
      },
    );
    const resolutionSocket = await connect(resolutionCrash.origin);
    await replay(resolutionSocket, sessionId);
    command(resolutionSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_approval_resolve",
      sessionId,
      method: "approval.resolve",
      params: { approvalId, resolution: "approved" },
    });
    await expect(resolutionCrash.process.waitForExit()).resolves.toMatchObject({
      code: 91,
      signal: null,
    });

    const resolvedRestart = await start(harness, "approval-round-trip");
    const resolvedSocket = await connect(resolvedRestart.origin);
    const resolvedReplay = await replay(resolvedSocket, sessionId);
    command(resolvedSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_approval_resolve",
      sessionId,
      method: "approval.resolve",
      params: { approvalId, resolution: "approved" },
    });
    await expect(
      resolvedSocket.take(
        (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_approval_resolve",
      ),
    ).resolves.toMatchObject({ duplicate: true });
    if (!resolvedReplay.some((message) => message.kind === "event" && message.eventType === "run.completed")) {
      await resolvedSocket.take(
        (message) => message.kind === "event" && message.eventType === "run.completed",
      );
    }
    await stop(resolvedRestart.process);

    const finalRestart = await start(harness, "approval-round-trip");
    const finalSocket = await connect(finalRestart.origin);
    const finalEvents = await replay(finalSocket, sessionId);
    expect(
      finalEvents.filter(
        (message) => message.kind === "event" && message.eventType === "run.completed",
      ),
    ).toHaveLength(1);
    expect(
      finalEvents.filter(
        (message) => message.kind === "event" && message.eventType === "tool.execution.completed",
      ),
    ).toHaveLength(1);
    await stop(finalRestart.process);
  }, 30_000);

  it("restores a pending input across repeated process restarts and resolves it once", async () => {
    const harness = await RealServerHarness.create("wi-m7-input-recovery-");
    harnesses.add(harness);
    const { sessionId, inputId } = await seedPendingInput(harness.homeDirectory);

    const first = await start(harness);
    const firstSocket = await connect(first.origin);
    const firstReplay = await replay(firstSocket, sessionId);
    expect(firstReplay).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "event", eventType: "input.requested" }),
      ]),
    );
    await first.process.signal("SIGKILL");
    await first.process.waitForExit();

    const second = await start(harness);
    const secondSocket = await connect(second.origin);
    const secondReplay = await replay(secondSocket, sessionId);
    expect(secondReplay.filter((message) => message.kind === "event" && message.eventType === "input.requested"))
      .toHaveLength(1);
    await stop(second.process);

    const third = await start(harness);
    const thirdSocket = await connect(third.origin);
    await replay(thirdSocket, sessionId);
    command(thirdSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_input_resolve",
      sessionId,
      method: "input.respond",
      params: { inputId, value: { continue: true } },
    });
    await thirdSocket.take(
      (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_input_resolve",
    );
    await thirdSocket.take(
      (message) => message.kind === "event" && message.eventType === "run.completed",
    );
    await stop(third.process);

    const final = await start(harness);
    const finalSocket = await connect(final.origin);
    const finalEvents = await replay(finalSocket, sessionId);
    expect(finalEvents.filter((message) => message.kind === "event" && message.eventType === "input.resolved"))
      .toHaveLength(1);
    expect(finalEvents.filter((message) => message.kind === "event" && message.eventType === "run.completed"))
      .toHaveLength(1);
    command(finalSocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7_input_resolve",
      sessionId,
      method: "input.respond",
      params: { inputId, value: { continue: true } },
    });
    await expect(
      finalSocket.take(
        (message) => message.kind === "command.accepted" && message.commandId === "cmd_m7_input_resolve",
      ),
    ).resolves.toMatchObject({ duplicate: true });
    await stop(final.process);
  }, 30_000);

  it("reconstructs sessions and create-command idempotency after total catalog loss", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-delete-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "catalogA", "project_m7missing");
    const secondId = await seedSession(harness.homeDirectory, "catalogB");
    const hyphenId = await seedSession(
      harness.homeDirectory,
      "hyphen",
      undefined,
      "ses_a-review",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(harness.homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 3,
      repaired: 3,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string }[];
    };
    expect(bootstrap.sessions.map((session) => session.sessionId).sort()).toEqual(
      [firstId, secondId, hyphenId].sort(),
    );

    const retrySocket = await connect(repaired.origin);
    command(retrySocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7catalogAcreate",
      method: "session.create",
      params: { title: "Milestone 7 catalogA", projectId: "project_m7missing" },
    });
    await expect(
      retrySocket.take(
        (message) =>
          message.kind === "command.accepted" &&
          message.commandId === "cmd_m7catalogAcreate",
      ),
    ).resolves.toMatchObject({ duplicate: true, result: { sessionId: firstId } });
    command(retrySocket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7catalogAcreate",
      method: "session.create",
      params: { title: "Conflicting reconstructed retry", projectId: "project_m7missing" },
    });
    await expect(
      retrySocket.take(
        (message) =>
          message.kind === "command.rejected" &&
          message.commandId === "cmd_m7catalogAcreate",
      ),
    ).resolves.toMatchObject({ code: "protocol.command_id_conflict" });
    await stop(repaired.process);

    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await storage.ready();
      await expect(storage.catalog.getSession(firstId)).resolves.toMatchObject({
        projectId: "project_m7missing",
      });
      expect(storage.catalogRepairStatus()).toMatchObject({ triggered: false, reason: "none" });
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("reconstructs valid large-title sessions across bounded discovery pages", async () => {
    const harness = await RealServerHarness.create("wi-m7-paged-discovery-");
    harnesses.add(harness);
    const sessionIds = Array.from({ length: 12 }, (_, index) => `ses_m7Paged${index}`);
    const eventIds = Array.from({ length: 12 }, (_, index) => `evt_m7Paged${index}`);
    const pendingSessionIds = [...sessionIds];
    const pendingEventIds = [...eventIds];
    const takeId = (values: string[], description: string): string => {
      const value = values.shift();
      if (value === undefined) throw new Error(`Missing ${description}`);
      return value;
    };
    const title = `Paged discovery ${"x".repeat(175_000)}`;
    const storage = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      ids: {
        sessionId: () => takeId(pendingSessionIds, "session ID"),
        eventId: () => takeId(pendingEventIds, "event ID"),
      },
      now: () => 1_000,
    });
    try {
      for (let index = 0; index < sessionIds.length; index += 1) {
        await storage.createSession({
          v: 1,
          kind: "command",
          commandId: `cmd_m7Paged${index}`,
          method: "session.create",
          params: { title },
        });
      }
    } finally {
      await storage.close();
    }
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: sessionIds.length,
      repaired: sessionIds.length,
      quarantined: 0,
    });
    await stop(repaired.process);

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      for (const sessionId of sessionIds) {
        await expect(inspected.catalog.getSession(sessionId)).resolves.toMatchObject({
          sessionId,
          status: "ready",
          title,
        });
      }
    } finally {
      await inspected.close();
    }
  }, 40_000);

  it("repairs every stale field on an existing valid catalog row", async () => {
    const harness = await RealServerHarness.create("wi-m7-explicit-stale-row-");
    harnesses.add(harness);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "explicitStale",
      "project_m7ExplicitStale",
    );
    await makeCatalogSessionStale(harness.homeDirectory, sessionId);

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 1,
      repaired: 1,
      quarantined: 0,
    });
    await stop(repaired.process);

    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await storage.ready();
      await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
        sessionId,
        projectId: "project_m7ExplicitStale",
        dbRelativePath: sessionDatabaseRelativePath(sessionId),
        title: "Milestone 7 explicitStale",
        status: "ready",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        lastEventSequence: 1,
        lastRunState: null,
        lastMessagePreview: null,
        requiresAttention: false,
        pendingApprovalCount: 0,
        pendingInputCount: 0,
        sessionSchemaVersion: 5,
      });
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("reconstructs valid large data with exact canonical summary parity", async () => {
    const harness = await RealServerHarness.create("wi-m7-large-summary-parity-");
    harnesses.add(harness);
    const title = "T".repeat(2_000);
    const message = "M".repeat(2_000);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "largeParity",
      undefined,
      "ses_m7LargeParity",
      title,
    );
    const original = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    let before: Awaited<ReturnType<typeof original.catalog.getSession>> = null;
    try {
      const session = await original.openSession(sessionId);
      await session.appendTransaction({
        events: [
          {
            eventId: "evt_m7LargeParityMessage",
            eventType: "user.message.appended",
            createdAtMs: 5_000,
            data: {
              eventVersion: 1,
              messageId: "msg_m7LargeParity",
              runId: "run_m7LargeParityZ",
              text: message,
            },
          },
          {
            eventId: "evt_m7LargeParityRunZ",
            eventType: "run.created",
            createdAtMs: 6_000,
            data: { eventVersion: 1, runId: "run_m7LargeParityZ" },
          },
          {
            eventId: "evt_m7LargeParityRunZCompleted",
            eventType: "run.completed",
            createdAtMs: 6_000,
            data: { eventVersion: 1, runId: "run_m7LargeParityZ" },
          },
          {
            eventId: "evt_m7LargeParityRunA",
            eventType: "run.created",
            createdAtMs: 6_000,
            data: { eventVersion: 1, runId: "run_m7LargeParityA" },
          },
          {
            eventId: "evt_m7LargeParityRunACancelled",
            eventType: "run.cancelled",
            createdAtMs: 6_000,
            data: { eventVersion: 1, runId: "run_m7LargeParityA" },
          },
        ],
        projections: [
          {
            kind: "run.put",
            runId: "run_m7LargeParityZ",
            state: "completed",
            providerId: "fake",
            providerConfig: { scenario: "plain-text" },
            createdAtMs: 6_000,
            startedAtMs: 6_000,
            completedAtMs: 6_000,
            cancelledAtMs: null,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: null,
          },
          {
            kind: "run.put",
            runId: "run_m7LargeParityA",
            state: "cancelled",
            providerId: "fake",
            providerConfig: { scenario: "plain-text" },
            createdAtMs: 6_000,
            startedAtMs: 6_000,
            completedAtMs: null,
            cancelledAtMs: 6_000,
            failureCategory: null,
            failureMessage: null,
            activeProviderStepId: null,
          },
        ],
      });
      await original.drainCatalogObservations();
      before = await original.catalog.getSession(sessionId);
    } finally {
      await original.close();
    }
    if (before === null) throw new Error("Canonical catalog summary is missing");
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 1,
      repaired: 1,
    });
    await stop(repaired.process);

    const reconstructed = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await reconstructed.ready();
      const after = await reconstructed.catalog.getSession(sessionId);
      expect(after).toMatchObject({
        title,
        updatedAtMs: 6_000,
        lastEventSequence: 6,
        lastRunState: "cancelled",
        lastMessagePreview: message.slice(0, 200),
      });
      expect(after).toEqual(before);
    } finally {
      await reconstructed.close();
    }
  }, 30_000);

  it("preserves an unsupported newer session schema without blocking catalog reconstruction", async () => {
    const harness = await RealServerHarness.create("wi-m7-unsupported-schema-");
    harnesses.add(harness);
    const unsupportedId = await seedSession(harness.homeDirectory, "unsupportedSchema");
    const healthyId = await seedSession(harness.homeDirectory, "unsupportedHealthy");
    await mutateCreationProvenance(
      harness.homeDirectory,
      unsupportedId,
      "user-version",
      "999",
    );
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 2,
      repaired: 1,
      quarantined: 0,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: unsupportedId, status: "unavailable" }),
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
      ]),
    );
    const unsupportedDatabase = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(unsupportedId),
    );
    expect((await stat(unsupportedDatabase)).isFile()).toBe(true);
    await stop(repaired.process);
    await expect(readSessionUserVersion(harness.homeDirectory, unsupportedId)).resolves.toBe(999);

    const restarted = await start(harness);
    expect(restarted.ready.repair).toMatchObject({ triggered: false, reason: "none" });
    await stop(restarted.process);
  }, 30_000);

  it("repairs 10,000 maximum-length catalog IDs through bounded complement pages", async () => {
    const harness = await RealServerHarness.create("wi-m7-maximum-complement-");
    harnesses.add(harness);
    const initial = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await initial.ready();
    } finally {
      await initial.close();
    }
    await seedMaximumCatalog(harness.homeDirectory, 10_000);

    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "force",
      sessionDiscoveryLimit: 10_000,
    });
    try {
      await repairing.ready();
      expect(repairing.catalogRepairStatus()).toMatchObject({
        triggered: true,
        reason: "explicit",
        discovered: 0,
      });
      await expect(repairing.catalog.countSessions()).resolves.toBe(10_000);
      for (const index of [0, 9_999]) {
        const sessionId = maximumLengthSessionId(index);
        expect(sessionId).toHaveLength(124);
        await expect(repairing.catalog.getSession(sessionId)).resolves.toMatchObject({
          sessionId,
          status: "missing",
          dbRelativePath: sessionDatabaseRelativePath(sessionId),
        });
      }
    } finally {
      await repairing.close();
    }
  }, 30_000);

  it("changes deleted preserved sessions to missing while retained corruption stays unavailable", async () => {
    const harness = await RealServerHarness.create("wi-m7-preserved-to-missing-");
    harnesses.add(harness);
    const unsupportedId = await seedSession(harness.homeDirectory, "deletedUnsupported");
    const oversizedId = await seedSession(harness.homeDirectory, "deletedOversized");
    const corruptId = await seedSession(harness.homeDirectory, "retainedCorrupt");
    await mutateCreationProvenance(
      harness.homeDirectory,
      unsupportedId,
      "user-version",
      "999",
    );
    await truncate(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(oversizedId)),
      256 * 1024 * 1024 + 1,
    );
    await writeFile(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(corruptId)),
      "not a sqlite database",
    );

    const classified = await start(harness, "plain-text", undefined, "force");
    const classifiedBootstrap = await fetch(`${classified.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(classified.ready.repair).toMatchObject({ quarantined: 0 });
    expect(classifiedBootstrap.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: unsupportedId, status: "unavailable" }),
      expect.objectContaining({ sessionId: oversizedId, status: "unavailable" }),
      expect.objectContaining({ sessionId: corruptId, status: "unavailable" }),
    ]));
    await stop(classified.process);
    await expectUnavailableSessionIsolation(harness.homeDirectory, [oversizedId]);

    for (const sessionId of [unsupportedId, oversizedId]) {
      const directory = resolveStoragePath(
        harness.homeDirectory,
        sessionDatabaseRelativePath(sessionId).slice(0, -"/session.sqlite3".length),
      );
      await rm(directory, { recursive: true, force: true });
    }

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 1,
    });
    await stop(repaired.process);

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      for (const sessionId of [unsupportedId, oversizedId]) {
        await expect(inspected.catalog.getSession(sessionId)).resolves.toMatchObject({
          sessionId,
          status: "missing",
          dbRelativePath: sessionDatabaseRelativePath(sessionId),
        });
      }
      await expect(inspected.catalog.getSession(corruptId)).resolves.toMatchObject({
        sessionId: corruptId,
        status: "unavailable",
        dbRelativePath: sessionDatabaseRelativePath(corruptId),
      });
    } finally {
      await inspected.close();
    }
  }, 40_000);

  it("repairs canonical paths for every discovery classification", async () => {
    const harness = await RealServerHarness.create("wi-m7-classification-paths-");
    harnesses.add(harness);
    const corruptId = await seedSession(harness.homeDirectory, "pathCorrupt");
    const unsupportedId = await seedSession(harness.homeDirectory, "pathUnsupported");
    const missingId = await seedSession(harness.homeDirectory, "pathMissing");
    const healthyId = await seedSession(harness.homeDirectory, "pathHealthy");
    for (const sessionId of [corruptId, unsupportedId, missingId, healthyId]) {
      await mutateCatalogSession(
        harness.homeDirectory,
        sessionId,
        "catalog-session-path",
      );
    }
    await writeFile(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(corruptId)),
      "not a sqlite database",
    );
    await mutateCreationProvenance(
      harness.homeDirectory,
      unsupportedId,
      "user-version",
      "999",
    );
    await rm(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(missingId)),
      { force: true },
    );

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 4,
      repaired: 1,
      quarantined: 0,
    });
    await stop(repaired.process);

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      for (const [sessionId, status] of [
        [corruptId, "unavailable"],
        [unsupportedId, "unavailable"],
        [missingId, "missing"],
        [healthyId, "ready"],
      ] as const) {
        await expect(inspected.catalog.getSession(sessionId)).resolves.toMatchObject({
          sessionId,
          status,
          dbRelativePath: sessionDatabaseRelativePath(sessionId),
        });
      }
    } finally {
      await inspected.close();
    }
  }, 30_000);

  it("isolates semantically invalid creation provenance without blocking a healthy session", async () => {
    const harness = await RealServerHarness.create("wi-m7-provenance-validation-");
    harnesses.add(harness);
    const healthyId = await seedSession(harness.homeDirectory, "provenanceHealthy");
    const resultId = await seedSession(harness.homeDirectory, "provenanceResult");
    const hashId = await seedSession(harness.homeDirectory, "provenanceHash");
    const eventId = await seedSession(harness.homeDirectory, "provenanceEvent");
    const timestampId = await seedSession(harness.homeDirectory, "provenanceTimestamp");

    await mutateCreationProvenance(
      harness.homeDirectory,
      resultId,
      "result-session",
      healthyId,
    );
    await mutateCreationProvenance(
      harness.homeDirectory,
      hashId,
      "payload-hash",
      "0".repeat(64),
    );
    await mutateCreationProvenance(
      harness.homeDirectory,
      eventId,
      "event-id",
      "evt_m7WrongCreationProvenance",
    );
    await mutateCreationProvenance(
      harness.homeDirectory,
      timestampId,
      "accepted-at",
      "1001",
    );
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 5,
      repaired: 1,
      quarantined: 0,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
        ...[resultId, hashId, eventId, timestampId].map((sessionId) =>
          expect.objectContaining({ sessionId, status: "unavailable" }),
        ),
      ]),
    );
    await stop(repaired.process);
    await expectUnavailableSessionIsolation(
      harness.homeDirectory,
      [resultId],
      healthyId,
    );
  }, 30_000);

  it("isolates every conflicting provenance claimant and repairs an independent session", async () => {
    const harness = await RealServerHarness.create("wi-m7-provenance-conflict-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "conflictA");
    const secondId = await seedSession(harness.homeDirectory, "conflictB");
    const healthyId = await seedSession(harness.homeDirectory, "conflictHealthy");
    await mutateCreationProvenance(
      harness.homeDirectory,
      secondId,
      "command-id",
      "cmd_m7conflictAcreate",
    );
    await deleteCatalog(harness.homeDirectory);

    const repaired = await start(harness);
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 3,
      repaired: 1,
      quarantined: 0,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: firstId, status: "unavailable" }),
        expect.objectContaining({ sessionId: secondId, status: "unavailable" }),
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
      ]),
    );
    await stop(repaired.process);
    await expectUnavailableSessionIsolation(
      harness.homeDirectory,
      [firstId, secondId],
      healthyId,
    );
  }, 30_000);

  it("marks a catalog-known missing database without overwriting metadata or renaming its directory", async () => {
    const harness = await RealServerHarness.create("wi-m7-explicit-missing-");
    harnesses.add(harness);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "explicitMissing",
      "project_m7ExplicitMissing",
    );
    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    let before: Awaited<ReturnType<typeof storage.catalog.getSession>> = null;
    try {
      await storage.ready();
      before = await storage.catalog.getSession(sessionId);
    } finally {
      await storage.close();
    }
    if (before === null) throw new Error("Seeded catalog session is missing");
    const databasePath = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    const sessionDirectory = databasePath.slice(0, -"/session.sqlite3".length);
    await rm(databasePath, { force: true });

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 1,
      repaired: 0,
      quarantined: 0,
    });
    await stop(repaired.process);
    expect((await stat(sessionDirectory)).isDirectory()).toBe(true);
    await expect(stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      const after = await inspected.catalog.getSession(sessionId);
      expect(after).toEqual({ ...before, status: "missing" });
    } finally {
      await inspected.close();
    }
  }, 30_000);

  it("marks a catalog-known session missing when its entire directory is absent", async () => {
    const harness = await RealServerHarness.create("wi-m7-explicit-missing-directory-");
    harnesses.add(harness);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "explicitMissingDirectory",
      "project_m7ExplicitMissingDirectory",
    );
    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    let before: Awaited<ReturnType<typeof storage.catalog.getSession>> = null;
    try {
      await storage.ready();
      before = await storage.catalog.getSession(sessionId);
    } finally {
      await storage.close();
    }
    if (before === null) throw new Error("Seeded catalog session is missing");
    const databasePath = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    const sessionDirectory = databasePath.slice(0, -"/session.sqlite3".length);
    await rm(sessionDirectory, { recursive: true, force: true });

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 0,
      repaired: 0,
      quarantined: 0,
    });
    await stop(repaired.process);
    await expect(stat(sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const inspected = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await inspected.ready();
      const after = await inspected.catalog.getSession(sessionId);
      expect(after).toEqual({ ...before, status: "missing" });
    } finally {
      await inspected.close();
    }
  }, 30_000);

  it("isolates provenance conflicting with an existing catalog command during explicit repair", async () => {
    const harness = await RealServerHarness.create("wi-m7-existing-provenance-conflict-");
    harnesses.add(harness);
    const sharedTitle = "Existing catalog provenance owner";
    const ownerId = await seedSession(
      harness.homeDirectory,
      "existingOwner",
      undefined,
      "ses_m7ExistingOwner",
      sharedTitle,
    );
    const claimantId = await seedSession(
      harness.homeDirectory,
      "existingClaimant",
      undefined,
      "ses_m7ExistingClaimant",
      sharedTitle,
    );
    const healthyId = await seedSession(harness.homeDirectory, "existingHealthy");
    await mutateCreationProvenance(
      harness.homeDirectory,
      claimantId,
      "command-id",
      "cmd_m7existingOwnercreate",
    );
    await rm(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(ownerId)),
      { force: true },
    );

    const repaired = await start(harness, "plain-text", undefined, "force");
    expect(repaired.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 3,
      repaired: 1,
      quarantined: 0,
    });
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string; status: string }[] };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: claimantId, status: "unavailable" }),
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
      ]),
    );
    const socket = await connect(repaired.origin);
    const healthyEvents = await replay(socket, healthyId);
    expect(
      healthyEvents.filter(
        (message) => message.kind === "event" && message.eventType === "session.created",
      ),
    ).toHaveLength(1);
    await stop(repaired.process);

    const storage = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await storage.ready();
      await expect(storage.catalog.getSession(ownerId)).resolves.toMatchObject({
        sessionId: ownerId,
        status: "missing",
        title: sharedTitle,
      });
      await expect(
        storage.catalog.getGlobalCommand("cmd_m7existingOwnercreate"),
      ).resolves.toMatchObject({
        state: "accepted",
        reservedSessionId: ownerId,
      });
    } finally {
      await storage.close();
    }
  }, 30_000);

  it("continues a durably marked partial catalog repair after a process crash", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-partial-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "partialA");
    const secondId = await seedSession(harness.homeDirectory, "partialB");
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(harness.homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const crashed = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      environment: {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_catalog_session_repair",
        WI_TEST_FAILPOINT_SESSION_ID: firstId,
      },
      waitForReady: false,
    });
    await expect(crashed.waitForExit()).resolves.toMatchObject({ code: 99, signal: null });

    const restarted = await start(harness);
    expect(restarted.ready.repair).toMatchObject({
      triggered: true,
      reason: "catalog_new",
      discovered: 2,
      repaired: 2,
    });
    const bootstrap = await fetch(`${restarted.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string }[];
    };
    expect(bootstrap.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(
      [firstId, secondId].sort(),
    );
    await stop(restarted.process);
  }, 30_000);

  it("continues an in-place explicit repair without losing command idempotency", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-explicit-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "explicitA");
    const secondId = await seedSession(harness.homeDirectory, "explicitB");
    const crashed = await harness.start({
      fixturePath,
      arguments: ["plain-text", "force"],
      environment: {
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_catalog_session_repair",
        WI_TEST_FAILPOINT_SESSION_ID: firstId,
      },
      waitForReady: false,
    });
    await expect(crashed.waitForExit()).resolves.toMatchObject({ code: 99, signal: null });

    const restarted = await start(harness);
    expect(restarted.ready.repair).toMatchObject({
      triggered: true,
      reason: "explicit",
      discovered: 2,
      repaired: 2,
    });
    const socket = await connect(restarted.origin);
    command(socket, {
      v: 1,
      kind: "command",
      commandId: "cmd_m7explicitAcreate",
      method: "session.create",
      params: { title: "Milestone 7 explicitA" },
    });
    await expect(
      socket.take(
        (message) =>
          message.kind === "command.accepted" &&
          message.commandId === "cmd_m7explicitAcreate",
      ),
    ).resolves.toMatchObject({ duplicate: true, result: { sessionId: firstId } });
    const bootstrap = await fetch(`${restarted.origin}/bootstrap`).then(
      (response) => response.json(),
    ) as { sessions: readonly { sessionId: string }[] };
    expect(bootstrap.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(
      [firstId, secondId].sort(),
    );
    await stop(restarted.process);
  }, 30_000);

  it(
    "recovers a missing catalog after repeated pre-repair crashes",
    async () => {
      const harness = await RealServerHarness.create("wi-m7-catalog-pre-marker-");
      harnesses.add(harness);
      const firstId = await seedSession(harness.homeDirectory, "premarkerA");
      const secondId = await seedSession(harness.homeDirectory, "premarkerB");
      for (const suffix of ["-wal", "-shm"]) {
        await rm(join(harness.homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
      }
      await rm(join(harness.homeDirectory, "catalog.sqlite3"), { force: true });

      for (let crash = 0; crash < 2; crash += 1) {
        const processHandle = await harness.start({
          fixturePath,
          arguments: ["plain-text", "auto"],
          environment: {
            NODE_ENV: "test",
            WI_ALLOW_TEST_FAILPOINTS: "1",
            WI_TEST_FAILPOINT: "after_catalog_replacement_before_repair",
            WI_TEST_FAILPOINT_CATALOG_GLOBAL: "1",
          },
          waitForReady: false,
        });
        await expect(processHandle.waitForExit()).resolves.toMatchObject({
          code: 100,
          signal: null,
        });
      }

      const restarted = await start(harness);
      expect(restarted.ready.repair).toMatchObject({
        triggered: true,
        reason: "catalog_new",
        discovered: 2,
        repaired: 2,
      });
      const bootstrap = await fetch(`${restarted.origin}/bootstrap`).then(
        (response) => response.json(),
      ) as { sessions: readonly { sessionId: string }[] };
      expect(bootstrap.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(
        [firstId, secondId].sort(),
      );
      await stop(restarted.process);
    },
    40_000,
  );

  it("never follows a swapped catalog-home ancestor after corrupt classification", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-ancestor-swap-");
    harnesses.add(harness);
    await seedSession(harness.homeDirectory, "catalogAncestorSwap");
    const catalogPath = join(harness.homeDirectory, "catalog.sqlite3");
    await writeFile(catalogPath, "not a sqlite database");

    const externalHome = await mkdtemp(join(tmpdir(), "wi-m7-external-catalog-home-"));
    externalHomes.add(externalHome);
    const externalCatalog = join(externalHome, "catalog.sqlite3");
    const externalWal = `${externalCatalog}-wal`;
    const externalShm = `${externalCatalog}-shm`;
    await writeFile(externalCatalog, "external catalog must not move");
    await writeFile(externalWal, "external wal must not move");
    await writeFile(externalShm, "external shm must not move");
    const externalIdentities = await Promise.all(
      [externalCatalog, externalWal, externalShm].map(async (path) => {
        const identity = await stat(path);
        return { path, dev: identity.dev, ino: identity.ino };
      }),
    );

    let releaseReplacement = (): void => {};
    let markReplacementReached = (): void => {};
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacementReached = new Promise<void>((resolve) => {
      markReplacementReached = resolve;
    });
    const previousFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "auto",
      testFailpoints: {
        hit: () => {},
        beforeCatalogReplacement: async () => {
          markReplacementReached();
          await replacementGate;
        },
      },
    });
    const originalHome = `${harness.homeDirectory}.original`;
    try {
      const ready = repairing.ready();
      await replacementReached;
      await rename(harness.homeDirectory, originalHome);
      await symlink(externalHome, harness.homeDirectory, "dir");
      releaseReplacement();

      const startupError = await ready.then(
        () => null,
        (error: unknown) => error,
      );
      expect((await lstat(harness.homeDirectory)).isSymbolicLink()).toBe(true);
      for (const expected of externalIdentities) {
        const actual = await stat(expected.path);
        expect({ dev: actual.dev, ino: actual.ino }).toEqual({
          dev: expected.dev,
          ino: expected.ino,
        });
      }
      await expect(readFile(externalCatalog, "utf8")).resolves.toBe(
        "external catalog must not move",
      );
      await expect(readFile(externalWal, "utf8")).resolves.toBe("external wal must not move");
      await expect(readFile(externalShm, "utf8")).resolves.toBe("external shm must not move");
      expect((await readdir(externalHome)).sort()).toEqual([
        "catalog.sqlite3",
        "catalog.sqlite3-shm",
        "catalog.sqlite3-wal",
      ]);
      await expect(readFile(join(originalHome, "catalog.sqlite3"), "utf8")).resolves.toBe(
        "not a sqlite database",
      );
      expect(startupError).toMatchObject({
        code: "storage.corrupt",
        message: "Catalog is corrupt and was preserved in place",
      });
    } finally {
      releaseReplacement();
      await repairing.close().catch(() => undefined);
      await rm(harness.homeDirectory, { recursive: true, force: true });
      await rename(originalHome, harness.homeDirectory).catch(() => undefined);
      if (previousFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
      else process.env.WI_ALLOW_TEST_FAILPOINTS = previousFailpointGate;
    }
  }, 30_000);

  it("does not mutate a catalog substituted after copy validation", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-open-swap-");
    harnesses.add(harness);
    const seeded = await fixtureProcesses.run(
      process.execPath,
      [catalogFixturePath, harness.homeDirectory, "valid-with-sidecars"],
      10_000,
    );
    expect(seeded).toMatchObject({ code: 0, signal: null });

    const externalHome = await mkdtemp(join(tmpdir(), "wi-m7-external-open-catalog-"));
    externalHomes.add(externalHome);
    const externalSeeded = await fixtureProcesses.run(
      process.execPath,
      [catalogFixturePath, externalHome, "corrupt-with-sidecars"],
      10_000,
    );
    expect(externalSeeded).toMatchObject({ code: 0, signal: null });
    const externalPaths = [
      join(externalHome, "catalog.sqlite3"),
      join(externalHome, "catalog.sqlite3-wal"),
      join(externalHome, "catalog.sqlite3-shm"),
    ];
    const externalBefore = await Promise.all(
      externalPaths.map(async (path) => {
        const identity = await stat(path);
        return { path, dev: identity.dev, ino: identity.ino, content: await readFile(path) };
      }),
    );

    let releaseOpen = (): void => {};
    let markOpenReached = (): void => {};
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openReached = new Promise<void>((resolve) => {
      markOpenReached = resolve;
    });
    const previousFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "auto",
      testFailpoints: {
        hit: () => {},
        beforeCatalogCanonicalOpen: async () => {
          markOpenReached();
          await openGate;
        },
      },
    });
    const originalHome = `${harness.homeDirectory}.validated`;
    try {
      const ready = repairing.ready();
      await openReached;
      await rename(harness.homeDirectory, originalHome);
      await symlink(externalHome, harness.homeDirectory, "dir");
      releaseOpen();

      await expect(ready).rejects.toMatchObject({
        code: "storage.corrupt",
        message: "Catalog is corrupt and was preserved in place",
      });
      expect((await lstat(harness.homeDirectory)).isSymbolicLink()).toBe(true);
      for (const expected of externalBefore) {
        const actual = await stat(expected.path);
        expect({ dev: actual.dev, ino: actual.ino }).toEqual({
          dev: expected.dev,
          ino: expected.ino,
        });
        await expect(readFile(expected.path)).resolves.toEqual(expected.content);
      }
      await expect(stat(join(originalHome, "catalog.sqlite3"))).resolves.toBeDefined();
      await expect(stat(join(originalHome, "catalog.sqlite3-wal"))).resolves.toBeDefined();
      await expect(stat(join(originalHome, "catalog.sqlite3-shm"))).resolves.toBeDefined();
    } finally {
      releaseOpen();
      await repairing.close().catch(() => undefined);
      await rm(harness.homeDirectory, { recursive: true, force: true });
      await rename(originalHome, harness.homeDirectory).catch(() => undefined);
      if (previousFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
      else process.env.WI_ALLOW_TEST_FAILPOINTS = previousFailpointGate;
    }
  }, 30_000);

  it("does not mutate catalog files substituted after copy validation", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-open-source-swap-");
    harnesses.add(harness);
    const seeded = await fixtureProcesses.run(
      process.execPath,
      [catalogFixturePath, harness.homeDirectory, "valid-with-sidecars"],
      10_000,
    );
    expect(seeded).toMatchObject({ code: 0, signal: null });

    const corruptHome = await mkdtemp(join(tmpdir(), "wi-m7-open-source-replacement-"));
    externalHomes.add(corruptHome);
    const corruptSeeded = await fixtureProcesses.run(
      process.execPath,
      [catalogFixturePath, corruptHome, "corrupt-with-sidecars"],
      10_000,
    );
    expect(corruptSeeded).toMatchObject({ code: 0, signal: null });

    let releaseOpen = (): void => {};
    let markOpenReached = (): void => {};
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openReached = new Promise<void>((resolve) => {
      markOpenReached = resolve;
    });
    const previousFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "auto",
      testFailpoints: {
        hit: () => {},
        beforeCatalogCanonicalOpen: async () => {
          markOpenReached();
          await openGate;
        },
      },
    });
    const suffixes = ["", "-wal", "-shm"] as const;
    try {
      const ready = repairing.ready();
      await openReached;
      for (const suffix of suffixes) {
        const canonical = join(harness.homeDirectory, `catalog.sqlite3${suffix}`);
        await rename(canonical, `${canonical}.validated`);
        await copyFile(join(corruptHome, `catalog.sqlite3${suffix}`), canonical);
      }
      const before = await Promise.all(
        suffixes.flatMap((suffix) => {
          const canonical = join(harness.homeDirectory, `catalog.sqlite3${suffix}`);
          return [canonical, `${canonical}.validated`];
        }).map(async (path) => {
          const identity = await stat(path);
          return { path, dev: identity.dev, ino: identity.ino, content: await readFile(path) };
        }),
      );
      releaseOpen();

      await expect(ready).rejects.toMatchObject({
        code: "storage.busy",
        message: "Catalog storage changed during startup",
      });
      for (const expected of before) {
        const actual = await stat(expected.path);
        expect({ dev: actual.dev, ino: actual.ino }).toEqual({
          dev: expected.dev,
          ino: expected.ino,
        });
        await expect(readFile(expected.path)).resolves.toEqual(expected.content);
      }
    } finally {
      releaseOpen();
      await repairing.close().catch(() => undefined);
      if (previousFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
      else process.env.WI_ALLOW_TEST_FAILPOINTS = previousFailpointGate;
    }
  }, 30_000);

  it("does not open a catalog that appears after missing-catalog reservation", async () => {
    const harness = await RealServerHarness.create("wi-m7-missing-catalog-open-swap-");
    harnesses.add(harness);
    const corruptHome = await mkdtemp(join(tmpdir(), "wi-m7-missing-open-replacement-"));
    externalHomes.add(corruptHome);
    const corruptSeeded = await fixtureProcesses.run(
      process.execPath,
      [catalogFixturePath, corruptHome, "corrupt-with-sidecars"],
      10_000,
    );
    expect(corruptSeeded).toMatchObject({ code: 0, signal: null });

    let releaseOpen = (): void => {};
    let markOpenReached = (): void => {};
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const openReached = new Promise<void>((resolve) => {
      markOpenReached = resolve;
    });
    const previousFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "auto",
      testFailpoints: {
        hit: () => {},
        beforeCatalogCanonicalOpen: async () => {
          markOpenReached();
          await openGate;
        },
      },
    });
    const catalogPath = join(harness.homeDirectory, "catalog.sqlite3");
    try {
      const ready = repairing.ready();
      await openReached;
      await rename(catalogPath, `${catalogPath}.reserved`);
      for (const suffix of ["", "-wal", "-shm"] as const) {
        await copyFile(
          join(corruptHome, `catalog.sqlite3${suffix}`),
          `${catalogPath}${suffix}`,
        );
      }
      const replacementBefore = await Promise.all(
        [catalogPath, `${catalogPath}-wal`, `${catalogPath}-shm`].map(async (path) => {
          const identity = await stat(path);
          return { path, dev: identity.dev, ino: identity.ino, content: await readFile(path) };
        }),
      );
      releaseOpen();

      await expect(ready).rejects.toMatchObject({
        code: "storage.busy",
        message: "Catalog storage changed during startup",
      });
      for (const expected of replacementBefore) {
        const actual = await stat(expected.path);
        expect({ dev: actual.dev, ino: actual.ino }).toEqual({
          dev: expected.dev,
          ino: expected.ino,
        });
        await expect(readFile(expected.path)).resolves.toEqual(expected.content);
      }
      await expect(stat(`${catalogPath}.reserved`)).resolves.toMatchObject({ size: 0 });
    } finally {
      releaseOpen();
      await repairing.close().catch(() => undefined);
      if (previousFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
      else process.env.WI_ALLOW_TEST_FAILPOINTS = previousFailpointGate;
    }
  }, 30_000);

  it("preserves a replaced catalog source and existing quarantine evidence", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-source-swap-");
    harnesses.add(harness);
    await seedSession(harness.homeDirectory, "catalogSourceSwap");
    const catalogPath = join(harness.homeDirectory, "catalog.sqlite3");
    await writeFile(catalogPath, "classified corrupt catalog");
    const existingQuarantine = `${catalogPath}.quarantine-existing`;
    const existingQuarantineWal = `${existingQuarantine}-wal`;
    const existingQuarantineShm = `${existingQuarantine}-shm`;
    await writeFile(existingQuarantine, "existing quarantine catalog");
    await writeFile(existingQuarantineWal, "existing quarantine wal");
    await writeFile(existingQuarantineShm, "existing quarantine shm");

    let releaseReplacement = (): void => {};
    let markReplacementReached = (): void => {};
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const replacementReached = new Promise<void>((resolve) => {
      markReplacementReached = resolve;
    });
    const previousFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "auto",
      testFailpoints: {
        hit: () => {},
        beforeCatalogReplacement: async () => {
          markReplacementReached();
          await replacementGate;
        },
      },
    });
    const classifiedCatalog = `${catalogPath}.classified`;
    const replacementFiles = [catalogPath, `${catalogPath}-wal`, `${catalogPath}-shm`];
    const quarantineFiles = [existingQuarantine, existingQuarantineWal, existingQuarantineShm];
    try {
      const ready = repairing.ready();
      await replacementReached;
      await rename(catalogPath, classifiedCatalog);
      await writeFile(catalogPath, "healthy replacement catalog");
      await writeFile(`${catalogPath}-wal`, "healthy replacement wal");
      await writeFile(`${catalogPath}-shm`, "healthy replacement shm");
      const identities = await Promise.all(
        [...replacementFiles, classifiedCatalog, ...quarantineFiles].map(async (path) => {
          const identity = await stat(path);
          return { path, dev: identity.dev, ino: identity.ino };
        }),
      );
      releaseReplacement();

      const startupError = await ready.then(
        () => null,
        (error: unknown) => error,
      );
      for (const expected of identities) {
        const actual = await stat(expected.path);
        expect({ dev: actual.dev, ino: actual.ino }).toEqual({
          dev: expected.dev,
          ino: expected.ino,
        });
      }
      await expect(readFile(catalogPath, "utf8")).resolves.toBe("healthy replacement catalog");
      await expect(readFile(`${catalogPath}-wal`, "utf8")).resolves.toBe(
        "healthy replacement wal",
      );
      await expect(readFile(`${catalogPath}-shm`, "utf8")).resolves.toBe(
        "healthy replacement shm",
      );
      await expect(readFile(classifiedCatalog, "utf8")).resolves.toBe(
        "classified corrupt catalog",
      );
      await expect(readFile(existingQuarantine, "utf8")).resolves.toBe(
        "existing quarantine catalog",
      );
      await expect(readFile(existingQuarantineWal, "utf8")).resolves.toBe(
        "existing quarantine wal",
      );
      await expect(readFile(existingQuarantineShm, "utf8")).resolves.toBe(
        "existing quarantine shm",
      );
      expect(
        (await readdir(harness.homeDirectory))
          .filter((name) => name.startsWith("catalog.sqlite3.quarantine-"))
          .sort(),
      ).toEqual([
        "catalog.sqlite3.quarantine-existing",
        "catalog.sqlite3.quarantine-existing-shm",
        "catalog.sqlite3.quarantine-existing-wal",
      ]);
      expect(startupError).toMatchObject({
        code: "storage.corrupt",
        message: "Catalog is corrupt and was preserved in place",
      });
    } finally {
      releaseReplacement();
      await repairing.close().catch(() => undefined);
      if (previousFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
      else process.env.WI_ALLOW_TEST_FAILPOINTS = previousFailpointGate;
    }
  }, 30_000);

  it("opens a valid crash-left catalog through the nonmutating copy probe", async () => {
    const harness = await RealServerHarness.create("wi-m7-valid-catalog-sidecars-");
    harnesses.add(harness);
    const seeded = await fixtureProcesses.run(
      process.execPath,
      [catalogFixturePath, harness.homeDirectory, "valid-with-sidecars"],
      10_000,
    );
    expect(seeded).toMatchObject({ code: 0, signal: null });
    await expect(stat(join(harness.homeDirectory, "catalog.sqlite3-wal"))).resolves.toBeDefined();
    await expect(stat(join(harness.homeDirectory, "catalog.sqlite3-shm"))).resolves.toBeDefined();

    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "auto",
    });
    try {
      await repairing.ready();
      expect(repairing.catalogRepairStatus()).toMatchObject({
        triggered: false,
        reason: "none",
      });
      await expect(repairing.catalog.countSessions()).resolves.toBe(0);
    } finally {
      await repairing.close();
    }
  }, 30_000);

  it("preserves pre-existing catalog database and sidecars through corrupt classification", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-sidecar-preservation-");
    harnesses.add(harness);
    const seeded = await fixtureProcesses.run(
      process.execPath,
      [catalogFixturePath, harness.homeDirectory, "corrupt-with-sidecars"],
      10_000,
    );
    expect(seeded).toMatchObject({ code: 0, signal: null });

    const catalogFiles = [
      join(harness.homeDirectory, "catalog.sqlite3"),
      join(harness.homeDirectory, "catalog.sqlite3-wal"),
      join(harness.homeDirectory, "catalog.sqlite3-shm"),
    ];
    const before = await Promise.all(
      catalogFiles.map(async (path) => {
        const identity = await stat(path);
        return { path, dev: identity.dev, ino: identity.ino, content: await readFile(path) };
      }),
    );

    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "auto",
    });
    try {
      await expect(repairing.ready()).rejects.toMatchObject({
        code: "storage.migration_failed",
      });
    } finally {
      await repairing.close().catch(() => undefined);
    }

    for (const expected of before) {
      const actual = await stat(expected.path);
      expect({ dev: actual.dev, ino: actual.ino }).toEqual({
        dev: expected.dev,
        ino: expected.ino,
      });
      await expect(readFile(expected.path)).resolves.toEqual(expected.content);
    }
  }, 30_000);

  it("fails closed and preserves a corrupt catalog with surviving sessions", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-corrupt-");
    harnesses.add(harness);
    const sessionId = await seedSession(harness.homeDirectory, "catalogcorrupt");
    const catalogPath = join(harness.homeDirectory, "catalog.sqlite3");
    await writeFile(catalogPath, "not a sqlite database");
    const catalogIdentity = await stat(catalogPath);
    const processHandle = await harness.start({
      fixturePath,
      arguments: ["plain-text", "auto"],
      waitForReady: false,
    });
    const exited = await processHandle.waitForExit();
    expect(exited).toMatchObject({ code: 1, signal: null });
    expect(exited.stderr).toContain("Catalog is corrupt and was preserved in place");
    expect(exited.stderr).not.toContain(harness.homeDirectory);
    const preservedIdentity = await stat(catalogPath);
    expect({ dev: preservedIdentity.dev, ino: preservedIdentity.ino }).toEqual({
      dev: catalogIdentity.dev,
      ino: catalogIdentity.ino,
    });
    await expect(readFile(catalogPath, "utf8")).resolves.toBe("not a sqlite database");
    await expect(
      stat(resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(sessionId))),
    ).resolves.toBeDefined();
    expect(
      (await readdir(harness.homeDirectory)).filter((name) =>
        name.startsWith("catalog.sqlite3.quarantine-"),
      ),
    ).toEqual([]);
  }, 20_000);

  it("keeps healthy-catalog startup catalog-only", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-healthy-");
    harnesses.add(harness);
    const firstId = await seedSession(harness.homeDirectory, "healthyA");
    const secondId = await seedSession(harness.homeDirectory, "healthyB");
    for (const sessionId of [firstId, secondId]) {
      const databasePath = resolveStoragePath(
        harness.homeDirectory,
        sessionDatabaseRelativePath(sessionId),
      );
      await rename(databasePath, `${databasePath}.offline`);
    }
    const server = await start(harness);
    expect(server.ready.repair).toMatchObject({ triggered: false, reason: "none" });
    const bootstrap = await fetch(`${server.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string }[];
    };
    expect(bootstrap.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(
      [firstId, secondId].sort(),
    );
    await stop(server.process);
  }, 20_000);

  it("never follows a swapped session-prefix ancestor while isolating corruption", async () => {
    const harness = await RealServerHarness.create("wi-m7-isolation-ancestor-swap-");
    harnesses.add(harness);
    const corruptId = await seedSession(
      harness.homeDirectory,
      "ancestorSwap",
      undefined,
      "ses_aaAncestorSwap",
    );
    const healthyId = await seedSession(
      harness.homeDirectory,
      "ancestorSwapHealthy",
      undefined,
      "ses_zzAncestorSwapHealthy",
    );
    await writeFile(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(corruptId)),
      "not a sqlite database",
    );

    const externalPrefix = await mkdtemp(join(tmpdir(), "wi-m7-external-prefix-"));
    externalHomes.add(externalPrefix);
    const externalSessionDirectory = join(externalPrefix, corruptId);
    const externalSentinel = join(externalSessionDirectory, "sentinel.txt");
    await mkdir(externalSessionDirectory);
    await writeFile(externalSentinel, "external data must not move");
    const externalIdentityBefore = await stat(externalSessionDirectory);

    const databasePath = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(corruptId),
    );
    const sessionDirectory = databasePath.slice(0, -"/session.sqlite3".length);
    const prefixDirectory = join(sessionDirectory, "..");
    const originalPrefixDirectory = `${prefixDirectory}.original`;
    let releaseIsolation = (): void => {};
    let markIsolationReached = (): void => {};
    const isolationGate = new Promise<void>((resolve) => {
      releaseIsolation = resolve;
    });
    const isolationReached = new Promise<void>((resolve) => {
      markIsolationReached = resolve;
    });
    const previousFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "force",
      ids: {
        sessionId: () => "ses_unusedAncestorSwap",
        eventId: () => "evt_unusedAncestorSwap",
        diagnosticId: () => "err_ancestorSwap",
      },
      testFailpoints: {
        hit: () => {},
        beforeCatalogSessionIsolation: async ({ sessionId }) => {
          if (sessionId !== corruptId) return;
          markIsolationReached();
          await isolationGate;
        },
      },
    });
    try {
      const ready = repairing.ready();
      await isolationReached;
      await rename(prefixDirectory, originalPrefixDirectory);
      await symlink(externalPrefix, prefixDirectory, "dir");
      releaseIsolation();
      await ready;

      expect(repairing.catalogRepairStatus()).toMatchObject({
        triggered: true,
        reason: "explicit",
        repaired: 1,
        quarantined: 0,
      });
      await expect(repairing.catalog.getSession(corruptId)).resolves.toMatchObject({
        status: "unavailable",
      });
      expect(
        (await repairing.catalog.listCatalogRepairPage(null)).records.find(
          (record) => record.sessionId === corruptId,
        ),
      ).toMatchObject({ status: "unavailable", unavailableReason: null });
      await expect(repairing.catalog.getSession(healthyId)).resolves.toMatchObject({
        status: "ready",
      });
      expect((await lstat(prefixDirectory)).isSymbolicLink()).toBe(true);
      const externalIdentityAfter = await stat(externalSessionDirectory);
      expect({ dev: externalIdentityAfter.dev, ino: externalIdentityAfter.ino }).toEqual({
        dev: externalIdentityBefore.dev,
        ino: externalIdentityBefore.ino,
      });
      await expect(readFile(externalSentinel, "utf8")).resolves.toBe(
        "external data must not move",
      );
      expect(await readdir(externalPrefix)).toEqual([corruptId]);
      await expect(
        stat(join(originalPrefixDirectory, corruptId, "session.sqlite3")),
      ).resolves.toBeDefined();
    } finally {
      releaseIsolation();
      await repairing.close().catch(() => undefined);
      if (previousFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
      else process.env.WI_ALLOW_TEST_FAILPOINTS = previousFailpointGate;
    }
  }, 30_000);

  it("does not move a healthy canonical replacement after corrupt classification", async () => {
    const harness = await RealServerHarness.create("wi-m7-isolation-healthy-swap-");
    harnesses.add(harness);
    const sessionId = await seedSession(
      harness.homeDirectory,
      "healthyReplacement",
      undefined,
      "ses_abHealthyReplacement",
    );
    const unrelatedId = await seedSession(
      harness.homeDirectory,
      "healthyReplacementUnrelated",
      undefined,
      "ses_zyHealthyReplacementUnrelated",
    );
    const databasePath = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    const sessionDirectory = databasePath.slice(0, -"/session.sqlite3".length);
    const replacementDirectory = `${sessionDirectory}.healthy-replacement`;
    const corruptOriginalDirectory = `${sessionDirectory}.corrupt-original`;
    await rename(sessionDirectory, replacementDirectory);
    await mkdir(sessionDirectory);
    await writeFile(databasePath, "not a sqlite database");
    const replacementIdentity = await stat(replacementDirectory);

    let releaseIsolation = (): void => {};
    let markIsolationReached = (): void => {};
    const isolationGate = new Promise<void>((resolve) => {
      releaseIsolation = resolve;
    });
    const isolationReached = new Promise<void>((resolve) => {
      markIsolationReached = resolve;
    });
    const previousFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const repairing = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "force",
      testFailpoints: {
        hit: () => {},
        beforeCatalogSessionIsolation: async ({ sessionId: candidateId }) => {
          if (candidateId !== sessionId) return;
          markIsolationReached();
          await isolationGate;
        },
      },
    });
    try {
      const ready = repairing.ready();
      await isolationReached;
      await rename(sessionDirectory, corruptOriginalDirectory);
      await rename(replacementDirectory, sessionDirectory);
      releaseIsolation();
      await ready;

      expect(repairing.catalogRepairStatus()).toMatchObject({
        triggered: true,
        reason: "explicit",
        quarantined: 0,
      });
      await expect(repairing.catalog.getSession(sessionId)).resolves.toMatchObject({
        status: "unavailable",
      });
      expect(
        (await repairing.catalog.listCatalogRepairPage(null)).records.find(
          (record) => record.sessionId === sessionId,
        ),
      ).toMatchObject({ status: "unavailable", unavailableReason: null });
      await expect(repairing.catalog.getSession(unrelatedId)).resolves.toMatchObject({
        status: "ready",
      });
      const replacementAfter = await stat(sessionDirectory);
      expect({ dev: replacementAfter.dev, ino: replacementAfter.ino }).toEqual({
        dev: replacementIdentity.dev,
        ino: replacementIdentity.ino,
      });
      await expect(stat(join(corruptOriginalDirectory, "session.sqlite3"))).resolves.toBeDefined();
    } finally {
      releaseIsolation();
      await repairing.close().catch(() => undefined);
      if (previousFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
      else process.env.WI_ALLOW_TEST_FAILPOINTS = previousFailpointGate;
    }

    const blocked = new SessionStoreManager({ homeDirectory: harness.homeDirectory });
    try {
      await blocked.ready();
      await expect(blocked.openSession(sessionId)).rejects.toMatchObject({
        code: "storage.corrupt",
      });
      await expect(blocked.catalog.getSession(sessionId)).resolves.toMatchObject({
        status: "unavailable",
      });
    } finally {
      await blocked.close();
    }

    const repeatedRepair = new SessionStoreManager({
      homeDirectory: harness.homeDirectory,
      catalogRepair: "force",
    });
    try {
      await repeatedRepair.ready();
      await expect(repeatedRepair.catalog.getSession(sessionId)).resolves.toMatchObject({
        status: "ready",
      });
      expect(
        (await repeatedRepair.catalog.listCatalogRepairPage(null)).records.find(
          (record) => record.sessionId === sessionId,
        ),
      ).toMatchObject({ status: "ready", unavailableReason: null });
      await expect(repeatedRepair.catalog.getSession(unrelatedId)).resolves.toMatchObject({
        status: "ready",
      });
    } finally {
      await repeatedRepair.close();
    }
  }, 30_000);

  it("rebuilds a deleted catalog and preserves corrupt discovered databases", async () => {
    const harness = await RealServerHarness.create("wi-m7-catalog-repair-");
    harnesses.add(harness);
    const healthyId = await seedSession(harness.homeDirectory, "healthy");
    const corruptId = await seedSession(harness.homeDirectory, "corrupt");
    const mismatchId = await seedSession(harness.homeDirectory, "mismatch");
    const healthyDatabase = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(healthyId),
    );
    await writeFile(
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(corruptId)),
      "not a sqlite database",
    );
    await copyFile(
      healthyDatabase,
      resolveStoragePath(harness.homeDirectory, sessionDatabaseRelativePath(mismatchId)),
    );
    const wrongPrefixDirectory = join(
      harness.homeDirectory,
      "sessions",
      "zz",
      healthyId,
    );
    await mkdir(wrongPrefixDirectory, { recursive: true });
    await copyFile(healthyDatabase, join(wrongPrefixDirectory, "session.sqlite3"));
    const symlinkId = "ses_symlinkProbe";
    const symlinkPath = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(symlinkId).slice(0, -"/session.sqlite3".length),
    );
    const externalDirectory = join(harness.homeDirectory, "external-session");
    await mkdir(externalDirectory, { recursive: true });
    await mkdir(join(symlinkPath, ".."), { recursive: true });
    await symlink(externalDirectory, symlinkPath, "dir");
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(harness.homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const repaired = await start(harness);
    const bootstrap = await fetch(`${repaired.origin}/bootstrap`).then((response) => response.json()) as {
      sessions: readonly { sessionId: string; status: string }[];
    };
    expect(bootstrap.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: healthyId, status: "ready" }),
        expect.objectContaining({ sessionId: corruptId, status: "unavailable" }),
        expect.objectContaining({ sessionId: mismatchId, status: "unavailable" }),
      ]),
    );
    expect(bootstrap.sessions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: symlinkId })]),
    );
    const corruptDirectory = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(corruptId).slice(0, -"/session.sqlite3".length),
    );
    await expect(stat(corruptDirectory)).resolves.toBeDefined();
    const mismatchDirectory = resolveStoragePath(
      harness.homeDirectory,
      sessionDatabaseRelativePath(mismatchId).slice(0, -"/session.sqlite3".length),
    );
    await expect(stat(mismatchDirectory)).resolves.toBeDefined();
    await expect(stat(wrongPrefixDirectory)).resolves.toBeDefined();
    await expect(lstat(symlinkPath)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    await stop(repaired.process);
  }, 30_000);
});
