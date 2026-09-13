import { createTestFailpointController, WiRuntime } from "../../apps/server/dist/index.js";
import { FakeProviderAdapter } from "../../packages/provider-fake/dist/index.js";

const [homeDirectory, mode] = process.argv.slice(2);
if (homeDirectory === undefined || !["execute-prepared", "execute-success", "inspect"].includes(mode)) {
  process.exit(64);
}

const commandId = "cmd_environmentRevalidateProcess";
const variableName = "WI_REVALIDATE_PROCESS_KEY";
const provider = new FakeProviderAdapter({ id: "openai_platform" });
const runtime = new WiRuntime({
  homeDirectory,
  testFailpoints: mode === "execute-prepared"
    ? createTestFailpointController(process.env) ?? undefined
    : undefined,
  providerConnectionFixture: {
    provider,
    capabilitiesForConnection: (connection) => ({
      version: 1,
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authMode: connection.authMode,
      capabilitiesVersion: "capver_processEnvironmentRevalidate",
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
await runtime.ready();

if (mode === "execute-prepared" || mode === "execute-success") {
  delete process.env[variableName];
  const created = await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId: "cmd_environmentRevalidateProcessCreate",
    method: "providerConnection.environment.create",
    params: {
      providerId: "openai_platform",
      authMode: "api_key",
      displayName: "Process environment revalidation",
      variableName,
    },
  }, "client_processEnvironmentRevalidate");
  const connectionId = created.result.connectionId;
  process.env[variableName] = "process-environment-revalidated";
  const revalidate = await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId,
    method: "providerConnection.environment.revalidate",
    params: {
      connectionId,
      expectedLifecycleRevision: 1,
      expectedGeneration: 1,
    },
  }, "client_processEnvironmentRevalidate");
  if (mode === "execute-success") {
    const connection = await runtime.storage.catalog.getProviderConnection(connectionId);
    process.stdout.write(`${JSON.stringify({
      accepted: !revalidate.duplicate,
      connectionId,
      lifecycleStatus: connection?.lifecycleStatus ?? null,
      lifecycleRevision: connection?.lifecycleRevision ?? null,
      credentialGeneration: connection?.credentialGeneration ?? null,
      providerRequests: provider.requests.length,
    })}\n`);
    await runtime.close();
  }
  process.exit(0);
}

const connections = await runtime.storage.catalog.listProviderConnections();
const connection = connections.connections[0];
if (connection === undefined) throw new Error("Revalidation connection is missing");
const operation = await runtime.storage.catalog.getProviderLifecycleOperation(commandId);
process.stdout.write(`${JSON.stringify({
  lifecycleStatus: connection.lifecycleStatus,
  lifecycleRevision: connection.lifecycleRevision,
  credentialGeneration: connection.credentialGeneration,
  lifecycleOwnerKind: connection.lifecycleOwnerKind,
  operationPhase: operation?.phase ?? null,
  providerRequests: provider.requests.length,
})}\n`);
await runtime.close();
