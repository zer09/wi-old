import { describe, expect, it } from "vitest";

import { canReuseProviderChain, providerAffinityKey } from "./affinity.js";

function snapshot() {
  return {
    version: 1 as const,
    routingPolicy: { kind: "explicit" as const, connectionId: "pconn_a" },
    routingDecision: { kind: "explicit" as const, connectionId: "pconn_a" },
    connectionId: "pconn_a",
    credentialGeneration: 1,
    lifecycleRevision: 1,
    credentialBackend: { kind: "file" as const },
    providerId: "openai_platform" as const,
    authMode: "api_key" as const,
    identity: { status: "unverified" as const },
    modelId: "fixture-model",
    capabilitiesVersion: "capver_a",
    acceptedCapabilities: {
      modelId: "fixture-model",
      reasoning: { effort: "none" as const, summary: "none" as const },
      tools: true,
      transportMode: "no_network_fixture" as const,
    },
    promptVersion: "prompt-v1",
    toolSchemaHash: "a".repeat(64),
    reasoning: { effort: "none" as const, summary: "none" as const },
    transportMode: "no_network_fixture" as const,
    providerChainId: "pchain_a",
  };
}

describe("provider affinity", () => {
  it("contains every required connection/cache dimension", () => {
    expect(providerAffinityKey(snapshot())).toMatchObject({
      connectionId: "pconn_a",
      modelId: "fixture-model",
      promptVersion: "prompt-v1",
      toolSchemaHash: "a".repeat(64),
      providerChainId: "pchain_a",
      transportMode: "no_network_fixture",
    });
  });

  it.each([
    ["connectionId", "pconn_b"],
    ["credentialGeneration", 2],
    ["modelId", "other-model"],
    ["promptVersion", "prompt-v2"],
    ["toolSchemaHash", "b".repeat(64)],
    ["transportMode", "responses_http_sse"],
  ] as const)("starts a new chain when %s changes", (field, value) => {
    const current = snapshot();
    const { providerChainId: ignoredProviderChainId, ...next } = { ...current, [field]: value };
    void ignoredProviderChainId;
    expect(canReuseProviderChain(current, next)).toBe(false);
  });
});
