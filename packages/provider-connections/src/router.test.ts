import { describe, expect, it } from "vitest";

import { ExplicitProviderRouter, ProviderRoutingError } from "./router.js";

const connection = {
  connectionId: "pconn_a",
  providerId: "openai_platform" as const,
  authMode: "api_key" as const,
  displayName: "Platform A",
  credentialBackend: { kind: "file" as const },
  credentialGeneration: 1,
  lifecycleRevision: 1,
  metadataRevision: 1,
  lifecycleStatus: "ready" as const,
  identity: { status: "unverified" as const },
  identityVerificationStatus: "unverified" as const,
  capabilitiesVersion: "capver_a",
  lifecycleOwnerKind: null,
  deleted: false,
  recoveryTombstone: false,
  createdAtMs: 1,
  updatedAtMs: 1,
};
const capabilities = {
  version: 1 as const,
  connectionId: "pconn_a",
  providerId: "openai_platform" as const,
  authMode: "api_key" as const,
  capabilitiesVersion: "capver_a",
  models: [{
    modelId: "fixture-model",
    label: "Fixture model",
    reasoningEfforts: ["none" as const],
    reasoningSummary: false,
    tools: true,
    transports: ["no_network_fixture" as const],
  }],
  promptCaching: false,
  usage: false,
  opaqueState: false,
  compaction: false,
  retrievalSource: "server_fixture" as const,
  retrievedAtMs: 1,
  status: "current" as const,
};
const request = {
  policy: { kind: "explicit" as const, connectionId: "pconn_a" },
  modelId: "fixture-model",
  reasoning: { effort: "none" as const, summary: "none" as const },
  transportMode: "no_network_fixture" as const,
  requiresTools: true,
  credentialBackendAvailable: true,
};

describe("ExplicitProviderRouter", () => {
  it("selects only the explicit compatible connection", () => {
    expect(
      new ExplicitProviderRouter().select(request, [{ connection, capabilities }]),
    ).toMatchObject({ kind: "explicit", connection, modelId: "fixture-model" });
  });

  it("rejects missing policy and never ranks another candidate", () => {
    expect(() =>
      new ExplicitProviderRouter().select(
        { ...request, policy: null },
        [{ connection, capabilities }],
      ),
    ).toThrowError(ProviderRoutingError);
  });

  it.each([
    ["disabled status", { connection: { ...connection, lifecycleStatus: "disabled" as const }, capabilities }],
    ["wrong model", { connection, capabilities: { ...capabilities, models: [] } }],
    ["wrong capability owner", { connection, capabilities: { ...capabilities, connectionId: "pconn_b" } }],
  ])("rejects %s without fallback", (_name, candidate) => {
    expect(() => new ExplicitProviderRouter().select(request, [candidate])).toThrow();
  });
});
