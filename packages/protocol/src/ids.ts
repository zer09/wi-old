import { z } from "zod";

const idSuffixPattern = "[A-Za-z0-9][A-Za-z0-9_-]{0,119}";

function idSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_${idSuffixPattern}$`));
}

export const ClientIdSchema = idSchema("client");
export const RequestIdSchema = idSchema("req");
export const CommandIdSchema = idSchema("cmd");
export const SessionIdSchema = idSchema("ses");
export const RunIdSchema = idSchema("run");
export const EventIdSchema = idSchema("evt");
export const MessageIdSchema = idSchema("msg");
export const PartIdSchema = idSchema("part");
export const ProviderStepIdSchema = idSchema("step");
export const ToolCallIdSchema = idSchema("call");
export const ApprovalIdSchema = idSchema("approval");
export const InputIdSchema = idSchema("input");
export const ConnectionIdSchema = idSchema("conn");
export const ProviderConnectionIdSchema = idSchema("pconn");
export const EnvelopeIdSchema = idSchema("envl");
export const ProvisioningIdSchema = idSchema("prov");
export const ProvisioningRefSchema = idSchema("provref");
export const RecoveryEpochIdSchema = idSchema("recepoch");
export const RecoveryRefSchema = idSchema("recref");
export const ProviderChainIdSchema = idSchema("pchain");
export const CapabilitiesVersionSchema = idSchema("capver");
export const BackendProcessEpochSchema = idSchema("process");
export const DiagnosticIdSchema = idSchema("err");
export const ProjectIdSchema = idSchema("project");

export type ClientId = z.infer<typeof ClientIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type PartId = z.infer<typeof PartIdSchema>;
export type ProviderStepId = z.infer<typeof ProviderStepIdSchema>;
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type InputId = z.infer<typeof InputIdSchema>;
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;
export type ProviderConnectionId = z.infer<typeof ProviderConnectionIdSchema>;
export type EnvelopeId = z.infer<typeof EnvelopeIdSchema>;
export type ProvisioningId = z.infer<typeof ProvisioningIdSchema>;
export type ProvisioningRef = z.infer<typeof ProvisioningRefSchema>;
export type RecoveryEpochId = z.infer<typeof RecoveryEpochIdSchema>;
export type RecoveryRef = z.infer<typeof RecoveryRefSchema>;
export type ProviderChainId = z.infer<typeof ProviderChainIdSchema>;
export type CapabilitiesVersion = z.infer<typeof CapabilitiesVersionSchema>;
export type BackendProcessEpoch = z.infer<typeof BackendProcessEpochSchema>;
export type DiagnosticId = z.infer<typeof DiagnosticIdSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;

export const ID_PREFIXES = {
  client: "client",
  request: "req",
  command: "cmd",
  session: "ses",
  run: "run",
  event: "evt",
  message: "msg",
  part: "part",
  providerStep: "step",
  toolCall: "call",
  approval: "approval",
  input: "input",
  connection: "conn",
  providerConnection: "pconn",
  envelope: "envl",
  provisioning: "prov",
  provisioningRef: "provref",
  recoveryEpoch: "recepoch",
  recoveryRef: "recref",
  providerChain: "pchain",
  capabilitiesVersion: "capver",
  backendProcessEpoch: "process",
  diagnostic: "err",
  project: "project",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdSource = () => string;

export function createId(kind: IdKind, source: IdSource): string {
  const id = `${ID_PREFIXES[kind]}_${source()}`;
  idSchema(ID_PREFIXES[kind]).parse(id);
  return id;
}

export function createIdGenerator(kind: IdKind, source: IdSource): () => string {
  return () => createId(kind, source);
}
