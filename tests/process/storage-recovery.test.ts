import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveStoragePath,
  sessionDatabaseRelativePath,
  SessionStoreManager,
} from "@wi/storage";

import { FixtureProcessRunner } from "./fixture-process.js";

const fixture = fileURLToPath(new URL("./storage-crash-fixture.mjs", import.meta.url));
const catalogV1Fixture = fileURLToPath(new URL("./catalog-v1-fixture.mjs", import.meta.url));
const sessionV1Fixture = fileURLToPath(new URL("./session-v1-fixture.mjs", import.meta.url));
const sessionV3Fixture = fileURLToPath(new URL("./session-v3-fixture.mjs", import.meta.url));
const homes: string[] = [];
const managers: SessionStoreManager[] = [];
const fixtureProcesses = new FixtureProcessRunner();

async function createHomeAndSession(): Promise<{
  homeDirectory: string;
  sessionId: string;
}> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
  homes.push(homeDirectory);
  const storage = new SessionStoreManager({
    homeDirectory,
    now: () => 1_000,
    ids: {
      sessionId: () => "ses_processA",
      eventId: () => "evt_processCreated",
    },
    sessionWorkers: { size: 1, allowTestOperations: true },
  });
  const created = await storage.createSession({
    v: 1,
    kind: "command",
    commandId: "cmd_processCreate",
    method: "session.create",
    params: { title: "Process recovery" },
  });
  await storage.close();
  return { homeDirectory, sessionId: created.session.sessionId };
}

async function runCrashFixture(
  homeDirectory: string,
  sessionId: string,
  mode: string,
): Promise<number | null> {
  const { WI_ALLOW_TEST_FAILPOINTS: _allowTestFailpoints, ...baseEnvironment } = process.env;
  void _allowTestFailpoints;
  const result = await fixtureProcesses.run(
    process.execPath,
    [fixture, homeDirectory, sessionId, mode],
    10_000,
    {
      ...baseEnvironment,
      NODE_ENV: "test",
      ...(mode === "failpoint_gate_probe" ? {} : { WI_ALLOW_TEST_FAILPOINTS: "1" }),
    },
  );
  if (result.code === 0 && result.stderr.trim().length > 0 && mode !== "failpoint_gate_probe") {
    throw new Error(result.stderr);
  }
  return result.code;
}

async function runCatalogV1Fixture(homeDirectory: string): Promise<number | null> {
  const result = await fixtureProcesses.run(process.execPath, [catalogV1Fixture, homeDirectory]);
  if (result.code !== 0) {
    throw new Error(result.stderr || `catalog v1 fixture exited ${String(result.code)}`);
  }
  return result.code;
}

async function runSessionV1Fixture(
  homeDirectory: string,
  mode: string,
): Promise<number | null> {
  const result = await fixtureProcesses.run(
    process.execPath,
    [sessionV1Fixture, homeDirectory, mode],
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || `session v1 fixture exited ${String(result.code)}`);
  }
  return result.code;
}

interface SessionV3Snapshot {
  readonly userVersion: number;
  readonly schema: readonly { readonly type: string; readonly name: string }[];
  readonly manifest: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly creationProvenance: readonly Record<string, unknown>[] | null;
}

async function runSessionV3Fixture(
  homeDirectory: string,
  mode: string,
): Promise<string> {
  const result = await fixtureProcesses.run(
    process.execPath,
    [sessionV3Fixture, homeDirectory, mode],
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || `session v3 fixture exited ${String(result.code)}`);
  }
  return result.stdout;
}

async function sessionV3Snapshot(homeDirectory: string): Promise<SessionV3Snapshot> {
  return JSON.parse(await runSessionV3Fixture(homeDirectory, "snapshot")) as SessionV3Snapshot;
}

function restart(
  homeDirectory: string,
  catalogRepair: "auto" | "force" | "off" = "auto",
): SessionStoreManager {
  const storage = new SessionStoreManager({
    homeDirectory,
    catalogRepair,
    sessionWorkers: { size: 1, allowTestOperations: true },
  });
  managers.push(storage);
  return storage;
}

afterEach(async () => {
  await fixtureProcesses.terminateAll();
  await Promise.allSettled(managers.splice(0).map((storage) => storage.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("storage crash windows", () => {
  it("rejects direct storage failpoints without the explicit allow gate", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    await expect(runCrashFixture(homeDirectory, sessionId, "failpoint_gate_probe")).resolves.toBe(0);
  });

  it("migrates a retained version-1 catalog to the current schema", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await expect(runCatalogV1Fixture(homeDirectory)).resolves.toBe(0);

    const storage = restart(homeDirectory);
    await storage.ready();
    await expect(storage.catalog.getStartupState()).resolves.toMatchObject({
      created: false,
      repairReason: null,
    });
    await expect(storage.catalog.getGlobalCommand("cmd_v1Migrated")).resolves.toMatchObject({
      state: "accepted",
      failureCode: null,
      failureMessage: null,
      diagnosticId: null,
      quarantinedRelativePath: null,
    });
  });

  it("reconstructs a retained session v1 without migrating or creating sidecars", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await expect(runSessionV1Fixture(homeDirectory, "valid")).resolves.toBe(0);
    const databasePath = resolveStoragePath(
      homeDirectory,
      sessionDatabaseRelativePath("ses_v1Populated"),
    );
    const originalBytes = await readFile(databasePath);
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(join(homeDirectory, `catalog.sqlite3${suffix}`), { force: true });
    }

    const storage = restart(homeDirectory);
    await storage.ready();
    await expect(storage.catalog.getSession("ses_v1Populated")).resolves.toMatchObject({
      status: "ready",
      sessionSchemaVersion: 1,
    });
    await storage.close();
    managers.splice(managers.indexOf(storage), 1);

    expect(await readFile(databasePath)).toEqual(originalBytes);
    await expect(stat(`${databasePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${databasePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runSessionV1Fixture(homeDirectory, "inspect-readonly")).resolves.toBe(0);
  }, 15_000);

  it("migrates a populated session v1 and backfills tool call occurrences", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await expect(runSessionV1Fixture(homeDirectory, "valid")).resolves.toBe(0);

    const storage = restart(homeDirectory);
    const session = await storage.openSession("ses_v1Populated");
    await expect(session.getManifest()).resolves.toMatchObject({ schemaVersion: 5 });
    await expect(session.getToolExecutionsForStep("step_v1Original")).resolves.toEqual([
      expect.objectContaining({ callId: "call_v1Existing", state: "completed" }),
    ]);

    await session.appendTransaction({
      events: [
        {
          eventId: "evt_v1LaterOccurrence",
          eventType: "provider.tool_call.reused",
          createdAtMs: 3_000,
          data: {
            eventVersion: 1,
            runId: "run_v1Populated",
            stepId: "step_v1Later",
            callId: "call_v1Existing",
            originalStepId: "step_v1Original",
          },
        },
      ],
      projections: [
        {
          kind: "providerStep.put",
          stepId: "step_v1Later",
          runId: "run_v1Populated",
          stepIndex: 1,
          state: "completed",
          startedAtMs: 3_000,
          completedAtMs: 3_000,
          responseId: "response_v1Later",
          errorCategory: null,
          errorMessage: null,
        },
        {
          kind: "toolCallOccurrence.put",
          runId: "run_v1Populated",
          stepId: "step_v1Later",
          callId: "call_v1Existing",
          occurredAtMs: 3_000,
        },
      ],
    });
    await expect(session.getToolExecutionsForStep("step_v1Later")).resolves.toEqual([
      expect.objectContaining({ callId: "call_v1Existing", state: "completed" }),
    ]);
  });

  it("rolls back a failed session v2 migration without advancing its version", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await expect(runSessionV1Fixture(homeDirectory, "conflict")).resolves.toBe(0);

    const storage = restart(homeDirectory);
    const session = await storage.openSession("ses_v1Populated");
    await expect(session.getManifest()).rejects.toMatchObject({ code: "storage.migration_failed" });
    await storage.close();
    managers.splice(managers.indexOf(storage), 1);
    await expect(runSessionV1Fixture(homeDirectory, "inspect-conflict")).resolves.toBe(0);
  });

  it("migrates an exact retained session v3 to the current schema without changing durable state", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await runSessionV3Fixture(homeDirectory, "seed-valid");
    const before = await sessionV3Snapshot(homeDirectory);
    expect(before.userVersion).toBe(3);
    expect(before.manifest).toEqual([
      expect.objectContaining({ schema_version: 3, last_event_sequence: 12 }),
    ]);
    expect(before.creationProvenance).toBeNull();
    expect(before.schema.some((entry) => entry.name === "creation_provenance")).toBe(false);

    const storage = restart(homeDirectory);
    const session = await storage.openSession("ses_v3Retained");
    await expect(session.getManifest()).resolves.toMatchObject({
      schemaVersion: 5,
      lastEventSequence: 12,
      title: "Retained session v3",
    });
    const events = await session.getEventsAfter(0);
    expect(events).toHaveLength(12);
    expect(events.map((event) => event.eventId)).toEqual(
      before.events.map((event) => event.event_id),
    );
    await expect(session.getAcceptedCommand("cmd_v3Submit")).resolves.toMatchObject({
      commandMethod: "message.submit",
      acceptedSequence: 6,
      runId: "run_v3Approval",
      result: { runId: "run_v3Approval" },
      duplicate: true,
    });
    await expect(session.getRun("run_v3Approval")).resolves.toMatchObject({
      state: "waiting_for_user",
      providerConfig: { scenario: "guarded-echo" },
    });
    await expect(session.getRun("run_v3Failed")).resolves.toMatchObject({
      state: "failed",
      failureCategory: "provider.protocol_error",
    });
    await expect(session.getProviderStep("step_v3Failed")).resolves.toMatchObject({
      state: "failed",
      diagnosticId: "err_v3Failed",
    });
    await expect(session.getToolExecutionsForStep("step_v3Approval")).resolves.toEqual([
      expect.objectContaining({
        callId: "call_v3Approval",
        state: "awaiting_approval",
        effectClass: "pure",
      }),
    ]);
    await expect(session.getPendingApprovals()).resolves.toEqual([
      expect.objectContaining({
        approvalId: "approval_v3Pending",
        callId: "call_v3Approval",
        state: "pending",
      }),
    ]);
    await expect(session.getPendingInputs()).resolves.toEqual([
      expect.objectContaining({
        inputId: "input_v3Pending",
        runId: "run_v3Input",
        state: "pending",
      }),
    ]);
    await expect(session.getInput("input_v3Pending")).resolves.toMatchObject({
      state: "pending",
      value: null,
    });
    await storage.close();
    managers.splice(managers.indexOf(storage), 1);

    const after = await sessionV3Snapshot(homeDirectory);
    expect(after.userVersion).toBe(5);
    expect(after.manifest).toEqual([
      expect.objectContaining({ schema_version: 5, last_event_sequence: 12 }),
    ]);
    expect(after.events).toEqual(before.events);
    expect(after.creationProvenance).toEqual([]);
    await runSessionV3Fixture(homeDirectory, "verify-v5");

    const repeated = restart(homeDirectory);
    await expect(
      (await repeated.openSession("ses_v3Retained")).getManifest(),
    ).resolves.toMatchObject({ schemaVersion: 5 });
    await repeated.close();
    managers.splice(managers.indexOf(repeated), 1);
    await expect(sessionV3Snapshot(homeDirectory)).resolves.toEqual(after);
  }, 20_000);

  it("rolls back an injected v3 to v4 migration failure and remains recoverable", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await runSessionV3Fixture(homeDirectory, "seed-failure");
    const before = await sessionV3Snapshot(homeDirectory);
    expect(before.userVersion).toBe(3);
    expect(before.creationProvenance).toBeNull();

    const failedStorage = restart(homeDirectory);
    const failedSession = await failedStorage.openSession("ses_v3Retained");
    await expect(failedSession.getManifest()).rejects.toMatchObject({
      code: "storage.migration_failed",
    });
    await failedStorage.close();
    managers.splice(managers.indexOf(failedStorage), 1);

    const rolledBack = await sessionV3Snapshot(homeDirectory);
    expect(rolledBack).toEqual(before);
    expect(rolledBack.userVersion).toBe(3);
    expect(rolledBack.creationProvenance).toBeNull();

    await runSessionV3Fixture(homeDirectory, "drop-failure");
    const recoveredStorage = restart(homeDirectory, "force");
    const recoveredSession = await recoveredStorage.openSession("ses_v3Retained");
    await expect(recoveredSession.getManifest()).resolves.toMatchObject({ schemaVersion: 5 });
    await recoveredStorage.close();
    managers.splice(managers.indexOf(recoveredStorage), 1);

    const recovered = await sessionV3Snapshot(homeDirectory);
    expect(recovered.userVersion).toBe(5);
    expect(recovered.events).toEqual(before.events);
    expect(recovered.creationProvenance).toEqual([]);
  }, 20_000);

  it("completes session creation committed before catalog readiness during startup", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await expect(
      runCrashFixture(
        homeDirectory,
        "ses_processIncomplete",
        "after_session_create_commit_before_catalog",
      ),
    ).resolves.toBe(84);

    const storage = restart(homeDirectory);
    await storage.ready();
    await expect(storage.catalog.getGlobalCommand("cmd_processIncompleteCreate")).resolves.toMatchObject({
      state: "accepted",
      reservedSessionId: "ses_processIncomplete",
    });
    await expect(storage.catalog.getSession("ses_processIncomplete")).resolves.toMatchObject({
      lastEventSequence: 1,
      title: "Incomplete creation",
    });
  });

  it("finishes initialization when schema creation committed without a manifest", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    await expect(
      runCrashFixture(
        homeDirectory,
        "ses_processSchemaOnly",
        "after_session_schema_before_manifest",
      ),
    ).resolves.toBe(85);

    const storage = restart(homeDirectory);
    await storage.ready();
    await expect(storage.catalog.getGlobalCommand("cmd_processIncompleteCreate")).resolves.toMatchObject({
      state: "accepted",
      reservedSessionId: "ses_processSchemaOnly",
    });
    await expect((await storage.openSession("ses_processSchemaOnly")).getManifest()).resolves.toMatchObject({
      title: "Incomplete creation",
      lastEventSequence: 1,
    });
  });

  it("persists corrupt incomplete creation failure across repeated restart and retry", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-storage-process-"));
    homes.push(homeDirectory);
    const sessionId = "ses_processCorruptCreate";
    await expect(
      runCrashFixture(homeDirectory, sessionId, "corrupt_incomplete_creation"),
    ).resolves.toBe(86);

    const firstRestart = restart(homeDirectory);
    await firstRestart.ready();
    const failed = await firstRestart.catalog.getGlobalCommand("cmd_processCorruptCreate");
    expect(failed).toMatchObject({
      state: "failed",
      reservedSessionId: sessionId,
      failureCode: "storage.corrupt",
      diagnosticId: expect.stringMatching(/^err_/),
    });
    if (failed === null) throw new Error("Failed creation command was not retained");
    await expect(firstRestart.catalog.getSession(sessionId)).resolves.toMatchObject({
      status: "unavailable",
      title: "Corrupt incomplete",
    });
    expect(failed?.quarantinedRelativePath).toBeNull();
    await expect(
      stat(
        resolveStoragePath(
          homeDirectory,
          sessionDatabaseRelativePath(sessionId),
        ),
      ),
    ).resolves.toBeDefined();
    await firstRestart.close();

    const secondRestart = restart(homeDirectory);
    await secondRestart.ready();
    await expect(
      secondRestart.catalog.getGlobalCommand("cmd_processCorruptCreate"),
    ).resolves.toMatchObject({
      state: "failed",
      diagnosticId: failed.diagnosticId,
      quarantinedRelativePath: null,
    });
    await expect(secondRestart.openSession(sessionId)).rejects.toMatchObject({
      code: "storage.corrupt",
    });
    await expect(secondRestart.catalog.getSession(sessionId)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(
      secondRestart.createSession({
        v: 1,
        kind: "command",
        commandId: "cmd_processCorruptCreate",
        method: "session.create",
        params: { title: "Corrupt incomplete" },
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      duplicate: true,
      session: { status: "unavailable" },
      command: { diagnosticId: failed.diagnosticId },
    });
    await expect(
      secondRestart.createSession({
        v: 1,
        kind: "command",
        commandId: "cmd_processReplacementCreate",
        method: "session.create",
        params: { title: "Replacement" },
      }),
    ).resolves.toMatchObject({ outcome: "created", duplicate: false });
  });

  it("does not recreate a missing session database and marks its catalog row missing", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    const databasePath = resolveStoragePath(
      homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    await rm(databasePath, { force: true });

    const storage = restart(homeDirectory);
    const session = await storage.openSession(sessionId);
    await expect(session.getManifest()).rejects.toMatchObject({
      code: "storage.session_missing",
    });
    await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
      status: "missing",
    });
    await expect(stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks a corrupt session database unavailable without blocking the catalog", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    const databasePath = resolveStoragePath(
      homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    await writeFile(databasePath, "not a sqlite database");

    const storage = restart(homeDirectory);
    const session = await storage.openSession(sessionId);
    await expect(session.getManifest()).rejects.toMatchObject({ code: "storage.corrupt" });
    await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(storage.catalog.listSessions()).resolves.toHaveLength(1);
  });

  it("rolls back an event when the session worker exits before commit", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    await expect(runCrashFixture(homeDirectory, sessionId, "before_commit")).resolves.toBe(80);

    const storage = restart(homeDirectory);
    const session = await storage.openSession(sessionId);
    await expect(session.getHeadSequence()).resolves.toBe(1);
    await expect(session.getEventsAfter(1)).resolves.toEqual([]);
  });

  it("keeps a committed event when the process exits before catalog update and repairs catalog", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    await expect(
      runCrashFixture(homeDirectory, sessionId, "after_session_commit_before_catalog"),
    ).resolves.toBe(82);

    const storage = restart(homeDirectory);
    expect((await storage.catalog.getSession(sessionId))?.lastEventSequence).toBe(1);
    const session = await storage.openSession(sessionId);
    await expect(session.getHeadSequence()).resolves.toBe(2);
    await expect(storage.catalog.getSession(sessionId)).resolves.toMatchObject({
      lastEventSequence: 2,
      updatedAtMs: 2_000,
    });
  });

  it("replays an event committed before the worker exits without returning it for publication", async () => {
    const { homeDirectory, sessionId } = await createHomeAndSession();
    await expect(
      runCrashFixture(homeDirectory, sessionId, "after_commit_before_publication"),
    ).resolves.toBe(83);

    const storage = restart(homeDirectory);
    const session = await storage.openSession(sessionId);
    const replay = await session.getEventsAfter(1);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({
      sequence: 2,
      eventType: "run.created",
      eventId: "evt_aftercommitbeforepublication",
    });
  });
});
