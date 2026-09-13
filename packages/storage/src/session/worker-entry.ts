import { lstatSync, mkdirSync, opendirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import type Database from "better-sqlite3";
import { z } from "zod";

import { SessionIdSchema } from "@wi/protocol";

import { openWorkerDatabase } from "../common/sqlite.js";
import { isValidSessionPrefix, sessionDatabaseRelativePath, sessionPrefixFromId } from "../manager/paths.js";
import {
  assertWorkerPayloadBounds,
  StorageError,
  toStorageError,
  WorkerRequestSchema,
  workerError,
  type WorkerResponse,
} from "../common/worker-rpc.js";
import { SessionEventPageInputSchema } from "../types.js";
import { SessionRepository } from "./repository.js";
import {
  boundDiscoveryDiagnostic,
  DISCOVERY_ERROR_CODE_MAXIMUM_UNITS,
  DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS,
} from "./discovery-limits.js";
import {
  discoverSessionDatabase,
  OversizedSessionDatabaseError,
  UnsupportedSessionSchemaError,
} from "./discovery-repository.js";

const WorkerDataSchema = z.strictObject({
  workerId: z.string().min(1),
  maxOpenHandles: z.number().int().positive().safe(),
  allowTestOperations: z.boolean(),
  allowTestFailpoints: z.boolean(),
});
const SessionPayloadSchema = z
  .strictObject({
    sessionId: z.string().min(1),
    databasePath: z.string().min(1),
  })
  .passthrough();

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface OpenSession {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly database: Database.Database;
  readonly repository: SessionRepository;
}

const config = WorkerDataSchema.parse(workerData);
if (parentPort === null) throw new Error("Session worker requires a parent port");
const port = parentPort;
const sessions = new Map<string, OpenSession>();

function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session === undefined) return;
  session.database.close();
  sessions.delete(sessionId);
}

function fileIdentity(path: string): FileIdentity | null {
  try {
    const stats = statSync(path);
    return { device: stats.dev, inode: stats.ino };
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return null;
    const message = error instanceof Error ? error.message : "Session database stat failed";
    throw new StorageError("storage.corrupt", message);
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function validateSessionDatabasePath(sessionId: string, databasePath: string): FileIdentity {
  const checkedLstat = (path: string) => {
    try {
      return lstatSync(path);
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new StorageError("storage.session_missing", "Session database file is missing");
      }
      throw error;
    }
  };
  const sessionDirectory = dirname(databasePath);
  const prefixDirectory = dirname(sessionDirectory);
  const sessionsRoot = dirname(prefixDirectory);
  const homeDirectory = dirname(sessionsRoot);
  const expected = resolve(homeDirectory, sessionDatabaseRelativePath(sessionId));
  if (resolve(databasePath) !== expected) {
    throw new StorageError("storage.corrupt", "Session database path is not canonically generated");
  }
  const expectedPrefix = sessionPrefixFromId(sessionId);
  if (dirname(sessionDirectory) !== prefixDirectory || !isValidSessionPrefix(expectedPrefix)) {
    throw new StorageError("storage.corrupt", "Session database prefix is invalid");
  }
  for (const [path, kind] of [
    [sessionsRoot, "sessions root"],
    [prefixDirectory, "prefix directory"],
    [sessionDirectory, "session directory"],
  ] as const) {
    const stats = checkedLstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new StorageError("storage.corrupt", `Session ${kind} is not a real directory`);
    }
  }
  const file = checkedLstat(databasePath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new StorageError("storage.corrupt", "Session database is not a real file");
  }
  const rootRealpath = realpathSync(sessionsRoot);
  const databaseRealpath = realpathSync(databasePath);
  if (databaseRealpath === rootRealpath || !databaseRealpath.startsWith(`${rootRealpath}${sep}`)) {
    throw new StorageError("storage.corrupt", "Session database escapes the generated sessions root");
  }
  return { device: file.dev, inode: file.ino };
}

function repositoryFor(
  payload: z.infer<typeof SessionPayloadSchema>,
  allowCreate: boolean,
): SessionRepository {
  const existing = sessions.get(payload.sessionId);
  if (existing !== undefined) {
    if (existing.path !== payload.databasePath) {
      throw new StorageError("storage.corrupt", "Session database path changed within a worker");
    }
    const currentIdentity = fileIdentity(existing.path);
    if (currentIdentity === null) {
      closeSession(payload.sessionId);
      throw new StorageError("storage.session_missing", "Session database file is missing");
    }
    let validatedIdentity: FileIdentity;
    try {
      validatedIdentity = validateSessionDatabasePath(payload.sessionId, existing.path);
    } catch (error) {
      closeSession(payload.sessionId);
      throw error;
    }
    if (!sameFileIdentity(existing.identity, currentIdentity) || !sameFileIdentity(existing.identity, validatedIdentity)) {
      closeSession(payload.sessionId);
      throw new StorageError("storage.corrupt", "Session database file was replaced while open");
    }
    sessions.delete(payload.sessionId);
    sessions.set(payload.sessionId, existing);
    return existing.repository;
  }

  while (sessions.size >= config.maxOpenHandles) {
    const oldestSessionId = sessions.keys().next().value as string | undefined;
    if (oldestSessionId === undefined) break;
    closeSession(oldestSessionId);
  }

  const identityBeforeOpen = allowCreate
    ? fileIdentity(payload.databasePath)
    : validateSessionDatabasePath(payload.sessionId, payload.databasePath);
  if (!allowCreate && identityBeforeOpen === null) {
    throw new StorageError("storage.session_missing", "Session database file is missing");
  }

  let database: Database.Database;
  try {
    database = openWorkerDatabase(payload.databasePath, { fileMustExist: !allowCreate });
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (!allowCreate && code === "SQLITE_CANTOPEN") {
      throw new StorageError("storage.session_missing", "Session database file is missing");
    }
    throw toStorageError(error, "storage.corrupt", "Session database open failed");
  }
  let repository: SessionRepository;
  try {
    repository = new SessionRepository(
      database,
      config.allowTestOperations,
      config.allowTestFailpoints,
    );
  } catch (error) {
    database.close();
    throw toStorageError(error, "storage.migration_failed", "Session migration failed");
  }
  const identityAfterOpen = allowCreate
    ? fileIdentity(payload.databasePath)
    : validateSessionDatabasePath(payload.sessionId, payload.databasePath);
  if (identityAfterOpen === null) {
    database.close();
    throw new StorageError("storage.session_missing", "Session database file disappeared while opening");
  }
  if (identityBeforeOpen !== null && !sameFileIdentity(identityBeforeOpen, identityAfterOpen)) {
    database.close();
    throw new StorageError("storage.corrupt", "Session database file changed while opening");
  }
  sessions.set(payload.sessionId, {
    path: payload.databasePath,
    identity: identityAfterOpen,
    database,
    repository,
  });
  return repository;
}

function discoverSessionInventory(payloadValue: unknown): unknown {
  const input = z
    .strictObject({
      homeDirectory: z.string().min(1),
      maximumSessions: z.number().int().positive().max(10_000),
    })
    .parse(payloadValue);
  const root = resolve(input.homeDirectory, "sessions");
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { sessionIds: [], inspectedEntries: 0, ignoredEntries: 0 };
    }
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new StorageError("storage.corrupt", "Generated sessions root is not a real directory");
  }
  realpathSync(root);
  const sessionIds: string[] = [];
  let inspectedEntries = 0;
  let ignoredEntries = 0;
  // Invalid trees must not bypass the session cap and consume unbounded worker memory/time.
  const maximumEntries = Math.min(40_000, input.maximumSessions * 8 + 256);
  const inspectEntry = (): void => {
    if (inspectedEntries >= maximumEntries) {
      throw new StorageError("storage.resource_limit", "Session discovery entry limit was exceeded");
    }
    inspectedEntries += 1;
  };
  const prefixes = opendirSync(root);
  try {
    let prefix;
    while ((prefix = prefixes.readSync()) !== null) {
      inspectEntry();
      if (
        !prefix.isDirectory() ||
        prefix.isSymbolicLink() ||
        !isValidSessionPrefix(prefix.name)
      ) {
        ignoredEntries += 1;
        continue;
      }
      const prefixPath = join(root, prefix.name);
      const prefixStats = lstatSync(prefixPath);
      if (!prefixStats.isDirectory() || prefixStats.isSymbolicLink()) {
        ignoredEntries += 1;
        continue;
      }
      const sessionDirectories = opendirSync(prefixPath);
      try {
        let sessionDirectory;
        while ((sessionDirectory = sessionDirectories.readSync()) !== null) {
          inspectEntry();
          const parsedSessionId = SessionIdSchema.safeParse(sessionDirectory.name);
          if (
            !sessionDirectory.isDirectory() ||
            sessionDirectory.isSymbolicLink() ||
            !parsedSessionId.success
          ) {
            ignoredEntries += 1;
            continue;
          }
          const sessionId = parsedSessionId.data;
          const expectedPrefix = sessionPrefixFromId(sessionId);
          if (expectedPrefix !== prefix.name) {
            ignoredEntries += 1;
            continue;
          }
          if (sessionIds.length >= input.maximumSessions) {
            throw new StorageError("storage.resource_limit", "Session discovery limit was exceeded");
          }
          sessionIds.push(sessionId);
        }
      } finally {
        sessionDirectories.closeSync();
      }
    }
  } finally {
    prefixes.closeSync();
  }
  sessionIds.sort((left, right) => left.localeCompare(right));
  return { sessionIds, inspectedEntries, ignoredEntries };
}

const MAXIMUM_DISCOVERY_PAGE_SESSION_IDS = 64;
const MAXIMUM_DISCOVERY_PAGE_RESPONSE_BYTES = 1_750_000;

function discoveryRootRealpath(homeDirectory: string): string | null {
  const root = resolve(homeDirectory, "sessions");
  try {
    const rootStats = lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new StorageError("storage.corrupt", "Generated sessions root is not a real directory");
    }
    return realpathSync(root);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function classifyDiscoveryFailure(sessionId: string, error: unknown): unknown {
  const errorCode = error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : null;
  if (errorCode === "ENOENT" || errorCode === "storage.session_missing") {
    return {
      kind: "missing",
      sessionId,
      code: "storage.session_missing",
      message: "Session database file is missing",
    };
  }
  if (error instanceof OversizedSessionDatabaseError) {
    return {
      kind: "oversized",
      sessionId,
      code: "storage.resource_limit",
      message: boundDiscoveryDiagnostic(
        error.message,
        DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS,
      ),
    };
  }
  if (error instanceof UnsupportedSessionSchemaError) {
    return {
      kind: "unsupported",
      sessionId,
      code: boundDiscoveryDiagnostic(error.code, DISCOVERY_ERROR_CODE_MAXIMUM_UNITS),
      message: boundDiscoveryDiagnostic(
        error.message,
        DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS,
      ),
      schemaVersion: error.schemaVersion,
    };
  }
  const classified = toStorageError(error, "storage.corrupt", "Session discovery failed");
  const operational = classified.retryable || [
    "storage.busy", "storage.disk_full", "storage.resource_limit",
    "SQLITE_BUSY", "SQLITE_LOCKED", "EACCES", "EMFILE", "ENFILE", "ENOSPC",
  ].includes(classified.code);
  return {
    kind: operational ? "transient" : "corrupt",
    sessionId,
    code: boundDiscoveryDiagnostic(
      classified.code,
      DISCOVERY_ERROR_CODE_MAXIMUM_UNITS,
    ),
    message: boundDiscoveryDiagnostic(
      classified.message,
      DISCOVERY_ERROR_MESSAGE_MAXIMUM_UNITS,
    ),
  };
}

function discoverSessionRecord(
  homeDirectory: string,
  rootRealpath: string | null,
  sessionId: string,
): unknown {
  const databasePath = resolve(homeDirectory, sessionDatabaseRelativePath(sessionId));
  try {
    if (rootRealpath === null) {
      throw new StorageError("storage.session_missing", "Generated sessions root is missing");
    }
    const sessionPath = resolve(databasePath, "..");
    const sessionStats = lstatSync(sessionPath);
    if (!sessionStats.isDirectory() || sessionStats.isSymbolicLink()) {
      throw new StorageError("storage.corrupt", "Discovered session path is not a real directory");
    }
    const databaseStats = lstatSync(databasePath);
    if (!databaseStats.isFile() || databaseStats.isSymbolicLink()) {
      throw new StorageError("storage.corrupt", "Discovered session database is not a real file");
    }
    const databaseRealpath = realpathSync(databasePath);
    if (
      databaseRealpath !== rootRealpath &&
      !databaseRealpath.startsWith(`${rootRealpath}${sep}`)
    ) {
      throw new StorageError("storage.corrupt", "Discovered session database escapes WI_HOME");
    }
    const identityBeforeOpen = validateSessionDatabasePath(sessionId, databasePath);
    const discovered = discoverSessionDatabase(databasePath);
    const identityAfterOpen = validateSessionDatabasePath(sessionId, databasePath);
    if (!sameFileIdentity(identityBeforeOpen, identityAfterOpen)) {
      throw new StorageError("storage.corrupt", "Discovered session database changed while opening");
    }
    if (discovered.manifest.sessionId !== sessionId) {
      throw new StorageError("storage.corrupt", "Discovered manifest identity does not match its path");
    }
    return { kind: "valid", sessionId, ...discovered };
  } catch (error) {
    return classifyDiscoveryFailure(sessionId, error);
  }
}

function discoverSessionPage(payloadValue: unknown): unknown {
  const input = z
    .strictObject({
      homeDirectory: z.string().min(1),
      sessionIds: z.array(SessionIdSchema).min(1).max(MAXIMUM_DISCOVERY_PAGE_SESSION_IDS),
    })
    .parse(payloadValue);
  const rootRealpath = discoveryRootRealpath(input.homeDirectory);
  const records: unknown[] = [];
  let responseBytes = 0;
  for (const sessionId of input.sessionIds) {
    const record = discoverSessionRecord(input.homeDirectory, rootRealpath, sessionId);
    const recordBytes = Buffer.byteLength(JSON.stringify(record));
    if (recordBytes > MAXIMUM_DISCOVERY_PAGE_RESPONSE_BYTES) {
      throw new StorageError(
        "storage.resource_limit",
        "One session discovery record exceeds the page response budget",
        true,
      );
    }
    if (records.length > 0 && responseBytes + recordBytes > MAXIMUM_DISCOVERY_PAGE_RESPONSE_BYTES) {
      break;
    }
    responseBytes += recordBytes;
    records.push(record);
  }
  return { records, processedCount: records.length };
}

function execute(operation: string, payloadValue: unknown): unknown {
  if (operation === "worker.close") {
    for (const sessionId of [...sessions.keys()]) closeSession(sessionId);
    return null;
  }
  if (operation === "session.getStats") {
    return { openSessionIds: [...sessions.keys()] };
  }
  if (operation === "session.discoverInventory") return discoverSessionInventory(payloadValue);
  if (operation === "session.discoverPage") return discoverSessionPage(payloadValue);

  const payload = SessionPayloadSchema.parse(payloadValue);
  if (operation.startsWith("session.test") && !config.allowTestOperations) {
    throw new StorageError("storage.worker_failed", "Test operations are disabled");
  }
  if (operation === "session.close") {
    closeSession(payload.sessionId);
    return null;
  }

  const repository = repositoryFor(
    payload,
    operation === "session.initialize" || operation === "session.testInitializeSchemaOnly",
  );
  if (
    operation !== "session.initialize" &&
    operation !== "session.testInitializeSchemaOnly"
  ) {
    const manifest = repository.getManifest();
    if (manifest.sessionId !== payload.sessionId) {
      closeSession(payload.sessionId);
      throw new StorageError(
        "storage.corrupt",
        `Session manifest ${manifest.sessionId} does not match requested ${payload.sessionId}`,
      );
    }
  }

  switch (operation) {
    case "session.initialize":
      mkdirSync(join(dirname(payload.databasePath), "artifacts"), { recursive: true });
      return repository.initialize({
        sessionId: payload.sessionId,
        projectId: payload.projectId,
        title: payload.title,
        createdAtMs: payload.createdAtMs,
        eventId: payload.eventId,
        ...(payload.creation === undefined ? {} : { creation: payload.creation }),
      });
    case "session.getManifest":
      return repository.getManifest();
    case "session.acceptCommand":
      return repository.acceptCommand(payload.input);
    case "session.appendTransaction":
      return repository.appendTransaction(payload.input);
    case "session.inspectAppendTransaction":
      return repository.inspectAppendTransaction(payload.input);
    case "session.getEventsAfter":
      return repository.getEventsAfter(
        z.number().int().nonnegative().safe().parse(payload.afterSequence),
        payload.throughSequence === undefined
          ? undefined
          : z.number().int().nonnegative().safe().parse(payload.throughSequence),
      );
    case "session.getEventPageAfter":
      return repository.getEventPageAfter(payload.input);
    case "session.getHeadSequence":
      return repository.getHeadSequence();
    case "session.getEventById":
      return repository.getEventById(z.string().min(1).parse(payload.eventId));
    case "session.getRun":
      return repository.getRun(z.string().min(1).parse(payload.runId));
    case "session.getProviderDefault":
      return repository.getSessionProviderDefault();
    case "session.getRunProviderMatch":
      return repository.getRunProviderMatch(
        z.string().min(1).parse(payload.runId),
        z.string().min(1).max(256).parse(payload.expectedProviderId),
      );
    case "session.getBoundedProviderRequestData":
      return repository.getBoundedProviderRequestData(payload.input);
    case "session.getAcceptedCommand":
      return repository.getAcceptedCommand(z.string().min(1).parse(payload.commandId));
    case "session.getProviderStep":
      return repository.getProviderStep(z.string().min(1).parse(payload.stepId));
    case "session.getProviderStepsForRun":
      return repository.getProviderStepsForRun(z.string().min(1).parse(payload.runId));
    case "session.getRecentProviderStepsForRun":
      return repository.getRecentProviderStepsForRun(
        z.string().min(1).parse(payload.runId),
        payload.limit,
      );
    case "session.getToolExecution":
      return repository.getToolExecution(z.string().min(1).parse(payload.callId));
    case "session.getToolExecutionsForStep":
      return repository.getToolExecutionsForStep(z.string().min(1).parse(payload.stepId));
    case "session.getToolExecutionsForRun":
      return repository.getToolExecutionsForRun(z.string().min(1).parse(payload.runId));
    case "session.getRunMessages":
      return repository.getRunMessages(z.string().min(1).parse(payload.runId));
    case "session.getStreamingMessagesForStep":
      return repository.getStreamingMessagesForStep(z.string().min(1).parse(payload.stepId));
    case "session.getNonterminalRuns":
      return repository.getNonterminalRuns();
    case "session.getCatalogProjection":
      return repository.getCatalogProjection();
    case "session.getCatalogObservation":
      return repository.getCatalogObservation();
    case "session.getPendingApprovals":
      return repository.getPendingApprovals();
    case "session.getPendingInputs":
      return repository.getPendingInputs();
    case "session.getInput":
      return repository.getInput(z.string().min(1).parse(payload.inputId));
    case "session.getPendingInputCount":
      return repository.getPendingInputCount();
    case "session.recover":
      return repository.recover();
    case "session.testInitializeSchemaOnly":
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      return null;
    case "session.testBarrier": {
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      const barrier = z.instanceof(SharedArrayBuffer).parse(payload.barrier);
      const view = new Int32Array(barrier);
      Atomics.add(view, 0, 1);
      Atomics.notify(view, 0);
      while (Atomics.load(view, 1) === 0) Atomics.wait(view, 1, 0, 1_000);
      return null;
    }
    case "session.testGetProjectionIdentity":
      return repository.testGetProjectionIdentity(
        z
          .enum([
            "run",
            "message",
            "messagePart",
            "providerStep",
            "toolExecution",
            "approval",
            "input",
          ])
          .parse(payload.kind),
        z.string().min(1).parse(payload.id),
      );
    case "session.testGetPragmas":
      return repository.testGetPragmas();
    case "session.testMalformedResponse":
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      return null;
    case "session.testMalformedResult":
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      return { invalid: true };
    case "session.testCorruptManifest":
      repository.testCorruptManifest();
      return null;
    case "session.testMutateEvent":
      repository.testMutateEvent(
        z.enum(["update", "delete"]).parse(payload.action),
        z.number().int().positive().safe().parse(payload.sequence),
      );
      return null;
    case "session.testCrashWorker":
      if (!config.allowTestOperations) {
        throw new StorageError("storage.worker_failed", "Test operations are disabled");
      }
      process.exit(73);
      return null;
    default:
      throw new StorageError("storage.worker_failed", `Unknown session operation ${operation}`);
  }
}

port.on("message", (message: unknown) => {
  const parsed = WorkerRequestSchema.safeParse(message);
  if (!parsed.success) return;
  if (parsed.data.operation === "session.testMalformedResponse" && config.allowTestOperations) {
    port.postMessage({ invalid: true });
    return;
  }

  let response: WorkerResponse;
  try {
    response = {
      v: 1,
      requestId: parsed.data.requestId,
      workerId: config.workerId,
      ok: true,
      result: execute(parsed.data.operation, parsed.data.payload),
    };
  } catch (error) {
    response = {
      v: 1,
      requestId: parsed.data.requestId,
      workerId: config.workerId,
      ok: false,
      error: workerError(error),
    };
  }
  try {
    if (response.ok && parsed.data.operation === "session.getEventPageAfter") {
      const pageInput = SessionEventPageInputSchema.parse(
        (parsed.data.payload as { readonly input?: unknown }).input,
      );
      if (Buffer.byteLength(JSON.stringify(response)) > pageInput.maximumBytes) {
        throw new StorageError(
          "storage.payload_too_large",
          "Replay worker response exceeded its serialized byte limit",
        );
      }
    }
    assertWorkerPayloadBounds(response, { maxNodes: 40_000, maxUnits: 2_000_000 });
  } catch (error) {
    response = {
      v: 1,
      requestId: parsed.data.requestId,
      workerId: config.workerId,
      ok: false,
      error: workerError(error),
    };
  }
  port.postMessage(response);
});
