import { z } from "zod";

export const ERROR_CODES = [
  "protocol.invalid_json",
  "protocol.invalid_message",
  "protocol.unsupported_version",
  "protocol.message_too_large",
  "protocol.command_id_conflict",
  "replay.cursor_ahead",
  "replay.unknown_session",
  "replay.disconnected",
  "replay.query_failed",
  "replay.sequence_gap",
  "replay.sequence_conflict",
  "replay.subscriber_overflow",
  "subscription.already_exists",
  "subscription.not_found",
  "storage.busy",
  "storage.corrupt",
  "storage.migration_failed",
  "storage.disk_full",
  "storage.worker_failed",
  "session.not_found",
  "session.run_already_active",
  "session.invalid_transition",
  "approval.already_resolved",
  "input.already_resolved",
  "credential.recovery_failed",
  "credential.recovery_ref_expired",
  "credential.recovery_source_changed",
  "credential.recovery_connection_conflict",
  "credential.recovery_identity_conflict",
  "credential.recovery_already_claimed",
  "credential.environment_invalid",
  "credential.provisioning_already_claimed",
  "provider.auth_mode_invalid",
  "provider.capabilities_unavailable",
  "provider.connection_not_found",
  "provider.connection_limit_exceeded",
  "provider.connection_unavailable",
  "provider.credential_unavailable",
  "provider.model_unavailable",
  "provider.not_implemented",
  "provider.operation_in_progress",
  "provider.rate_limited",
  "provider.reasoning_incompatible",
  "provider.selection_required",
  "provider.tools_incompatible",
  "provider.transport_incompatible",
  "provider.transient_before_output",
  "provider.transport_after_output",
  "provider.protocol_error",
  "provider.incomplete",
  "provider.cancelled",
  "tool.unknown",
  "tool.invalid_arguments",
  "tool.approval_denied",
  "tool.timeout",
  "tool.execution_failed",
  "tool.outcome_unknown",
  "websocket.unauthorized",
  "websocket.invalid_origin",
  "websocket.slow_consumer",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const SAFE_DIAGNOSTIC_MESSAGE_MAX_LENGTH = 512;
export const LEGACY_FAILURE_MESSAGE_MAX_BYTES = 8 * 1_024;
const utf8 = new TextEncoder();

export const LegacyFailureMessageSchema = z.string().refine(
  (message) => utf8.encode(message).byteLength <= LEGACY_FAILURE_MESSAGE_MAX_BYTES,
  { message: "Legacy failure message exceeds its UTF-8 byte limit" },
);
export const SafeDiagnosticMessageSchema = z
  .string()
  .max(SAFE_DIAGNOSTIC_MESSAGE_MAX_LENGTH);

export const PROTOCOL_ERROR_CODES = [
  "protocol.invalid_json",
  "protocol.invalid_message",
  "protocol.unsupported_version",
  "protocol.message_too_large",
  "replay.cursor_ahead",
  "replay.unknown_session",
  "replay.disconnected",
  "replay.query_failed",
  "replay.sequence_gap",
  "replay.sequence_conflict",
  "replay.subscriber_overflow",
  "subscription.already_exists",
  "subscription.not_found",
  "storage.corrupt",
] as const;

export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
