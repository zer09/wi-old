import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogClient, SessionStoreManager } from "@wi/storage";

import { FixtureProcessRunner } from "./fixture-process.js";

const fixture = fileURLToPath(new URL("./provider-migration-fixture.mjs", import.meta.url));
const homes: string[] = [];
const managers: SessionStoreManager[] = [];
const processes = new FixtureProcessRunner();

afterEach(async () => {
  await processes.terminateAll();
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "wi-provider-migration-"));
  homes.push(path);
  return path;
}

async function runFixture(
  path: string,
  mode: "catalog-v5" | "catalog-v6-failure" | "session-v4" | "session-v5-failure",
): Promise<string> {
  const result = await processes.run(process.execPath, [fixture, path, mode], 15_000);
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
  return result.stdout.trim();
}

describe("Milestone 11 exact prior-version migrations", () => {
  it("migrates the exact catalog v5 shape to v6 transactionally", async () => {
    const path = await home();
    await runFixture(path, "catalog-v5");
    const catalog = new CatalogClient({ homeDirectory: path, allowRepair: true });
    try {
      await catalog.getStartupState();
      await expect(catalog.getProviderCatalogState()).resolves.toEqual({
        catalogRevision: 0,
        rebuiltEpoch: 0,
        recoveryActive: false,
      });
      await expect(catalog.listProviderConnections()).resolves.toMatchObject({
        connections: [],
      });
    } finally {
      await catalog.close();
    }
  });

  it("migrates the exact session v4 shape to v5 without inventing a default", async () => {
    const path = await home();
    const sessionId = await runFixture(path, "session-v4");
    const manager = new SessionStoreManager({ homeDirectory: path });
    managers.push(manager);
    const session = await manager.openSession(sessionId);
    await expect(session.getManifest()).resolves.toMatchObject({
      schemaVersion: 5,
      lastEventSequence: 1,
    });
    await expect(session.getProviderDefault()).resolves.toBeNull();
    await expect(session.getEventsAfter(0)).resolves.toMatchObject([{
      eventId: "evt_retainedV4",
      eventType: "run.created",
      data: { eventVersion: 1, runId: "run_retainedV4" },
    }]);
    await expect(session.getRun("run_retainedV4")).resolves.toMatchObject({
      providerId: "fake",
      providerSelection: null,
      state: "completed",
    });
  });

  it("rolls back an injected catalog v6 failure and retries from frozen v5", async () => {
    const path = await home();
    await runFixture(path, "catalog-v5");
    await runFixture(path, "catalog-v6-failure");
    const catalog = new CatalogClient({ homeDirectory: path, allowRepair: true });
    try {
      await catalog.getStartupState();
      await expect(catalog.getProviderCatalogState()).resolves.toMatchObject({
        catalogRevision: 0,
        recoveryActive: false,
      });
    } finally {
      await catalog.close();
    }
  });

  it("rolls back an injected session v5 failure and retries from frozen v4", async () => {
    const path = await home();
    const sessionId = await runFixture(path, "session-v4");
    await runFixture(path, "session-v5-failure");
    const manager = new SessionStoreManager({ homeDirectory: path });
    managers.push(manager);
    const session = await manager.openSession(sessionId);
    await expect(session.getManifest()).resolves.toMatchObject({
      schemaVersion: 5,
      lastEventSequence: 1,
    });
    await expect(session.getEventsAfter(0)).resolves.toHaveLength(1);
    await expect(session.getProviderDefault()).resolves.toBeNull();
  });
});
