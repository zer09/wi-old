import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { FileCredentialStore, StoredCredential } from "@wi/credentials";
import { milestone8Parameters, milestone8Profile } from "./support/milestone8.js";

const tokenArbitrary = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), { minLength: 1, maxLength: 24 })
  .map((characters) => characters.join(""));

describe("provider credential evidence properties", () => {
  it("makes exact replacement and deletion retries idempotent without accepting stale evidence", async () => {
    await fc.assert(fc.asyncProperty(tokenArbitrary, tokenArbitrary, async (suffix, secretSuffix) => {
      const root = await mkdtemp(join(tmpdir(), "wi-property-credential-evidence-"));
      try {
        const store = new FileCredentialStore(root);
        const ref = `credref_${suffix}`;
        const original = new StoredCredential({
          version: 1,
          envelopeId: `envl_original_${suffix}`,
          connectionId: `pconn_${suffix}`,
          providerId: "openai_platform",
          authMode: "api_key",
          generation: 1,
          updatedAtMs: 1,
          identity: { status: "unverified" },
          credential: { type: "api_key", apiKey: `original-${secretSuffix}` },
        });
        const replacement = new StoredCredential({
          ...original.toEnvelopeForStore(),
          envelopeId: `envl_replacement_${suffix}`,
          generation: 2,
          updatedAtMs: 2,
          credential: { type: "api_key", apiKey: `replacement-${secretSuffix}` },
        });
        const originalEvidence = {
          connectionId: `pconn_${suffix}`,
          providerId: "openai_platform" as const,
          authMode: "api_key" as const,
          generation: 1,
          envelopeId: `envl_original_${suffix}`,
        };
        await store.put(ref, original);
        await store.replaceBound(ref, originalEvidence, replacement);
        await store.replaceBound(ref, originalEvidence, replacement);
        await expect(store.deleteBound(ref, {
          ...originalEvidence,
          generation: 1,
          envelopeId: `envl_wrong_${suffix}`,
        })).rejects.toMatchObject({ code: "credential.binding_mismatch" });
        const retained = await store.get(ref);
        expect(retained?.metadata).toMatchObject({
          generation: 2,
          envelopeId: `envl_replacement_${suffix}`,
        });
        const replacementEvidence = {
          ...originalEvidence,
          generation: 2,
          envelopeId: `envl_replacement_${suffix}`,
        };
        await store.deleteBound(ref, replacementEvidence);
        await store.deleteBound(ref, replacementEvidence);
        await expect(store.get(ref)).resolves.toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }), milestone8Profile === "property"
      ? { ...milestone8Parameters(1), numRuns: 50 }
      : milestone8Parameters(1));
  });
});
