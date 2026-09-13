import { z } from "zod";

import {
  ApprovalIdSchema,
  CanonicalJsonValueSchema,
  CommandIdSchema,
  CommandMethodSchema,
  CapabilitiesVersionSchema,
  DiagnosticIdSchema,
  EnvelopeIdSchema,
  EnvironmentVariableNameSchema,
  EventIdSchema,
  InputIdSchema,
  MessageIdSchema,
  PartIdSchema,
  ProjectIdSchema,
  ProviderAuthModeSchema,
  ProviderCapabilitiesSnapshotSchema,
  ProviderConnectionIdSchema,
  ProviderIdSchema,
  ProviderConnectionSafeViewSchema,
  ProviderIdentitySchema,
  ProviderLifecycleOperationKindSchema,
  ProviderStepIdSchema,
  ProviderStepStateSchema,
  ProvisioningIdSchema,
  RecoveryEpochIdSchema,
  RunIdSchema,
  RunProviderSelectionSnapshotSchema,
  RunStateSchema,
  SafeDiagnosticMessageSchema,
  SessionProviderDefaultSchema,
  SessionEventSchema,
  SessionEventTypeSchema,
  SessionIdSchema,
  TimestampMsSchema,
  ToolCallIdSchema,
  ToolEffectClassSchema,
  ToolExecutionStateSchema,
} from "@wi/protocol";

export const CATALOG_SCHEMA_VERSION = 6;
export const SESSION_SCHEMA_VERSION = 5;
export const SESSION_FORMAT_VERSION = 1;

export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const NullableStringSchema = z.union([z.string(), z.null()]);
export const NullableDiagnosticMessageSchema = z.union([
  SafeDiagnosticMessageSchema,
  z.null(),
]);
export const NullableTimestampSchema = z.union([TimestampMsSchema, z.null()]);
export const SessionStatusSchema = z.enum(["ready", "missing", "unavailable"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ProjectRecordSchema = z.strictObject({
  projectId: ProjectIdSchema,
  name: z.string().min(1),
  rootPath: z.string().min(1),
  rootRealpath: z.string().min(1),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  config: CanonicalJsonValueSchema,
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const SessionSummarySchema = z.strictObject({
  sessionId: SessionIdSchema,
  projectId: z.union([ProjectIdSchema, z.null()]),
  dbRelativePath: z.string().min(1),
  title: z.string(),
  status: SessionStatusSchema,
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
  lastEventSequence: z.number().int().nonnegative().safe(),
  lastRunState: z.union([RunStateSchema, z.null()]),
  lastMessagePreview: NullableStringSchema,
  requiresAttention: z.boolean(),
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
  sessionSchemaVersion: z.number().int().positive().safe(),
  recoveryCandidate: z.boolean().default(false),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type SessionSummaryInput = z.input<typeof SessionSummarySchema>;

export const SessionCreationRequestSchema = z.strictObject({
  title: z.string(),
  projectId: z.union([ProjectIdSchema, z.null()]),
});
export type SessionCreationRequest = z.infer<typeof SessionCreationRequestSchema>;

export const GlobalCommandRecordSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: z.literal("session.create"),
  payloadHash: HashSchema,
  state: z.enum(["creating", "accepted", "failed"]),
  reservedSessionId: SessionIdSchema,
  reservedEventId: EventIdSchema,
  request: SessionCreationRequestSchema,
  result: z.union([CanonicalJsonValueSchema, z.null()]),
  acceptedAtMs: NullableTimestampSchema,
  failureCode: NullableStringSchema,
  failureMessage: NullableStringSchema,
  diagnosticId: z.union([DiagnosticIdSchema, z.null()]),
  quarantinedRelativePath: NullableStringSchema,
  updatedAtMs: TimestampMsSchema,
});
export type GlobalCommandRecord = z.infer<typeof GlobalCommandRecordSchema>;

export const GlobalCommandReservationSchema = z.strictObject({
  command: GlobalCommandRecordSchema,
  duplicate: z.boolean(),
});
export type GlobalCommandReservation = z.infer<typeof GlobalCommandReservationSchema>;

export const InternalCredentialRefSchema = z.string().regex(/^credref_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u);
export const InternalStagingRefSchema = z.string().regex(/^stage_[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u);

export const ProviderConnectionRecordSchema = ProviderConnectionSafeViewSchema.extend({
  credentialInternalRef: z.union([InternalCredentialRefSchema, z.null()]),
  envelopeId: z.union([EnvelopeIdSchema, z.null()]),
});
export type ProviderConnectionRecord = z.infer<typeof ProviderConnectionRecordSchema>;

export const ProviderCatalogStateSchema = z.strictObject({
  catalogRevision: z.number().int().nonnegative().safe(),
  rebuiltEpoch: z.number().int().nonnegative().safe(),
  recoveryActive: z.boolean(),
});
export type ProviderCatalogState = z.infer<typeof ProviderCatalogStateSchema>;

export const ProviderLifecycleOperationPhaseSchema = z.enum([
  "validating",
  "prepared",
  "file_observed",
  "succeeded",
  "failed",
  "failed_after_effect",
]);
export const ProviderCredentialFileIdentitySchema = z.strictObject({
  device: z.string().regex(/^\d{1,32}$/u),
  inode: z.string().regex(/^\d{1,32}$/u),
  size: z.string().regex(/^\d{1,32}$/u),
  ctimeNs: z.string().regex(/^\d{1,32}$/u),
});
export type ProviderCredentialFileIdentity = z.infer<typeof ProviderCredentialFileIdentitySchema>;

export const ProviderLifecycleOperationRecordSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: z.string().min(1).max(128),
  contentHash: HashSchema,
  operationKind: ProviderLifecycleOperationKindSchema,
  targetConnectionId: ProviderConnectionIdSchema,
  expectedLifecycleRevision: z.union([z.number().int().positive().safe(), z.null()]),
  expectedGeneration: z.union([z.number().int().positive().safe(), z.null()]),
  reservedLifecycleRevision: z.number().int().positive().safe(),
  reservedGeneration: z.number().int().positive().safe(),
  ownerKey: z.string().min(1).max(256),
  provisioningId: z.union([ProvisioningIdSchema, z.null()]),
  stagingInternalRef: z.union([InternalStagingRefSchema, z.null()]),
  stagingFileIdentity: z.union([ProviderCredentialFileIdentitySchema, z.null()]),
  credentialBackendKind: z.enum(["file", "environment"]),
  credentialInternalRef: z.union([InternalCredentialRefSchema, z.null()]),
  envelopeId: z.union([EnvelopeIdSchema, z.null()]),
  recoveryEpochId: z.union([RecoveryEpochIdSchema, z.null()]),
  expectedSafeMetadata: z.union([CanonicalJsonValueSchema, z.null()]),
  recoveryFileIdentity: z.union([ProviderCredentialFileIdentitySchema, z.null()]),
  phase: ProviderLifecycleOperationPhaseSchema,
  result: z.union([CanonicalJsonValueSchema, z.null()]),
  failureCode: NullableStringSchema,
  failureMessage: NullableDiagnosticMessageSchema,
  diagnosticId: z.union([DiagnosticIdSchema, z.null()]),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
});
export type ProviderLifecycleOperationRecord = z.infer<typeof ProviderLifecycleOperationRecordSchema>;

export const ProviderCapabilityRecordSchema = z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  capabilitiesVersion: CapabilitiesVersionSchema,
  snapshot: ProviderCapabilitiesSnapshotSchema,
  createdAtMs: TimestampMsSchema,
});
export type ProviderCapabilityRecord = z.infer<typeof ProviderCapabilityRecordSchema>;

export const EnvironmentConnectionRegistrationSchema = z.strictObject({
  commandId: CommandIdSchema,
  contentHash: HashSchema,
  connectionId: ProviderConnectionIdSchema,
  providerId: z.literal("openai_platform"),
  authMode: z.literal("api_key"),
  displayName: z.string().min(1).max(256),
  variableName: EnvironmentVariableNameSchema,
  identity: ProviderIdentitySchema,
  identityClaim: z.union([
    z.strictObject({
      identityKey: z.string().min(1).max(1_024),
      stableKind: z.enum(["subject", "account", "project"]),
      stableValue: z.string().min(1).max(256),
      workspacePresence: z.enum(["unknown", "none", "value"]),
      workspaceValue: z.string().max(256),
    }),
    z.null(),
  ]),
  initialStatus: z.enum(["ready", "unavailable"]),
  createdAtMs: TimestampMsSchema,
});
export type EnvironmentConnectionRegistration = z.infer<typeof EnvironmentConnectionRegistrationSchema>;

export const FileConnectionReservationSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: z.literal("providerConnection.file.create"),
  contentHash: HashSchema,
  connectionId: ProviderConnectionIdSchema,
  providerId: z.literal("openai_platform"),
  authMode: z.literal("api_key"),
  displayName: z.string().min(1).max(256),
  identity: ProviderIdentitySchema,
  credentialInternalRef: InternalCredentialRefSchema,
  targetEnvelopeId: EnvelopeIdSchema,
  provisioningId: ProvisioningIdSchema,
  stagingInternalRef: InternalStagingRefSchema,
  stagingFileIdentity: ProviderCredentialFileIdentitySchema,
  createdAtMs: TimestampMsSchema,
});
export type FileConnectionReservation = z.infer<typeof FileConnectionReservationSchema>;

export const RecoveryAdmissionSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: z.literal("providerConnection.recover"),
  contentHash: HashSchema,
  connectionId: ProviderConnectionIdSchema,
  generation: z.number().int().positive().safe(),
  recoveryEpochId: RecoveryEpochIdSchema,
  expectedSafeMetadata: CanonicalJsonValueSchema,
  createdAtMs: TimestampMsSchema,
});
export type RecoveryAdmission = z.infer<typeof RecoveryAdmissionSchema>;

export const RecoveredConnectionReservationSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: z.literal("providerConnection.recover"),
  contentHash: HashSchema,
  connectionId: ProviderConnectionIdSchema,
  providerId: ProviderIdSchema,
  authMode: ProviderAuthModeSchema,
  displayName: z.string().min(1).max(256),
  identity: ProviderIdentitySchema,
  identityClaim: z.union([
    z.strictObject({
      identityKey: z.string().min(1).max(1_024),
      stableKind: z.enum(["subject", "account", "project"]),
      stableValue: z.string().min(1).max(256),
      workspacePresence: z.enum(["unknown", "none", "value"]),
      workspaceValue: z.string().max(256),
    }),
    z.null(),
  ]),
  generation: z.number().int().positive().safe(),
  credentialInternalRef: InternalCredentialRefSchema,
  envelopeId: EnvelopeIdSchema,
  recoveryEpochId: RecoveryEpochIdSchema,
  recoveryFileIdentity: ProviderCredentialFileIdentitySchema,
  createdAtMs: TimestampMsSchema,
});
export type RecoveredConnectionReservation = z.infer<typeof RecoveredConnectionReservationSchema>;

export const SessionCatalogProjectionSchema = z.strictObject({
  updatedAtMs: TimestampMsSchema,
  lastRunState: z.union([RunStateSchema, z.null()]),
  lastMessagePreview: NullableStringSchema,
});
export type SessionCatalogProjection = z.infer<typeof SessionCatalogProjectionSchema>;

export const SessionCatalogObservationSchema = z.strictObject({
  headSequence: z.number().int().nonnegative().safe(),
  projection: SessionCatalogProjectionSchema,
  pendingApprovalCount: z.number().int().nonnegative().safe(),
  pendingInputCount: z.number().int().nonnegative().safe(),
  recoveryNeeded: z.boolean(),
});
export type SessionCatalogObservation = z.infer<typeof SessionCatalogObservationSchema>;

export const SessionManifestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  projectId: z.union([ProjectIdSchema, z.null()]),
  createdAtMs: TimestampMsSchema,
  schemaVersion: z.number().int().positive().safe(),
  formatVersion: z.number().int().positive().safe(),
  title: z.string(),
  lastEventSequence: z.number().int().nonnegative().safe(),
});
export type SessionManifest = z.infer<typeof SessionManifestSchema>;

export const CreationProvenanceSchema = z.strictObject({
  commandId: CommandIdSchema,
  payloadHash: HashSchema,
  commandMethod: z.literal("session.create"),
  eventId: EventIdSchema,
  result: z.strictObject({ sessionId: SessionIdSchema }),
  acceptedAtMs: TimestampMsSchema,
});
export type CreationProvenance = z.infer<typeof CreationProvenanceSchema>;

export const SESSION_EVENT_PAGE_BOUNDS = {
  maximumEvents: 256,
  envelopeReserveBytes: 1_024,
  minimumBytes: 1_025,
  maximumBytes: 1_000_000,
  maximumSingleEventBytes: 1_000_000 - 1_024,
} as const;

export const SessionEventPageInputSchema = z
  .strictObject({
    afterSequence: z.number().int().nonnegative().safe(),
    throughSequence: z.number().int().nonnegative().safe(),
    maximumEvents: z.number().int().positive().max(SESSION_EVENT_PAGE_BOUNDS.maximumEvents),
    maximumBytes: z
      .number()
      .int()
      .min(SESSION_EVENT_PAGE_BOUNDS.minimumBytes)
      .max(SESSION_EVENT_PAGE_BOUNDS.maximumBytes),
    maximumSingleEventBytes: z
      .number()
      .int()
      .positive()
      .max(SESSION_EVENT_PAGE_BOUNDS.maximumSingleEventBytes),
  })
  .refine(
    (input) =>
      input.maximumSingleEventBytes <=
      input.maximumBytes - SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
    {
      message: "A replay event and its response envelopes must fit within the page byte limit",
    },
  );
export type SessionEventPageInput = z.infer<typeof SessionEventPageInputSchema>;

export const SessionEventPageSchema = z.strictObject({
  events: z.array(SessionEventSchema).max(256),
  nextAfterSequence: z.number().int().nonnegative().safe(),
  done: z.boolean(),
  serializedBytes: z.number().int().nonnegative().safe(),
});
export type SessionEventPage = z.infer<typeof SessionEventPageSchema>;

export const NewSessionEventSchema = z.strictObject({
  eventId: EventIdSchema,
  eventType: SessionEventTypeSchema,
  createdAtMs: TimestampMsSchema,
  data: z.unknown(),
  itemId: z.string().nullable().optional(),
});
export type NewSessionEvent = z.infer<typeof NewSessionEventSchema>;

export const RunProjectionSchema = z.strictObject({
  kind: z.literal("run.put"),
  runId: RunIdSchema,
  state: RunStateSchema,
  providerId: z.string().min(1),
  providerConfig: CanonicalJsonValueSchema,
  providerSelection: RunProviderSelectionSnapshotSchema.nullable().optional(),
  createdAtMs: TimestampMsSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  cancelledAtMs: NullableTimestampSchema,
  failureCategory: NullableStringSchema,
  failureMessage: NullableDiagnosticMessageSchema,
  activeProviderStepId: NullableStringSchema,
});

export const RunStateProjectionSchema = z.strictObject({
  kind: z.literal("run.state"),
  runId: RunIdSchema,
  expectedState: RunStateSchema,
  nextState: RunStateSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  cancelledAtMs: NullableTimestampSchema,
  failureCategory: NullableStringSchema,
  failureMessage: NullableDiagnosticMessageSchema,
  activeProviderStepId: NullableStringSchema,
});

export const MessageProjectionSchema = z.strictObject({
  kind: z.literal("message.put"),
  messageId: MessageIdSchema,
  runId: z.union([RunIdSchema, z.null()]),
  role: z.enum(["user", "assistant", "tool", "system"]),
  state: z.string().min(1),
  createdAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
});

export const MessagePartProjectionSchema = z.strictObject({
  kind: z.literal("messagePart.put"),
  partId: PartIdSchema,
  messageId: MessageIdSchema,
  partIndex: z.number().int().nonnegative().safe(),
  partType: z.string().min(1),
  textContent: NullableStringSchema,
  data: z.union([CanonicalJsonValueSchema, z.null()]),
});

export const RunActiveProviderStepProjectionSchema = z.strictObject({
  kind: z.literal("run.activeProviderStep"),
  runId: RunIdSchema,
  expectedActiveProviderStepId: z.union([ProviderStepIdSchema, z.null()]),
  activeProviderStepId: z.union([ProviderStepIdSchema, z.null()]),
});

export const ProviderStepProjectionSchema = z.strictObject({
  kind: z.literal("providerStep.put"),
  stepId: ProviderStepIdSchema,
  expectedState: ProviderStepStateSchema.optional(),
  runId: RunIdSchema,
  stepIndex: z.number().int().nonnegative().safe(),
  state: ProviderStepStateSchema,
  startedAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
  responseId: NullableStringSchema,
  errorCategory: NullableStringSchema,
  errorMessage: NullableDiagnosticMessageSchema,
  diagnosticId: z.union([DiagnosticIdSchema, z.null()]).optional(),
});

export const ProviderStepRecordSchema = z.strictObject({
  stepId: ProviderStepIdSchema,
  runId: RunIdSchema,
  stepIndex: z.number().int().nonnegative().safe(),
  state: ProviderStepStateSchema,
  startedAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
  responseId: NullableStringSchema,
  errorCategory: NullableStringSchema,
  errorMessage: NullableStringSchema,
  diagnosticId: z.union([DiagnosticIdSchema, z.null()]),
});
export type ProviderStepRecord = z.infer<typeof ProviderStepRecordSchema>;

export const ToolExecutionProjectionSchema = z.strictObject({
  kind: z.literal("toolExecution.put"),
  callId: ToolCallIdSchema,
  expectedState: ToolExecutionStateSchema.optional(),
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
  toolName: z.string().min(1),
  argumentsJson: z.string(),
  argumentsHash: HashSchema,
  effectClass: z.union([ToolEffectClassSchema, z.null()]),
  state: ToolExecutionStateSchema,
  attemptCount: z.number().int().nonnegative().safe(),
  requestedAtMs: TimestampMsSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  result: z.union([CanonicalJsonValueSchema, z.null()]),
  error: z.union([CanonicalJsonValueSchema, z.null()]),
});

export const ToolCallOccurrenceProjectionSchema = z.strictObject({
  kind: z.literal("toolCallOccurrence.put"),
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
  callId: ToolCallIdSchema,
  occurredAtMs: TimestampMsSchema,
});

export const ToolExecutionRecordSchema = ToolExecutionProjectionSchema.omit({
  kind: true,
  expectedState: true,
});
export type ToolExecutionRecord = z.infer<typeof ToolExecutionRecordSchema>;

export const ApprovalProjectionSchema = z.strictObject({
  kind: z.literal("approval.put"),
  approvalId: ApprovalIdSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
  state: z.literal("pending"),
  actionDigest: HashSchema,
  requestedAtMs: TimestampMsSchema,
});

export const ApprovalResolutionProjectionSchema = z.strictObject({
  kind: z.literal("approval.resolve"),
  approvalId: ApprovalIdSchema,
  resolution: z.enum(["approved", "denied"]),
  resolvedAtMs: TimestampMsSchema,
  resolvedByClientId: z.string().min(1),
});

export const PendingInputProjectionSchema = z.strictObject({
  kind: z.literal("input.put"),
  inputId: z.string().min(1),
  runId: RunIdSchema,
  state: z.literal("pending"),
  prompt: z.string(),
  requestedAtMs: TimestampMsSchema,
});

export const InputResolutionProjectionSchema = z.strictObject({
  kind: z.literal("input.resolve"),
  inputId: z.string().min(1),
  resolvedAtMs: TimestampMsSchema,
  value: CanonicalJsonValueSchema,
});

export const PendingInteractionsCancellationProjectionSchema = z.strictObject({
  kind: z.literal("run.pendingInteractions.cancel"),
  runId: RunIdSchema,
  cancelledAtMs: TimestampMsSchema,
});

export const SessionProviderDefaultProjectionSchema = z.strictObject({
  kind: z.literal("session.providerDefault.put"),
  default: SessionProviderDefaultSchema,
  eventId: EventIdSchema,
});

export const ProjectionMutationSchema = z.discriminatedUnion("kind", [
  RunProjectionSchema,
  RunStateProjectionSchema,
  MessageProjectionSchema,
  MessagePartProjectionSchema,
  RunActiveProviderStepProjectionSchema,
  ProviderStepProjectionSchema,
  ToolExecutionProjectionSchema,
  ToolCallOccurrenceProjectionSchema,
  ApprovalProjectionSchema,
  ApprovalResolutionProjectionSchema,
  PendingInputProjectionSchema,
  InputResolutionProjectionSchema,
  PendingInteractionsCancellationProjectionSchema,
  SessionProviderDefaultProjectionSchema,
]);
export type ProjectionMutation = z.infer<typeof ProjectionMutationSchema>;

const TransactionProjectionFields = {
  projections: z.array(ProjectionMutationSchema).default([]),
  testFailpoint: z
    .enum([
      "crash_before_commit",
      "crash_after_commit",
      "after_command_event_insert_before_commit",
    ])
    .optional(),
} as const;

export const AppendTransactionInputSchema = z.strictObject({
  events: z.array(NewSessionEventSchema).min(1),
  ...TransactionProjectionFields,
});
export type AppendTransactionInput = z.input<typeof AppendTransactionInputSchema>;

// An idempotent command may be a durable no-op, such as cancelling an already terminal run.
// Its acceptance still commits even though it does not invent a session event.
export const AcceptCommandTransactionInputSchema = z.strictObject({
  events: z.array(NewSessionEventSchema),
  ...TransactionProjectionFields,
});

export const AcceptCommandInputSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: CommandMethodSchema,
  payloadHash: HashSchema,
  result: CanonicalJsonValueSchema,
  acceptedAtMs: TimestampMsSchema,
  runId: z.union([RunIdSchema, z.null()]),
  transaction: AcceptCommandTransactionInputSchema,
});
export type AcceptCommandInput = z.input<typeof AcceptCommandInputSchema>;

export const AcceptedCommandResultSchema = z.strictObject({
  commandId: CommandIdSchema,
  commandMethod: CommandMethodSchema,
  payloadHash: HashSchema,
  acceptedSequence: z.union([z.number().int().positive().safe(), z.null()]),
  runId: z.union([RunIdSchema, z.null()]),
  result: CanonicalJsonValueSchema,
  acceptedAtMs: TimestampMsSchema,
  duplicate: z.boolean(),
  events: z.array(SessionEventSchema),
});
export type AcceptedCommandResult = z.infer<typeof AcceptedCommandResultSchema>;

export const AppendTransactionResultSchema = z.strictObject({
  events: z.array(SessionEventSchema),
  headSequence: z.number().int().positive().safe(),
});
export type AppendTransactionResult = z.infer<typeof AppendTransactionResultSchema>;

export const AppendTransactionInspectionSchema = z.strictObject({
  storedEvents: z.array(z.union([SessionEventSchema, z.null()])),
  headSequence: z.number().int().nonnegative().safe(),
  projectionsApplied: z.boolean(),
});
export type AppendTransactionInspection = z.infer<typeof AppendTransactionInspectionSchema>;

const ProviderRequestAcquisitionLimitSchema = z.number().int().positive().max(1024 * 1024);
export const BoundedProviderRequestDataInputSchema = z.strictObject({
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
  stepIndex: z.number().int().nonnegative().safe(),
  expectedProviderId: z.string().min(1).max(256),
  maxProviderConfigBytes: ProviderRequestAcquisitionLimitSchema,
  maxMessageTextBytes: ProviderRequestAcquisitionLimitSchema,
  maxToolNameBytes: ProviderRequestAcquisitionLimitSchema,
  maxInputItems: z.number().int().positive().max(1024),
  maxRequestBytes: ProviderRequestAcquisitionLimitSchema,
});
export type BoundedProviderRequestDataInput = z.infer<
  typeof BoundedProviderRequestDataInputSchema
>;

export const RunProviderMatchSchema = z.enum(["missing", "match", "mismatch"]);
export type RunProviderMatch = z.infer<typeof RunProviderMatchSchema>;

export const BoundedProviderRequestDataSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("missing") }),
  z.strictObject({ status: z.literal("provider_mismatch") }),
  z.strictObject({ status: z.literal("unsafe_outcome_unknown") }),
  z.strictObject({
    status: z.literal("limit_exceeded"),
    boundary: z.enum([
      "provider_config",
      "message_text",
      "tool_name",
      "input_items",
      "request_bytes",
    ]),
  }),
  z.strictObject({
    status: z.literal("ready"),
    requestJson: z.string().max(1024 * 1024),
  }),
]);
export type BoundedProviderRequestData = z.infer<typeof BoundedProviderRequestDataSchema>;

export const RunRecordSchema = z.strictObject({
  runId: RunIdSchema,
  state: RunStateSchema,
  providerId: z.string().min(1),
  providerConfig: CanonicalJsonValueSchema,
  providerSelection: z.union([RunProviderSelectionSnapshotSchema, z.null()]).optional(),
  createdAtMs: TimestampMsSchema,
  startedAtMs: NullableTimestampSchema,
  completedAtMs: NullableTimestampSchema,
  cancelledAtMs: NullableTimestampSchema,
  failureCategory: NullableStringSchema,
  failureMessage: NullableStringSchema,
  activeProviderStepId: NullableStringSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const SessionProviderDefaultRecordSchema = z.strictObject({
  default: SessionProviderDefaultSchema,
  updatedSequence: z.number().int().positive().safe(),
  eventId: EventIdSchema,
});
export type SessionProviderDefaultRecord = z.infer<typeof SessionProviderDefaultRecordSchema>;

export const PendingApprovalRecordSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
  state: z.literal("pending"),
  actionDigest: HashSchema,
  requestedAtMs: TimestampMsSchema,
});
export type PendingApprovalRecord = z.infer<typeof PendingApprovalRecordSchema>;

export const PendingInputRecordSchema = z.strictObject({
  inputId: InputIdSchema,
  runId: RunIdSchema,
  state: z.literal("pending"),
  prompt: z.string(),
  requestedAtMs: TimestampMsSchema,
});
export type PendingInputRecord = z.infer<typeof PendingInputRecordSchema>;

export const InputRecordSchema = z.strictObject({
  inputId: InputIdSchema,
  runId: RunIdSchema,
  state: z.enum(["pending", "resolved", "cancelled"]),
  prompt: z.string(),
  requestedAtMs: TimestampMsSchema,
  resolvedAtMs: NullableTimestampSchema,
  value: CanonicalJsonValueSchema,
});
export type InputRecord = z.infer<typeof InputRecordSchema>;

export const RunMessageRecordSchema = z.strictObject({
  messageId: MessageIdSchema,
  runId: RunIdSchema,
  role: z.enum(["user", "assistant", "tool", "system"]),
  state: z.string().min(1),
  text: z.string(),
  createdAtMs: TimestampMsSchema,
  completedAtMs: NullableTimestampSchema,
});
export type RunMessageRecord = z.infer<typeof RunMessageRecordSchema>;

export const StartedToolRecoveryRecordSchema = z.strictObject({
  callId: ToolCallIdSchema,
  effectClass: ToolEffectClassSchema,
});

export const SessionRecoveryResultSchema = z.strictObject({
  interruptedRunIds: z.array(RunIdSchema),
  interruptedStepIds: z.array(z.string().min(1)),
  startedToolCalls: z.array(StartedToolRecoveryRecordSchema),
  outcomeUnknownRunIds: z.array(RunIdSchema),
});
export type SessionRecoveryResult = z.infer<typeof SessionRecoveryResultSchema>;
