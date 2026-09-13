import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialError } from "./errors.js";
import { FileCredentialStore } from "./file-store.js";
import { StoredCredential } from "./models.js";

const execFileAsync = promisify(execFile);
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wi-file-credentials-"));
  homes.push(root);
  await chmod(root, 0o700);
  const store = new FileCredentialStore(root);
  const credential = new StoredCredential({
    version: 1,
    envelopeId: "envl_a",
    connectionId: "pconn_a",
    providerId: "openai_platform",
    authMode: "api_key",
    generation: 1,
    updatedAtMs: 1,
    identity: { status: "unverified" },
    credential: { type: "api_key", apiKey: "synthetic-file-secret" },
  });
  return { root, store, credential };
}

describe("FileCredentialStore", () => {
  it("atomically writes one private file and returns a redacted credential wrapper", async () => {
    const { root, store, credential } = await fixture();
    await store.put("credref_a", credential);
    const path = join(root, "credref_a.json");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const loaded = await store.getBound("credref_a", {
      connectionId: "pconn_a",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
    });
    expect(JSON.stringify(loaded)).not.toContain("synthetic-file-secret");
    expect(inspect(loaded)).not.toContain("synthetic-file-secret");
    expect(loaded?.withApiKey((value) => value)).toBe("synthetic-file-secret");
    await expect(store.put("credref_a", credential)).resolves.toBeUndefined();
    await expect(store.put("credref_a", new StoredCredential({
      ...credential.toEnvelopeForStore(),
      envelopeId: "envl_conflict",
      credential: { type: "api_key", apiKey: "conflicting-secret" },
    }))).rejects.toMatchObject({ code: "credential.binding_mismatch" });
    expect((await store.get("credref_a"))?.withApiKey((value) => value))
      .toBe("synthetic-file-secret");
    expect(await store.listRefs()).toEqual(["credref_a"]);
  });

  it("exposes final rename and unlink hooks in namespace order", async () => {
    const { root, credential } = await fixture();
    const boundaries: string[] = [];
    const store = new FileCredentialStore(root, {
      afterCredentialRenameBeforeFlush: () => boundaries.push("rename"),
      afterCredentialUnlinkBeforeFlush: () => boundaries.push("unlink"),
    });

    await store.put("credref_a", credential);
    expect(boundaries).toEqual(["rename"]);
    await store.delete("credref_a");
    expect(boundaries).toEqual(["rename", "unlink"]);
  });

  it("repairs a verified 0644 file before reading", async () => {
    const { root, store, credential } = await fixture();
    await store.put("credref_a", credential);
    const path = join(root, "credref_a.json");
    await chmod(path, 0o644);
    await expect(store.get("credref_a")).resolves.not.toBeNull();
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("removes only strict generated orphan temporary files", async () => {
    const { root, store } = await fixture();
    await writeFile(join(root, ".tmp-0123456789abcdef0123456789abcdef"), "orphan-secret", {
      mode: 0o600,
    });
    await writeFile(join(root, ".tmp-review-secret"), "not-generated", { mode: 0o600 });

    await expect(store.cleanupOrphanedTemporaryFiles()).resolves.toBe(1);
    await expect(readdir(root)).resolves.toEqual([".tmp-review-secret"]);
  });

  it("rejects symlinks, hard links, and FIFOs without reading", async () => {
    const { root, store, credential } = await fixture();
    await store.put("credref_a", credential);
    await symlink(join(root, "credref_a.json"), join(root, "credref_link.json"));
    await expect(store.get("credref_link")).rejects.toThrowError(CredentialError);
    await link(join(root, "credref_a.json"), join(root, "extra-link"));
    await expect(store.get("credref_a")).rejects.toThrowError(CredentialError);
    const fifo = join(root, "credref_fifo.json");
    await execFileAsync("mkfifo", [fifo]);
    await chmod(fifo, 0o600);
    await expect(store.get("credref_fifo")).rejects.toMatchObject({
      code: "credential.unsafe_file",
    });
  });

  it("deletes only the selected connection file", async () => {
    const { store, credential } = await fixture();
    await store.put("credref_a", credential);
    await store.put("credref_b", new StoredCredential({
      ...credential.toEnvelopeForStore(),
      envelopeId: "envl_b",
      connectionId: "pconn_b",
    }));
    await store.delete("credref_a");
    await expect(store.get("credref_a")).resolves.toBeNull();
    await expect(store.get("credref_b")).resolves.not.toBeNull();
  });

  it("recognizes already-published replacement and deletion effects on identical retry", async () => {
    const { store, credential } = await fixture();
    await store.put("credref_a", credential);
    const originalEvidence = {
      connectionId: "pconn_a",
      providerId: "openai_platform" as const,
      authMode: "api_key" as const,
      generation: 1,
      envelopeId: "envl_a",
    };
    const replacement = new StoredCredential({
      ...credential.toEnvelopeForStore(),
      envelopeId: "envl_replacement",
      generation: 2,
      credential: { type: "api_key", apiKey: "replacement-secret" },
    });

    await store.replaceBound("credref_a", originalEvidence, replacement);
    await expect(store.replaceBound("credref_a", originalEvidence, replacement)).resolves.toBeUndefined();
    const wrongSecret = new StoredCredential({
      ...replacement.toEnvelopeForStore(),
      credential: { type: "api_key", apiKey: "wrong-replacement-secret" },
    });
    await expect(store.replaceBound("credref_a", originalEvidence, wrongSecret)).rejects.toMatchObject({
      code: "credential.binding_mismatch",
    });
    expect((await store.get("credref_a"))?.withApiKey((value) => value)).toBe("replacement-secret");
    const replacementEvidence = { ...originalEvidence, generation: 2, envelopeId: "envl_replacement" };
    await store.deleteBound("credref_a", replacementEvidence);
    await expect(store.deleteBound("credref_a", replacementEvidence)).resolves.toBeUndefined();
    await expect(store.get("credref_a")).resolves.toBeNull();
  });

  it("preserves a mismatched envelope during bound replace and delete", async () => {
    const { store, credential } = await fixture();
    const credentialB = new StoredCredential({
      ...credential.toEnvelopeForStore(),
      envelopeId: "envl_b",
      connectionId: "pconn_b",
      credential: { type: "api_key", apiKey: "connection-b-secret" },
    });
    await store.put("credref_a", credentialB);
    const evidenceA = {
      connectionId: "pconn_a",
      providerId: "openai_platform" as const,
      authMode: "api_key" as const,
      generation: 1,
      envelopeId: "envl_a",
    };

    await expect(store.replaceBound("credref_a", evidenceA, credential)).rejects.toMatchObject({
      code: "credential.binding_mismatch",
    });
    await expect(store.deleteBound("credref_a", evidenceA)).rejects.toMatchObject({
      code: "credential.binding_mismatch",
    });
    const retained = await store.get("credref_a");
    expect(retained?.metadata).toMatchObject({ connectionId: "pconn_b", envelopeId: "envl_b" });
    expect(retained?.withApiKey((value) => value)).toBe("connection-b-secret");
  });
});
