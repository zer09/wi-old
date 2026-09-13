import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PROVIDER_CONNECTION_LIMITS } from "@wi/protocol";
import { CatalogClient } from "@wi/storage";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function catalog(): Promise<CatalogClient> {
  const home = await mkdtemp(join(tmpdir(), "wi-provider-catalog-"));
  homes.push(home);
  const client = new CatalogClient({ homeDirectory: home, allowRepair: true });
  await client.getStartupState();
  await client.completeRepair();
  return client;
}

function registration(suffix: string) {
  return {
    commandId: `cmd_env${suffix}`,
    contentHash: suffix.repeat(64).slice(0, 64),
    connectionId: `pconn_${suffix}`,
    providerId: "openai_platform" as const,
    authMode: "api_key" as const,
    displayName: `Platform ${suffix}`,
    variableName: `OPENAI_KEY_${suffix.toUpperCase()}`,
    identity: { status: "unverified" as const },
    identityClaim: null,
    initialStatus: "ready" as const,
    createdAtMs: 1_000,
  };
}

describe("provider connection catalog storage", () => {
  it("creates and lists two same-provider connections without overwrite", async () => {
    const client = await catalog();
    try {
      await client.registerEnvironmentConnection(registration("a"));
      await client.registerEnvironmentConnection(registration("b"));
      const listed = await client.listProviderConnections();
      expect(listed.connections.map(({ connectionId }) => connectionId).sort()).toEqual([
        "pconn_a",
        "pconn_b",
      ]);
      expect(listed.catalogRevision).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("returns stable identical retries and rejects changed command content", async () => {
    const client = await catalog();
    try {
      const first = await client.registerEnvironmentConnection(registration("a"));
      const duplicate = await client.registerEnvironmentConnection(registration("a"));
      expect(first.duplicate).toBe(false);
      expect(duplicate).toMatchObject({ duplicate: true, connection: first.connection });
      await expect(
        client.registerEnvironmentConnection({
          ...registration("a"),
          contentHash: "b".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    } finally {
      await client.close();
    }
  });

  it("atomically resolves concurrent authoritative identity claims to one stable winner", async () => {
    const client = await catalog();
    const claim = {
      identityKey: '["openai_platform","api_key","project","project-a","none"]',
      stableKind: "project" as const,
      stableValue: "project-a",
      workspacePresence: "none" as const,
      workspaceValue: "",
    };
    try {
      const identity = {
        status: "authoritative" as const,
        projectId: "project-a",
        workspace: { presence: "none" as const },
      };
      const [first, second] = await Promise.all([
        client.registerEnvironmentConnection({
          ...registration("a"),
          identity,
          identityClaim: claim,
        }),
        client.registerEnvironmentConnection({
          ...registration("b"),
          identity,
          identityClaim: claim,
        }),
      ]);
      expect(first.connection.connectionId).toBe(second.connection.connectionId);
      expect((await client.listProviderConnections()).connections).toHaveLength(1);
      await expect(client.registerEnvironmentConnection({
        ...registration("b"),
        contentHash: "c".repeat(64),
        identity,
        identityClaim: claim,
      })).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    } finally {
      await client.close();
    }
  });

  it("keeps unknown-workspace authoritative identities connection-distinct", async () => {
    const client = await catalog();
    const identity = {
      status: "authoritative" as const,
      subjectId: "subject-unknown-workspace",
      workspace: { presence: "unknown" as const },
    };
    const identityClaim = {
      identityKey: JSON.stringify([
        "openai_platform", "api_key", "subject", "subject-unknown-workspace", "unknown",
      ]),
      stableKind: "subject" as const,
      stableValue: "subject-unknown-workspace",
      workspacePresence: "unknown" as const,
      workspaceValue: "",
    };
    try {
      const first = await client.registerEnvironmentConnection({
        ...registration("unknownWorkspaceA"),
        contentHash: "a".repeat(64),
        identity,
        identityClaim,
      });
      const second = await client.registerEnvironmentConnection({
        ...registration("unknownWorkspaceB"),
        contentHash: "b".repeat(64),
        identity,
        identityClaim,
      });
      expect(first.connection.connectionId).not.toBe(second.connection.connectionId);
      expect((await client.listProviderConnections()).connections).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("rejects command ID reuse across metadata and lifecycle ledgers", async () => {
    const client = await catalog();
    try {
      await client.registerEnvironmentConnection(registration("a"));
      await client.renameProviderConnection({
        commandId: "cmd_shared",
        contentHash: "c".repeat(64),
        connectionId: "pconn_a",
        expectedMetadataRevision: 1,
        displayName: "Renamed",
        updatedAtMs: 2_000,
      });
      await expect(client.prepareProviderLifecycle({
        commandId: "cmd_shared",
        commandMethod: "providerConnection.disable",
        contentHash: "d".repeat(64),
        operationKind: "disable",
        connectionId: "pconn_a",
        expectedLifecycleRevision: 1,
        expectedGeneration: 1,
        credentialBackendKind: "environment",
        credentialInternalRef: null,
        targetEnvelopeId: null,
        provisioningId: null,
        stagingInternalRef: null,
        stagingFileIdentity: null,
        recoveryEpochId: null,
        expectedSafeMetadata: null,
        createdAtMs: 2_001,
      })).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
    } finally {
      await client.close();
    }
  });

  it("shares command IDs with catalog-global session creation in both and concurrent orderings", async () => {
    const client = await catalog();
    const globalInput = (suffix: string) => ({
      commandId: `cmd_crossCatalog${suffix}`,
      payloadHash: "1".repeat(64),
      reservedSessionId: `ses_crossCatalog${suffix}`,
      reservedEventId: `evt_crossCatalog${suffix}`,
      request: { title: `Cross ${suffix}`, projectId: null },
      updatedAtMs: 1_000,
    });
    const environmentInput = (suffix: string) => ({
      ...registration(`cross${suffix}`),
      commandId: `cmd_crossCatalog${suffix}`,
      contentHash: "2".repeat(64),
    });
    const fileInput = (suffix: string) => ({
      commandId: `cmd_crossCatalog${suffix}`,
      commandMethod: "providerConnection.file.create" as const,
      contentHash: "3".repeat(64),
      connectionId: `pconn_crossFile${suffix}`,
      providerId: "openai_platform" as const,
      authMode: "api_key" as const,
      displayName: `Cross file ${suffix}`,
      identity: { status: "unverified" as const },
      credentialInternalRef: `credref_crossFile${suffix}`,
      targetEnvelopeId: `envl_crossFile${suffix}`,
      provisioningId: `prov_crossFile${suffix}`,
      stagingInternalRef: `stage_crossFile${suffix}`,
      stagingFileIdentity: { device: "1", inode: "2", size: "3", ctimeNs: "4" },
      createdAtMs: 1_000,
    });
    try {
      await client.reserveGlobalCommand(globalInput("GlobalFirst"));
      await expect(client.registerEnvironmentConnection(environmentInput("GlobalFirst")))
        .rejects.toMatchObject({ code: "protocol.command_id_conflict" });

      await client.registerEnvironmentConnection(environmentInput("ProviderFirst"));
      await expect(client.reserveGlobalCommand(globalInput("ProviderFirst")))
        .rejects.toMatchObject({ code: "protocol.command_id_conflict" });

      for (const [suffix, providerCommand] of [
        ["ConcurrentEnvironment", () => client.registerEnvironmentConnection(
          environmentInput("ConcurrentEnvironment"),
        )],
        ["ConcurrentFile", () => client.reserveFileProviderConnection(
          fileInput("ConcurrentFile"),
        )],
      ] as const) {
        const outcomes = await Promise.allSettled([
          client.reserveGlobalCommand(globalInput(suffix)),
          providerCommand(),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        expect(rejected).toMatchObject({
          status: "rejected",
          reason: { code: "protocol.command_id_conflict" },
        });
      }
    } finally {
      await client.close();
    }
  });

  it("restores an authoritative recovery claim before another connection can claim it", async () => {
    const client = await catalog();
    const identity = {
      status: "authoritative" as const,
      subjectId: "subject-recovered",
      workspace: { presence: "none" as const },
    };
    const identityClaim = {
      identityKey: JSON.stringify(["openai_platform", "api_key", "subject", "subject-recovered", "none"]),
      stableKind: "subject" as const,
      stableValue: "subject-recovered",
      workspacePresence: "none" as const,
      workspaceValue: "",
    };
    try {
      const recovery = await client.reserveRecoveredProviderConnection({
        commandId: "cmd_authoritativeRecovery",
        commandMethod: "providerConnection.recover",
        contentHash: "c".repeat(64),
        connectionId: "pconn_authoritativeRecovered",
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Authoritative recovered",
        identity,
        identityClaim,
        generation: 4,
        credentialInternalRef: "credref_authoritativeRecovered",
        envelopeId: "envl_authoritativeRecovered",
        recoveryEpochId: "recepoch_authoritativeRecovered",
        recoveryFileIdentity: { device: "1", inode: "2", size: "3", ctimeNs: "4" },
        createdAtMs: 1_000,
      });
      await client.observeProviderLifecycleEffect({
        commandId: recovery.operation.commandId,
        contentHash: recovery.operation.contentHash,
        observedEnvelopeId: recovery.operation.envelopeId,
        credentialInternalRef: recovery.operation.credentialInternalRef,
        updatedAtMs: 1_001,
      });
      await client.completeProviderLifecycle({
        commandId: recovery.operation.commandId,
        contentHash: recovery.operation.contentHash,
        observedEnvelopeId: recovery.operation.envelopeId,
        credentialInternalRef: recovery.operation.credentialInternalRef,
        terminalPhase: "succeeded",
        lifecycleStatus: "ready",
        result: { connectionId: recovery.connection.connectionId },
        failureCode: null,
        failureMessage: null,
        diagnosticId: null,
        updatedAtMs: 1_002,
      });
      const competing = await client.registerEnvironmentConnection({
        ...registration("authoritativeCompetitor"),
        contentHash: "d".repeat(64),
        identity,
        identityClaim,
      });
      expect(competing.connection.connectionId).toBe("pconn_authoritativeRecovered");
    } finally {
      await client.close();
    }
  });

  it("classifies occupied recovery connections and identities distinctly", async () => {
    const client = await catalog();
    const authoritativeIdentity = {
      status: "authoritative" as const,
      subjectId: "subject-recovery-conflict",
      workspace: { presence: "none" as const },
    };
    const identityClaim = {
      identityKey: JSON.stringify([
        "openai_platform",
        "api_key",
        "subject",
        "subject-recovery-conflict",
        "none",
      ]),
      stableKind: "subject" as const,
      stableValue: "subject-recovery-conflict",
      workspacePresence: "none" as const,
      workspaceValue: "",
    };
    try {
      await client.registerEnvironmentConnection({
        ...registration("occupiedRecovery"),
        contentHash: "a".repeat(64),
      });
      await expect(client.reserveRecoveredProviderConnection({
        commandId: "cmd_recoveryConnectionConflict",
        commandMethod: "providerConnection.recover",
        contentHash: "b".repeat(64),
        connectionId: "pconn_occupiedRecovery",
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Occupied recovery",
        identity: { status: "unverified" },
        identityClaim: null,
        generation: 1,
        credentialInternalRef: "credref_connectionConflict",
        envelopeId: "envl_connectionConflict",
        recoveryEpochId: "recepoch_connectionConflict",
        recoveryFileIdentity: { device: "1", inode: "2", size: "3", ctimeNs: "4" },
        createdAtMs: 2_000,
      })).rejects.toMatchObject({ code: "credential.recovery_connection_conflict" });

      await client.registerEnvironmentConnection({
        ...registration("identityOwner"),
        contentHash: "c".repeat(64),
        identity: authoritativeIdentity,
        identityClaim,
      });
      await expect(client.reserveRecoveredProviderConnection({
        commandId: "cmd_recoveryIdentityConflict",
        commandMethod: "providerConnection.recover",
        contentHash: "d".repeat(64),
        connectionId: "pconn_recoveryIdentityConflict",
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Identity recovery",
        identity: authoritativeIdentity,
        identityClaim,
        generation: 1,
        credentialInternalRef: "credref_identityConflict",
        envelopeId: "envl_identityConflict",
        recoveryEpochId: "recepoch_identityConflict",
        recoveryFileIdentity: { device: "1", inode: "2", size: "3", ctimeNs: "4" },
        createdAtMs: 2_001,
      })).rejects.toMatchObject({ code: "credential.recovery_identity_conflict" });
    } finally {
      await client.close();
    }
  });

  it("commits catalog-only disable atomically with its terminal result", async () => {
    const client = await catalog();
    const input = {
      commandId: "cmd_atomicDisable",
      commandMethod: "providerConnection.disable" as const,
      contentHash: "e".repeat(64),
      operationKind: "disable" as const,
      connectionId: "pconn_a",
      expectedLifecycleRevision: 1,
      expectedGeneration: 1,
      credentialBackendKind: "environment" as const,
      credentialInternalRef: null,
      targetEnvelopeId: null,
      provisioningId: null,
      stagingInternalRef: null,
      stagingFileIdentity: null,
      recoveryEpochId: null,
      expectedSafeMetadata: null,
      createdAtMs: 2_000,
    };
    try {
      await client.registerEnvironmentConnection(registration("a"));
      const disabled = await client.disableProviderConnection(input);
      expect(disabled).toMatchObject({
        duplicate: false,
        connection: {
          lifecycleStatus: "disabled",
          lifecycleRevision: 2,
          credentialGeneration: 1,
          lifecycleOwnerKind: null,
        },
        operation: { phase: "succeeded", operationKind: "disable" },
      });
      await expect(client.disableProviderConnection(input)).resolves.toMatchObject({
        duplicate: true,
        connection: { lifecycleStatus: "disabled", lifecycleOwnerKind: null },
        operation: { phase: "succeeded" },
      });
    } finally {
      await client.close();
    }
  });

  it("revalidates only an unavailable environment connection without changing generation", async () => {
    const client = await catalog();
    const input = {
      commandId: "cmd_environmentRevalidateStorage",
      commandMethod: "providerConnection.environment.revalidate",
      contentHash: "e".repeat(64),
      operationKind: "enable" as const,
      connectionId: "pconn_a",
      expectedLifecycleRevision: 1,
      expectedGeneration: 1,
      credentialBackendKind: "environment" as const,
      credentialInternalRef: null,
      targetEnvelopeId: null,
      provisioningId: null,
      stagingInternalRef: null,
      stagingFileIdentity: null,
      recoveryEpochId: null,
      expectedSafeMetadata: null,
      createdAtMs: 2_000,
    };
    try {
      await client.registerEnvironmentConnection({
        ...registration("a"),
        initialStatus: "unavailable",
      });
      const prepared = await client.prepareProviderLifecycle(input);
      expect(prepared).toMatchObject({
        duplicate: false,
        connection: {
          lifecycleStatus: "unavailable",
          lifecycleRevision: 2,
          credentialGeneration: 1,
          lifecycleOwnerKind: "enable",
        },
        operation: { phase: "prepared", operationKind: "enable" },
      });
      const completed = await client.completeProviderLifecycle({
        commandId: input.commandId,
        contentHash: input.contentHash,
        observedEnvelopeId: null,
        credentialInternalRef: null,
        terminalPhase: "succeeded",
        lifecycleStatus: "ready",
        result: { connectionId: input.connectionId },
        failureCode: null,
        failureMessage: null,
        diagnosticId: null,
        updatedAtMs: 2_001,
      });
      expect(completed).toMatchObject({
        duplicate: false,
        connection: {
          lifecycleStatus: "ready",
          lifecycleRevision: 2,
          credentialGeneration: 1,
          lifecycleOwnerKind: null,
        },
        operation: { phase: "succeeded", operationKind: "enable" },
      });
      await expect(client.prepareProviderLifecycle(input)).resolves.toMatchObject({
        duplicate: true,
        connection: { lifecycleStatus: "ready", lifecycleRevision: 2, credentialGeneration: 1 },
        operation: { phase: "succeeded" },
      });
      await expect(client.prepareProviderLifecycle({
        ...input,
        contentHash: "f".repeat(64),
      })).rejects.toMatchObject({ code: "protocol.command_id_conflict" });
      await expect(client.prepareProviderLifecycle({
        ...input,
        commandId: "cmd_enableReadyStorage",
        contentHash: "1".repeat(64),
        expectedLifecycleRevision: 2,
      })).rejects.toMatchObject({ code: "provider.connection_unavailable" });

      const fileInput = {
        commandId: "cmd_fileBackedRevalidateCreate",
        commandMethod: "providerConnection.file.create" as const,
        contentHash: "2".repeat(64),
        connectionId: "pconn_fileBackedRevalidate",
        providerId: "openai_platform" as const,
        authMode: "api_key" as const,
        displayName: "File-backed revalidation",
        identity: { status: "unverified" as const },
        credentialInternalRef: "credref_fileBackedRevalidate",
        targetEnvelopeId: "envl_fileBackedRevalidate",
        provisioningId: "prov_fileBackedRevalidate",
        stagingInternalRef: "stage_fileBackedRevalidate",
        stagingFileIdentity: { device: "1", inode: "2", size: "3", ctimeNs: "4" },
        createdAtMs: 3_000,
      };
      await client.reserveFileProviderConnection(fileInput);
      await client.completeProviderLifecycle({
        commandId: fileInput.commandId,
        contentHash: fileInput.contentHash,
        observedEnvelopeId: null,
        credentialInternalRef: fileInput.credentialInternalRef,
        terminalPhase: "failed",
        lifecycleStatus: "unavailable",
        result: null,
        failureCode: "credential.test_failure",
        failureMessage: "test failure",
        diagnosticId: null,
        updatedAtMs: 3_001,
      });
      await expect(client.prepareProviderLifecycle({
        ...input,
        commandId: "cmd_enableFileBackedStorage",
        contentHash: "3".repeat(64),
        connectionId: fileInput.connectionId,
        credentialBackendKind: "file",
        credentialInternalRef: fileInput.credentialInternalRef,
        targetEnvelopeId: fileInput.targetEnvelopeId,
      })).rejects.toMatchObject({ code: "provider.connection_unavailable" });
    } finally {
      await client.close();
    }
  });

  it("enforces one transactional total limit across every connection insertion path", async () => {
    const client = await catalog();
    const registrationAt = (index: number) => ({
      commandId: `cmd_limit${index}`,
      contentHash: index.toString(16).padStart(64, "0"),
      connectionId: `pconn_limit${index}`,
      providerId: "openai_platform" as const,
      authMode: "api_key" as const,
      displayName: `Limit ${index}`,
      variableName: `WI_LIMIT_${index}`,
      identity: { status: "unverified" as const },
      identityClaim: null,
      initialStatus: "ready" as const,
      createdAtMs: index + 1,
    });
    try {
      for (let index = 0; index < PROVIDER_CONNECTION_LIMITS.maximumConnections; index += 1) {
        await client.registerEnvironmentConnection(registrationAt(index));
      }
      await expect(client.registerEnvironmentConnection(registrationAt(0))).resolves.toMatchObject({
        duplicate: true,
        connection: { connectionId: "pconn_limit0" },
      });
      await expect(client.registerEnvironmentConnection(
        registrationAt(PROVIDER_CONNECTION_LIMITS.maximumConnections),
      )).rejects.toMatchObject({ code: "provider.connection_limit_exceeded" });
      await expect(client.reserveFileProviderConnection({
        commandId: "cmd_limitFile",
        commandMethod: "providerConnection.file.create",
        contentHash: "a".repeat(64),
        connectionId: "pconn_limitFile",
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Limit file",
        identity: { status: "unverified" },
        credentialInternalRef: "credref_limitFile",
        targetEnvelopeId: "envl_limitFile",
        provisioningId: "prov_limitFile",
        stagingInternalRef: "stage_limitFile",
        stagingFileIdentity: { device: "1", inode: "2", size: "3", ctimeNs: "4" },
        createdAtMs: 2_000,
      })).rejects.toMatchObject({ code: "provider.connection_limit_exceeded" });
      await expect(client.reserveRecoveredProviderConnection({
        commandId: "cmd_limitRecovery",
        commandMethod: "providerConnection.recover",
        contentHash: "b".repeat(64),
        connectionId: "pconn_limitRecovery",
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Limit recovery",
        identity: { status: "unverified" },
        identityClaim: null,
        generation: 1,
        credentialInternalRef: "credref_limitRecovery",
        envelopeId: "envl_limitRecovery",
        recoveryEpochId: "recepoch_limitRecovery",
        recoveryFileIdentity: { device: "1", inode: "2", size: "3", ctimeNs: "4" },
        createdAtMs: 2_001,
      })).rejects.toMatchObject({ code: "provider.connection_limit_exceeded" });
      const listed = await client.listProviderConnections();
      expect(listed).toMatchObject({
        truncated: false,
        connections: { length: PROVIDER_CONNECTION_LIMITS.maximumConnections },
      });
      await expect(client.getProviderConnection("pconn_limit0")).resolves.toMatchObject({
        connectionId: "pconn_limit0",
      });
      await expect(client.getProviderConnection("pconn_limitFile")).resolves.toBeNull();
      await expect(client.getProviderConnection("pconn_limitRecovery")).resolves.toBeNull();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("keeps one lifecycle owner and never queues a conflicting replacement", async () => {
    const client = await catalog();
    try {
      await client.registerEnvironmentConnection(registration("a"));
      const prepared = await client.prepareProviderLifecycle({
        commandId: "cmd_replaceA",
        commandMethod: "providerConnection.file.replace",
        contentHash: "a".repeat(64),
        operationKind: "replace",
        connectionId: "pconn_a",
        expectedLifecycleRevision: 1,
        expectedGeneration: 1,
        credentialBackendKind: "file",
        credentialInternalRef: "credref_a2",
        targetEnvelopeId: "envl_a2",
        provisioningId: "prov_a2",
        stagingInternalRef: "stage_a2",
        stagingFileIdentity: { device: "1", inode: "2", size: "3", ctimeNs: "4" },
        recoveryEpochId: null,
        expectedSafeMetadata: null,
        createdAtMs: 2_000,
      });
      expect(prepared.connection).toMatchObject({
        lifecycleRevision: 2,
        credentialGeneration: 2,
        lifecycleOwnerKind: "replace",
      });
      const conflict = await client.prepareProviderLifecycle({
        commandId: "cmd_disableA",
        commandMethod: "providerConnection.disable",
        contentHash: "b".repeat(64),
        operationKind: "disable",
        connectionId: "pconn_a",
        expectedLifecycleRevision: 2,
        expectedGeneration: 2,
        credentialBackendKind: "file",
        credentialInternalRef: null,
        targetEnvelopeId: null,
        provisioningId: null,
        stagingInternalRef: null,
        stagingFileIdentity: null,
        recoveryEpochId: null,
        expectedSafeMetadata: null,
        createdAtMs: 2_001,
      });
      expect(conflict.operation).toMatchObject({
        phase: "failed",
        failureCode: "provider.operation_in_progress",
      });
      const observed = await client.observeProviderLifecycleEffect({
        commandId: "cmd_replaceA",
        contentHash: "a".repeat(64),
        observedEnvelopeId: "envl_a2",
        credentialInternalRef: "credref_a2",
        updatedAtMs: 2_500,
      });
      expect(observed.phase).toBe("file_observed");
      const terminal = await client.completeProviderLifecycle({
        commandId: "cmd_replaceA",
        contentHash: "a".repeat(64),
        observedEnvelopeId: "envl_a2",
        credentialInternalRef: "credref_a2",
        terminalPhase: "succeeded",
        lifecycleStatus: "ready",
        result: { connectionId: "pconn_a", generation: 2 },
        failureCode: null,
        failureMessage: null,
        diagnosticId: null,
        updatedAtMs: 3_000,
      });
      expect(terminal.connection).toMatchObject({ lifecycleOwnerKind: null, credentialGeneration: 2 });
      expect((await client.getProviderLifecycleOperation("cmd_disableA"))?.phase).toBe("failed");
    } finally {
      await client.close();
    }
  });

  it("rejects refresh plus logout and delete plus reauthenticate interleavings durably", async () => {
    const client = await catalog();
    try {
      const registered = await client.registerEnvironmentConnection(registration("f"));
      const connectionId = registered.connection.connectionId;
      const refresh = await client.prepareProviderLifecycle({
        commandId: "cmd_futureRefresh",
        commandMethod: "test.refresh",
        contentHash: "a".repeat(64),
        operationKind: "refresh",
        connectionId,
        expectedLifecycleRevision: 1,
        expectedGeneration: 1,
        credentialBackendKind: "environment",
        credentialInternalRef: null,
        targetEnvelopeId: null,
        provisioningId: null,
        stagingInternalRef: null,
        stagingFileIdentity: null,
        recoveryEpochId: null,
        expectedSafeMetadata: null,
        createdAtMs: 2_000,
      });
      expect(refresh.operation).toMatchObject({ phase: "prepared", reservedGeneration: 1 });
      const logoutConflict = await client.prepareProviderLifecycle({
        commandId: "cmd_logoutDuringFutureRefresh",
        commandMethod: "providerConnection.logout",
        contentHash: "b".repeat(64),
        operationKind: "logout",
        connectionId,
        expectedLifecycleRevision: 1,
        expectedGeneration: 1,
        credentialBackendKind: "environment",
        credentialInternalRef: null,
        targetEnvelopeId: null,
        provisioningId: null,
        stagingInternalRef: null,
        stagingFileIdentity: null,
        recoveryEpochId: null,
        expectedSafeMetadata: null,
        createdAtMs: 2_001,
      });
      expect(logoutConflict.operation).toMatchObject({
        phase: "failed",
        failureCode: "provider.operation_in_progress",
      });
      await client.completeProviderLifecycle({
        commandId: "cmd_futureRefresh",
        contentHash: "a".repeat(64),
        observedEnvelopeId: null,
        credentialInternalRef: null,
        terminalPhase: "succeeded",
        lifecycleStatus: "ready",
        result: { connectionId },
        failureCode: null,
        failureMessage: null,
        diagnosticId: null,
        updatedAtMs: 2_500,
      });
      const beforeDelete = await client.getProviderConnection(connectionId);
      const deletion = await client.prepareProviderLifecycle({
        commandId: "cmd_deleteBeforeFutureReauth",
        commandMethod: "providerConnection.delete",
        contentHash: "c".repeat(64),
        operationKind: "delete",
        connectionId,
        expectedLifecycleRevision: beforeDelete!.lifecycleRevision,
        expectedGeneration: beforeDelete!.credentialGeneration,
        credentialBackendKind: "environment",
        credentialInternalRef: null,
        targetEnvelopeId: null,
        provisioningId: null,
        stagingInternalRef: null,
        stagingFileIdentity: null,
        recoveryEpochId: null,
        expectedSafeMetadata: null,
        createdAtMs: 3_000,
      });
      expect(deletion.operation.phase).toBe("prepared");
      const reauthenticateConflict = await client.prepareProviderLifecycle({
        commandId: "cmd_reauthDuringDelete",
        commandMethod: "test.reauthenticate",
        contentHash: "d".repeat(64),
        operationKind: "reauthenticate",
        connectionId,
        expectedLifecycleRevision: beforeDelete!.lifecycleRevision,
        expectedGeneration: beforeDelete!.credentialGeneration,
        credentialBackendKind: "environment",
        credentialInternalRef: null,
        targetEnvelopeId: null,
        provisioningId: null,
        stagingInternalRef: null,
        stagingFileIdentity: null,
        recoveryEpochId: null,
        expectedSafeMetadata: null,
        createdAtMs: 3_001,
      });
      expect(reauthenticateConflict.operation).toMatchObject({
        phase: "failed",
        failureCode: "provider.operation_in_progress",
      });
    } finally {
      await client.close();
    }
  });
});
