import { z } from "zod";

import { CanonicalJsonValueSchema } from "./canonical-json.js";
import { TimestampMsSchema } from "./envelope.js";
import {
  BackendProcessEpochSchema,
  CapabilitiesVersionSchema,
  CommandIdSchema,
  ProviderChainIdSchema,
  ProviderConnectionIdSchema,
  RecoveryEpochIdSchema,
  RecoveryRefSchema,
} from "./ids.js";

const encoder = new TextEncoder();

function boundedUtf8(label: string, maximumBytes: number, minimumBytes = 0) {
  return z.string().superRefine((value, context) => {
    const bytes = encoder.encode(value).byteLength;
    if (bytes < minimumBytes || bytes > maximumBytes) {
      context.addIssue({
        code: "custom",
        message: `${label} must be between ${minimumBytes} and ${maximumBytes} UTF-8 bytes`,
      });
    }
  });
}

export const PROVIDER_CONNECTION_LIMITS = {
  displayNameBytes: 256,
  identityValueBytes: 256,
  modelIdBytes: 256,
  modelLabelBytes: 256,
  environmentNameBytes: 128,
  maximumModels: 64,
  maximumConnections: 1_000,
  maximumReasoningValues: 16,
} as const;

export const ProviderConnectionDisplayNameSchema = boundedUtf8(
  "Provider connection display name",
  PROVIDER_CONNECTION_LIMITS.displayNameBytes,
  1,
);

export const ProviderStepStateSchema = z.enum([
  "created",
  "streaming",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const ProviderIdSchema = z.enum(["openai_platform", "openai_codex"]);
export const ProviderAuthModeSchema = z.enum(["api_key", "chatgpt_oauth"]);
export const CredentialBackendKindSchema = z.enum(["file", "environment"]);
export const ConnectionLifecycleStatusSchema = z.enum([
  "ready",
  "reauth_required",
  "disabled",
  "rate_limited",
  "unavailable",
]);
export const IdentityVerificationStatusSchema = z.enum(["unverified", "authoritative"]);
export const WorkspaceIdentitySchema = z.discriminatedUnion("presence", [
  z.strictObject({ presence: z.literal("unknown") }),
  z.strictObject({ presence: z.literal("none") }),
  z.strictObject({
    presence: z.literal("value"),
    value: boundedUtf8("Workspace identity", PROVIDER_CONNECTION_LIMITS.identityValueBytes, 1),
  }),
]);

const OptionalIdentityValueSchema = boundedUtf8(
  "Provider identity value",
  PROVIDER_CONNECTION_LIMITS.identityValueBytes,
  1,
).optional();

export const UnverifiedProviderIdentitySchema = z.strictObject({
  status: z.literal("unverified"),
});
export const AuthoritativeProviderIdentitySchema = z
  .strictObject({
    status: z.literal("authoritative"),
    subjectId: OptionalIdentityValueSchema,
    accountId: OptionalIdentityValueSchema,
    projectId: OptionalIdentityValueSchema,
    workspace: WorkspaceIdentitySchema,
    planType: OptionalIdentityValueSchema,
  })
  .refine(
    (identity) =>
      identity.subjectId !== undefined ||
      identity.accountId !== undefined ||
      identity.projectId !== undefined,
    { message: "Authoritative identity requires a stable subject, account, or project" },
  );
export const ProviderIdentitySchema = z.discriminatedUnion("status", [
  UnverifiedProviderIdentitySchema,
  AuthoritativeProviderIdentitySchema,
]);

export function authoritativeProviderIdentityKey(
  providerId: z.infer<typeof ProviderIdSchema>,
  authMode: z.infer<typeof ProviderAuthModeSchema>,
  identity: z.infer<typeof AuthoritativeProviderIdentitySchema>,
): string {
  const stable = identity.subjectId !== undefined
    ? ["subject", identity.subjectId]
    : identity.accountId !== undefined
      ? ["account", identity.accountId]
      : ["project", identity.projectId as string];
  const workspace = identity.workspace.presence === "value"
    ? ["value", identity.workspace.value]
    : [identity.workspace.presence];
  return JSON.stringify([providerId, authMode, ...stable, ...workspace]);
}

export const EnvironmentVariableNameSchema = boundedUtf8(
  "Environment variable name",
  PROVIDER_CONNECTION_LIMITS.environmentNameBytes,
  1,
).regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

export const ProviderCredentialReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file") }),
  z.strictObject({
    kind: z.literal("environment"),
    variableName: EnvironmentVariableNameSchema,
  }),
]);

export const TransportModeSchema = z.enum([
  "responses_http_sse",
  "provider_websocket",
  "no_network_fixture",
]);
export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);
export const ProviderReasoningConfigurationSchema = z.strictObject({
  effort: ReasoningEffortSchema,
  summary: z.enum(["none", "auto", "concise", "detailed"]),
});

export const ProviderModelCapabilitySchema = z.strictObject({
  modelId: boundedUtf8("Provider model ID", PROVIDER_CONNECTION_LIMITS.modelIdBytes, 1),
  label: boundedUtf8("Provider model label", PROVIDER_CONNECTION_LIMITS.modelLabelBytes, 1),
  reasoningEfforts: z.array(ReasoningEffortSchema).max(
    PROVIDER_CONNECTION_LIMITS.maximumReasoningValues,
  ),
  reasoningSummary: z.boolean(),
  tools: z.boolean(),
  transports: z.array(TransportModeSchema).min(1).max(3),
});

export const ProviderCapabilitiesSnapshotSchema = z.strictObject({
  version: z.literal(1),
  connectionId: ProviderConnectionIdSchema,
  providerId: ProviderIdSchema,
  authMode: ProviderAuthModeSchema,
  capabilitiesVersion: CapabilitiesVersionSchema,
  models: z.array(ProviderModelCapabilitySchema).max(PROVIDER_CONNECTION_LIMITS.maximumModels),
  promptCaching: z.boolean(),
  usage: z.boolean(),
  opaqueState: z.boolean(),
  compaction: z.boolean(),
  retrievalSource: z.enum(["server_fixture", "provider"]),
  retrievedAtMs: TimestampMsSchema,
  status: z.enum(["current", "stale", "unavailable"]),
});

export const ProviderLifecycleOperationKindSchema = z.enum([
  "create",
  "replace",
  "disable",
  "logout",
  "delete",
  "reauthenticate",
  "refresh",
  "enable",
  "credential_recovery",
]);

export const ProviderConnectionSafeViewSchema = z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  providerId: ProviderIdSchema,
  authMode: ProviderAuthModeSchema,
  displayName: ProviderConnectionDisplayNameSchema,
  credentialBackend: ProviderCredentialReferenceSchema,
  credentialGeneration: z.number().int().positive().safe(),
  lifecycleRevision: z.number().int().positive().safe(),
  metadataRevision: z.number().int().positive().safe(),
  lifecycleStatus: ConnectionLifecycleStatusSchema,
  identity: ProviderIdentitySchema,
  identityVerificationStatus: IdentityVerificationStatusSchema,
  capabilitiesVersion: z.union([CapabilitiesVersionSchema, z.null()]),
  lifecycleOwnerKind: z.union([ProviderLifecycleOperationKindSchema, z.null()]),
  deleted: z.boolean(),
  recoveryTombstone: z.boolean(),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
});

export const ExplicitProviderSelectionPolicySchema = z.strictObject({
  kind: z.literal("explicit"),
  connectionId: ProviderConnectionIdSchema,
});

export const AcceptedProviderCapabilitiesSchema = z.strictObject({
  modelId: boundedUtf8("Accepted model ID", PROVIDER_CONNECTION_LIMITS.modelIdBytes, 1),
  reasoning: ProviderReasoningConfigurationSchema,
  tools: z.boolean(),
  transportMode: TransportModeSchema,
});

const CredentialBackendSnapshotSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file") }),
  z.strictObject({
    kind: z.literal("environment"),
    backendProcessEpoch: BackendProcessEpochSchema,
  }),
]);

export const RunProviderSelectionSnapshotSchema = z.strictObject({
  version: z.literal(1),
  routingPolicy: ExplicitProviderSelectionPolicySchema,
  routingDecision: z.strictObject({
    kind: z.literal("explicit"),
    connectionId: ProviderConnectionIdSchema,
  }),
  connectionId: ProviderConnectionIdSchema,
  credentialGeneration: z.number().int().positive().safe(),
  lifecycleRevision: z.number().int().positive().safe(),
  credentialBackend: CredentialBackendSnapshotSchema,
  providerId: ProviderIdSchema,
  authMode: ProviderAuthModeSchema,
  identity: ProviderIdentitySchema,
  modelId: boundedUtf8("Run provider model ID", PROVIDER_CONNECTION_LIMITS.modelIdBytes, 1),
  capabilitiesVersion: CapabilitiesVersionSchema,
  acceptedCapabilities: AcceptedProviderCapabilitiesSchema,
  promptVersion: boundedUtf8("Prompt version", 256, 1),
  toolSchemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reasoning: ProviderReasoningConfigurationSchema,
  transportMode: TransportModeSchema,
  providerChainId: ProviderChainIdSchema,
});

export const SessionProviderDefaultSchema = z.strictObject({
  version: z.literal(1),
  policy: ExplicitProviderSelectionPolicySchema,
  modelId: boundedUtf8("Default provider model ID", PROVIDER_CONNECTION_LIMITS.modelIdBytes, 1),
  capabilitiesVersion: CapabilitiesVersionSchema,
  promptVersion: boundedUtf8("Default prompt version", 256, 1),
  toolSchemaHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reasoning: ProviderReasoningConfigurationSchema,
  transportMode: TransportModeSchema,
});

export const SessionProviderDefaultRequestSchema = SessionProviderDefaultSchema.omit({
  promptVersion: true,
  toolSchemaHash: true,
});

export const ProviderConnectionListSchema = z.strictObject({
  catalogRevision: z.number().int().nonnegative().safe(),
  connections: z.array(ProviderConnectionSafeViewSchema).max(
    PROVIDER_CONNECTION_LIMITS.maximumConnections,
  ),
  truncated: z.boolean(),
});

export const CredentialRecoveryCandidateSafeViewSchema = z.strictObject({
  recoveryRef: RecoveryRefSchema,
  originalConnectionId: ProviderConnectionIdSchema,
  providerId: ProviderIdSchema,
  authMode: ProviderAuthModeSchema,
  generation: z.number().int().positive().safe(),
  identity: ProviderIdentitySchema,
  updatedAtMs: TimestampMsSchema,
});

export const CredentialRecoveryExpectedSchema = CredentialRecoveryCandidateSafeViewSchema.omit({
  recoveryRef: true,
});

export const CredentialRecoveryExpectedSafeMetadataSchema = z.strictObject({
  expected: CredentialRecoveryExpectedSchema,
  displayName: ProviderConnectionDisplayNameSchema,
});

export const CredentialRecoveryScanResultSchema = z.strictObject({
  recoveryEpochId: RecoveryEpochIdSchema,
  expiresAtMs: TimestampMsSchema,
  candidates: z.array(CredentialRecoveryCandidateSafeViewSchema).max(1_000),
});

export const CredentialRecoveryCommandStatusSchema = z.strictObject({
  commandId: CommandIdSchema,
  recoveryEpochId: RecoveryEpochIdSchema,
  status: z.enum([
    "admitting",
    "unobserved",
    "pending",
    "validating",
    "prepared",
    "file_observed",
    "succeeded",
    "failed",
    "failed_after_effect",
    "conflict",
    "rate_limited",
    "not_accepted",
  ]),
  connectionId: z.union([ProviderConnectionIdSchema, z.null()]),
  result: z.union([CanonicalJsonValueSchema, z.null()]),
  failureCode: z.union([boundedUtf8("Recovery failure code", 128, 1), z.null()]),
  expectedSafeMetadata: z.union([
    CredentialRecoveryExpectedSafeMetadataSchema,
    z.null(),
  ]),
});

export const ProviderSafeResultSchema = z.strictObject({
  code: boundedUtf8("Provider result code", 128, 1),
  message: boundedUtf8("Provider result message", 512, 1),
  data: CanonicalJsonValueSchema,
});

export type ProviderStepState = z.infer<typeof ProviderStepStateSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type ProviderAuthMode = z.infer<typeof ProviderAuthModeSchema>;
export type CredentialBackendKind = z.infer<typeof CredentialBackendKindSchema>;
export type ConnectionLifecycleStatus = z.infer<typeof ConnectionLifecycleStatusSchema>;
export type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>;
export type ProviderCredentialReference = z.infer<typeof ProviderCredentialReferenceSchema>;
export type ProviderReasoningConfiguration = z.infer<typeof ProviderReasoningConfigurationSchema>;
export type ProviderCapabilitiesSnapshot = z.infer<typeof ProviderCapabilitiesSnapshotSchema>;
export type ProviderLifecycleOperationKind = z.infer<typeof ProviderLifecycleOperationKindSchema>;
export type ProviderConnectionSafeView = z.infer<typeof ProviderConnectionSafeViewSchema>;
export type ProviderConnectionList = z.infer<typeof ProviderConnectionListSchema>;
export type CredentialRecoveryCandidateSafeView = z.infer<
  typeof CredentialRecoveryCandidateSafeViewSchema
>;
export type CredentialRecoveryExpectedSafeMetadata = z.infer<
  typeof CredentialRecoveryExpectedSafeMetadataSchema
>;
export type CredentialRecoveryScanResult = z.infer<typeof CredentialRecoveryScanResultSchema>;
export type CredentialRecoveryCommandStatus = z.infer<typeof CredentialRecoveryCommandStatusSchema>;
export type ExplicitProviderSelectionPolicy = z.infer<typeof ExplicitProviderSelectionPolicySchema>;
export type RunProviderSelectionSnapshot = z.infer<typeof RunProviderSelectionSnapshotSchema>;
export type SessionProviderDefault = z.infer<typeof SessionProviderDefaultSchema>;
export type SessionProviderDefaultRequest = z.infer<typeof SessionProviderDefaultRequestSchema>;
export type TransportMode = z.infer<typeof TransportModeSchema>;
