import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStoreManager } from "@wi/storage";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function providerDefault() {
  return {
    version: 1 as const,
    policy: { kind: "explicit" as const, connectionId: "pconn_a" },
    modelId: "fixture-model",
    capabilitiesVersion: "capver_a",
    promptVersion: "prompt-v1",
    toolSchemaHash: "a".repeat(64),
    reasoning: { effort: "none" as const, summary: "none" as const },
    transportMode: "no_network_fixture" as const,
  };
}

function providerSelection() {
  return {
    version: 1 as const,
    routingPolicy: providerDefault().policy,
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
      reasoning: providerDefault().reasoning,
      tools: true,
      transportMode: "no_network_fixture" as const,
    },
    promptVersion: "prompt-v1",
    toolSchemaHash: "a".repeat(64),
    reasoning: providerDefault().reasoning,
    transportMode: "no_network_fixture" as const,
    providerChainId: "pchain_a",
  };
}

describe("session provider defaults and run snapshots", () => {
  it("commits the default event/projection and immutable run snapshot", async () => {
    const home = await mkdtemp(join(tmpdir(), "wi-provider-session-"));
    homes.push(home);
    const manager = new SessionStoreManager({
      homeDirectory: home,
      ids: { sessionId: () => "ses_provider", eventId: () => "evt_created" },
      now: () => 1,
    });
    try {
      const created = await manager.createSession({
        v: 1,
        kind: "command",
        commandId: "cmd_create",
        method: "session.create",
        params: {},
      });
      const session = await manager.openSession(created.session.sessionId);
      const setEventId = "evt_default";
      const accepted = await session.acceptCommand({
        commandId: "cmd_default",
        commandMethod: "session.providerDefault.set",
        payloadHash: "a".repeat(64),
        result: { connectionId: "pconn_a" },
        acceptedAtMs: 2,
        runId: null,
        transaction: {
          events: [{
            eventId: setEventId,
            eventType: "session.provider_default.set",
            createdAtMs: 2,
            data: { eventVersion: 1, default: providerDefault() },
          }],
          projections: [{
            kind: "session.providerDefault.put",
            default: providerDefault(),
            eventId: setEventId,
          }],
        },
      });
      expect(accepted.duplicate).toBe(false);
      await expect(session.getProviderDefault()).resolves.toMatchObject({
        default: providerDefault(),
        eventId: setEventId,
      });

      const runProjection = {
        kind: "run.put" as const,
        runId: "run_provider",
        state: "queued" as const,
        providerId: "openai_platform",
        providerConfig: { kind: "selected_connection" },
        providerSelection: providerSelection(),
        createdAtMs: 3,
        startedAtMs: null,
        completedAtMs: null,
        cancelledAtMs: null,
        failureCategory: null,
        failureMessage: null,
        activeProviderStepId: null,
      };
      await session.appendTransaction({
        events: [{
          eventId: "evt_run",
          eventType: "run.created",
          createdAtMs: 3,
          data: { eventVersion: 2, runId: "run_provider", providerSelection: providerSelection() },
        }],
        projections: [runProjection],
      });
      await expect(session.getRun("run_provider")).resolves.toMatchObject({
        providerSelection: providerSelection(),
      });
      await expect(session.appendTransaction({
        events: [{
          eventId: "evt_conflict",
          eventType: "run.created",
          createdAtMs: 3,
          data: { eventVersion: 2, runId: "run_provider", providerSelection: {
            ...providerSelection(), modelId: "changed-model",
          } },
        }],
        projections: [{ ...runProjection, providerSelection: {
          ...providerSelection(), modelId: "changed-model",
        } }],
      })).rejects.toMatchObject({ code: "session.invalid_transition" });
    } finally {
      await manager.close();
    }
  });
});
