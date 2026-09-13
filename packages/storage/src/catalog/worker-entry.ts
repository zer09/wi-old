import {
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import type Database from "better-sqlite3";
import { z } from "zod";

import { openWorkerDatabase } from "../common/sqlite.js";
import {
  assertWorkerPayloadBounds,
  StorageError,
  WorkerRequestSchema,
  workerError,
  type WorkerResponse,
} from "../common/worker-rpc.js";
import { ProjectRecordSchema } from "../types.js";
import { CatalogRepairReasonSchema, CatalogRepository } from "./repository.js";
import { safeCatalogStartupError } from "./startup-error.js";

const WorkerDataSchema = z.strictObject({
  workerId: z.string().min(1),
  databasePath: z.string().min(1),
  allowRepair: z.boolean(),
});

const config = WorkerDataSchema.parse(workerData);
if (parentPort === null) throw new Error("Catalog worker requires a parent port");
const port = parentPort;

let database: Database.Database | null = null;
let repository: CatalogRepository | null = null;
let startupError: StorageError | null = null;
let validatedSource: CatalogSourceIdentity | null = null;

interface CatalogDirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface CatalogFileIdentity {
  readonly suffix: "" | "-wal" | "-shm";
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface CatalogSourceIdentity {
  readonly directory: CatalogDirectoryIdentity;
  readonly files: readonly CatalogFileIdentity[];
}

function catalogDirectoryIdentity(databasePath: string): CatalogDirectoryIdentity {
  const identity = lstatSync(dirname(databasePath), { bigint: true });
  if (!identity.isDirectory()) {
    throw new StorageError("storage.corrupt", "Catalog home is not a directory");
  }
  return { dev: identity.dev, ino: identity.ino };
}

function catalogFileIdentity(
  databasePath: string,
  suffix: CatalogFileIdentity["suffix"],
): CatalogFileIdentity | null {
  try {
    const identity = lstatSync(`${databasePath}${suffix}`, { bigint: true });
    if (!identity.isFile()) {
      throw new StorageError("storage.corrupt", "Catalog storage is not a regular file");
    }
    return {
      suffix,
      dev: identity.dev,
      ino: identity.ino,
      size: identity.size,
      mtimeNs: identity.mtimeNs,
      ctimeNs: identity.ctimeNs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function catalogSourceIdentity(databasePath: string): CatalogSourceIdentity {
  const files = (["", "-wal", "-shm"] as const).flatMap((suffix) => {
    const identity = catalogFileIdentity(databasePath, suffix);
    return identity === null ? [] : [identity];
  });
  return { directory: catalogDirectoryIdentity(databasePath), files };
}

function sameCatalogSourceIdentity(
  first: CatalogSourceIdentity,
  second: CatalogSourceIdentity,
): boolean {
  return first.directory.dev === second.directory.dev &&
    first.directory.ino === second.directory.ino &&
    first.files.length === second.files.length &&
    first.files.every((expected, index) => {
      const actual = second.files[index];
      return actual !== undefined &&
        expected.suffix === actual.suffix &&
        expected.dev === actual.dev &&
        expected.ino === actual.ino &&
        expected.size === actual.size &&
        expected.mtimeNs === actual.mtimeNs &&
        expected.ctimeNs === actual.ctimeNs;
    });
}

function assertCatalogSourceIdentity(expected: CatalogSourceIdentity): void {
  if (!sameCatalogSourceIdentity(expected, catalogSourceIdentity(config.databasePath))) {
    throw new StorageError("storage.busy", "Catalog storage changed during startup", true);
  }
}

function reserveMissingCatalog(databasePath: string, before: CatalogSourceIdentity): void {
  if (before.files.length > 0) {
    throw new StorageError(
      "storage.corrupt",
      "Catalog sidecars exist without the catalog database",
    );
  }
  const file = openSync(
    databasePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(file);
}

function validateCatalogCopy(databasePath: string): CatalogSourceIdentity {
  let before = catalogSourceIdentity(databasePath);
  if (!before.files.some(({ suffix }) => suffix === "")) {
    reserveMissingCatalog(databasePath, before);
    const reserved = catalogSourceIdentity(databasePath);
    if (
      before.directory.dev !== reserved.directory.dev ||
      before.directory.ino !== reserved.directory.ino
    ) {
      throw new StorageError("storage.busy", "Catalog home changed during startup", true);
    }
    before = reserved;
  }

  const probeDirectory = mkdtempSync(join(tmpdir(), "wi-catalog-probe-"));
  const probePath = join(probeDirectory, "catalog.sqlite3");
  let probeDatabase: Database.Database | null = null;
  try {
    for (const { suffix } of before.files) {
      copyFileSync(
        `${databasePath}${suffix}`,
        `${probePath}${suffix}`,
        constants.COPYFILE_EXCL,
      );
    }
    assertCatalogSourceIdentity(before);
    probeDatabase = openWorkerDatabase(probePath, { fileMustExist: true });
    const integrity = probeDatabase.pragma("quick_check") as readonly Record<string, unknown>[];
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new StorageError("storage.corrupt", "Catalog integrity check failed");
    }
    new CatalogRepository(probeDatabase);
    assertCatalogSourceIdentity(before);
    return before;
  } finally {
    try {
      probeDatabase?.close();
    } finally {
      rmSync(probeDirectory, { recursive: true, force: true });
    }
  }
}

function prepareCatalogOpen(): void {
  if (repository !== null || validatedSource !== null) return;
  try {
    validatedSource = validateCatalogCopy(config.databasePath);
    startupError = null;
  } catch (error) {
    startupError = safeCatalogStartupError(error);
    throw startupError;
  }
}

function openCatalog(requirePrepared = false): void {
  if (repository !== null) return;
  if (validatedSource === null) {
    if (requirePrepared) {
      throw new StorageError("storage.busy", "Catalog validation must be repeated", true);
    }
    prepareCatalogOpen();
  }
  const expected = validatedSource;
  if (expected === null) {
    throw new StorageError("storage.worker_failed", "Catalog validation is unavailable");
  }
  try {
    database = openWorkerDatabase(config.databasePath, {
      fileMustExist: true,
      beforeConfigure: () => assertCatalogSourceIdentity(expected),
    });
    repository = new CatalogRepository(database);
    startupError = null;
  } catch (error) {
    database?.close();
    database = null;
    repository = null;
    startupError = safeCatalogStartupError(error);
    throw startupError;
  } finally {
    validatedSource = null;
  }
}

function repairCatalog(): never {
  if (!config.allowRepair) {
    throw new StorageError("storage.worker_failed", "Catalog repair mode is disabled");
  }
  database?.close();
  database = null;
  repository = null;
  validatedSource = null;
  // Node has no cross-platform handle-relative, no-follow, no-overwrite move.
  // Preserve the catalog and sidecars rather than mutate a substituted pathname.
  throw new StorageError(
    "storage.corrupt",
    "Catalog is corrupt and was preserved in place",
    false,
  );
}

function execute(operation: string, payload: unknown): unknown {
  if (operation === "worker.close") {
    database?.close();
    validatedSource = null;
    return null;
  }
  if (operation === "catalog.prepareOpen") {
    prepareCatalogOpen();
    return null;
  }
  if (operation === "catalog.openPrepared") {
    openCatalog(true);
    return null;
  }
  if (operation === "catalog.repair") return repairCatalog();
  if (repository === null) openCatalog();
  if (startupError !== null) throw startupError;
  if (repository === null) {
    throw new StorageError("storage.worker_failed", "Catalog repository is unavailable");
  }

  switch (operation) {
    case "catalog.getStartupState":
      return {
        created: false,
        repairReason: repository.getRepairReason(),
        hasCompletedRepair: repository.hasCompletedRepair(),
      };
    case "catalog.beginRepair": {
      const input = z.strictObject({ reason: CatalogRepairReasonSchema }).parse(payload);
      return repository.beginRepair(input.reason);
    }
    case "catalog.completeRepair":
      repository.completeRepair();
      return null;
    case "catalog.createProject":
      return repository.createProject(ProjectRecordSchema.parse(payload));
    case "catalog.reserveGlobalCommand":
      return repository.reserveGlobalCommand(payload);
    case "catalog.completeGlobalCommand":
      return repository.completeGlobalCommand(payload);
    case "catalog.failGlobalCommand":
      return repository.failGlobalCommand(payload);
    case "catalog.setGlobalCommandQuarantine":
      return repository.setGlobalCommandQuarantine(payload);
    case "catalog.getGlobalCommand": {
      const input = z.strictObject({ commandId: z.string().min(1) }).parse(payload);
      return repository.getGlobalCommand(input.commandId);
    }
    case "catalog.listCreatingGlobalCommands":
      return repository.listCreatingGlobalCommands();
    case "catalog.createSessionIndex":
      return repository.createSessionIndex(payload);
    case "catalog.countSessions":
      return repository.countSessions();
    case "catalog.listSessions":
      return repository.listSessions();
    case "catalog.listCatalogRepairPage":
      return repository.listCatalogRepairPage(payload);
    case "catalog.markSessionsMissing":
      return repository.markSessionsMissing(payload);
    case "catalog.listBrowserSessionsBounded":
      return repository.listBrowserSessionsBounded(payload);
    case "catalog.getSession": {
      const input = z.strictObject({ sessionId: z.string().min(1) }).parse(payload);
      return repository.getSession(input.sessionId);
    }
    case "catalog.updateSessionProjection":
      return repository.updateSessionProjection(payload);
    case "catalog.markSessionStatus":
      return repository.markSessionStatus(payload);
    case "catalog.repairSessionClassification":
      return repository.repairSessionClassification(payload);
    case "catalog.listRecoveryCandidates":
      return repository.listRecoveryCandidates(payload);
    case "catalog.markRecoveryCandidate": {
      const input = z.strictObject({ sessionId: z.string().min(1) }).parse(payload);
      repository.markRecoveryCandidate(input.sessionId);
      return null;
    }
    case "catalog.getProviderCatalogState":
      return repository.getProviderCatalogState();
    case "catalog.setProviderCatalogRecoveryActive": {
      const input = z.strictObject({ active: z.boolean() }).parse(payload);
      return repository.setProviderCatalogRecoveryActive(input.active);
    }
    case "catalog.listProviderConnections":
      return repository.listProviderConnections(payload);
    case "catalog.getProviderConnection": {
      const input = z.strictObject({ connectionId: z.string().min(1) }).parse(payload);
      return repository.getProviderConnection(input.connectionId);
    }
    case "catalog.registerEnvironmentConnection":
      return repository.registerEnvironmentConnection(payload);
    case "catalog.admitProviderRecovery":
      return repository.admitProviderRecovery(payload);
    case "catalog.failProviderRecovery":
      return repository.failProviderRecovery(payload);
    case "catalog.failValidatingProviderRecoveries": {
      const input = z.strictObject({ updatedAtMs: z.number().int().nonnegative().safe() }).parse(payload);
      return repository.failValidatingProviderRecoveries(input.updatedAtMs);
    }
    case "catalog.reserveRecoveredProviderConnection":
      return repository.reserveRecoveredProviderConnection(payload);
    case "catalog.reserveFileProviderConnection":
      return repository.reserveFileProviderConnection(payload);
    case "catalog.prepareProviderLifecycle":
      return repository.prepareProviderLifecycle(payload);
    case "catalog.disableProviderConnection":
      return repository.disableProviderConnection(payload);
    case "catalog.observeProviderLifecycleEffect":
      return repository.observeProviderLifecycleEffect(payload);
    case "catalog.failOrphanedProviderLifecycle":
      return repository.failOrphanedProviderLifecycle(payload);
    case "catalog.completeProviderLifecycle":
      return repository.completeProviderLifecycle(payload);
    case "catalog.hasProviderMetadataCommand": {
      const input = z.strictObject({ commandId: z.string() }).parse(payload);
      return repository.hasProviderMetadataCommand(input.commandId);
    }
    case "catalog.getProviderLifecycleOperation": {
      const input = z.strictObject({ commandId: z.string().min(1) }).parse(payload);
      return repository.getProviderLifecycleOperation(input.commandId);
    }
    case "catalog.isProvisioningClaimActive": {
      const input = z.strictObject({ provisioningId: z.string().min(1).max(128) }).parse(payload);
      return repository.isProvisioningClaimActive(input.provisioningId);
    }
    case "catalog.markProviderStageCleaned": {
      const input = z.strictObject({ stagingInternalRef: z.string().min(1).max(128) }).parse(payload);
      repository.markProviderStageCleaned(input.stagingInternalRef);
      return null;
    }
    case "catalog.listTerminalProviderStages":
      return repository.listTerminalProviderStages();
    case "catalog.listPreparedProviderOperations":
      return repository.listPreparedProviderOperations();
    case "catalog.markEnvironmentConnectionUnavailable":
      return repository.markEnvironmentConnectionUnavailable(payload);
    case "catalog.renameProviderConnection":
      return repository.renameProviderConnection(payload);
    case "catalog.putProviderCapabilities":
      return repository.putProviderCapabilities(payload);
    case "catalog.getProviderCapabilities": {
      const input = z.strictObject({ connectionId: z.string().min(1) }).parse(payload);
      return repository.getProviderCapabilities(input.connectionId);
    }
    case "catalog.reconcileSession":
      return repository.reconcileSession(payload);
    case "catalog.reconcileCreationSession":
      return repository.reconcileCreationSession(payload);
    case "catalog.reconcileValidatedRepairSession":
      return repository.reconcileValidatedRepairSession(payload);
    default:
      throw new StorageError("storage.worker_failed", `Unknown catalog operation ${operation}`);
  }
}

port.on("message", (message: unknown) => {
  const parsed = WorkerRequestSchema.safeParse(message);
  if (!parsed.success) return;

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
