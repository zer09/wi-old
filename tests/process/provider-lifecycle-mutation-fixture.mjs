import { createTestFailpointController, WiRuntime } from "../../apps/server/dist/index.js";
import {
  CredentialProvisioner,
  FileCredentialStore,
  StoredCredential,
  internalStagingRef,
} from "../../packages/credentials/dist/index.js";

const [homeDirectory, credentialRoot, stagingRoot, operationKind, provisioningRef, commandId, connectionId, mode] = process.argv.slice(2);
if ([homeDirectory, credentialRoot, stagingRoot, operationKind, provisioningRef, commandId, connectionId, mode].some((value) => value === undefined)) process.exit(64);
if (
  !["setup", "execute", "inspect", "inspect-detailed"].includes(mode) ||
  !["replace", "logout", "delete", "refresh", "reauthenticate"].includes(operationKind)
) process.exit(65);

const failpoint = mode === "execute"
  ? createTestFailpointController(process.env) ?? undefined
  : undefined;
const runtime = new WiRuntime({
  homeDirectory,
  credentialRoots: { credentialRoot, stagingRoot },
  testFailpoints: failpoint,
});
await runtime.ready();

if (mode === "setup") {
  const created = await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId: "cmd_mutationSetup",
    method: "providerConnection.file.create",
    params: {
      providerId: "openai_platform",
      authMode: "api_key",
      displayName: "Mutation source",
      provisioningRef,
    },
  }, "client_processMutation");
  process.stdout.write(`${JSON.stringify({ connectionId: created.result?.connectionId })}\n`);
} else if (mode === "execute") {
  const connection = await runtime.storage.catalog.getProviderConnection(connectionId);
  if (connection === null) throw new Error("Mutation source connection is missing");
  if (operationKind === "refresh" || operationKind === "reauthenticate") {
    if (connection.credentialInternalRef === null || connection.envelopeId === null) {
      throw new Error("Future publication fixture requires a file credential");
    }
    const provisioner = new CredentialProvisioner(stagingRoot);
    const stagedRead = await provisioner.readWithFileIdentity(provisioningRef, {});
    const staged = stagedRead.credential;
    const stagingRef = internalStagingRef(provisioningRef);
    const prepared = await runtime.storage.catalog.prepareProviderLifecycle({
      commandId,
      commandMethod: `test.${operationKind}`,
      contentHash: "f".repeat(64),
      operationKind,
      connectionId,
      expectedLifecycleRevision: connection.lifecycleRevision,
      expectedGeneration: connection.credentialGeneration,
      credentialBackendKind: "file",
      credentialInternalRef: connection.credentialInternalRef,
      targetEnvelopeId: `envl_${operationKind}Publication`,
      provisioningId: staged.provisioningId,
      stagingInternalRef: stagingRef,
      stagingFileIdentity: stagedRead.fileIdentity,
      recoveryEpochId: null,
      expectedSafeMetadata: { previousEnvelopeId: connection.envelopeId },
      createdAtMs: Date.now(),
    });
    failpoint?.hit("after_provider_lifecycle_prepare", { commandId });
    const claimedRead = await provisioner.readClaimedInternalWithFileIdentity(stagingRef);
    const claimed = claimedRead.credential;
    if (
      claimed.provisioningId !== prepared.operation.provisioningId ||
      JSON.stringify(claimedRead.fileIdentity) !==
        JSON.stringify(prepared.operation.stagingFileIdentity) ||
      claimed.providerId !== connection.providerId ||
      claimed.authMode !== connection.authMode
    ) {
      throw new Error("Claimed stage binding changed after lifecycle prepare");
    }
    const replacement = new StoredCredential({
      version: 1,
      envelopeId: prepared.operation.envelopeId,
      connectionId,
      providerId: connection.providerId,
      authMode: connection.authMode,
      generation: prepared.operation.reservedGeneration,
      updatedAtMs: Date.now(),
      identity: connection.identity,
      credential: { type: "api_key", apiKey: claimed.apiKey },
    });
    await new FileCredentialStore(credentialRoot, {
      afterCredentialRenameBeforeFlush: () => failpoint?.hit(
        "after_provider_credential_rename_before_flush",
        { commandId },
      ),
    }).replaceBound(
      connection.credentialInternalRef,
      {
        connectionId,
        providerId: connection.providerId,
        authMode: connection.authMode,
        generation: connection.credentialGeneration,
        envelopeId: connection.envelopeId,
      },
      replacement,
    );
    failpoint?.hit("after_provider_file_effect", { commandId });
    await runtime.storage.catalog.observeProviderLifecycleEffect({
      commandId,
      contentHash: prepared.operation.contentHash,
      observedEnvelopeId: prepared.operation.envelopeId,
      credentialInternalRef: connection.credentialInternalRef,
      updatedAtMs: Date.now(),
    });
    failpoint?.hit("after_provider_file_observed", { commandId });
    await runtime.storage.catalog.completeProviderLifecycle({
      commandId,
      contentHash: prepared.operation.contentHash,
      observedEnvelopeId: prepared.operation.envelopeId,
      credentialInternalRef: connection.credentialInternalRef,
      terminalPhase: "succeeded",
      lifecycleStatus: "ready",
      result: { connectionId },
      failureCode: null,
      failureMessage: null,
      diagnosticId: null,
      updatedAtMs: Date.now(),
    });
    failpoint?.hit("after_provider_lifecycle_terminal_before_ack", { commandId });
    await provisioner.deleteClaimedInternal(stagingRef);
    failpoint?.hit("after_provider_stage_cleanup", { commandId });
  } else {
  const existingOperation = await runtime.storage.catalog.getProviderLifecycleOperation(commandId);
  const expectedLifecycleRevision = existingOperation?.expectedLifecycleRevision
    ?? connection.lifecycleRevision;
  const expectedGeneration = existingOperation?.expectedGeneration ?? connection.credentialGeneration;
  const params = operationKind === "replace"
    ? {
        connectionId,
        expectedLifecycleRevision,
        expectedGeneration,
        provisioningRef,
      }
    : {
        connectionId,
        expectedLifecycleRevision,
        expectedGeneration,
      };
  await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId,
    method: operationKind === "replace"
      ? "providerConnection.file.replace"
      : operationKind === "logout"
        ? "providerConnection.logout"
        : "providerConnection.delete",
    params,
  }, "client_processMutation");
  }
} else {
  const operation = await runtime.storage.catalog.getProviderLifecycleOperation(commandId);
  const connection = await runtime.storage.catalog.getProviderConnection(connectionId);
  let stagePresent = false;
  if (["replace", "refresh", "reauthenticate"].includes(operationKind)) {
    try {
      await new CredentialProvisioner(stagingRoot).read(provisioningRef, { allowExpiredClaimed: true });
      stagePresent = true;
    } catch (error) {
      if (error?.code !== "credential.stage_missing") throw error;
    }
  }
  const refs = await new FileCredentialStore(credentialRoot).listRefs();
  const summary = {
    phase: operation?.phase ?? null,
    lifecycleStatus: connection?.lifecycleStatus ?? null,
    generation: connection?.credentialGeneration ?? null,
    deleted: connection?.deleted ?? null,
    credentialInternalRef: connection?.credentialInternalRef ?? null,
    envelopeId: connection?.envelopeId ?? null,
    stagePresent,
    credentialFileCount: refs.length,
  };
  if (mode === "inspect-detailed") {
    let claimActive = false;
    if (operation?.provisioningId !== null && operation?.provisioningId !== undefined) {
      claimActive = await runtime.storage.catalog.isProvisioningClaimActive(
        operation.provisioningId,
      );
    }
    process.stdout.write(`${JSON.stringify({
      ...summary,
      lifecycleOwnerKind: connection?.lifecycleOwnerKind ?? null,
      claimActive,
    })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }
}
await runtime.close();
