import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  acquireLifecycleOwner,
  advanceLifecycleOwner,
  canReuseProviderChain,
  type LifecycleOperationKind,
  type LifecycleState,
} from "@wi/provider-connections";
import {
  RunProviderSelectionSnapshotSchema,
  type RunProviderSelectionSnapshot,
} from "@wi/protocol";

const kinds: readonly LifecycleOperationKind[] = [
  "create", "replace", "disable", "logout", "delete",
  "reauthenticate", "refresh", "enable", "credential_recovery",
];

const seed = Number(process.env.WI_FC_SEED ?? "737373");

const hashArbitrary = fc
  .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 })
  .map((characters) => characters.join(""));

function ready(): LifecycleState {
  return {
    status: "ready",
    lifecycleRevision: 1,
    metadataRevision: 1,
    credentialGeneration: 1,
    owner: null,
    deleted: false,
  };
}

function affinityFixture(): RunProviderSelectionSnapshot {
  return RunProviderSelectionSnapshotSchema.parse({
    version: 1,
    routingPolicy: { kind: "explicit", connectionId: "pconn_affinityA" },
    routingDecision: { kind: "explicit", connectionId: "pconn_affinityA" },
    connectionId: "pconn_affinityA",
    credentialGeneration: 1,
    lifecycleRevision: 1,
    credentialBackend: { kind: "environment", backendProcessEpoch: "process_affinityA" },
    providerId: "openai_platform",
    authMode: "api_key",
    identity: {
      status: "authoritative",
      subjectId: "subject-a",
      workspace: { presence: "value", value: "workspace-a" },
    },
    modelId: "model-a",
    capabilitiesVersion: "capver_affinityA",
    acceptedCapabilities: {
      modelId: "model-a",
      reasoning: { effort: "low", summary: "auto" },
      tools: true,
      transportMode: "responses_http_sse",
    },
    promptVersion: "prompt-a",
    toolSchemaHash: "a".repeat(64),
    reasoning: { effort: "low", summary: "auto" },
    transportMode: "responses_http_sse",
    providerChainId: "pchain_affinityA",
  });
}

function withoutProviderChain(
  snapshot: RunProviderSelectionSnapshot,
): Omit<RunProviderSelectionSnapshot, "providerChainId"> {
  const { providerChainId: ignored, ...withoutChain } = snapshot;
  void ignored;
  return withoutChain;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

describe("provider lifecycle properties", () => {
  it("never admits a second distinct owner and identical retries never reserve twice", () => {
    fc.assert(fc.property(
      fc.constantFrom(...kinds),
      fc.constantFrom(...kinds),
      hashArbitrary,
      hashArbitrary,
      (firstKind, secondKind, firstHash, secondHash) => {
        const first = acquireLifecycleOwner(ready(), "cmd_first", firstHash, firstKind);
        expect(first.outcome).toBe("acquired");
        if (first.outcome !== "acquired") return;
        const retry = acquireLifecycleOwner(first.state, "cmd_first", firstHash, firstKind);
        expect(retry).toMatchObject({ outcome: "resume", state: first.state });
        const second = acquireLifecycleOwner(first.state, "cmd_second", secondHash, secondKind);
        expect(second).toMatchObject({ outcome: "operation_in_progress", state: first.state });
      },
    ), { numRuns: 250, seed });
  });

  it("terminalization clears ownership without changing reserved revisions", () => {
    fc.assert(fc.property(fc.constantFrom(...kinds), (kind) => {
      const acquired = acquireLifecycleOwner(ready(), "cmd_owner", "a".repeat(64), kind);
      if (acquired.outcome !== "acquired") throw new Error("owner missing");
      const prepared = acquired.owner.phase === "validating"
        ? advanceLifecycleOwner(acquired.state, "prepared")
        : acquired.state;
      const terminal = advanceLifecycleOwner(prepared, "failed_after_effect");
      expect(terminal.owner).toBeNull();
      expect(terminal.status).toBe("unavailable");
      expect(terminal.lifecycleRevision).toBe(acquired.state.lifecycleRevision);
      expect(terminal.credentialGeneration).toBe(acquired.state.credentialGeneration);
    }), { numRuns: 100, seed });
  });

  it("requires a new provider chain for every independently incompatible field", () => {
    const previous = affinityFixture();
    const mutations: readonly ((snapshot: RunProviderSelectionSnapshot) => unknown)[] = [
      (value) => ({ ...value, routingPolicy: { kind: "explicit", connectionId: "pconn_affinityB" } }),
      (value) => ({ ...value, routingDecision: { kind: "explicit", connectionId: "pconn_affinityB" } }),
      (value) => ({ ...value, connectionId: "pconn_affinityB" }),
      (value) => ({ ...value, credentialGeneration: 2 }),
      (value) => ({ ...value, lifecycleRevision: 2 }),
      (value) => ({ ...value, credentialBackend: { kind: "file" } }),
      (value) => ({ ...value, credentialBackend: { kind: "environment", backendProcessEpoch: "process_affinityB" } }),
      (value) => ({ ...value, providerId: "openai_codex" }),
      (value) => ({ ...value, authMode: "chatgpt_oauth" }),
      (value) => ({ ...value, identity: { ...value.identity, subjectId: "subject-b" } }),
      (value) => ({ ...value, identity: { ...value.identity, workspace: { presence: "none" } } }),
      (value) => ({ ...value, modelId: "model-b" }),
      (value) => ({ ...value, capabilitiesVersion: "capver_affinityB" }),
      (value) => ({ ...value, acceptedCapabilities: { ...value.acceptedCapabilities, modelId: "model-b" } }),
      (value) => ({ ...value, acceptedCapabilities: { ...value.acceptedCapabilities, tools: false } }),
      (value) => ({
        ...value,
        acceptedCapabilities: {
          ...value.acceptedCapabilities,
          reasoning: { effort: "high", summary: "detailed" },
        },
      }),
      (value) => ({
        ...value,
        acceptedCapabilities: {
          ...value.acceptedCapabilities,
          transportMode: "provider_websocket",
        },
      }),
      (value) => ({ ...value, promptVersion: "prompt-b" }),
      (value) => ({ ...value, toolSchemaHash: "b".repeat(64) }),
      (value) => ({ ...value, reasoning: { ...value.reasoning, effort: "high" } }),
      (value) => ({ ...value, reasoning: { ...value.reasoning, summary: "detailed" } }),
      (value) => ({ ...value, transportMode: "provider_websocket" }),
    ];
    const indices = mutations.map((_mutation, index) => index);
    fc.assert(fc.property(
      fc.shuffledSubarray(indices, { minLength: indices.length, maxLength: indices.length }),
      (order) => {
        for (const index of order) {
          const mutate = mutations[index];
          if (mutate === undefined) throw new Error("Affinity mutation is missing");
          const changed = RunProviderSelectionSnapshotSchema.parse(mutate(previous));
          expect(canReuseProviderChain(previous, withoutProviderChain(changed))).toBe(false);
        }
      },
    ), { numRuns: 25, seed });
  });

  it("reuses a provider chain across recursively reordered object keys", () => {
    const previous = affinityFixture();
    fc.assert(fc.property(fc.boolean(), () => {
      const reordered = reverseObjectKeys(withoutProviderChain(previous)) as Omit<
        RunProviderSelectionSnapshot,
        "providerChainId"
      >;
      expect(canReuseProviderChain(previous, reordered)).toBe(true);
    }), { numRuns: 25, seed });
  });
});
