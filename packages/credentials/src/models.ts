import { inspect } from "node:util";
import { z } from "zod";

import {
  EnvelopeIdSchema,
  ProviderAuthModeSchema,
  ProviderConnectionIdSchema,
  ProviderIdSchema,
  ProviderIdentitySchema,
  ProvisioningIdSchema,
  TimestampMsSchema,
  type ProviderAuthMode,
  type ProviderConnectionId,
  type ProviderId,
  type ProviderIdentity,
} from "@wi/protocol";

const encoder = new TextEncoder();
export const MAXIMUM_API_KEY_BYTES = 16_384;
export const MAXIMUM_CREDENTIAL_FILE_BYTES = 64 * 1024;

const ApiKeySchema = z.string().superRefine((value, context) => {
  const bytes = encoder.encode(value).byteLength;
  if (bytes < 1 || bytes > MAXIMUM_API_KEY_BYTES) {
    context.addIssue({ code: "custom", message: "API key exceeds its private byte limit" });
  }
});

export const StoredCredentialEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  envelopeId: EnvelopeIdSchema,
  connectionId: ProviderConnectionIdSchema,
  providerId: ProviderIdSchema,
  authMode: ProviderAuthModeSchema,
  generation: z.number().int().positive().safe(),
  updatedAtMs: TimestampMsSchema,
  identity: ProviderIdentitySchema,
  credential: z.strictObject({
    type: z.literal("api_key"),
    apiKey: ApiKeySchema,
  }),
});
export type StoredCredentialEnvelope = z.infer<typeof StoredCredentialEnvelopeSchema>;

export const StagedCredentialEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  provisioningId: ProvisioningIdSchema,
  providerId: ProviderIdSchema,
  authMode: z.literal("api_key"),
  createdAtMs: TimestampMsSchema,
  expiresAtMs: TimestampMsSchema,
  apiKey: ApiKeySchema,
});
export type StagedCredentialEnvelope = z.infer<typeof StagedCredentialEnvelopeSchema>;

export interface StoredCredentialMetadata {
  readonly version: 1;
  readonly envelopeId: string;
  readonly connectionId: ProviderConnectionId;
  readonly providerId: ProviderId;
  readonly authMode: ProviderAuthMode;
  readonly generation: number;
  readonly updatedAtMs: number;
  readonly identity: ProviderIdentity;
}

export class StoredCredential {
  readonly metadata: StoredCredentialMetadata;
  readonly #apiKey: string;

  constructor(envelope: StoredCredentialEnvelope) {
    const parsed = StoredCredentialEnvelopeSchema.parse(envelope);
    this.metadata = {
      version: 1,
      envelopeId: parsed.envelopeId,
      connectionId: parsed.connectionId,
      providerId: parsed.providerId,
      authMode: parsed.authMode,
      generation: parsed.generation,
      updatedAtMs: parsed.updatedAtMs,
      identity: parsed.identity,
    };
    this.#apiKey = parsed.credential.apiKey;
  }

  withApiKey<T>(use: (apiKey: string) => T): T {
    return use(this.#apiKey);
  }

  toEnvelopeForStore(): StoredCredentialEnvelope {
    return {
      ...this.metadata,
      credential: { type: "api_key", apiKey: this.#apiKey },
    };
  }

  toJSON(): StoredCredentialMetadata & { readonly credential: "[REDACTED]" } {
    return { ...this.metadata, credential: "[REDACTED]" };
  }

  [inspect.custom](): unknown {
    return this.toJSON();
  }
}

export interface CredentialStore {
  put(ref: string, credential: StoredCredential): Promise<void>;
  get(ref: string): Promise<StoredCredential | null>;
  delete(ref: string): Promise<void>;
  listRefs(): Promise<readonly string[]>;
}
