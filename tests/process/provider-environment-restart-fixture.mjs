import { createTestFailpointController, WiRuntime } from "../../apps/server/dist/index.js";
import { FakeProviderAdapter } from "../../packages/provider-fake/dist/index.js";

const [homeDirectory, mode] = process.argv.slice(2);
if (homeDirectory === undefined || !["execute", "inspect"].includes(mode)) process.exit(64);
const provider = new FakeProviderAdapter({ id: "openai_platform" });
const runtime = new WiRuntime({
  homeDirectory,
  testFailpoints: mode === "execute" ? createTestFailpointController(process.env) ?? undefined : undefined,
  providerConnectionFixture: {
    provider,
    capabilitiesForConnection: (connection) => ({
      version: 1,
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authMode: connection.authMode,
      capabilitiesVersion: "capver_processEnvironment",
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

if (mode === "execute") {
  const connectionResult = await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId: "cmd_environmentRestartConnection",
    method: "providerConnection.environment.create",
    params: {
      providerId: "openai_platform",
      authMode: "api_key",
      displayName: "Restart environment",
      variableName: "WI_PROCESS_PROVIDER_KEY",
    },
  }, "client_processEnvironment");
  const connectionId = connectionResult.result.connectionId;
  const created = await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId: "cmd_environmentRestartSession",
    method: "session.create",
    params: {},
  }, "client_processEnvironment");
  await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId: "cmd_environmentRestartDefault",
    sessionId: created.sessionId,
    method: "session.providerDefault.set",
    params: { default: {
      version: 1,
      policy: { kind: "explicit", connectionId },
      modelId: "fixture-model",
      capabilitiesVersion: "capver_processEnvironment",
      reasoning: { effort: "none", summary: "none" },
      transportMode: "no_network_fixture",
    } },
  }, "client_processEnvironment");
  await runtime.commandRouter.route({
    v: 1,
    kind: "command",
    commandId: "cmd_environmentRestartSubmit",
    sessionId: created.sessionId,
    method: "message.submit",
    params: { text: "accepted before process restart" },
  }, "client_processEnvironment");
} else {
  const sessions = await runtime.storage.catalog.listBrowserSessionsBounded(2);
  const sessionId = sessions[0]?.sessionId;
  if (sessionId === undefined) throw new Error("Restart session is missing");
  const session = await runtime.storage.openSession(sessionId);
  const events = await session.getEventsAfter(0);
  const created = events.find((event) => event.eventType === "run.created");
  const runId = created?.data.runId;
  if (typeof runId !== "string") throw new Error("Restart run is missing");
  let run = await session.getRun(runId);
  for (let attempt = 0; attempt < 100 && run !== null && !["completed", "cancelled", "failed", "interrupted"].includes(run.state); attempt += 1) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    run = await session.getRun(runId);
  }
  process.stdout.write(`${JSON.stringify({
    runState: run?.state ?? null,
    providerRequests: provider.requests.length,
    backendProcessEpoch: run?.providerSelection?.credentialBackend.kind === "environment"
      ? run.providerSelection.credentialBackend.backendProcessEpoch
      : null,
  })}\n`);
}
await runtime.close();
