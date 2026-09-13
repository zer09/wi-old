import childProcess from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const [homeDirectory] = process.argv.slice(2);
if (homeDirectory === undefined) process.exit(64);

const attempts = [];
const deny = (kind) => {
  attempts.push(kind);
  throw new Error(`Outbound operation denied: ${kind}`);
};

globalThis.fetch = async () => deny("fetch");
globalThis.WebSocket = class {
  constructor() { deny("websocket"); }
};
net.Socket.prototype.connect = function () { return deny("net.connect"); };
tls.connect = () => deny("tls.connect");
http.request = () => deny("http.request");
http.get = () => deny("http.get");
https.request = () => deny("https.request");
https.get = () => deny("https.get");
dns.lookup = () => deny("dns.lookup");
dns.resolve = () => deny("dns.resolve");
childProcess.spawn = () => deny("child_process.spawn");
childProcess.exec = () => deny("child_process.exec");
childProcess.execFile = () => deny("child_process.execFile");
childProcess.fork = () => deny("child_process.fork");

const [{ WiRuntime }, { FakeProviderAdapter }] = await Promise.all([
  import("../../apps/server/dist/index.js"),
  import("../../packages/provider-fake/dist/index.js"),
]);
process.env.WI_NO_NETWORK_PROVIDER_KEY = "no-network-process-secret";
const provider = new FakeProviderAdapter({ id: "openai_platform" });
const runtime = new WiRuntime({
  homeDirectory,
  providerConnectionFixture: {
    provider,
    capabilitiesForConnection: (connection) => ({
      version: 1,
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authMode: connection.authMode,
      capabilitiesVersion: "capver_noNetworkProcess",
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
const connectionResult = await runtime.providerConnections.route({
  v: 1,
  kind: "command",
  commandId: "cmd_noNetworkConnection",
  method: "providerConnection.environment.create",
  params: {
    providerId: "openai_platform",
    authMode: "api_key",
    displayName: "No-network process",
    variableName: "WI_NO_NETWORK_PROVIDER_KEY",
  },
});
const connectionId = connectionResult.result.connectionId;
const session = await runtime.commandRouter.route({
  v: 1,
  kind: "command",
  commandId: "cmd_noNetworkSession",
  method: "session.create",
  params: {},
}, "client_noNetwork");
await runtime.commandRouter.route({
  v: 1,
  kind: "command",
  commandId: "cmd_noNetworkDefault",
  sessionId: session.sessionId,
  method: "session.providerDefault.set",
  params: { default: {
    version: 1,
    policy: { kind: "explicit", connectionId },
    modelId: "fixture-model",
    capabilitiesVersion: "capver_noNetworkProcess",
    reasoning: { effort: "none", summary: "none" },
    transportMode: "no_network_fixture",
  } },
}, "client_noNetwork");
const submitted = await runtime.commandRouter.route({
  v: 1,
  kind: "command",
  commandId: "cmd_noNetworkSubmit",
  sessionId: session.sessionId,
  method: "message.submit",
  params: { text: "prove no outbound transport" },
}, "client_noNetwork");
const sessionStore = await runtime.storage.openSession(session.sessionId);
let run = null;
for (let attempt = 0; attempt < 100; attempt += 1) {
  run = await sessionStore.getRun(submitted.runId);
  if (["completed", "failed", "cancelled", "interrupted"].includes(run?.state)) break;
  await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
}
process.stdout.write(`${JSON.stringify({ state: run?.state ?? null, attempts })}\n`);
await runtime.close();
