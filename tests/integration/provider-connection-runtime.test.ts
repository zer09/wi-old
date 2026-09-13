import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JsonLogger,
  WiRuntime,
  type LogRecord,
} from "../../apps/server/src/index.js";
import {
  CredentialProvisioner,
  FileCredentialStore,
  StoredCredential,
  initializeCredentialRoots,
  internalStagingRef,
} from "@wi/credentials";
import {
  authoritativeProviderIdentityKey,
  canonicalJsonHash,
  CredentialRecoveryExpectedSafeMetadataSchema,
  type FileConnectionCreateCommand,
} from "@wi/protocol";
import { FakeProviderAdapter } from "@wi/provider-fake";

const homes: string[] = [];
const runtimes: WiRuntime[] = [];
const previousGate = process.env.WI_ALLOW_TEST_FAILPOINTS;
const previousNodeEnv = process.env.NODE_ENV;
const previousKey = process.env.WI_TEST_PROVIDER_KEY;
const previousChangedKey = process.env.WI_CHANGED_PROVIDER_KEY;
const previousRevalidateInitialKey = process.env.WI_REVALIDATE_INITIAL_KEY;
const previousRevalidateChangedKey = process.env.WI_REVALIDATE_CHANGED_KEY;

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  if (previousGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
  else process.env.WI_ALLOW_TEST_FAILPOINTS = previousGate;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousKey === undefined) delete process.env.WI_TEST_PROVIDER_KEY;
  else process.env.WI_TEST_PROVIDER_KEY = previousKey;
  if (previousChangedKey === undefined) delete process.env.WI_CHANGED_PROVIDER_KEY;
  else process.env.WI_CHANGED_PROVIDER_KEY = previousChangedKey;
  if (previousRevalidateInitialKey === undefined) delete process.env.WI_REVALIDATE_INITIAL_KEY;
  else process.env.WI_REVALIDATE_INITIAL_KEY = previousRevalidateInitialKey;
  if (previousRevalidateChangedKey === undefined) delete process.env.WI_REVALIDATE_CHANGED_KEY;
  else process.env.WI_REVALIDATE_CHANGED_KEY = previousRevalidateChangedKey;
  vi.restoreAllMocks();
});

async function filesBelow(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function waitForTerminal(runtime: WiRuntime, sessionId: string, runId: string) {
  const session = await runtime.storage.openSession(sessionId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await session.getRun(runId);
    if (run?.state === "completed" || run?.state === "failed" || run?.state === "interrupted") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not become terminal");
}

describe("provider connection runtime fixture", () => {
  it("removes expired unclaimed credential stages during startup", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-stage-cleanup-"));
    homes.push(home);
    const stateRoot = `${home}-state`;
    homes.push(stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    const provisioner = new CredentialProvisioner(roots.stagingRoot, () => 0);
    const staged = await provisioner.stageApiKey("openai_platform", "api_key", "expired-private-key");
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
      now: () => 1_000_000,
    });
    runtimes.push(runtime);
    await runtime.ready();
    await expect(provisioner.read(staged.provisioningRef, { allowExpiredClaimed: true }))
      .rejects.toMatchObject({ code: "credential.stage_missing" });
  });

  it("persists one stable loser when distinct commands race for one staged credential", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-stage-claim-race-"));
    const stateRoot = `${home}-state`;
    homes.push(home, stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    const provisioner = new CredentialProvisioner(roots.stagingRoot);
    const staged = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "stage-claim-race-secret",
    );
    let markPrepared!: () => void;
    let releasePrepared!: () => void;
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
    const prepareGate = new Promise<void>((resolve) => { releasePrepared = resolve; });
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: () => null,
        afterLifecyclePrepare: async (_kind, commandId) => {
          if (commandId !== "cmd_stageClaimWinner") return;
          markPrepared();
          await prepareGate;
        },
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const command = (commandId: string, displayName: string): FileConnectionCreateCommand => ({
      v: 1,
      kind: "command",
      commandId,
      method: "providerConnection.file.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName,
        provisioningRef: staged.provisioningRef,
      },
    });
    const winnerCommand = command("cmd_stageClaimWinner", "Stage claim winner");
    const loserCommand = command("cmd_stageClaimLoser", "Stage claim loser");
    const winner = runtime.providerConnections.route(winnerCommand);
    await prepared;
    await expect(runtime.providerConnections.route(loserCommand)).rejects.toMatchObject({
      code: "credential.provisioning_already_claimed",
    });
    await expect(runtime.storage.catalog.getProviderLifecycleOperation(loserCommand.commandId))
      .resolves.toMatchObject({
        phase: "failed",
        failureCode: "credential.provisioning_already_claimed",
      });
    releasePrepared();
    await expect(winner).resolves.toMatchObject({ duplicate: false });
    await expect(runtime.providerConnections.route(loserCommand)).rejects.toMatchObject({
      code: "credential.provisioning_already_claimed",
    });
    await expect(runtime.storage.catalog.listProviderConnections()).resolves.toMatchObject({
      connections: [expect.objectContaining({
        displayName: "Stage claim winner",
        credentialGeneration: 1,
        lifecycleStatus: "ready",
      })],
    });
    await expect(new FileCredentialStore(roots.credentialRoot).listRefs()).resolves.toHaveLength(1);
    await expect(provisioner.read(staged.provisioningRef, {
      allowExpiredClaimed: false,
    })).rejects.toMatchObject({
      code: "credential.stage_missing",
    });
  });

  it("terminalizes and cleans an ordinary malformed-stage failure after durable prepare", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-stage-failure-"));
    homes.push(home);
    const stateRoot = `${home}-state`;
    homes.push(stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    const provisioner = new CredentialProvisioner(roots.stagingRoot);
    const staged = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "missing-stage-secret",
    );
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const stagedRead = await provisioner.readWithFileIdentity(staged.provisioningRef, {
      allowExpiredClaimed: false,
    });
    const stagedMetadata = stagedRead.credential;
    const command: FileConnectionCreateCommand = {
      v: 1,
      kind: "command",
      commandId: "cmd_missingStageAfterPrepare",
      method: "providerConnection.file.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Missing stage",
        provisioningRef: staged.provisioningRef,
      },
    };
    await runtime.storage.catalog.reserveFileProviderConnection({
      commandId: command.commandId,
      commandMethod: command.method,
      contentHash: await canonicalJsonHash(command),
      connectionId: "pconn_missingStage",
      providerId: "openai_platform",
      authMode: "api_key",
      displayName: command.params.displayName,
      identity: { status: "unverified" },
      credentialInternalRef: "credref_missingStage",
      targetEnvelopeId: "envl_missingStage",
      provisioningId: stagedMetadata.provisioningId,
      stagingInternalRef: internalStagingRef(staged.provisioningRef),
      stagingFileIdentity: stagedRead.fileIdentity,
      createdAtMs: 1,
    });
    const stagingInternalRef = internalStagingRef(staged.provisioningRef);
    await writeFile(
      join(roots.stagingRoot, `${stagingInternalRef.replace("stage_", "stage-")}.json`),
      "{",
      "utf8",
    );

    await expect(runtime.providerConnections.route(command)).rejects.toMatchObject({
      code: "credential.malformed",
    });
    await expect(runtime.storage.catalog.getProviderLifecycleOperation(command.commandId))
      .resolves.toMatchObject({ phase: "failed", failureCode: "credential.malformed" });
    await expect(provisioner.readClaimedInternal(stagingInternalRef)).rejects.toMatchObject({
      code: "credential.stage_missing",
    });
    await expect(runtime.storage.catalog.getProviderConnection("pconn_missingStage"))
      .resolves.toMatchObject({ lifecycleOwnerKind: null, lifecycleStatus: "unavailable" });
    await expect(runtime.providerConnections.route(command)).rejects.toMatchObject({
      code: "credential.malformed",
    });
  });

  it("rejects secret-only claimed-stage replacement after durable prepare", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-stage-secret-substitution-"));
    homes.push(home);
    const stateRoot = `${home}-state`;
    homes.push(stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    const provisioner = new CredentialProvisioner(roots.stagingRoot);
    const staged = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "same-process-stage-secret-before-prepare",
    );
    const stagedRead = await provisioner.readWithFileIdentity(staged.provisioningRef, {
      allowExpiredClaimed: false,
    });
    const command: FileConnectionCreateCommand = {
      v: 1,
      kind: "command",
      commandId: "cmd_sameProcessStageSecretSubstitution",
      method: "providerConnection.file.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Substituted stage",
        provisioningRef: staged.provisioningRef,
      },
    };
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    await runtime.storage.catalog.reserveFileProviderConnection({
      commandId: command.commandId,
      commandMethod: command.method,
      contentHash: await canonicalJsonHash(command),
      connectionId: "pconn_sameProcessStageSubstitution",
      providerId: "openai_platform",
      authMode: "api_key",
      displayName: command.params.displayName,
      identity: { status: "unverified" },
      credentialInternalRef: "credref_sameProcessStageSubstitution",
      targetEnvelopeId: "envl_sameProcessStageSubstitution",
      provisioningId: stagedRead.credential.provisioningId,
      stagingInternalRef: internalStagingRef(staged.provisioningRef),
      stagingFileIdentity: stagedRead.fileIdentity,
      createdAtMs: 1,
    });
    const stagingInternalRef = internalStagingRef(staged.provisioningRef);
    const stagePath = join(
      roots.stagingRoot,
      `${stagingInternalRef.replace("stage_", "stage-")}.json`,
    );
    const envelope = JSON.parse(await readFile(stagePath, "utf8")) as Record<string, unknown>;
    envelope.apiKey = "same-process-stage-secret-after-prepare";
    const replacementPath = join(roots.stagingRoot, ".same-process-stage-substitution");
    await writeFile(replacementPath, JSON.stringify(envelope), { mode: 0o600 });
    await rename(replacementPath, stagePath);

    await expect(runtime.providerConnections.route(command)).rejects.toMatchObject({
      code: "credential.binding_mismatch",
    });
    await expect(runtime.storage.catalog.getProviderLifecycleOperation(command.commandId))
      .resolves.toMatchObject({ phase: "failed", failureCode: "credential.binding_mismatch" });
    await expect(runtime.storage.catalog.getProviderConnection("pconn_sameProcessStageSubstitution"))
      .resolves.toMatchObject({ lifecycleOwnerKind: null, lifecycleStatus: "unavailable" });
    await expect(new FileCredentialStore(roots.credentialRoot).listRefs()).resolves.toEqual([]);
    await expect(provisioner.readClaimedInternal(stagingInternalRef)).rejects.toMatchObject({
      code: "credential.stage_missing",
    });
  });

  it("acknowledges durable connection success when capability publication fails", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-post-commit-capabilities-"));
    homes.push(home);
    const stateRoot = `${home}-state`;
    homes.push(stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    const records: LogRecord[] = [];
    let failCapabilities = true;
    const runtime = new WiRuntime({
      homeDirectory: home,
      logger: new JsonLogger({ write: (record) => records.push(record) }),
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: (connection) => ({
          version: 1,
          connectionId: connection.connectionId,
          providerId: connection.providerId,
          authMode: connection.authMode,
          capabilitiesVersion: "capver_postCommit",
          models: [{
            modelId: "fixture-model",
            label: "Fixture model",
            reasoningEfforts: ["none"],
            reasoningSummary: false,
            tools: true,
            transports: ["no_network_fixture"],
          }],
          promptCaching: false,
          usage: false,
          opaqueState: false,
          compaction: false,
          retrievalSource: "server_fixture",
          retrievedAtMs: 1,
          status: "current",
        }),
        beforePostCommitMaintenance: (kind) => {
          if (kind === "capabilities" && failCapabilities) {
            throw new Error("injected post-commit capability failure");
          }
        },
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const environment = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_postCommitEnvironment",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Post-commit environment",
        variableName: "WI_MISSING_POST_COMMIT_KEY",
      },
    });
    const environmentConnectionId = String(
      (environment.result as { connectionId: string }).connectionId,
    );
    await expect(runtime.storage.catalog.getProviderConnection(environmentConnectionId))
      .resolves.toMatchObject({ lifecycleStatus: "unavailable" });

    const staged = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      "post-commit-file-secret",
    );
    const file = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_postCommitFile",
      method: "providerConnection.file.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Post-commit file",
        provisioningRef: staged.provisioningRef,
      },
    });
    const fileConnectionId = String((file.result as { connectionId: string }).connectionId);
    await expect(runtime.storage.catalog.getProviderConnection(fileConnectionId))
      .resolves.toMatchObject({ lifecycleStatus: "ready" });
    expect(records.filter((record) =>
      record.event === "provider_connection_maintenance_failed"
    )).toHaveLength(2);

    failCapabilities = false;
    await runtime.providerConnections.listSafeConnections();
    await expect(runtime.storage.catalog.getProviderCapabilities(environmentConnectionId))
      .resolves.toMatchObject({ capabilitiesVersion: "capver_postCommit" });
    await expect(runtime.storage.catalog.getProviderCapabilities(fileConnectionId))
      .resolves.toMatchObject({ capabilitiesVersion: "capver_postCommit" });
  });

  it("claims a staged file credential without exposing the secret in catalog views", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-file-runtime-"));
    homes.push(home);
    const stateRoot = `${home}-state`;
    homes.push(stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    const staged = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      "private-file-key",
    );
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: (connection) => ({
          version: 1,
          connectionId: connection.connectionId,
          providerId: connection.providerId,
          authMode: connection.authMode,
          capabilitiesVersion: "capver_file_fixture",
          models: [{
            modelId: "fixture-model",
            label: "Fixture model",
            reasoningEfforts: ["none"],
            reasoningSummary: false,
            tools: true,
            transports: ["no_network_fixture"],
          }],
          promptCaching: false,
          usage: false,
          opaqueState: false,
          compaction: false,
          retrievalSource: "server_fixture",
          retrievedAtMs: 1,
          status: "current",
        }),
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const result = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_fileCreate",
      method: "providerConnection.file.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "File account",
        provisioningRef: staged.provisioningRef,
      },
    }, "client_fixture");
    const connectionId = String((result.result as { connectionId: string }).connectionId);
    const listed = await runtime.storage.catalog.listProviderConnections();
    expect(listed.connections).toEqual([
      expect.objectContaining({ connectionId, credentialBackend: { kind: "file" }, lifecycleStatus: "ready" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("private-file-key");
    await expect(runtime.providerConnections.startRecoveryScan()).rejects.toMatchObject({
      code: "provider.connection_unavailable",
    });
    const refs = await new FileCredentialStore(roots.credentialRoot).listRefs();
    const internalConnection = await runtime.storage.catalog.getProviderConnection(connectionId);
    expect(refs).toContain(internalConnection?.credentialInternalRef);
    await expect(new CredentialProvisioner(roots.stagingRoot).read(
      staged.provisioningRef,
      { allowExpiredClaimed: true },
    )).rejects.toMatchObject({ code: "credential.stage_missing" });

    const replacement = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      "private-replacement-key",
    );
    await expect(runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_fileCreate",
      method: "providerConnection.file.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Changed file account",
        provisioningRef: replacement.provisioningRef,
      },
    }, "client_fixture")).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    let replaceEntered!: () => void;
    const replaceBlocked = new Promise<void>((resolve) => {
      replaceEntered = resolve;
    });
    let releaseReplace!: () => void;
    const replaceGate = new Promise<void>((resolve) => {
      releaseReplace = resolve;
    });
    const concurrentReplacement = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      "concurrent-replacement-key",
    );
    const originalReplaceBound = FileCredentialStore.prototype.replaceBound;
    vi.spyOn(FileCredentialStore.prototype, "replaceBound").mockImplementationOnce(
      async function (this: FileCredentialStore, ref, evidence, credential) {
        replaceEntered();
        await replaceGate;
        return originalReplaceBound.call(this, ref, evidence, credential);
      },
    );
    const replacePromise = runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_fileReplace",
      method: "providerConnection.file.replace",
      params: {
        connectionId,
        expectedLifecycleRevision: internalConnection!.lifecycleRevision,
        expectedGeneration: internalConnection!.credentialGeneration,
        provisioningRef: replacement.provisioningRef,
      },
    }, "client_fixture");
    await replaceBlocked;
    const conflictingDisable = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_disableDuringReplace",
      method: "providerConnection.disable" as const,
      params: {
        connectionId,
        expectedLifecycleRevision: internalConnection!.lifecycleRevision,
        expectedGeneration: internalConnection!.credentialGeneration,
      },
    };
    const conflictingCommands = [
      conflictingDisable,
      {
        ...conflictingDisable,
        commandId: "cmd_logoutDuringReplace",
        method: "providerConnection.logout" as const,
      },
      {
        ...conflictingDisable,
        commandId: "cmd_deleteDuringReplace",
        method: "providerConnection.delete" as const,
      },
      {
        v: 1 as const,
        kind: "command" as const,
        commandId: "cmd_secondReplaceDuringReplace",
        method: "providerConnection.file.replace" as const,
        params: {
          connectionId,
          expectedLifecycleRevision: internalConnection!.lifecycleRevision,
          expectedGeneration: internalConnection!.credentialGeneration,
          provisioningRef: concurrentReplacement.provisioningRef,
        },
      },
    ];
    for (const conflictingCommand of conflictingCommands) {
      await expect(runtime.commandRouter.route(
        conflictingCommand,
        "client_fixture",
      )).rejects.toMatchObject({ code: "provider.operation_in_progress" });
      await expect(runtime.storage.catalog.getProviderLifecycleOperation(
        conflictingCommand.commandId,
      )).resolves.toMatchObject({
        phase: "failed",
        failureCode: "provider.operation_in_progress",
      });
    }
    await expect(runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_renameDuringReplace",
      method: "providerConnection.rename",
      params: {
        connectionId,
        expectedMetadataRevision: internalConnection!.metadataRevision,
        displayName: "Renamed during replacement",
      },
    }, "client_fixture")).resolves.toMatchObject({ duplicate: false });
    releaseReplace();
    await replacePromise;
    for (const conflictingCommand of conflictingCommands) {
      await expect(runtime.commandRouter.route(
        conflictingCommand,
        "client_fixture",
      )).rejects.toMatchObject({ code: "provider.operation_in_progress" });
    }
    await expect(runtime.storage.catalog.getProviderConnection(connectionId)).resolves.toMatchObject({
      lifecycleStatus: "ready",
      lifecycleRevision: 2,
      credentialGeneration: 2,
    });

    const missingReplacement = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      "missing-replacement-key",
    );
    const missingReplacementRead = await new CredentialProvisioner(roots.stagingRoot)
      .readWithFileIdentity(
        missingReplacement.provisioningRef,
        { allowExpiredClaimed: false },
      );
    const missingReplacementMetadata = missingReplacementRead.credential;
    const missingReplacementCommand = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_missingFileReplace",
      method: "providerConnection.file.replace" as const,
      params: {
        connectionId,
        expectedLifecycleRevision: 2,
        expectedGeneration: 2,
        provisioningRef: missingReplacement.provisioningRef,
      },
    };
    const generationTwo = await runtime.storage.catalog.getProviderConnection(connectionId);
    await runtime.storage.catalog.prepareProviderLifecycle({
      commandId: missingReplacementCommand.commandId,
      commandMethod: missingReplacementCommand.method,
      contentHash: await canonicalJsonHash(missingReplacementCommand),
      operationKind: "replace",
      connectionId,
      expectedLifecycleRevision: 2,
      expectedGeneration: 2,
      credentialBackendKind: "file",
      credentialInternalRef: generationTwo!.credentialInternalRef,
      targetEnvelopeId: "envl_missingFileReplace",
      provisioningId: missingReplacementMetadata.provisioningId,
      stagingInternalRef: internalStagingRef(missingReplacement.provisioningRef),
      stagingFileIdentity: missingReplacementRead.fileIdentity,
      recoveryEpochId: null,
      expectedSafeMetadata: { previousEnvelopeId: generationTwo!.envelopeId },
      createdAtMs: 2,
    });
    await new CredentialProvisioner(roots.stagingRoot).deleteClaimedInternal(
      internalStagingRef(missingReplacement.provisioningRef),
    );
    await expect(runtime.commandRouter.route(
      missingReplacementCommand,
      "client_fixture",
    )).rejects.toMatchObject({ code: "credential.stage_missing" });
    await expect(runtime.storage.catalog.getProviderConnection(connectionId)).resolves.toMatchObject({
      lifecycleStatus: "ready",
      lifecycleRevision: 3,
      credentialGeneration: 2,
      lifecycleOwnerKind: null,
    });
    expect((await new FileCredentialStore(roots.credentialRoot).get(
      generationTwo!.credentialInternalRef!,
    ))?.metadata.generation).toBe(2);

    const restagedReplacement = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      "restaged-replacement-key",
    );
    await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_restagedFileReplace",
      method: "providerConnection.file.replace",
      params: {
        connectionId,
        expectedLifecycleRevision: 3,
        expectedGeneration: 2,
        provisioningRef: restagedReplacement.provisioningRef,
      },
    }, "client_fixture");
    await expect(runtime.storage.catalog.getProviderConnection(connectionId)).resolves.toMatchObject({
      lifecycleStatus: "ready",
      lifecycleRevision: 4,
      credentialGeneration: 3,
    });

    await expect(runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_fileReplace",
      method: "providerConnection.file.replace",
      params: {
        connectionId,
        expectedLifecycleRevision: internalConnection!.lifecycleRevision,
        expectedGeneration: internalConnection!.credentialGeneration,
        provisioningRef: staged.provisioningRef,
      },
    }, "client_fixture")).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    expect(JSON.stringify(await runtime.storage.catalog.listProviderConnections()))
      .not.toContain("private-replacement-key");

    const resolvedDefault = await runtime.providerConnections.resolveSessionDefault({
      v: 1,
      kind: "command",
      commandId: "cmd_resolveFileDefault",
      sessionId: "ses_resolveFileDefault",
      method: "session.providerDefault.set",
      params: { default: {
        version: 1,
        policy: { kind: "explicit", connectionId },
        modelId: "fixture-model",
        capabilitiesVersion: "capver_file_fixture",
        reasoning: { effort: "none", summary: "none" },
        transportMode: "no_network_fixture",
      } },
    });
    const selection = await runtime.providerConnections.snapshotForRun(
      resolvedDefault,
      "run_fileLease",
    );
    runtime.providerConnections.completeRunAcceptance("run_fileLease");
    const lease = await runtime.providerConnections.acquireCredentialRequestLease(
      "run_fileLease",
      selection,
    );
    expect(lease.withCredential((credential) =>
      credential?.type === "api_key" && credential.apiKey === "restaged-replacement-key"
    )).toBe(true);
    const replacedConnection = await runtime.storage.catalog.getProviderConnection(connectionId);
    await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_fileDisable",
      method: "providerConnection.disable",
      params: {
        connectionId,
        expectedLifecycleRevision: replacedConnection!.lifecycleRevision,
        expectedGeneration: replacedConnection!.credentialGeneration,
      },
    }, "client_fixture");
    await expect(runtime.providerConnections.acquireCredentialRequestLease(
      "run_fileLease",
      selection,
    )).rejects.toMatchObject({ code: "provider.connection_unavailable" });
    let providerCloseSettled = false;
    const providerClose = runtime.providerConnections.close(Date.now() + 1_000).finally(() => {
      providerCloseSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(providerCloseSettled).toBe(false);
    lease.release();
    await expect(providerClose).resolves.toBeUndefined();
    for (const path of await filesBelow(home)) {
      const bytes = await readFile(path);
      expect(bytes.includes(Buffer.from("private-file-key")), path).toBe(false);
      expect(bytes.includes(Buffer.from("private-replacement-key")), path).toBe(false);
    }
  });

  it("recovers an original file connection explicitly after complete catalog loss", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-recovery-runtime-"));
    homes.push(home);
    const stateRoot = `${home}-state`;
    homes.push(stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    const staged = await new CredentialProvisioner(roots.stagingRoot).stageApiKey(
      "openai_platform", "api_key", "private-recovery-key",
    );
    const credentialRoots = {
      credentialRoot: roots.credentialRoot,
      stagingRoot: roots.stagingRoot,
    };
    const first = new WiRuntime({ homeDirectory: home, credentialRoots });
    runtimes.push(first);
    await first.ready();
    const created = await first.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_recoveryOriginalCreate",
      method: "providerConnection.file.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Recoverable account",
        provisioningRef: staged.provisioningRef,
      },
    }, "client_fixture");
    const originalConnectionId = String((created.result as { connectionId: string }).connectionId);
    await new FileCredentialStore(roots.credentialRoot).put(
      "credref_secondRecovery",
      new StoredCredential({
        version: 1,
        envelopeId: "envl_secondRecovery",
        connectionId: "pconn_secondRecovery",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 5,
        updatedAtMs: 20,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: "private-second-recovery-key" },
      }),
    );
    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);
    await Promise.all([
      rm(join(home, "catalog.sqlite3"), { force: true }),
      rm(join(home, "catalog.sqlite3-wal"), { force: true }),
      rm(join(home, "catalog.sqlite3-shm"), { force: true }),
    ]);

    const recoveryMaintenanceRecords: LogRecord[] = [];
    let failRecoveryAvailability = true;
    const restarted = new WiRuntime({
      homeDirectory: home,
      credentialRoots,
      logger: new JsonLogger({ write: (record) => recoveryMaintenanceRecords.push(record) }),
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: () => null,
        beforePostCommitMaintenance: (kind) => {
          if (kind === "recovery_availability" && failRecoveryAvailability) {
            throw new Error("injected post-commit recovery availability failure");
          }
        },
      },
    });
    runtimes.push(restarted);
    await restarted.ready();
    const [scan, concurrentScan] = await Promise.all([
      restarted.providerConnections.startRecoveryScan(),
      restarted.providerConnections.startRecoveryScan(),
    ]);
    expect(concurrentScan.recoveryEpochId).toBe(scan.recoveryEpochId);
    const candidate = scan.candidates.find((entry) => entry.originalConnectionId === originalConnectionId)!;
    const expectedSafeMetadata = CredentialRecoveryExpectedSafeMetadataSchema.parse({
      expected: {
        providerId: candidate.providerId,
        authMode: candidate.authMode,
        originalConnectionId: candidate.originalConnectionId,
        generation: candidate.generation,
        identity: candidate.identity,
        updatedAtMs: candidate.updatedAtMs,
      },
      displayName: "Recovered account",
    });
    await expect(restarted.providerConnections.recoveryCommandStatus(
      "cmd_pendingRecovery",
      scan.recoveryEpochId,
      expectedSafeMetadata,
    )).resolves.toMatchObject({ status: "unobserved", connectionId: null });
    const recoverCommand = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_recoverOriginal",
      method: "providerConnection.recover" as const,
      params: {
        recoveryRef: candidate.recoveryRef,
        recoveryEpochId: scan.recoveryEpochId,
        expected: {
          providerId: "openai_platform" as const,
          authMode: "api_key" as const,
          originalConnectionId,
          generation: candidate.generation,
          identity: candidate.identity,
          updatedAtMs: candidate.updatedAtMs,
        },
        displayName: "Recovered account",
      },
    };
    await restarted.commandRouter.route(recoverCommand, "client_fixture");
    expect(recoveryMaintenanceRecords.some((record) =>
      record.event === "provider_connection_maintenance_failed"
    )).toBe(true);
    failRecoveryAvailability = false;
    await restarted.providerConnections.listSafeConnections();
    await expect(restarted.storage.catalog.getProviderCatalogState()).resolves.toMatchObject({
      recoveryActive: true,
    });
    await expect(restarted.providerConnections.recoveryCommandStatus(
      recoverCommand.commandId,
      scan.recoveryEpochId,
      expectedSafeMetadata,
    )).resolves.toMatchObject({
      status: "succeeded",
      connectionId: originalConnectionId,
      failureCode: null,
      expectedSafeMetadata: {
        expected: recoverCommand.params.expected,
        displayName: recoverCommand.params.displayName,
      },
    });
    await expect(restarted.providerConnections.recoveryCommandStatus(
      recoverCommand.commandId,
      scan.recoveryEpochId,
      { ...expectedSafeMetadata, displayName: "Wrong local metadata" },
    )).resolves.toMatchObject({
      status: "conflict",
      failureCode: "protocol.command_id_conflict",
    });
    await expect(restarted.commandRouter.route({
      ...recoverCommand,
      params: { ...recoverCommand.params, displayName: "Changed recovered account" },
    }, "client_fixture")).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    await expect(restarted.storage.catalog.getProviderConnection(originalConnectionId)).resolves.toMatchObject({
      connectionId: originalConnectionId,
      credentialGeneration: 1,
      lifecycleStatus: "ready",
      displayName: "Recovered account",
    });

    await restarted.close();
    runtimes.splice(runtimes.indexOf(restarted), 1);
    const resumed = new WiRuntime({ homeDirectory: home, credentialRoots });
    runtimes.push(resumed);
    await resumed.ready();
    const resumedScan = await resumed.providerConnections.startRecoveryScan();
    expect(resumedScan.candidates).toHaveLength(1);
    const secondCandidate = resumedScan.candidates[0]!;
    expect(secondCandidate.originalConnectionId).toBe("pconn_secondRecovery");
    await resumed.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_recoverSecondAfterRestart",
      method: "providerConnection.recover",
      params: {
        recoveryRef: secondCandidate.recoveryRef,
        recoveryEpochId: resumedScan.recoveryEpochId,
        expected: {
          providerId: secondCandidate.providerId,
          authMode: secondCandidate.authMode,
          originalConnectionId: secondCandidate.originalConnectionId,
          generation: secondCandidate.generation,
          identity: secondCandidate.identity,
          updatedAtMs: secondCandidate.updatedAtMs,
        },
        displayName: "Second recovered account",
      },
    }, "client_fixture");
    await expect(resumed.storage.catalog.getProviderCatalogState()).resolves.toMatchObject({
      recoveryActive: false,
    });
    await expect(resumed.providerConnections.startRecoveryScan()).rejects.toMatchObject({
      code: "provider.connection_unavailable",
    });
  });

  it("keeps not_accepted final after a recovery epoch closes", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-closed-recovery-"));
    const stateRoot = `${home}-state`;
    homes.push(home, stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    await new FileCredentialStore(roots.credentialRoot).put(
      "credref_closedRecovery",
      new StoredCredential({
        version: 1,
        envelopeId: "envl_closedRecovery",
        connectionId: "pconn_closedRecovery",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 2,
        updatedAtMs: 50,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: "closed-recovery-key" },
      }),
    );
    let now = 100;
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
      now: () => now,
    });
    runtimes.push(runtime);
    await runtime.ready();
    const scan = await runtime.providerConnections.startRecoveryScan();
    const candidate = scan.candidates[0]!;
    const commandId = "cmd_closedRecovery";
    const expectedSafeMetadata = CredentialRecoveryExpectedSafeMetadataSchema.parse({
      expected: {
        providerId: candidate.providerId,
        authMode: candidate.authMode,
        originalConnectionId: candidate.originalConnectionId,
        generation: candidate.generation,
        identity: candidate.identity,
        updatedAtMs: candidate.updatedAtMs,
      },
      displayName: "Closed recovery",
    });
    now = scan.expiresAtMs;
    await expect(runtime.providerConnections.recoveryCommandStatus(
      commandId,
      scan.recoveryEpochId,
      expectedSafeMetadata,
    )).resolves.toMatchObject({ status: "not_accepted" });
    await expect(runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId,
      method: "providerConnection.recover",
      params: {
        recoveryRef: candidate.recoveryRef,
        recoveryEpochId: scan.recoveryEpochId,
        expected: expectedSafeMetadata.expected,
        displayName: expectedSafeMetadata.displayName,
      },
    }, "client_fixture")).rejects.toMatchObject({ code: "credential.recovery_ref_expired" });
    await expect(runtime.storage.catalog.getProviderLifecycleOperation(commandId)).resolves.toBeNull();
  });

  it("keeps a claimed recovery verifier valid after public epoch expiry", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-recovery-epoch-claim-"));
    const stateRoot = `${home}-state`;
    homes.push(home, stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    await new FileCredentialStore(roots.credentialRoot).put(
      "credref_epochClaim",
      new StoredCredential({
        version: 1,
        envelopeId: "envl_epochClaim",
        connectionId: "pconn_epochClaim",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 7,
        updatedAtMs: 70,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: "epoch-claim-unchanged-key" },
      }),
    );
    let now = 100;
    let markPrepared!: () => void;
    let releasePrepared!: () => void;
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
    const prepareGate = new Promise<void>((resolve) => { releasePrepared = resolve; });
    let markObserved!: () => void;
    let releaseObserved!: () => void;
    const observed = new Promise<void>((resolve) => { markObserved = resolve; });
    const observedGate = new Promise<void>((resolve) => { releaseObserved = resolve; });
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
      now: () => now,
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: () => null,
        afterRecoveryPrepare: async (commandId) => {
          if (commandId !== "cmd_epochClaim") return;
          markPrepared();
          await prepareGate;
        },
        afterRecoveryFileObserved: async (commandId) => {
          if (commandId !== "cmd_epochClaim") return;
          markObserved();
          await observedGate;
        },
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const scan = await runtime.providerConnections.startRecoveryScan();
    const candidate = scan.candidates[0]!;
    const command = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_epochClaim",
      method: "providerConnection.recover" as const,
      params: {
        recoveryRef: candidate.recoveryRef,
        recoveryEpochId: scan.recoveryEpochId,
        expected: {
          providerId: candidate.providerId,
          authMode: candidate.authMode,
          originalConnectionId: candidate.originalConnectionId,
          generation: candidate.generation,
          identity: candidate.identity,
          updatedAtMs: candidate.updatedAtMs,
        },
        displayName: "Epoch claim",
      },
    };
    const recovery = runtime.providerConnections.route(command);
    await prepared;
    expect(await runtime.storage.catalog.getProviderLifecycleOperation(command.commandId))
      .toMatchObject({ phase: "prepared" });

    // Close the public epoch while the claimed verifier is still needed, then let final
    // verification continue. The replacement scan closes the old public scanner epoch.
    now = scan.expiresAtMs;
    await runtime.providerConnections.startRecoveryScan();
    releasePrepared();
    await observed;
    await expect(runtime.storage.catalog.getProviderLifecycleOperation(command.commandId))
      .resolves.toMatchObject({ phase: "file_observed" });
    releaseObserved();
    await expect(recovery).resolves.toMatchObject({ duplicate: false });
    await expect(runtime.storage.catalog.getProviderLifecycleOperation(command.commandId))
      .resolves.toMatchObject({ phase: "succeeded", failureCode: null });
    await expect(runtime.storage.catalog.getProviderConnection("pconn_epochClaim"))
      .resolves.toMatchObject({
        credentialGeneration: 7,
        lifecycleStatus: "ready",
        recoveryTombstone: false,
      });
    const retry = await runtime.providerConnections.route(command);
    expect(retry).toMatchObject({ duplicate: true, result: { connectionId: "pconn_epochClaim" } });
    await expect(new FileCredentialStore(roots.credentialRoot).get("credref_epochClaim"))
      .resolves.toMatchObject({ metadata: { connectionId: "pconn_epochClaim", generation: 7 } });
  });

  it("rechecks durable recovery after a stale absent status read", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-status-linearization-"));
    const stateRoot = `${home}-state`;
    homes.push(home, stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    await new FileCredentialStore(roots.credentialRoot).put(
      "credref_statusLinearization",
      new StoredCredential({
        version: 1,
        envelopeId: "envl_statusLinearization",
        connectionId: "pconn_statusLinearization",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 3,
        updatedAtMs: 30,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: "status-linearization-key" },
      }),
    );
    let now = 100;
    let markInitialLookup!: () => void;
    let releaseInitialLookup!: () => void;
    const initialLookup = new Promise<void>((resolve) => { markInitialLookup = resolve; });
    const initialLookupGate = new Promise<void>((resolve) => { releaseInitialLookup = resolve; });
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
      now: () => now,
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: () => null,
        afterRecoveryStatusInitialLookup: async () => {
          markInitialLookup();
          await initialLookupGate;
        },
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const scan = await runtime.providerConnections.startRecoveryScan();
    const candidate = scan.candidates[0]!;
    const command = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_statusLinearization",
      method: "providerConnection.recover" as const,
      params: {
        recoveryRef: candidate.recoveryRef,
        recoveryEpochId: scan.recoveryEpochId,
        expected: {
          providerId: candidate.providerId,
          authMode: candidate.authMode,
          originalConnectionId: candidate.originalConnectionId,
          generation: candidate.generation,
          identity: candidate.identity,
          updatedAtMs: candidate.updatedAtMs,
        },
        displayName: "Status linearization",
      },
    };
    const expected = CredentialRecoveryExpectedSafeMetadataSchema.parse({
      expected: command.params.expected,
      displayName: command.params.displayName,
    });
    const status = runtime.providerConnections.recoveryCommandStatus(
      command.commandId,
      scan.recoveryEpochId,
      expected,
    );
    await initialLookup;
    await runtime.commandRouter.route(command, "client_fixture");
    now = scan.expiresAtMs;
    releaseInitialLookup();
    await expect(status).resolves.toMatchObject({
      status: "succeeded",
      connectionId: "pconn_statusLinearization",
      failureCode: null,
    });
  });

  it("bounds aggregate concurrent recovery status reads", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-status-bound-"));
    homes.push(home);
    const runtime = new WiRuntime({ homeDirectory: home });
    runtimes.push(runtime);
    await runtime.ready();
    const expected = CredentialRecoveryExpectedSafeMetadataSchema.parse({
      expected: {
        providerId: "openai_platform",
        authMode: "api_key",
        originalConnectionId: "pconn_statusBound",
        generation: 1,
        identity: { status: "unverified" },
        updatedAtMs: 1,
      },
      displayName: "Status bound",
    });
    const statuses = await Promise.all(Array.from({ length: 40 }, (_value, index) =>
      runtime.providerConnections.recoveryCommandStatus(
        `cmd_statusBound${index}`,
        `recepoch_statusBound${index}`,
        expected,
      )
    ));
    expect(statuses.filter((status) => status.status === "rate_limited")).toHaveLength(8);
  });

  it("drains recovery scans and status reads before provider-service shutdown", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-recovery-drain-"));
    const stateHome = `${home}-state`;
    homes.push(home, stateHome);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateHome });
    await new FileCredentialStore(roots.credentialRoot).put(
      "credref_shutdownDrain",
      new StoredCredential({
        version: 1,
        envelopeId: "envl_shutdownDrain",
        connectionId: "pconn_shutdownDrain",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 1,
        updatedAtMs: 1,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: "shutdown-drain-secret" },
      }),
    );
    let markScanStarted!: () => void;
    let releaseScan!: () => void;
    const scanStarted = new Promise<void>((resolve) => { markScanStarted = resolve; });
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    let markStatusStarted!: () => void;
    let releaseStatus!: () => void;
    const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: () => null,
        beforeRecoveryScanPublication: async () => {
          markScanStarted();
          await scanGate;
        },
        beforeRecoveryStatusRead: async () => {
          markStatusStarted();
          await statusGate;
        },
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const scan = runtime.providerConnections.startRecoveryScan();
    const scanOutcome = scan.catch((error: unknown) => error);
    await scanStarted;
    const expected = CredentialRecoveryExpectedSafeMetadataSchema.parse({
      expected: {
        providerId: "openai_platform",
        authMode: "api_key",
        originalConnectionId: "pconn_shutdownDrain",
        generation: 1,
        identity: { status: "unverified" },
        updatedAtMs: 1,
      },
      displayName: "Shutdown drain",
    });
    const status = runtime.providerConnections.recoveryCommandStatus(
      "cmd_shutdownDrain",
      "recepoch_shutdownDrain",
      expected,
    );
    await statusStarted;
    let closeSettled = false;
    const close = runtime.providerConnections.close(Date.now() + 5_000).then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeSettled).toBe(false);
    releaseStatus();
    releaseScan();
    await expect(status).resolves.toMatchObject({ commandId: "cmd_shutdownDrain" });
    await expect(scanOutcome).resolves.toMatchObject({ code: "server.shutting_down" });
    await close;
    expect(closeSettled).toBe(true);
    await expect(runtime.providerConnections.startRecoveryScan()).rejects.toMatchObject({
      code: "server.shutting_down",
    });
    await expect(runtime.providerConnections.recoveryCommandStatus(
      "cmd_shutdownDrainLater",
      "recepoch_shutdownDrainLater",
      expected,
    )).rejects.toMatchObject({ code: "server.shutting_down" });
  });

  it("reloads the complete durable inventory after a restart mutation before first list", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-cache-restart-"));
    homes.push(home);
    const first = new WiRuntime({ homeDirectory: home });
    runtimes.push(first);
    await first.ready();
    const firstResult = await first.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_cacheFirst",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "First",
        variableName: "WI_CACHE_FIRST",
      },
    });
    await first.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_cacheSecond",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Second",
        variableName: "WI_CACHE_SECOND",
      },
    });
    const firstConnectionId = String(
      (firstResult.result as { readonly connectionId: string }).connectionId,
    );
    await first.close();

    const restarted = new WiRuntime({ homeDirectory: home });
    runtimes.push(restarted);
    await restarted.ready();
    const connection = await restarted.storage.catalog.getProviderConnection(firstConnectionId);
    await restarted.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_cacheRename",
      method: "providerConnection.rename",
      params: {
        connectionId: firstConnectionId,
        expectedMetadataRevision: connection!.metadataRevision,
        displayName: "Renamed first",
      },
    });

    await expect(restarted.providerConnections.recoveryCommandStatus(
      "cmd_cacheRename",
      "recepoch_crossLedgerStatus",
      CredentialRecoveryExpectedSafeMetadataSchema.parse({
        expected: {
          providerId: "openai_platform",
          authMode: "api_key",
          originalConnectionId: firstConnectionId,
          generation: 1,
          identity: { status: "unverified" },
          updatedAtMs: 1,
        },
        displayName: "Cross-ledger probe",
      }),
    )).resolves.toMatchObject({ status: "conflict" });

    const listed = await restarted.providerConnections.listSafeConnections();
    expect(listed.connections).toHaveLength(2);
    expect(listed.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ displayName: "Renamed first" }),
      expect.objectContaining({ displayName: "Second" }),
    ]));
  });

  it("preserves distinct recovery conflicts across rejection, retry, and status", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-recovery-conflicts-"));
    const stateRoot = `${home}-state`;
    homes.push(home, stateRoot);
    const roots = await initializeCredentialRoots({ wiHome: home, xdgStateHome: stateRoot });
    const store = new FileCredentialStore(roots.credentialRoot);
    const authoritativeIdentity = {
      status: "authoritative" as const,
      subjectId: "subject-runtime-recovery-conflict",
      workspace: { presence: "none" as const },
    };
    for (const [internalRef, envelope] of [
      ["credref_runtimeOccupied", {
        envelopeId: "envl_runtimeOccupied",
        connectionId: "pconn_runtimeOccupied",
        identity: { status: "unverified" as const },
        apiKey: "occupied-recovery-secret",
      }],
      ["credref_runtimeIdentity", {
        envelopeId: "envl_runtimeIdentity",
        connectionId: "pconn_runtimeIdentity",
        identity: authoritativeIdentity,
        apiKey: "identity-recovery-secret",
      }],
      ["credref_runtimeClaimed", {
        envelopeId: "envl_runtimeClaimed",
        connectionId: "pconn_runtimeClaimed",
        identity: { status: "unverified" as const },
        apiKey: "claimed-recovery-secret",
      }],
    ] as const) {
      await store.put(internalRef, new StoredCredential({
        version: 1,
        envelopeId: envelope.envelopeId,
        connectionId: envelope.connectionId,
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 1,
        updatedAtMs: 10,
        identity: envelope.identity,
        credential: { type: "api_key", apiKey: envelope.apiKey },
      }));
    }
    const runtime = new WiRuntime({
      homeDirectory: home,
      credentialRoots: {
        credentialRoot: roots.credentialRoot,
        stagingRoot: roots.stagingRoot,
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const scan = await runtime.providerConnections.startRecoveryScan();
    const candidate = (connectionId: string) =>
      scan.candidates.find((entry) => entry.originalConnectionId === connectionId)!;
    const command = (
      commandId: string,
      connectionId: string,
      displayName: string,
    ) => {
      const selected = candidate(connectionId);
      return {
        v: 1 as const,
        kind: "command" as const,
        commandId,
        method: "providerConnection.recover" as const,
        params: {
          recoveryRef: selected.recoveryRef,
          recoveryEpochId: scan.recoveryEpochId,
          expected: {
            providerId: selected.providerId,
            authMode: selected.authMode,
            originalConnectionId: selected.originalConnectionId,
            generation: selected.generation,
            identity: selected.identity,
            updatedAtMs: selected.updatedAtMs,
          },
          displayName,
        },
      };
    };
    const expectedStatus = (recoveryCommand: ReturnType<typeof command>) =>
      CredentialRecoveryExpectedSafeMetadataSchema.parse({
        expected: recoveryCommand.params.expected,
        displayName: recoveryCommand.params.displayName,
      });

    await runtime.storage.catalog.registerEnvironmentConnection({
      commandId: "cmd_runtimeOccupiedOwner",
      contentHash: "a".repeat(64),
      connectionId: "pconn_runtimeOccupied",
      providerId: "openai_platform",
      authMode: "api_key",
      displayName: "Occupied owner",
      variableName: "WI_RUNTIME_OCCUPIED",
      identity: { status: "unverified" },
      identityClaim: null,
      initialStatus: "unavailable",
      createdAtMs: 20,
    });
    const occupied = command(
      "cmd_runtimeRecoveryConnectionConflict",
      "pconn_runtimeOccupied",
      "Occupied recovery",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(runtime.commandRouter.route(occupied, "client_fixture")).rejects.toMatchObject({
        code: "credential.recovery_connection_conflict",
      });
    }
    await expect(runtime.providerConnections.recoveryCommandStatus(
      occupied.commandId,
      scan.recoveryEpochId,
      expectedStatus(occupied),
    )).resolves.toMatchObject({
      status: "failed",
      failureCode: "credential.recovery_connection_conflict",
    });

    const identityKey = authoritativeProviderIdentityKey(
      "openai_platform",
      "api_key",
      authoritativeIdentity,
    );
    await runtime.storage.catalog.registerEnvironmentConnection({
      commandId: "cmd_runtimeIdentityOwner",
      contentHash: "b".repeat(64),
      connectionId: "pconn_runtimeIdentityOwner",
      providerId: "openai_platform",
      authMode: "api_key",
      displayName: "Identity owner",
      variableName: "WI_RUNTIME_IDENTITY",
      identity: authoritativeIdentity,
      identityClaim: {
        identityKey,
        stableKind: "subject",
        stableValue: authoritativeIdentity.subjectId,
        workspacePresence: "none",
        workspaceValue: "",
      },
      initialStatus: "unavailable",
      createdAtMs: 21,
    });
    const identity = command(
      "cmd_runtimeRecoveryIdentityConflict",
      "pconn_runtimeIdentity",
      "Identity recovery",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(runtime.commandRouter.route(identity, "client_fixture")).rejects.toMatchObject({
        code: "credential.recovery_identity_conflict",
      });
    }
    await expect(runtime.providerConnections.recoveryCommandStatus(
      identity.commandId,
      scan.recoveryEpochId,
      expectedStatus(identity),
    )).resolves.toMatchObject({
      status: "failed",
      failureCode: "credential.recovery_identity_conflict",
    });

    const firstClaim = command(
      "cmd_runtimeRecoveryFirstClaim",
      "pconn_runtimeClaimed",
      "First claim",
    );
    const alreadyClaimed = command(
      "cmd_runtimeRecoverySecondClaim",
      "pconn_runtimeClaimed",
      "Second claim",
    );
    const originalListRefs = FileCredentialStore.prototype.listRefs;
    let markClaimScanStarted!: () => void;
    let releaseClaimScan!: () => void;
    const claimScanStarted = new Promise<void>((resolve) => { markClaimScanStarted = resolve; });
    const claimScanGate = new Promise<void>((resolve) => { releaseClaimScan = resolve; });
    let gateClaimScan = true;
    vi.spyOn(FileCredentialStore.prototype, "listRefs").mockImplementation(async function (
      this: FileCredentialStore,
    ) {
      if (gateClaimScan) {
        gateClaimScan = false;
        markClaimScanStarted();
        await claimScanGate;
      }
      return originalListRefs.call(this);
    });
    const firstClaimResult = runtime.commandRouter.route(firstClaim, "client_fixture");
    await claimScanStarted;
    await expect(runtime.commandRouter.route(alreadyClaimed, "client_fixture"))
      .rejects.toMatchObject({ code: "credential.recovery_already_claimed" });
    await expect(runtime.commandRouter.route(alreadyClaimed, "client_fixture"))
      .rejects.toMatchObject({ code: "credential.recovery_already_claimed" });
    await expect(runtime.providerConnections.recoveryCommandStatus(
      alreadyClaimed.commandId,
      scan.recoveryEpochId,
      expectedStatus(alreadyClaimed),
    )).resolves.toMatchObject({
      status: "failed",
      failureCode: "credential.recovery_already_claimed",
    });
    releaseClaimScan();
    await expect(firstClaimResult).resolves.toMatchObject({ duplicate: false });
    await expect(runtime.commandRouter.route(alreadyClaimed, "client_fixture"))
      .rejects.toMatchObject({ code: "credential.recovery_already_claimed" });
  });

  it("rejects run acceptance when disable commits during preliminary selection", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    process.env.WI_ACCEPTANCE_RACE_KEY = "acceptance-race-secret";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-acceptance-race-"));
    homes.push(home);
    const runtime = new WiRuntime({
      homeDirectory: home,
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: (connection) => ({
          version: 1,
          connectionId: connection.connectionId,
          providerId: connection.providerId,
          authMode: connection.authMode,
          capabilitiesVersion: "capver_acceptance_race",
          models: [{
            modelId: "fixture-model",
            label: "Fixture model",
            reasoningEfforts: ["none"],
            reasoningSummary: false,
            tools: true,
            transports: ["no_network_fixture"],
          }],
          promptCaching: false,
          usage: false,
          opaqueState: false,
          compaction: false,
          retrievalSource: "server_fixture",
          retrievedAtMs: 1,
          status: "current",
        }),
      },
    });
    runtimes.push(runtime);
    await runtime.ready();
    const createdConnection = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_acceptanceRaceConnection",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Acceptance race",
        variableName: "WI_ACCEPTANCE_RACE_KEY",
      },
    }, "client_fixture");
    const connectionId = String(
      (createdConnection.result as { readonly connectionId: string }).connectionId,
    );
    const createdSession = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_acceptanceRaceSession",
      method: "session.create",
      params: {},
    }, "client_fixture");
    const sessionId = createdSession.sessionId!;
    await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_acceptanceRaceDefault",
      sessionId,
      method: "session.providerDefault.set",
      params: { default: {
        version: 1,
        policy: { kind: "explicit", connectionId },
        modelId: "fixture-model",
        capabilitiesVersion: "capver_acceptance_race",
        reasoning: { effort: "none", summary: "none" },
        transportMode: "no_network_fixture",
      } },
    }, "client_fixture");

    const originalGetCapabilities = runtime.storage.catalog.getProviderCapabilities.bind(
      runtime.storage.catalog,
    );
    let releaseCapabilities!: () => void;
    const capabilitiesGate = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });
    let signalCapabilitiesRead!: () => void;
    const capabilitiesRead = new Promise<void>((resolve) => {
      signalCapabilitiesRead = resolve;
    });
    let gated = false;
    vi.spyOn(runtime.storage.catalog, "getProviderCapabilities").mockImplementation(async (id) => {
      const capabilities = await originalGetCapabilities(id);
      if (!gated) {
        gated = true;
        signalCapabilitiesRead();
        await capabilitiesGate;
      }
      return capabilities;
    });
    const submit = runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_acceptanceRaceSubmit",
      sessionId,
      method: "message.submit",
      params: { text: "must not commit after disable" },
    }, "client_fixture");
    await capabilitiesRead;
    await expect(runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_acceptanceRaceDisable",
      method: "providerConnection.disable",
      params: { connectionId, expectedLifecycleRevision: 1, expectedGeneration: 1 },
    }, "client_fixture")).resolves.toMatchObject({ duplicate: false });
    releaseCapabilities();
    await expect(submit).rejects.toMatchObject({ code: "provider.connection_unavailable" });
    const session = await runtime.storage.openSession(sessionId);
    await expect(session.getAcceptedCommand("cmd_acceptanceRaceSubmit")).resolves.toBeNull();
    await expect(session.getNonterminalRuns()).resolves.toEqual([]);
  });

  it("restores an environment connection that started unavailable after its value returns", async () => {
    delete process.env.WI_REVALIDATE_INITIAL_KEY;
    const home = await mkdtemp(join(tmpdir(), "wi-provider-environment-revalidate-initial-"));
    homes.push(home);
    const runtime = new WiRuntime({ homeDirectory: home });
    runtimes.push(runtime);
    await runtime.ready();

    const created = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateInitialCreate",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Initially unavailable",
        variableName: "WI_REVALIDATE_INITIAL_KEY",
      },
    });
    const connectionId = String((created.result as { readonly connectionId: string }).connectionId);
    await expect(runtime.storage.catalog.getProviderConnection(connectionId)).resolves.toMatchObject({
      lifecycleStatus: "unavailable",
      credentialGeneration: 1,
      lifecycleRevision: 1,
    });

    process.env.WI_REVALIDATE_INITIAL_KEY = "restored-initial-value";
    const revalidate = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_revalidateInitial",
      method: "providerConnection.environment.revalidate" as const,
      params: {
        connectionId,
        expectedLifecycleRevision: 1,
        expectedGeneration: 1,
      },
    };
    await expect(runtime.providerConnections.route(revalidate)).resolves.toMatchObject({
      duplicate: false,
      result: { connectionId },
    });
    await expect(runtime.storage.catalog.getProviderConnection(connectionId)).resolves.toMatchObject({
      lifecycleStatus: "ready",
      credentialGeneration: 1,
      lifecycleRevision: 2,
    });
    await expect(runtime.providerConnections.route(revalidate)).resolves.toMatchObject({
      duplicate: true,
      result: { connectionId },
    });
    await expect(runtime.providerConnections.route({
      ...revalidate,
      params: { ...revalidate.params, expectedGeneration: 2 },
    })).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    const secret = "restored-initial-value";
    expect(JSON.stringify(await runtime.storage.catalog.getProviderLifecycleOperation(
      revalidate.commandId,
    ))).not.toContain(secret);
    for (const path of await filesBelow(home)) {
      expect((await readFile(path)).includes(Buffer.from(secret))).toBe(false);
    }
  });

  it("restores the same environment connection after request invalidation", async () => {
    process.env.WI_REVALIDATE_CHANGED_KEY = "original-revalidate-value";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-environment-revalidate-request-"));
    homes.push(home);
    const runtime = new WiRuntime({ homeDirectory: home });
    runtimes.push(runtime);
    await runtime.ready();

    const created = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateChangedCreate",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Invalidated environment",
        variableName: "WI_REVALIDATE_CHANGED_KEY",
      },
    });
    const connectionId = String((created.result as { readonly connectionId: string }).connectionId);
    const connection = await runtime.storage.catalog.getProviderConnection(connectionId);
    expect(connection).not.toBeNull();
    await runtime.storage.catalog.markEnvironmentConnectionUnavailable({
      connectionId,
      expectedGeneration: connection!.credentialGeneration,
      expectedLifecycleRevision: connection!.lifecycleRevision,
      updatedAtMs: Date.now(),
    });
    process.env.WI_REVALIDATE_CHANGED_KEY = "restored-revalidate-value";

    const revalidate = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_revalidateChanged",
      method: "providerConnection.environment.revalidate" as const,
      params: {
        connectionId,
        expectedLifecycleRevision: connection!.lifecycleRevision + 1,
        expectedGeneration: connection!.credentialGeneration,
      },
    };
    await expect(runtime.providerConnections.route(revalidate)).resolves.toMatchObject({
      duplicate: false,
      result: { connectionId },
    });
    await expect(runtime.storage.catalog.getProviderConnection(connectionId)).resolves.toMatchObject({
      lifecycleStatus: "ready",
      credentialGeneration: connection!.credentialGeneration,
      lifecycleRevision: connection!.lifecycleRevision + 2,
    });
  });

  it("rejects environment revalidation for invalid states and lifecycle conflicts", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    delete process.env.WI_REVALIDATE_INITIAL_KEY;
    const home = await mkdtemp(join(tmpdir(), "wi-provider-environment-revalidate-states-"));
    homes.push(home);
    let markPrepared!: () => void;
    let releasePrepared!: () => void;
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
    const prepareGate = new Promise<void>((resolve) => { releasePrepared = resolve; });
    const runtime = new WiRuntime({
      homeDirectory: home,
      providerConnectionFixture: {
        provider: new FakeProviderAdapter({ id: "openai_platform" }),
        capabilitiesForConnection: () => null,
        afterLifecyclePrepare: async (kind) => {
          if (kind !== "enable") return;
          markPrepared();
          await prepareGate;
        },
      },
    });
    runtimes.push(runtime);
    await runtime.ready();

    process.env.WI_REVALIDATE_INITIAL_KEY = "ready-environment-value";
    const readyResult = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateReadyCreate",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Ready environment",
        variableName: "WI_REVALIDATE_INITIAL_KEY",
      },
    });
    const readyConnectionId = String((readyResult.result as { readonly connectionId: string }).connectionId);
    await expect(runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateReady",
      method: "providerConnection.environment.revalidate" as const,
      params: { connectionId: readyConnectionId, expectedLifecycleRevision: 1, expectedGeneration: 1 },
    })).rejects.toMatchObject({ code: "provider.connection_unavailable" });
    await expect(runtime.storage.catalog.getProviderLifecycleOperation("cmd_revalidateReady"))
      .resolves.toBeNull();

    const disabled = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateDisabledCreate",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Disabled environment",
        variableName: "WI_REVALIDATE_INITIAL_KEY",
      },
    });
    const disabledConnectionId = String((disabled.result as { readonly connectionId: string }).connectionId);
    await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateDelete",
      method: "providerConnection.delete",
      params: { connectionId: disabledConnectionId, expectedLifecycleRevision: 1, expectedGeneration: 1 },
    });
    await expect(runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateDeletedState",
      method: "providerConnection.environment.revalidate" as const,
      params: { connectionId: disabledConnectionId, expectedLifecycleRevision: 2, expectedGeneration: 1 },
    })).rejects.toMatchObject({ code: "provider.connection_unavailable" });

    const unavailable = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateWrongRevisionCreate",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Unavailable environment",
        variableName: "WI_REVALIDATE_INITIAL_KEY",
      },
    });
    const unavailableConnectionId = String((unavailable.result as { readonly connectionId: string }).connectionId);
    await runtime.storage.catalog.markEnvironmentConnectionUnavailable({
      connectionId: unavailableConnectionId,
      expectedGeneration: 1,
      expectedLifecycleRevision: 1,
      updatedAtMs: Date.now(),
    });
    delete process.env.WI_REVALIDATE_INITIAL_KEY;
    await expect(runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateMissingValue",
      method: "providerConnection.environment.revalidate" as const,
      params: { connectionId: unavailableConnectionId, expectedLifecycleRevision: 2, expectedGeneration: 1 },
    })).rejects.toMatchObject({ code: "credential.environment_missing" });
    await expect(runtime.storage.catalog.getProviderConnection(unavailableConnectionId))
      .resolves.toMatchObject({ lifecycleStatus: "unavailable", lifecycleRevision: 2, credentialGeneration: 1 });
    process.env.WI_REVALIDATE_INITIAL_KEY = "a".repeat(16_385);
    await expect(runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateOversizedValue",
      method: "providerConnection.environment.revalidate" as const,
      params: { connectionId: unavailableConnectionId, expectedLifecycleRevision: 2, expectedGeneration: 1 },
    })).rejects.toMatchObject({ code: "credential.environment_invalid" });
    await expect(runtime.storage.catalog.getProviderConnection(unavailableConnectionId))
      .resolves.toMatchObject({ lifecycleStatus: "unavailable", lifecycleRevision: 2, credentialGeneration: 1 });
    process.env.WI_REVALIDATE_INITIAL_KEY = "ready-after-invalid-values";
    await expect(runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateWrongRevision",
      method: "providerConnection.environment.revalidate" as const,
      params: { connectionId: unavailableConnectionId, expectedLifecycleRevision: 1, expectedGeneration: 1 },
    })).rejects.toMatchObject({ code: "provider.stale_revision" });

    delete process.env.WI_REVALIDATE_INITIAL_KEY;
    const conflict = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateConflictCreate",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Conflict environment",
        variableName: "WI_REVALIDATE_INITIAL_KEY",
      },
    });
    const conflictConnectionId = String((conflict.result as { readonly connectionId: string }).connectionId);
    process.env.WI_REVALIDATE_INITIAL_KEY = "conflict-restored-value";
    const revalidate = runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateConflict",
      method: "providerConnection.environment.revalidate" as const,
      params: { connectionId: conflictConnectionId, expectedLifecycleRevision: 1, expectedGeneration: 1 },
    });
    await prepared;
    await expect(runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_disableDuringRevalidate",
      method: "providerConnection.disable",
      params: { connectionId: conflictConnectionId, expectedLifecycleRevision: 1, expectedGeneration: 1 },
    })).rejects.toMatchObject({ code: "provider.operation_in_progress" });
    await expect(runtime.storage.catalog.getProviderLifecycleOperation("cmd_disableDuringRevalidate"))
      .resolves.toMatchObject({ phase: "failed", failureCode: "provider.operation_in_progress" });
    releasePrepared();
    await expect(revalidate).resolves.toMatchObject({ duplicate: false, result: { connectionId: conflictConnectionId } });
    await expect(runtime.storage.catalog.getProviderConnection(conflictConnectionId)).resolves.toMatchObject({
      lifecycleStatus: "ready",
      lifecycleRevision: 2,
      credentialGeneration: 1,
    });
    expect(runtime.provider.requests).toHaveLength(0);
  });

  it("pins an explicit environment connection snapshot before acknowledgement", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    process.env.WI_TEST_PROVIDER_KEY = "private-test-value";
    const home = await mkdtemp(join(tmpdir(), "wi-provider-runtime-"));
    homes.push(home);
    const issuedCredentialMatches: boolean[] = [];
    let expectedIssuedCredential = "private-test-value";
    let mutateEnvironmentAfterIssue: string | null = null;
    const selectedProvider = new FakeProviderAdapter({
      id: "openai_platform",
      onCredential: (credential) => {
        issuedCredentialMatches.push(
          credential?.type === "api_key" && credential.apiKey === expectedIssuedCredential,
        );
        if (mutateEnvironmentAfterIssue !== null) {
          process.env[mutateEnvironmentAfterIssue] = "second-value";
          mutateEnvironmentAfterIssue = null;
        }
      },
    });
    const runtime = new WiRuntime({
      homeDirectory: home,
      providerConnectionFixture: {
        provider: selectedProvider,
        providerConfiguration: { scenario: "echo-tool-round-trip", roundTripTool: "echo" },
        capabilitiesForConnection: (connection) => ({
          version: 1,
          connectionId: connection.connectionId,
          providerId: connection.providerId,
          authMode: connection.authMode,
          capabilitiesVersion: "capver_fixture",
          models: [{
            modelId: "fixture-model",
            label: "Fixture model",
            reasoningEfforts: ["none"],
            reasoningSummary: false,
            tools: true,
            transports: ["no_network_fixture"],
          }],
          promptCaching: false,
          usage: false,
          opaqueState: false,
          compaction: false,
          retrievalSource: "server_fixture",
          retrievedAtMs: 1,
          status: "current",
        }),
      },
    });
    runtimes.push(runtime);
    await runtime.ready();

    const connection = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_environmentCreate",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Fixture account",
        variableName: "WI_TEST_PROVIDER_KEY",
      },
    }, "client_fixture");
    const connectionId = String((connection.result as { connectionId: string }).connectionId);
    await expect(runtime.storage.catalog.listProviderConnections()).resolves.toMatchObject({
      connections: [expect.objectContaining({ connectionId })],
    });
    await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_missingEnvironmentCreate",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Missing environment",
        variableName: "WI_MISSING_PROVIDER_KEY",
      },
    }, "client_fixture");
    await expect(runtime.storage.catalog.listProviderConnections()).resolves.toMatchObject({
      connections: expect.arrayContaining([
        expect.objectContaining({ displayName: "Missing environment", lifecycleStatus: "unavailable" }),
      ]),
    });
    const created = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_sessionCreate",
      method: "session.create",
      params: {},
    }, "client_fixture");
    const sessionId = created.sessionId!;
    await expect(runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_staleDefaultSet",
      sessionId,
      method: "session.providerDefault.set",
      params: { default: {
        version: 1,
        policy: { kind: "explicit", connectionId },
        modelId: "fixture-model",
        capabilitiesVersion: "capver_stale",
        reasoning: { effort: "none", summary: "none" },
        transportMode: "no_network_fixture",
      } },
    }, "client_fixture")).rejects.toMatchObject({ code: "provider.capabilities_unavailable" });
    const boundedListSpy = vi.spyOn(
      runtime.storage.catalog,
      "listProviderConnections",
    ).mockRejectedValue(new Error("Exact selection must not depend on the bounded list"));
    await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_defaultSet",
      sessionId,
      method: "session.providerDefault.set",
      params: { default: {
        version: 1,
        policy: { kind: "explicit", connectionId },
        modelId: "fixture-model",
        capabilitiesVersion: "capver_fixture",
        reasoning: { effort: "none", summary: "none" },
        transportMode: "no_network_fixture",
      } },
    }, "client_fixture");
    expect(boundedListSpy).not.toHaveBeenCalled();
    boundedListSpy.mockRestore();
    const storedDefault = await (await runtime.storage.openSession(sessionId)).getProviderDefault();
    expect(storedDefault?.default).toMatchObject({
      promptVersion: "wi-v1",
      toolSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(storedDefault?.default.toolSchemaHash).not.toBe("a".repeat(64));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Milestone 11 must not issue outbound requests"),
    );
    const submitted = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_selectedSubmit",
      sessionId,
      method: "message.submit",
      params: { text: "selected connection" },
    }, "client_fixture");
    const runId = submitted.runId!;
    const run = await waitForTerminal(runtime, sessionId, runId);
    expect(run).toMatchObject({
      state: "completed",
      providerId: "openai_platform",
      providerSelection: {
        connectionId,
        credentialGeneration: 1,
        lifecycleRevision: 1,
        providerId: "openai_platform",
        credentialBackend: { kind: "environment" },
        promptVersion: storedDefault!.default.promptVersion,
        toolSchemaHash: storedDefault!.default.toolSchemaHash,
        providerChainId: expect.stringMatching(/^pchain_/u),
      },
    });
    expect(selectedProvider.requests).toHaveLength(2);
    expect(issuedCredentialMatches).toEqual([true, true]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runtime.providerConnections.getEnvironmentLease(runId)).toBeNull();

    await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_disableSelected",
      method: "providerConnection.disable",
      params: {
        connectionId,
        expectedLifecycleRevision: 1,
        expectedGeneration: 1,
      },
    }, "client_fixture");
    await expect(runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_defaultSet",
      sessionId,
      method: "session.providerDefault.set",
      params: { default: {
        version: 1,
        policy: { kind: "explicit", connectionId },
        modelId: "fixture-model",
        capabilitiesVersion: "capver_fixture",
        reasoning: { effort: "none", summary: "none" },
        transportMode: "no_network_fixture",
      } },
    }, "client_fixture")).resolves.toMatchObject({ duplicate: true });
    let issuedAfterDisable = false;
    await expect(runtime.providerConnections.withEnvironmentCredentialForRequest(
      runId,
      run.providerSelection ?? null,
      () => {
        issuedAfterDisable = true;
      },
    )).rejects.toMatchObject({ code: "provider.connection_unavailable" });
    expect(issuedAfterDisable).toBe(false);

    process.env.WI_CHANGED_PROVIDER_KEY = "first-value";
    const changedResult = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_changedEnvironment",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Changed environment",
        variableName: "WI_CHANGED_PROVIDER_KEY",
      },
    });
    const changedConnectionId = String(
      (changedResult.result as { readonly connectionId: string }).connectionId,
    );
    const changedSession = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_changedEnvironmentSessionCreate",
      method: "session.create",
      params: {},
    }, "client_fixture");
    const changedSessionId = changedSession.sessionId!;
    await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_changedEnvironmentDefault",
      sessionId: changedSessionId,
      method: "session.providerDefault.set",
      params: { default: {
        version: 1,
        policy: { kind: "explicit", connectionId: changedConnectionId },
        modelId: "fixture-model",
        capabilitiesVersion: "capver_fixture",
        reasoning: { effort: "none", summary: "none" },
        transportMode: "no_network_fixture",
      } },
    }, "client_fixture");
    expectedIssuedCredential = "first-value";
    mutateEnvironmentAfterIssue = "WI_CHANGED_PROVIDER_KEY";
    const changedSubmission = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_changedEnvironmentSubmit",
      sessionId: changedSessionId,
      method: "message.submit",
      params: { text: "change environment after the first provider step" },
    }, "client_fixture");
    const changedRun = await waitForTerminal(
      runtime,
      changedSessionId,
      changedSubmission.runId!,
    );
    expect(changedRun.state).toBe("failed");
    expect(selectedProvider.requests).toHaveLength(3);
    expect(issuedCredentialMatches).toEqual([true, true, true]);
    await expect(runtime.storage.catalog.getProviderConnection(changedConnectionId))
      .resolves.toMatchObject({ lifecycleStatus: "unavailable", lifecycleRevision: 2 });
    process.env.WI_CHANGED_PROVIDER_KEY = "first-value";
    await expect(runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateAfterToolResult",
      method: "providerConnection.environment.revalidate" as const,
      params: {
        connectionId: changedConnectionId,
        expectedLifecycleRevision: 2,
        expectedGeneration: 1,
      },
    })).resolves.toMatchObject({
      duplicate: false,
      result: { connectionId: changedConnectionId },
    });
    await expect(runtime.storage.catalog.getProviderConnection(changedConnectionId))
      .resolves.toMatchObject({ lifecycleStatus: "ready", lifecycleRevision: 3, credentialGeneration: 1 });

    process.env.WI_CHANGED_PROVIDER_KEY = "a".repeat(16_385);
    const oversizedResult = await runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_oversizedEnvironment",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Oversized environment",
        variableName: "WI_CHANGED_PROVIDER_KEY",
      },
    });
    const oversizedConnectionId = String(
      (oversizedResult.result as { readonly connectionId: string }).connectionId,
    );
    const oversizedSession = await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_oversizedEnvironmentSession",
      method: "session.create",
      params: {},
    }, "client_fixture");
    await runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_oversizedEnvironmentDefault",
      sessionId: oversizedSession.sessionId!,
      method: "session.providerDefault.set",
      params: { default: {
        version: 1,
        policy: { kind: "explicit", connectionId: oversizedConnectionId },
        modelId: "fixture-model",
        capabilitiesVersion: "capver_fixture",
        reasoning: { effort: "none", summary: "none" },
        transportMode: "no_network_fixture",
      } },
    }, "client_fixture");
    await expect(runtime.commandRouter.route({
      v: 1,
      kind: "command",
      commandId: "cmd_oversizedEnvironmentSubmit",
      sessionId: oversizedSession.sessionId!,
      method: "message.submit",
      params: { text: "reject oversized environment before acceptance" },
    }, "client_fixture")).rejects.toMatchObject({ code: "credential.environment_invalid" });
    await expect(runtime.storage.catalog.getProviderConnection(oversizedConnectionId))
      .resolves.toMatchObject({ lifecycleStatus: "unavailable", lifecycleRevision: 2 });
    process.env.WI_CHANGED_PROVIDER_KEY = "restored-after-oversized";
    await expect(runtime.providerConnections.route({
      v: 1,
      kind: "command",
      commandId: "cmd_revalidateAfterOversized",
      method: "providerConnection.environment.revalidate" as const,
      params: {
        connectionId: oversizedConnectionId,
        expectedLifecycleRevision: 2,
        expectedGeneration: 1,
      },
    })).resolves.toMatchObject({
      duplicate: false,
      result: { connectionId: oversizedConnectionId },
    });
    await expect(runtime.storage.catalog.getProviderConnection(oversizedConnectionId))
      .resolves.toMatchObject({ lifecycleStatus: "ready", lifecycleRevision: 3, credentialGeneration: 1 });
  });
});
