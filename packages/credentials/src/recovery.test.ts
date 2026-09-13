import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileCredentialStore } from "./file-store.js";
import { StoredCredential } from "./models.js";
import { CredentialRecoveryScanner } from "./recovery.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("CredentialRecoveryScanner", () => {
  it("finishes a closed scan before exposing one-time process-bound references", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-scan-"));
    roots.push(root);
    const store = new FileCredentialStore(root);
    await store.put("credref_original", new StoredCredential({
      version: 1,
      envelopeId: "envl_original",
      connectionId: "pconn_original",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 4,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "private-value" },
    }));
    let counter = 0;
    const scanner = new CredentialRecoveryScanner(store, () => 100, () => `id${counter += 1}`);
    const scan = await scanner.scanClosedRoot();
    expect(JSON.stringify(scan)).not.toContain("private-value");
    expect(JSON.stringify(scan)).not.toContain("credref_original");
    expect(JSON.stringify(scan)).not.toContain("envl_original");
    const candidate = scan.candidates[0]!;
    const expected = {
      originalConnectionId: candidate.originalConnectionId,
      providerId: candidate.providerId,
      authMode: candidate.authMode,
      generation: candidate.generation,
      identity: candidate.identity,
      updatedAtMs: candidate.updatedAtMs,
    };
    const claimed = await scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, expected);
    expect(claimed).toMatchObject({ internalRef: "credref_original" });
    await expect(scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, expected)).rejects.toMatchObject({
      code: "credential.recovery_already_claimed",
    });
    scanner.close();
    expect(claimed.verifier.matchesCredential(new StoredCredential({
      version: 1,
      envelopeId: "envl_original",
      connectionId: "pconn_original",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 4,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "private-value" },
    }))).toBe(true);
    expect(claimed.verifier.matchesCredential(new StoredCredential({
      version: 1,
      envelopeId: "envl_original",
      connectionId: "pconn_original",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 4,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "substituted-private-value" },
    }))).toBe(false);
    const owned = claimed.verifier as unknown as {
      readonly fingerprintKey: Buffer | null;
      readonly apiKeyFingerprint: Buffer | null;
    };
    const fingerprintKey = owned.fingerprintKey!;
    const apiKeyFingerprint = owned.apiKeyFingerprint!;
    claimed.verifier.dispose();
    claimed.verifier.dispose();
    expect(claimed.verifier.isDisposed).toBe(true);
    expect(owned.fingerprintKey).toBeNull();
    expect(owned.apiKeyFingerprint).toBeNull();
    expect([...fingerprintKey].every((byte) => byte === 0)).toBe(true);
    expect([...apiKeyFingerprint].every((byte) => byte === 0)).toBe(true);
    try {
      claimed.verifier.matchesCredential(new StoredCredential({
        version: 1,
        envelopeId: "envl_original",
        connectionId: "pconn_original",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 4,
        updatedAtMs: 10,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: "private-value" },
      }));
      throw new Error("disposed verifier unexpectedly accepted a credential");
    } catch (error) {
      expect(error).toMatchObject({ code: "credential.reference_invalid" });
    }
    await expect(scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, expected)).rejects.toMatchObject({
      code: "credential.reference_invalid",
    });
  });

  it("linearizes concurrent claims before the first asynchronous rescan", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-concurrent-claim-"));
    roots.push(root);
    let armed = false;
    let markClaimStarted!: () => void;
    let releaseClaim!: () => void;
    const claimStarted = new Promise<void>((resolve) => { markClaimStarted = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    class GatedStore extends FileCredentialStore {
      private gated = false;

      override async listRefs(): Promise<readonly string[]> {
        if (armed && !this.gated) {
          this.gated = true;
          markClaimStarted();
          await claimGate;
        }
        return super.listRefs();
      }
    }
    const store = new GatedStore(root);
    await store.put("credref_concurrent", new StoredCredential({
      version: 1,
      envelopeId: "envl_concurrent",
      connectionId: "pconn_concurrent",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "concurrent-private-value" },
    }));
    const scanner = new CredentialRecoveryScanner(store);
    const scan = await scanner.scanClosedRoot();
    const candidate = scan.candidates[0]!;
    const expected = {
      originalConnectionId: candidate.originalConnectionId,
      providerId: candidate.providerId,
      authMode: candidate.authMode,
      generation: candidate.generation,
      identity: candidate.identity,
      updatedAtMs: candidate.updatedAtMs,
    };
    armed = true;
    const first = scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, expected);
    await claimStarted;
    await expect(scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, expected))
      .rejects.toMatchObject({ code: "credential.recovery_already_claimed" });
    releaseClaim();
    await expect(first).resolves.toMatchObject({ internalRef: "credref_concurrent" });
    scanner.close();
  });

  it("clears keyed evidence and cached bindings exactly when the epoch expires", async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), "wi-recovery-expiry-"));
      roots.push(root);
      const store = new FileCredentialStore(root);
      await store.put("credref_expiry", new StoredCredential({
        version: 1,
        envelopeId: "envl_expiry",
        connectionId: "pconn_expiry",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 1,
        updatedAtMs: 10,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: "expiry-private-value" },
      }));
      let now = 100;
      let counter = 0;
      let expirationNotices = 0;
      const scanner = new CredentialRecoveryScanner(
        store,
        () => now,
        () => `expiry${counter += 1}`,
        undefined,
        () => {
          expirationNotices += 1;
        },
      );
      const scan = await scanner.scanClosedRoot();
      const internals = scanner as unknown as {
        readonly bindings: Map<string, {
          readonly credentialEvidence: { readonly apiKeyFingerprint: Buffer };
        }>;
        readonly fingerprintKey: Buffer | null;
      };
      const retainedKey = internals.fingerprintKey!;
      const retainedFingerprint = [...internals.bindings.values()][0]!
        .credentialEvidence.apiKeyFingerprint;
      expect(JSON.stringify([...internals.bindings.values()])).not.toContain(
        "expiry-private-value",
      );

      now = scan.expiresAtMs;
      await vi.advanceTimersByTimeAsync(scan.expiresAtMs - 100);

      expect(internals.bindings.size).toBe(0);
      expect(internals.fingerprintKey).toBeNull();
      expect(expirationNotices).toBe(1);
      expect([...retainedKey].every((byte) => byte === 0)).toBe(true);
      expect([...retainedFingerprint].every((byte) => byte === 0)).toBe(true);
      expect(scanner.isEpochOpen(scan.recoveryEpochId)).toBe(false);
      await expect(scanner.scanClosedRoot()).resolves.toMatchObject({
        candidates: [expect.objectContaining({ originalConnectionId: "pconn_expiry" })],
      });
      scanner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects membership inserted while the initial scan reads candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-initial-membership-race-"));
    roots.push(root);
    const duplicate = new StoredCredential({
      version: 1,
      envelopeId: "envl_initialHidden",
      connectionId: "pconn_original",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "initial-hidden-secret" },
    });
    class MutatingStore extends FileCredentialStore {
      private listCalls = 0;
      private inserted = false;

      override async listRefs(): Promise<readonly string[]> {
        this.listCalls += 1;
        return super.listRefs();
      }

      override async get(ref: string) {
        if (this.listCalls === 1 && !this.inserted) {
          this.inserted = true;
          await super.put("credref_initialHidden", duplicate);
        }
        return super.get(ref);
      }
    }
    const store = new MutatingStore(root);
    await store.put("credref_original", new StoredCredential({
      version: 1,
      envelopeId: "envl_original",
      connectionId: "pconn_original",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "original-secret" },
    }));

    await expect(new CredentialRecoveryScanner(store, () => 100).scanClosedRoot())
      .rejects.toMatchObject({ code: "credential.scan_incomplete" });
  });

  it("rejects same-reference metadata replacement during initial discovery closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-initial-content-race-"));
    roots.push(root);
    const original = new StoredCredential({
      version: 1,
      envelopeId: "envl_initialOriginal",
      connectionId: "pconn_initialOriginal",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "initial-original-secret" },
    });
    class MutatingStore extends FileCredentialStore {
      private armed = false;
      private replaced = false;

      arm(): void {
        this.armed = true;
      }

      override async get(ref: string) {
        const credential = await super.get(ref);
        if (this.armed && !this.replaced) {
          this.replaced = true;
          await super.replaceBound(ref, {
            connectionId: "pconn_initialOriginal",
            providerId: "openai_platform",
            authMode: "api_key",
            generation: 1,
            envelopeId: "envl_initialOriginal",
          }, new StoredCredential({
            ...original.toEnvelopeForStore(),
            envelopeId: "envl_initialChanged",
            connectionId: "pconn_otherIdentity",
            credential: { type: "api_key", apiKey: "initial-changed-secret" },
          }));
        }
        return credential;
      }
    }
    const store = new MutatingStore(root);
    await store.put("credref_initialContent", original);
    store.arm();

    await expect(new CredentialRecoveryScanner(store, () => 100).scanClosedRoot())
      .rejects.toMatchObject({ code: "credential.scan_incomplete" });
  });

  it("rejects secret-only substitution during initial discovery closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-initial-secret-race-"));
    roots.push(root);
    const original = new StoredCredential({
      version: 1,
      envelopeId: "envl_initialSecret",
      connectionId: "pconn_initialSecret",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "initial-secret-a" },
    });
    const changed = new StoredCredential({
      ...original.toEnvelopeForStore(),
      credential: { type: "api_key", apiKey: "initial-secret-b" },
    });
    class SecretChangingStore extends FileCredentialStore {
      private armed = false;
      private reads = 0;

      arm(): void { this.armed = true; }

      override async get(ref: string) {
        if (this.armed && (this.reads += 1) > 1) return changed;
        return super.get(ref);
      }
    }
    const store = new SecretChangingStore(root);
    await store.put("credref_initialSecret", original);
    store.arm();

    await expect(new CredentialRecoveryScanner(store, () => 100).scanClosedRoot())
      .rejects.toMatchObject({ code: "credential.scan_incomplete" });
  });

  it("rejects secret-only substitution before exact claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-claim-secret-race-"));
    roots.push(root);
    const original = new StoredCredential({
      version: 1,
      envelopeId: "envl_claimSecret",
      connectionId: "pconn_claimSecret",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "claim-secret-a" },
    });
    const changed = new StoredCredential({
      ...original.toEnvelopeForStore(),
      credential: { type: "api_key", apiKey: "claim-secret-b" },
    });
    class SecretChangingStore extends FileCredentialStore {
      substitute = false;
      override async get(ref: string) {
        return this.substitute ? changed : super.get(ref);
      }
    }
    const store = new SecretChangingStore(root);
    await store.put("credref_claimSecret", original);
    const scanner = new CredentialRecoveryScanner(store, () => 100);
    const scan = await scanner.scanClosedRoot();
    const candidate = scan.candidates[0]!;
    store.substitute = true;

    await expect(scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, {
      originalConnectionId: candidate.originalConnectionId,
      providerId: candidate.providerId,
      authMode: candidate.authMode,
      generation: candidate.generation,
      identity: candidate.identity,
      updatedAtMs: candidate.updatedAtMs,
    })).rejects.toMatchObject({ code: "credential.scan_incomplete" });
  });

  it("rejects a stale claim when a duplicate appears after the displayed scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-stale-"));
    roots.push(root);
    const store = new FileCredentialStore(root);
    const envelope = {
      version: 1 as const,
      connectionId: "pconn_original",
      providerId: "openai_platform" as const,
      authMode: "api_key" as const,
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" as const },
      credential: { type: "api_key" as const, apiKey: "first-secret" },
    };
    await store.put("credref_first", new StoredCredential({ ...envelope, envelopeId: "envl_first" }));
    let counter = 0;
    const scanner = new CredentialRecoveryScanner(store, () => 100, () => `stale${counter += 1}`);
    const scan = await scanner.scanClosedRoot();
    const candidate = scan.candidates[0]!;
    await store.put("credref_second", new StoredCredential({
      ...envelope,
      envelopeId: "envl_second",
      credential: { type: "api_key", apiKey: "second-secret" },
    }));

    await expect(scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, {
      originalConnectionId: candidate.originalConnectionId,
      providerId: candidate.providerId,
      authMode: candidate.authMode,
      generation: candidate.generation,
      identity: candidate.identity,
      updatedAtMs: candidate.updatedAtMs,
    })).rejects.toMatchObject({ code: "credential.binding_mismatch" });
  });

  it("rejects a duplicate inserted after the claim enumeration snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-membership-race-"));
    roots.push(root);
    const duplicate = new StoredCredential({
      version: 1,
      envelopeId: "envl_hidden",
      connectionId: "pconn_original",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "hidden-secret" },
    });
    class MutatingStore extends FileCredentialStore {
      private listCalls = 0;
      private inserted = false;

      override async listRefs(): Promise<readonly string[]> {
        this.listCalls += 1;
        return super.listRefs();
      }

      override async get(ref: string) {
        if (this.listCalls === 3 && !this.inserted) {
          this.inserted = true;
          await super.put("credref_hidden", duplicate);
        }
        return super.get(ref);
      }
    }
    const store = new MutatingStore(root);
    await store.put("credref_original", new StoredCredential({
      version: 1,
      envelopeId: "envl_original",
      connectionId: "pconn_original",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "original-secret" },
    }));
    const scanner = new CredentialRecoveryScanner(store, () => 100);
    const scan = await scanner.scanClosedRoot();
    const candidate = scan.candidates[0]!;

    await expect(scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, {
      originalConnectionId: candidate.originalConnectionId,
      providerId: candidate.providerId,
      authMode: candidate.authMode,
      generation: candidate.generation,
      identity: candidate.identity,
      updatedAtMs: candidate.updatedAtMs,
    })).rejects.toMatchObject({ code: "credential.scan_incomplete" });
  });

  it("rejects same-reference metadata replacement during final claim closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-content-race-"));
    roots.push(root);
    const originalOther = new StoredCredential({
      version: 1,
      envelopeId: "envl_otherOriginal",
      connectionId: "pconn_other",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "other-original-secret" },
    });
    class MutatingStore extends FileCredentialStore {
      private listCalls = 0;
      private replaced = false;

      override async listRefs(): Promise<readonly string[]> {
        this.listCalls += 1;
        if (this.listCalls === 4 && !this.replaced) {
          this.replaced = true;
          await super.replaceBound("credref_other", {
            connectionId: "pconn_other",
            providerId: "openai_platform",
            authMode: "api_key",
            generation: 1,
            envelopeId: "envl_otherOriginal",
          }, new StoredCredential({
            ...originalOther.toEnvelopeForStore(),
            envelopeId: "envl_otherChanged",
            connectionId: "pconn_target",
            credential: { type: "api_key", apiKey: "other-changed-secret" },
          }));
        }
        return super.listRefs();
      }
    }
    const store = new MutatingStore(root);
    await store.put("credref_target", new StoredCredential({
      version: 1,
      envelopeId: "envl_target",
      connectionId: "pconn_target",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "target-secret" },
    }));
    await store.put("credref_other", originalOther);
    const scanner = new CredentialRecoveryScanner(store, () => 100);
    const scan = await scanner.scanClosedRoot();
    const candidate = scan.candidates.find((entry) =>
      entry.originalConnectionId === "pconn_target"
    )!;

    await expect(scanner.claim(scan.recoveryEpochId, candidate.recoveryRef, {
      originalConnectionId: candidate.originalConnectionId,
      providerId: candidate.providerId,
      authMode: candidate.authMode,
      generation: candidate.generation,
      identity: candidate.identity,
      updatedAtMs: candidate.updatedAtMs,
    })).rejects.toMatchObject({ code: "credential.scan_incomplete" });
  });

  it("counts represented evidence before filtering emitted recovery candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-represented-duplicate-"));
    roots.push(root);
    const store = new FileCredentialStore(root);
    const common = {
      version: 1 as const,
      providerId: "openai_platform" as const,
      authMode: "api_key" as const,
      generation: 1,
      updatedAtMs: 10,
      identity: { status: "unverified" as const },
    };
    await store.put("credref_represented", new StoredCredential({
      ...common,
      envelopeId: "envl_represented",
      connectionId: "pconn_duplicate",
      credential: { type: "api_key", apiKey: "represented-secret" },
    }));
    await store.put("credref_duplicate", new StoredCredential({
      ...common,
      envelopeId: "envl_duplicate",
      connectionId: "pconn_duplicate",
      credential: { type: "api_key", apiKey: "duplicate-secret" },
    }));
    await store.put("credref_independent", new StoredCredential({
      ...common,
      envelopeId: "envl_independent",
      connectionId: "pconn_independent",
      credential: { type: "api_key", apiKey: "independent-secret" },
    }));

    const scan = await new CredentialRecoveryScanner(
      store,
      () => 100,
      undefined,
      (internalRef) => internalRef !== "credref_represented",
    ).scanClosedRoot();
    expect(scan.candidates.map((candidate) => candidate.originalConnectionId)).toEqual([
      "pconn_independent",
    ]);
  });

  it("makes one original connection ambiguous across different generations", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-generation-duplicates-"));
    roots.push(root);
    const store = new FileCredentialStore(root);
    for (const generation of [1, 2]) {
      await store.put(`credref_generation${generation}`, new StoredCredential({
        version: 1,
        envelopeId: `envl_generation${generation}`,
        connectionId: "pconn_original",
        providerId: "openai_platform",
        authMode: "api_key",
        generation,
        updatedAtMs: generation,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: `generation-${generation}-secret` },
      }));
    }

    const scan = await new CredentialRecoveryScanner(store, () => 100).scanClosedRoot();
    expect(scan.candidates).toEqual([]);
  });

  it("uses canonical authoritative identity precedence for ambiguity", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-identity-duplicates-"));
    roots.push(root);
    const store = new FileCredentialStore(root);
    for (const [suffix, accountId] of [["first", "account-a"], ["second", "account-b"]] as const) {
      await store.put(`credref_${suffix}`, new StoredCredential({
        version: 1,
        envelopeId: `envl_${suffix}`,
        connectionId: `pconn_${suffix}`,
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 1,
        updatedAtMs: 1,
        identity: {
          status: "authoritative",
          subjectId: "shared-subject",
          accountId,
          workspace: { presence: "none" },
        },
        credential: { type: "api_key", apiKey: `${suffix}-secret` },
      }));
    }

    const scan = await new CredentialRecoveryScanner(store, () => 100).scanClosedRoot();
    expect(scan.candidates).toEqual([]);
  });

  it("does not assert uniqueness for unknown-workspace authoritative identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-unknown-workspace-"));
    roots.push(root);
    const store = new FileCredentialStore(root);
    for (const suffix of ["first", "second"] as const) {
      await store.put(`credref_unknown${suffix}`, new StoredCredential({
        version: 1,
        envelopeId: `envl_unknown${suffix}`,
        connectionId: `pconn_unknown${suffix}`,
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 1,
        updatedAtMs: 1,
        identity: {
          status: "authoritative",
          subjectId: "shared-unknown-workspace-subject",
          workspace: { presence: "unknown" },
        },
        credential: { type: "api_key", apiKey: `${suffix}-secret` },
      }));
    }

    const scan = await new CredentialRecoveryScanner(store, () => 100).scanClosedRoot();
    expect(scan.candidates).toHaveLength(2);
  });

  it("makes every duplicate original connection ineligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "wi-recovery-duplicates-"));
    roots.push(root);
    const store = new FileCredentialStore(root);
    for (const [ref, envelopeId, apiKey] of [
      ["credref_first", "envl_first", "first-secret"],
      ["credref_last", "envl_last", "last-secret"],
    ] as const) {
      await store.put(ref, new StoredCredential({
        version: 1,
        envelopeId,
        connectionId: "pconn_original",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 1,
        updatedAtMs: 10,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey },
      }));
    }

    const scan = await new CredentialRecoveryScanner(store, () => 100).scanClosedRoot();
    expect(scan.candidates).toEqual([]);
  });
});
