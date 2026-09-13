import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { BackendProcessEpochSchema, EnvironmentVariableNameSchema } from "@wi/protocol";

import { CredentialError } from "./errors.js";
import { MAXIMUM_API_KEY_BYTES } from "./models.js";

export interface EnvironmentCredentialLease {
  readonly runId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly lifecycleRevision: number;
  readonly variableName: string;
  readonly processEpoch: string;
  readonly fingerprint: Uint8Array;
}

export type EnvironmentResolver = (name: string) => string | undefined;

export class EnvironmentCredentialLeaseManager {
  readonly processEpoch: string;
  readonly #key: Uint8Array;
  readonly #leases = new Map<string, EnvironmentCredentialLease>();

  constructor(
    private readonly resolveEnvironment: EnvironmentResolver = (name) => process.env[name],
    options: { readonly processEpoch: string; readonly hmacKey?: Uint8Array },
  ) {
    this.processEpoch = BackendProcessEpochSchema.parse(options.processEpoch);
    this.#key = options.hmacKey === undefined ? randomBytes(32) : Uint8Array.from(options.hmacKey);
    if (this.#key.byteLength < 32) throw new RangeError("Environment lease HMAC key is too short");
  }

  private value(name: string): string {
    const variableName = EnvironmentVariableNameSchema.parse(name);
    const value = this.resolveEnvironment(variableName);
    if (value === undefined || value.length === 0) {
      throw new CredentialError("credential.environment_missing");
    }
    if (Buffer.byteLength(value, "utf8") > MAXIMUM_API_KEY_BYTES) {
      throw new CredentialError("credential.environment_invalid");
    }
    return value;
  }

  private fingerprint(value: string): Uint8Array {
    return createHmac("sha256", this.#key).update(value, "utf8").digest();
  }

  accept(input: {
    readonly runId: string;
    readonly connectionId: string;
    readonly generation: number;
    readonly lifecycleRevision: number;
    readonly variableName: string;
  }): EnvironmentCredentialLease {
    const value = this.value(input.variableName);
    const lease: EnvironmentCredentialLease = {
      ...input,
      processEpoch: this.processEpoch,
      fingerprint: this.fingerprint(value),
    };
    this.#leases.set(input.runId, lease);
    return lease;
  }

  discard(runId: string): void {
    this.#leases.delete(runId);
  }

  validate(variableName: string): void {
    this.value(variableName);
  }

  get(runId: string): EnvironmentCredentialLease | null {
    return this.#leases.get(runId) ?? null;
  }

  withCredential<T>(
    runId: string,
    expected: {
      readonly connectionId: string;
      readonly generation: number;
      readonly lifecycleRevision: number;
      readonly processEpoch: string;
    },
    use: (apiKey: string) => T,
  ): T {
    const lease = this.#leases.get(runId);
    if (lease === undefined || lease.processEpoch !== expected.processEpoch || expected.processEpoch !== this.processEpoch) {
      throw new CredentialError("credential.process_epoch_mismatch");
    }
    if (
      lease.connectionId !== expected.connectionId ||
      lease.generation !== expected.generation ||
      lease.lifecycleRevision !== expected.lifecycleRevision
    ) {
      throw new CredentialError("credential.environment_changed");
    }
    const value = this.value(lease.variableName);
    const current = this.fingerprint(value);
    if (current.byteLength !== lease.fingerprint.byteLength || !timingSafeEqual(current, lease.fingerprint)) {
      throw new CredentialError("credential.environment_changed");
    }
    return use(value);
  }

  close(): void {
    this.#leases.clear();
    this.#key.fill(0);
  }
}
