import { z } from "zod";

import { canonicalJsonHash } from "./canonical-json.js";
import { CanonicalJsonValueSchema } from "./canonical-json.js";
import { ProtocolVersionSchema, SequenceSchema, TimestampMsSchema } from "./envelope.js";
import {
  ApprovalIdSchema,
  ClientIdSchema,
  CommandIdSchema,
  InputIdSchema,
  ProjectIdSchema,
  ProviderConnectionIdSchema,
  ProvisioningRefSchema,
  RecoveryEpochIdSchema,
  RecoveryRefSchema,
  RequestIdSchema,
  RunIdSchema,
  SessionIdSchema,
} from "./ids.js";
import {
  CredentialRecoveryExpectedSchema,
  EnvironmentVariableNameSchema,
  ProviderConnectionDisplayNameSchema,
  SessionProviderDefaultRequestSchema,
} from "./providers.js";
import { ApprovalResolutionSchema } from "./tools.js";

export const COMMAND_METHODS = [
  "session.create",
  "message.submit",
  "run.cancel",
  "approval.resolve",
  "input.respond",
  "providerConnection.file.create",
  "providerConnection.environment.create",
  "providerConnection.environment.revalidate",
  "providerConnection.file.replace",
  "providerConnection.rename",
  "providerConnection.disable",
  "providerConnection.logout",
  "providerConnection.delete",
  "providerConnection.recover",
  "session.providerDefault.set",
] as const;

export const CommandMethodSchema = z.enum(COMMAND_METHODS);
export type CommandMethod = z.infer<typeof CommandMethodSchema>;

const SessionCreateParamsSchema = z.strictObject({
  projectId: ProjectIdSchema.optional(),
  title: z.string().optional(),
});

const MessageSubmitParamsSchema = z.strictObject({
  text: z.string(),
});

const RunCancelParamsSchema = z.strictObject({
  runId: RunIdSchema,
});

const ApprovalResolveParamsSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  resolution: ApprovalResolutionSchema,
});

const InputRespondParamsSchema = z.strictObject({
  inputId: InputIdSchema,
  value: CanonicalJsonValueSchema,
});

const FileConnectionCreateParamsSchema = z.strictObject({
  providerId: z.literal("openai_platform"),
  authMode: z.literal("api_key"),
  displayName: ProviderConnectionDisplayNameSchema,
  provisioningRef: ProvisioningRefSchema,
});

const EnvironmentConnectionCreateParamsSchema = z.strictObject({
  providerId: z.literal("openai_platform"),
  authMode: z.literal("api_key"),
  displayName: ProviderConnectionDisplayNameSchema,
  variableName: EnvironmentVariableNameSchema,
});

const EnvironmentConnectionRevalidateParamsSchema = z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  expectedLifecycleRevision: z.number().int().positive().safe(),
  expectedGeneration: z.number().int().positive().safe(),
});

const FileConnectionReplaceParamsSchema = z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  expectedLifecycleRevision: z.number().int().positive().safe(),
  expectedGeneration: z.number().int().positive().safe(),
  provisioningRef: ProvisioningRefSchema,
});

const ProviderConnectionRenameParamsSchema = z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  expectedMetadataRevision: z.number().int().positive().safe(),
  displayName: ProviderConnectionDisplayNameSchema,
});

const ProviderConnectionLifecycleParamsSchema = z.strictObject({
  connectionId: ProviderConnectionIdSchema,
  expectedLifecycleRevision: z.number().int().positive().safe(),
  expectedGeneration: z.number().int().positive().safe(),
});

const ProviderConnectionRecoverParamsSchema = z.strictObject({
  recoveryRef: RecoveryRefSchema,
  recoveryEpochId: RecoveryEpochIdSchema,
  expected: CredentialRecoveryExpectedSchema,
  displayName: ProviderConnectionDisplayNameSchema,
});

const SessionProviderDefaultSetParamsSchema = z.strictObject({
  default: SessionProviderDefaultRequestSchema,
});

const CommandBaseSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("command"),
  commandId: CommandIdSchema,
});

export const SessionCreateCommandSchema = CommandBaseSchema.extend({
  method: z.literal("session.create"),
  params: SessionCreateParamsSchema,
});

export const MessageSubmitCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("message.submit"),
  params: MessageSubmitParamsSchema,
});

export const RunCancelCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("run.cancel"),
  params: RunCancelParamsSchema,
});

export const ApprovalResolveCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("approval.resolve"),
  params: ApprovalResolveParamsSchema,
});

export const InputRespondCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("input.respond"),
  params: InputRespondParamsSchema,
});

export const FileConnectionCreateCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.file.create"),
  params: FileConnectionCreateParamsSchema,
});
export const EnvironmentConnectionCreateCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.environment.create"),
  params: EnvironmentConnectionCreateParamsSchema,
});
export const EnvironmentConnectionRevalidateCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.environment.revalidate"),
  params: EnvironmentConnectionRevalidateParamsSchema,
});
export const FileConnectionReplaceCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.file.replace"),
  params: FileConnectionReplaceParamsSchema,
});
export const ProviderConnectionRenameCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.rename"),
  params: ProviderConnectionRenameParamsSchema,
});
export const ProviderConnectionDisableCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.disable"),
  params: ProviderConnectionLifecycleParamsSchema,
});
export const ProviderConnectionLogoutCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.logout"),
  params: ProviderConnectionLifecycleParamsSchema,
});
export const ProviderConnectionDeleteCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.delete"),
  params: ProviderConnectionLifecycleParamsSchema,
});
export const ProviderConnectionRecoverCommandSchema = CommandBaseSchema.extend({
  method: z.literal("providerConnection.recover"),
  params: ProviderConnectionRecoverParamsSchema,
});
export const SessionProviderDefaultSetCommandSchema = CommandBaseSchema.extend({
  sessionId: SessionIdSchema,
  method: z.literal("session.providerDefault.set"),
  params: SessionProviderDefaultSetParamsSchema,
});

export const CommandMessageSchema = z.discriminatedUnion("method", [
  SessionCreateCommandSchema,
  MessageSubmitCommandSchema,
  RunCancelCommandSchema,
  ApprovalResolveCommandSchema,
  InputRespondCommandSchema,
  FileConnectionCreateCommandSchema,
  EnvironmentConnectionCreateCommandSchema,
  EnvironmentConnectionRevalidateCommandSchema,
  FileConnectionReplaceCommandSchema,
  ProviderConnectionRenameCommandSchema,
  ProviderConnectionDisableCommandSchema,
  ProviderConnectionLogoutCommandSchema,
  ProviderConnectionDeleteCommandSchema,
  ProviderConnectionRecoverCommandSchema,
  SessionProviderDefaultSetCommandSchema,
]);

export const ResumeCursorSchema = z.strictObject({
  sessionId: SessionIdSchema,
  afterSequence: SequenceSchema,
});

export const HelloMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("hello"),
  clientId: ClientIdSchema,
  resume: z.array(ResumeCursorSchema),
});

export const SubscribeMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("subscribe"),
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
  afterSequence: SequenceSchema,
});

export const UnsubscribeMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("unsubscribe"),
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
});

export const ClientHeartbeatMessageSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("heartbeat"),
  clientTimeMs: TimestampMsSchema,
});

export const ClientMessageSchema = z.union([
  HelloMessageSchema,
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  CommandMessageSchema,
  ClientHeartbeatMessageSchema,
]);

export type SessionCreateCommand = z.infer<typeof SessionCreateCommandSchema>;
export type MessageSubmitCommand = z.infer<typeof MessageSubmitCommandSchema>;
export type RunCancelCommand = z.infer<typeof RunCancelCommandSchema>;
export type ApprovalResolveCommand = z.infer<typeof ApprovalResolveCommandSchema>;
export type InputRespondCommand = z.infer<typeof InputRespondCommandSchema>;
export type FileConnectionCreateCommand = z.infer<typeof FileConnectionCreateCommandSchema>;
export type EnvironmentConnectionCreateCommand = z.infer<typeof EnvironmentConnectionCreateCommandSchema>;
export type EnvironmentConnectionRevalidateCommand = z.infer<typeof EnvironmentConnectionRevalidateCommandSchema>;
export type FileConnectionReplaceCommand = z.infer<typeof FileConnectionReplaceCommandSchema>;
export type ProviderConnectionRenameCommand = z.infer<typeof ProviderConnectionRenameCommandSchema>;
export type ProviderConnectionDisableCommand = z.infer<typeof ProviderConnectionDisableCommandSchema>;
export type ProviderConnectionLogoutCommand = z.infer<typeof ProviderConnectionLogoutCommandSchema>;
export type ProviderConnectionDeleteCommand = z.infer<typeof ProviderConnectionDeleteCommandSchema>;
export type ProviderConnectionRecoverCommand = z.infer<typeof ProviderConnectionRecoverCommandSchema>;
export type SessionProviderDefaultSetCommand = z.infer<typeof SessionProviderDefaultSetCommandSchema>;
export type CommandMessage = z.infer<typeof CommandMessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;
export type UnsubscribeMessage = z.infer<typeof UnsubscribeMessageSchema>;
export type ClientHeartbeatMessage = z.infer<typeof ClientHeartbeatMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export async function hashCommandContent(command: CommandMessage): Promise<string> {
  const content: Record<string, unknown> = {
    method: command.method,
    params: command.params,
  };
  if ("sessionId" in command) content.sessionId = command.sessionId;
  return canonicalJsonHash(content);
}
