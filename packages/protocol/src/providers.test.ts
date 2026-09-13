import { describe, expect, it } from "vitest";

import {
  AuthoritativeProviderIdentitySchema,
  EnvironmentVariableNameSchema,
  ProviderConnectionDisplayNameSchema,
  ProviderConnectionSafeViewSchema,
  RunProviderSelectionSnapshotSchema,
} from "./providers.js";

const identity = {
  status: "authoritative" as const,
  subjectId: "subject-a",
  workspace: { presence: "none" as const },
};

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
    identity,
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

describe("provider connection schemas", () => {
  it.each(["OPENAI_API_KEY", "_PRIVATE_1", "A"])("accepts environment name %s", (name) => {
    expect(EnvironmentVariableNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(["", "1KEY", "BAD-NAME", "WITH SPACE", "A".repeat(129)])(
    "rejects environment name %s",
    (name) => expect(EnvironmentVariableNameSchema.safeParse(name).success).toBe(false),
  );

  it("bounds provider display names by UTF-8 bytes", () => {
    expect(ProviderConnectionDisplayNameSchema.safeParse("😀".repeat(64)).success).toBe(true);
    expect(ProviderConnectionDisplayNameSchema.safeParse("😀".repeat(65)).success).toBe(false);
  });

  it("distinguishes explicit no-workspace from unknown workspace", () => {
    const none = AuthoritativeProviderIdentitySchema.parse(identity);
    const unknown = AuthoritativeProviderIdentitySchema.parse({
      ...identity,
      workspace: { presence: "unknown" },
    });
    expect(none.workspace).not.toEqual(unknown.workspace);
  });

  it("requires a stable authoritative identity and rejects unknown fields", () => {
    expect(
      AuthoritativeProviderIdentitySchema.safeParse({
        status: "authoritative",
        workspace: { presence: "none" },
      }).success,
    ).toBe(false);
    expect(
      ProviderConnectionSafeViewSchema.safeParse({ unknown: true }).success,
    ).toBe(false);
  });

  it("validates a bounded nonsecret immutable run snapshot", () => {
    expect(RunProviderSelectionSnapshotSchema.parse(snapshot())).toEqual(snapshot());
    expect(
      RunProviderSelectionSnapshotSchema.safeParse({
        ...snapshot(),
        credentialBackend: { kind: "environment", backendProcessEpoch: "process_epoch1" },
        credential: "secret",
      }).success,
    ).toBe(false);
  });
});
