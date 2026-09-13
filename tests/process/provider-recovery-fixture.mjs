import {
  createTestFailpointController,
  WiRuntime,
} from "../../apps/server/dist/index.js";
import {
  CredentialProvisioner,
  FileCredentialStore,
} from "../../packages/credentials/dist/index.js";

const [
  homeDirectory,
  credentialRoot,
  stagingRoot,
  commandId,
  mode,
  replacementProvisioningRef,
] = process.argv.slice(2);
if ([homeDirectory, credentialRoot, stagingRoot, commandId, mode].some((value) => value === undefined)) process.exit(64);
if (
  mode !== "execute" && mode !== "execute-second" &&
  mode !== "inspect" && mode !== "inspect-binding" && mode !== "replace"
) process.exit(65);

const runtime = new WiRuntime({
  homeDirectory,
  credentialRoots: { credentialRoot, stagingRoot },
  testFailpoints: mode === "execute" || mode === "replace"
    ? createTestFailpointController(process.env) ?? undefined
    : undefined,
});
await runtime.ready();
if (mode === "execute" || mode === "execute-second") {
  const scan = await runtime.providerConnections.startRecoveryScan();
  const targetConnectionId = mode === "execute"
    ? "pconn_recoveryCrash"
    : "pconn_recoverySecond";
  const candidate = scan.candidates.find((value) =>
    value.originalConnectionId === targetConnectionId
  );
  if (candidate === undefined) throw new Error("Recovery fixture candidate is missing");
  await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId,
    method: "providerConnection.recover",
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
      displayName: mode === "execute"
        ? "Recovered crash account"
        : "Recovered second account",
    },
  }, "client_processRecovery");
} else if (mode === "replace") {
  const connection = await runtime.storage.catalog.getProviderConnection("pconn_recoveryCrash");
  if (connection === null) throw new Error("Recovery tombstone connection is missing");
  const stagedRef = replacementProvisioningRef ?? (
    await new CredentialProvisioner(stagingRoot).stageApiKey(
      "openai_platform",
      "api_key",
      "replacement-after-recovery-tombstone",
    )
  ).provisioningRef;
  await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId: `${commandId}Replacement`,
    method: "providerConnection.file.replace",
    params: {
      connectionId: connection.connectionId,
      expectedLifecycleRevision: replacementProvisioningRef === undefined
        ? connection.lifecycleRevision
        : 1,
      expectedGeneration: replacementProvisioningRef === undefined
        ? connection.credentialGeneration
        : 3,
      provisioningRef: stagedRef,
    },
  }, "client_processRecovery");
  const replaced = await runtime.storage.catalog.getProviderConnection(connection.connectionId);
  const store = new FileCredentialStore(credentialRoot);
  const refs = await store.listRefs();
  const retained = await store.get("credref_recoveryCrash");
  process.stdout.write(`${JSON.stringify({
    connectionStatus: replaced?.lifecycleStatus ?? null,
    generation: replaced?.credentialGeneration ?? null,
    recoveryTombstone: replaced?.recoveryTombstone ?? null,
    credentialInternalRef: replaced?.credentialInternalRef ?? null,
    refs,
    retainedConnectionId: retained?.metadata.connectionId ?? null,
    retainedEnvelopeId: retained?.metadata.envelopeId ?? null,
  })}\n`);
} else {
  const operation = await runtime.storage.catalog.getProviderLifecycleOperation(commandId);
  const connection = await runtime.storage.catalog.getProviderConnection("pconn_recoveryCrash");
  process.stdout.write(`${JSON.stringify({
    phase: operation?.phase ?? null,
    failureCode: operation?.failureCode ?? null,
    connectionStatus: connection?.lifecycleStatus ?? null,
    generation: connection?.credentialGeneration ?? null,
    recoveryTombstone: connection?.recoveryTombstone ?? null,
    ...(mode === "inspect-binding"
      ? { credentialInternalRef: connection?.credentialInternalRef ?? null }
      : {}),
  })}\n`);
}
await runtime.close();
