import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialProvisioner, internalStagingRef } from "./provisioner.js";

const execFileAsync = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("CredentialProvisioner", () => {
  it("durably stages before returning only an opaque reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-stage-"));
    homes.push(root);
    await chmod(root, 0o700);
    const values = ["stageid", "stageref"];
    const provisioner = new CredentialProvisioner(root, () => 1_000, () => values.shift() ?? "x");
    const result = await provisioner.stageApiKey(
      "openai_platform",
      "api_key",
      "synthetic-staged-secret",
    );
    expect(result).toEqual({
      provisioningRef: "provref_stageref",
      providerId: "openai_platform",
      authMode: "api_key",
      expiresAtMs: 901_000,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-staged-secret");
    const staged = await provisioner.read(result.provisioningRef, { allowExpiredClaimed: false });
    expect(staged.provisioningId).toBe("prov_stageid");
    expect(staged.apiKey).toBe("synthetic-staged-secret");
    await provisioner.delete(result.provisioningRef);
  });

  it("exposes the stage rename hook before the post-rename commit hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-stage-hooks-"));
    homes.push(root);
    await chmod(root, 0o700);
    const boundaries: string[] = [];
    const provisioner = new CredentialProvisioner(root, () => 1_000, () => "hookid", {
      afterStageRenameBeforeFlush: () => boundaries.push("rename"),
      afterStageCommit: () => boundaries.push("commit"),
      beforeProvisioningRefReturn: () => boundaries.push("return"),
    });

    await provisioner.stageApiKey("openai_platform", "api_key", "synthetic-stage-hook-secret");
    expect(boundaries).toEqual(["rename", "commit", "return"]);
  });

  it("rejects a claimed FIFO without waiting for a writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-stage-fifo-"));
    homes.push(root);
    await chmod(root, 0o700);
    const internalRef = `stage_${"a".repeat(64)}`;
    const fifo = join(root, `stage-${"a".repeat(64)}.json`);
    await execFileAsync("mkfifo", [fifo]);
    await chmod(fifo, 0o600);

    await expect(new CredentialProvisioner(root).readClaimedInternal(internalRef)).rejects.toMatchObject({
      code: "credential.unsafe_file",
    });
  });

  it("removes strict generated orphan stage temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-stage-temp-cleanup-"));
    homes.push(root);
    await chmod(root, 0o700);
    await writeFile(join(root, ".tmp-stage-0123456789abcdef0123456789abcdef"), "secret", {
      mode: 0o600,
    });
    await writeFile(join(root, ".tmp-stage-review-secret"), "not-generated", {
      mode: 0o600,
    });

    const provisioner = new CredentialProvisioner(root);
    await expect(provisioner.cleanupExpiredUnclaimed(async () => false)).resolves.toBe(1);
    await expect(readdir(root)).resolves.toEqual([".tmp-stage-review-secret"]);
  });

  it("does not read or delete an expired stage with unsafe mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-stage-unsafe-mode-"));
    homes.push(root);
    await chmod(root, 0o700);
    const staged = await new CredentialProvisioner(root, () => 0).stageApiKey(
      "openai_platform",
      "api_key",
      "unsafe-mode-secret",
    );
    const filename = `${internalStagingRef(staged.provisioningRef).replace("stage_", "stage-")}.json`;
    await chmod(join(root, filename), 0o644);

    await expect(new CredentialProvisioner(root, () => 1_000_000).cleanupExpiredUnclaimed(
      async () => false,
    )).resolves.toBe(0);
    await expect(readdir(root)).resolves.toContain(filename);
  });

  it("fails closed while streaming one stage over the cleanup bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-stage-over-cap-"));
    homes.push(root);
    await chmod(root, 0o700);
    for (let index = 0; index <= 1_000; index += 1) {
      await writeFile(
        join(root, `stage-${index.toString(16).padStart(64, "0")}.json`),
        "{}",
        { mode: 0o600 },
      );
    }

    await expect(new CredentialProvisioner(root).cleanupExpiredUnclaimed(
      async () => false,
    )).rejects.toMatchObject({ code: "credential.scan_incomplete" });
  });
});
