import {
  createTestFailpointController,
  WiRuntime,
} from "../../apps/server/dist/index.js";
import {
  CredentialProvisioner,
  FileCredentialStore,
} from "../../packages/credentials/dist/index.js";

const [homeDirectory, credentialRoot, stagingRoot, provisioningRef, commandId, mode] = process.argv.slice(2);
if ([homeDirectory, credentialRoot, stagingRoot, provisioningRef, commandId, mode].some((value) => value === undefined)) {
  process.exit(64);
}
if (mode !== "execute" && mode !== "inspect" && mode !== "inspect-detailed" && mode !== "inspect-operation") process.exit(65);

const runtime = new WiRuntime({
  homeDirectory,
  credentialRoots: { credentialRoot, stagingRoot },
  testFailpoints: mode === "execute"
    ? createTestFailpointController(process.env) ?? undefined
    : undefined,
});
await runtime.ready();
if (mode === "inspect-operation") {
  const operation = await runtime.storage.catalog.getProviderLifecycleOperation(commandId);
  const connection = operation === null
    ? null
    : await runtime.storage.catalog.getProviderConnection(operation.targetConnectionId);
  let stagePresent = true;
  try {
    await new CredentialProvisioner(stagingRoot).read(provisioningRef, { allowExpiredClaimed: true });
  } catch (error) {
    if (error?.code === "credential.stage_missing") stagePresent = false;
    else throw error;
  }
  process.stdout.write(`${JSON.stringify({
    phase: operation?.phase ?? null,
    failureCode: operation?.failureCode ?? null,
    lifecycleStatus: connection?.lifecycleStatus ?? null,
    credentialGeneration: connection?.credentialGeneration ?? null,
    lifecycleOwnerKind: connection?.lifecycleOwnerKind ?? null,
    stagePresent,
    credentialFileCount: (await new FileCredentialStore(credentialRoot).listRefs()).length,
  })}\n`);
  await runtime.close();
  process.exit(0);
}

const command = {
  v: 1,
  kind: "command",
  commandId,
  method: "providerConnection.file.create",
  params: {
    providerId: "openai_platform",
    authMode: "api_key",
    displayName: "Crash-recovered file connection",
    provisioningRef,
  },
};
const result = await runtime.commandRouter.route(command, "client_processProviderLifecycle");
if (mode === "inspect" || mode === "inspect-detailed") {
  const operation = await runtime.storage.catalog.getProviderLifecycleOperation(commandId);
  const connectionId = result.result?.connectionId;
  const connection = typeof connectionId === "string"
    ? await runtime.storage.catalog.getProviderConnection(connectionId)
    : null;
  let stagePresent = true;
  try {
    await new CredentialProvisioner(stagingRoot).read(provisioningRef, { allowExpiredClaimed: true });
  } catch (error) {
    if (error?.code === "credential.stage_missing") stagePresent = false;
    else throw error;
  }
  const summary = {
    duplicate: result.duplicate,
    phase: operation?.phase ?? null,
    lifecycleStatus: connection?.lifecycleStatus ?? null,
    credentialGeneration: connection?.credentialGeneration ?? null,
    stagePresent,
    credentialFileCount: (await new FileCredentialStore(credentialRoot).listRefs()).length,
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
