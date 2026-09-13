import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

async function document(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

describe("Milestone 11 documentation truth", () => {
  it("marks only the fake/no-network Milestone 11 foundation as implemented", async () => {
    const [plan, architecture, adrs, security] = await Promise.all([
      document("docs/plans/v0.2-openai-provider-integration.md"),
      document("docs/architecture/v0.2-provider-connections.md"),
      document("docs/adr/README.md"),
      document("docs/security.md"),
    ]);
    expect(plan).toContain("Milestone 11 implementation candidate complete");
    expect(plan).toContain("Milestone 12 not started");
    expect(plan).toContain("does **not** implement OpenAI requests");
    expect(architecture).toContain("Milestone 11 implements provider-connection identity/catalog");
    expect(architecture).toContain("OpenAI transport, OAuth, live discovery, automatic routing");
    expect(adrs).toContain("M11 file/environment stores and recovery implemented");
    expect(security).not.toContain("Planned Milestone 11 catalog-loss recovery");
    expect(security).toContain("Milestone 11 catalog-loss recovery");
  });

  it("catalogs the provider-default event, current migrations, and every M11 failpoint", async () => {
    const [events, migrations, failures] = await Promise.all([
      document("docs/reference/event-catalog.md"),
      document("docs/reference/migrations.md"),
      document("docs/architecture/failure-recovery-matrix.md"),
    ]);
    expect(events).toContain("`session.provider_default.set`");
    expect(events).toContain("version 2: `runId`, complete immutable `providerSelection`");
    expect(migrations).toContain("| Catalog | 6 |");
    expect(migrations).toContain("| Session | 5 |");
    for (const failpoint of [
      "after_provider_lifecycle_prepare",
      "after_provider_file_effect",
      "after_provider_file_observed",
      "after_provider_lifecycle_terminal_before_ack",
      "after_provider_stage_cleanup",
      "after_provider_stage_temp_flush",
      "after_provider_credential_temp_flush",
      "after_provider_stage_commit",
      "before_provider_provisioning_ref_return",
      "after_recovery_admission",
      "after_recovery_prepare",
      "after_environment_run_acceptance_before_request",
      "after_provider_credential_rename_before_flush",
      "after_provider_credential_unlink_before_flush",
      "after_provider_stage_rename_before_flush",
    ]) {
      expect(failures).toContain(`\`${failpoint}\``);
    }
  });
});
