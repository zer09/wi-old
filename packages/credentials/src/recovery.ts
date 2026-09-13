import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  authoritativeProviderIdentityKey,
  canonicalJson,
  RecoveryEpochIdSchema,
  RecoveryRefSchema,
  type ProviderIdentity,
} from "@wi/protocol";

import { CredentialError } from "./errors.js";
import type { CredentialFileIdentity, FileCredentialStore } from "./file-store.js";
import type { StoredCredential } from "./models.js";

export interface CredentialRecoveryCandidate {
  readonly recoveryRef: string;
  readonly originalConnectionId: string;
  readonly providerId: string;
  readonly authMode: string;
  readonly generation: number;
  readonly identity: ProviderIdentity;
  readonly updatedAtMs: number;
}

export interface CredentialRecoveryScanResult {
  readonly recoveryEpochId: string;
  readonly expiresAtMs: number;
  readonly candidates: readonly CredentialRecoveryCandidate[];
}

interface CredentialEvidence {
  readonly metadata: StoredCredential["metadata"];
  readonly apiKeyFingerprint: Buffer;
}

/**
 * Owns only the keyed fingerprint evidence needed after a public recovery epoch closes.
 * It never retains the credential string itself and can be disposed exactly once.
 */
export class ClaimedCredentialVerifier {
  private fingerprintKey: Buffer | null;
  private apiKeyFingerprint: Buffer | null;
  private disposed = false;

  constructor(
    private readonly metadata: StoredCredential["metadata"],
    fingerprintKey: Buffer,
    apiKeyFingerprint: Buffer,
  ) {
    this.fingerprintKey = Buffer.from(fingerprintKey);
    this.apiKeyFingerprint = Buffer.from(apiKeyFingerprint);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  matchesCredential(credential: StoredCredential): boolean {
    const fingerprintKey = this.fingerprintKey;
    const expected = this.apiKeyFingerprint;
    if (this.disposed || fingerprintKey === null || expected === null) {
      throw new CredentialError("credential.reference_invalid");
    }
    if (canonicalJson(credential.metadata) !== canonicalJson(this.metadata)) return false;
    const actual = credential.withApiKey((apiKey) =>
      createHmac("sha256", fingerprintKey).update(apiKey, "utf8").digest(),
    );
    try {
      return timingSafeEqual(actual, expected);
    } finally {
      actual.fill(0);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fingerprintKey?.fill(0);
    this.apiKeyFingerprint?.fill(0);
    this.fingerprintKey = null;
    this.apiKeyFingerprint = null;
  }
}

interface RecoveryBinding {
  readonly internalRef: string;
  readonly envelopeId: string;
  readonly credentialEvidence: CredentialEvidence;
  readonly candidate: CredentialRecoveryCandidate;
  claiming: boolean;
  claimed: boolean;
}

const RECOVERY_SCAN_LIFETIME_MS = 10 * 60 * 1_000;
const MAXIMUM_RECOVERY_CANDIDATES = 1_000;
const MAXIMUM_RECOVERY_SCAN_MS = 10_000;

export class CredentialRecoveryScanner {
  private epochId: string | null = null;
  private expiresAtMs = 0;
  private bindings = new Map<string, RecoveryBinding>();
  private fingerprintKey: Buffer | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: FileCredentialStore,
    private readonly now: () => number = Date.now,
    private readonly random: () => string = () => randomUUID().replaceAll("-", ""),
    private readonly includeRef: (internalRef: string) => boolean = () => true,
    private readonly onExpire: () => void = () => {},
  ) {}

  private async listRefs(): Promise<readonly string[]> {
    return this.store.listRefs();
  }

  private evidenceFor(credential: StoredCredential): CredentialEvidence {
    const fingerprintKey = this.fingerprintKey;
    if (fingerprintKey === null) throw new CredentialError("credential.reference_invalid");
    return {
      metadata: credential.metadata,
      apiKeyFingerprint: credential.withApiKey((apiKey) =>
        createHmac("sha256", fingerprintKey).update(apiKey, "utf8").digest()),
    };
  }

  private credentialMatchesEvidence(
    credential: StoredCredential,
    evidence: CredentialEvidence,
  ): boolean {
    if (canonicalJson(credential.metadata) !== canonicalJson(evidence.metadata)) return false;
    const actual = this.evidenceFor(credential).apiKeyFingerprint;
    try {
      return timingSafeEqual(actual, evidence.apiKeyFingerprint);
    } finally {
      actual.fill(0);
    }
  }

  private expire(): void {
    this.close();
    this.onExpire();
  }

  private assertWithinDeadline(startedAt: number): void {
    if (performance.now() - startedAt > MAXIMUM_RECOVERY_SCAN_MS) {
      throw new CredentialError("credential.scan_incomplete");
    }
  }

  async scanClosedRoot(): Promise<CredentialRecoveryScanResult> {
    this.close();
    this.fingerprintKey = randomBytes(32);
    const startedAt = performance.now();
    try {
      const refs = await this.listRefs();
    if (refs.length > MAXIMUM_RECOVERY_CANDIDATES) {
      throw new CredentialError("credential.scan_incomplete");
    }
    const epochId = RecoveryEpochIdSchema.parse(`recepoch_${this.random()}`);
    const expiresAtMs = this.now() + RECOVERY_SCAN_LIFETIME_MS;
    const scanned: Array<{
      readonly internalRef: string;
      readonly envelopeId: string;
      readonly credentialEvidence: CredentialEvidence;
      readonly candidate: Omit<CredentialRecoveryCandidate, "recoveryRef">;
      readonly uniquenessKeys: readonly string[];
      readonly included: boolean;
    }> = [];
    const keyCounts = new Map<string, number>();
    for (const internalRef of refs) {
      this.assertWithinDeadline(startedAt);
      const credential = await this.store.get(internalRef);
      if (credential === null) throw new CredentialError("credential.scan_incomplete");
      const metadata = credential.metadata;
      const candidate = {
        originalConnectionId: metadata.connectionId,
        providerId: metadata.providerId,
        authMode: metadata.authMode,
        generation: metadata.generation,
        identity: metadata.identity,
        updatedAtMs: metadata.updatedAtMs,
      };
      const uniquenessKeys = [`connection:${metadata.connectionId}`];
      if (
        metadata.identity.status === "authoritative" &&
        metadata.identity.workspace.presence !== "unknown"
      ) {
        uniquenessKeys.push(`identity:${authoritativeProviderIdentityKey(
          metadata.providerId,
          metadata.authMode,
          metadata.identity,
        )}`);
      }
      for (const key of uniquenessKeys) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      scanned.push({
        internalRef,
        envelopeId: metadata.envelopeId,
        credentialEvidence: this.evidenceFor(credential),
        candidate,
        uniquenessKeys,
        included: this.includeRef(internalRef),
      });
    }
    this.assertWithinDeadline(startedAt);
    const closedRefs = await this.listRefs();
    if (
      closedRefs.length !== refs.length ||
      closedRefs.some((internalRef, index) => internalRef !== refs[index])
    ) {
      throw new CredentialError("credential.scan_incomplete");
    }
    for (const scannedCredential of scanned) {
      this.assertWithinDeadline(startedAt);
      const closedCredential = await this.store.get(scannedCredential.internalRef);
      if (
        closedCredential === null ||
        !this.credentialMatchesEvidence(closedCredential, scannedCredential.credentialEvidence)
      ) {
        throw new CredentialError("credential.scan_incomplete");
      }
    }
    const bindings = new Map<string, RecoveryBinding>();
    const candidates: CredentialRecoveryCandidate[] = [];
    for (const scannedCredential of scanned) {
      if (
        !scannedCredential.included ||
        scannedCredential.uniquenessKeys.some((key) => keyCounts.get(key) !== 1)
      ) continue;
      const recoveryRef = RecoveryRefSchema.parse(`recref_${this.random()}`);
      const candidate = { recoveryRef, ...scannedCredential.candidate };
      candidates.push(candidate);
      bindings.set(recoveryRef, {
        internalRef: scannedCredential.internalRef,
        envelopeId: scannedCredential.envelopeId,
        credentialEvidence: scannedCredential.credentialEvidence,
        candidate,
        claiming: false,
        claimed: false,
      });
    }
    this.epochId = epochId;
    this.expiresAtMs = expiresAtMs;
    this.bindings = bindings;
    this.expiryTimer = setTimeout(() => {
      if (this.epochId === epochId && this.now() >= expiresAtMs) this.expire();
    }, Math.max(0, expiresAtMs - this.now()));
      this.expiryTimer.unref?.();
      return { recoveryEpochId: epochId, expiresAtMs, candidates };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async claim(
    recoveryEpochId: string,
    recoveryRef: string,
    expected: Omit<CredentialRecoveryCandidate, "recoveryRef">,
  ): Promise<{
    readonly internalRef: string;
    readonly envelopeId: string;
    readonly candidate: CredentialRecoveryCandidate;
    readonly fileIdentity: CredentialFileIdentity;
    readonly verifier: ClaimedCredentialVerifier;
  }> {
    if (this.epochId !== RecoveryEpochIdSchema.parse(recoveryEpochId)) {
      throw new CredentialError("credential.reference_invalid");
    }
    if (this.now() >= this.expiresAtMs) {
      this.expire();
      throw new CredentialError("credential.reference_invalid");
    }
    const binding = this.bindings.get(RecoveryRefSchema.parse(recoveryRef));
    if (binding === undefined) throw new CredentialError("credential.reference_invalid");
    if (binding.claiming || binding.claimed) {
      throw new CredentialError("credential.recovery_already_claimed");
    }
    if (
      binding.candidate.originalConnectionId !== expected.originalConnectionId ||
      binding.candidate.providerId !== expected.providerId ||
      binding.candidate.authMode !== expected.authMode ||
      binding.candidate.generation !== expected.generation ||
      JSON.stringify(binding.candidate.identity) !== JSON.stringify(expected.identity) ||
      binding.candidate.updatedAtMs !== expected.updatedAtMs
    ) {
      throw new CredentialError("credential.binding_mismatch");
    }
    binding.claiming = true;
    const startedAt = performance.now();
    try {
      const refs = await this.listRefs();
    if (refs.length > MAXIMUM_RECOVERY_CANDIDATES) {
      throw new CredentialError("credential.scan_incomplete");
    }
    let matchingOriginalConnection = 0;
    let matchingAuthoritativeIdentity = 0;
    const credentialEvidence = new Map<string, CredentialEvidence>();
    const expectedAuthoritativeIdentityKey =
      binding.candidate.identity.status === "authoritative" &&
      binding.candidate.identity.workspace.presence !== "unknown"
        ? authoritativeProviderIdentityKey(
            binding.candidate.providerId as "openai_platform" | "openai_codex",
            binding.candidate.authMode as "api_key" | "chatgpt_oauth",
            binding.candidate.identity,
          )
        : null;
    let exactBindingPresent = false;
    for (const internalRef of refs) {
      this.assertWithinDeadline(startedAt);
      const credential = await this.store.get(internalRef);
      if (credential === null) throw new CredentialError("credential.scan_incomplete");
      if (
        internalRef === binding.internalRef &&
        !this.credentialMatchesEvidence(credential, binding.credentialEvidence)
      ) {
        throw new CredentialError("credential.scan_incomplete");
      }
      const metadata = credential.metadata;
      credentialEvidence.set(internalRef, this.evidenceFor(credential));
      if (metadata.connectionId === binding.candidate.originalConnectionId) {
        matchingOriginalConnection += 1;
      }
      if (
        expectedAuthoritativeIdentityKey !== null &&
        metadata.identity.status === "authoritative" &&
        metadata.identity.workspace.presence !== "unknown" &&
        authoritativeProviderIdentityKey(
          metadata.providerId,
          metadata.authMode,
          metadata.identity,
        ) === expectedAuthoritativeIdentityKey
      ) {
        matchingAuthoritativeIdentity += 1;
      }
      if (
        internalRef === binding.internalRef &&
        metadata.envelopeId === binding.envelopeId &&
        metadata.connectionId === binding.candidate.originalConnectionId &&
        metadata.providerId === binding.candidate.providerId &&
        metadata.authMode === binding.candidate.authMode &&
        metadata.generation === binding.candidate.generation &&
        metadata.updatedAtMs === binding.candidate.updatedAtMs &&
        JSON.stringify(metadata.identity) === JSON.stringify(binding.candidate.identity) &&
        this.credentialMatchesEvidence(credential, binding.credentialEvidence)
      ) {
        exactBindingPresent = true;
      }
    }
    this.assertWithinDeadline(startedAt);
    const finalRefs = await this.listRefs();
    if (
      finalRefs.length !== refs.length ||
      finalRefs.some((internalRef, index) => internalRef !== refs[index])
    ) {
      throw new CredentialError("credential.scan_incomplete");
    }
    let finalMetadata: StoredCredential["metadata"] | undefined;
    let finalFileIdentity: CredentialFileIdentity | undefined;
    for (const internalRef of finalRefs) {
      this.assertWithinDeadline(startedAt);
      const finalRead = await this.store.getWithFileIdentity(internalRef);
      if (finalRead === null) throw new CredentialError("credential.scan_incomplete");
      const finalCredential = finalRead.credential;
      if (
        credentialEvidence.get(internalRef) === undefined ||
        !this.credentialMatchesEvidence(finalCredential, credentialEvidence.get(internalRef)!)
      ) {
        throw new CredentialError("credential.scan_incomplete");
      }
      if (internalRef === binding.internalRef) {
        finalMetadata = finalCredential.metadata;
        finalFileIdentity = finalRead.fileIdentity;
      }
    }
    if (
      !exactBindingPresent ||
      matchingOriginalConnection !== 1 ||
      (expectedAuthoritativeIdentityKey !== null && matchingAuthoritativeIdentity !== 1) ||
      finalMetadata?.envelopeId !== binding.envelopeId ||
      finalMetadata.connectionId !== binding.candidate.originalConnectionId ||
      finalMetadata.providerId !== binding.candidate.providerId ||
      finalMetadata.authMode !== binding.candidate.authMode ||
      finalMetadata.generation !== binding.candidate.generation ||
      finalMetadata.updatedAtMs !== binding.candidate.updatedAtMs ||
      JSON.stringify(finalMetadata.identity) !== JSON.stringify(binding.candidate.identity) ||
      finalFileIdentity === undefined
    ) {
      throw new CredentialError("credential.binding_mismatch");
    }
      const fingerprintKey = this.fingerprintKey;
      if (fingerprintKey === null) throw new CredentialError("credential.reference_invalid");
      const verifier = new ClaimedCredentialVerifier(
        binding.credentialEvidence.metadata,
        fingerprintKey,
        binding.credentialEvidence.apiKeyFingerprint,
      );
      binding.credentialEvidence.apiKeyFingerprint.fill(0);
      binding.claiming = false;
      binding.claimed = true;
      return {
        internalRef: binding.internalRef,
        envelopeId: binding.envelopeId,
        candidate: binding.candidate,
        fileIdentity: finalFileIdentity,
        verifier,
      };
    } catch (error) {
      binding.claiming = false;
      throw error;
    }
  }

  isEpochOpen(recoveryEpochId: string): boolean {
    const parsed = RecoveryEpochIdSchema.safeParse(recoveryEpochId);
    if (!parsed.success || this.epochId !== parsed.data) return false;
    if (this.now() >= this.expiresAtMs) {
      this.expire();
      return false;
    }
    return true;
  }

  close(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const binding of this.bindings.values()) {
      binding.credentialEvidence.apiKeyFingerprint.fill(0);
    }
    this.fingerprintKey?.fill(0);
    this.fingerprintKey = null;
    this.epochId = null;
    this.expiresAtMs = 0;
    this.bindings.clear();
  }
}
