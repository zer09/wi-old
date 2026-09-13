import {
  DiagnosticIdSchema,
  ErrorCodeSchema,
  SafeDiagnosticMessageSchema,
  type ErrorCode,
  type ProtocolErrorCode,
} from "@wi/protocol";
import {
  ReplaySubscriptionError,
  SessionActorError,
  SessionRegistryUnavailableError,
} from "@wi/harness-core";
import { StorageError } from "@wi/storage";
import { CommandRoutingError } from "./command-router.js";

export interface SafeCommandError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly diagnosticId: string;
}

const SAFE_MESSAGES: Partial<Record<ErrorCode, string>> = {
  "protocol.command_id_conflict": "This command ID was already used with different content.",
  "storage.busy": "Storage is temporarily busy. Retry the same command ID.",
  "storage.corrupt": "The requested session storage is unavailable.",
  "storage.migration_failed": "The requested session could not be opened.",
  "storage.disk_full": "Storage has no space available for this command.",
  "storage.worker_failed": "The storage operation could not be completed safely.",
  "session.not_found": "The requested session or run was not found.",
  "session.run_already_active": "This session already has an active run.",
  "session.invalid_transition": "The command is not valid in the current session state.",
  "approval.already_resolved": "This approval was already resolved.",
  "input.already_resolved": "This input request was already resolved.",
  "credential.recovery_connection_conflict": "The original provider connection is already occupied.",
  "credential.recovery_identity_conflict": "The provider identity is already claimed by another connection.",
  "credential.recovery_already_claimed": "The credential recovery evidence was already claimed.",
  "provider.cancelled": "The run operation was cancelled.",
  "provider.rate_limited": "The provider connection recovery queue is temporarily full.",
  "websocket.slow_consumer": "The connection could not keep up with event delivery.",
};

function trustedErrorCode(error: unknown): string | null {
  if (
    error instanceof CommandRoutingError ||
    error instanceof StorageError ||
    error instanceof SessionActorError ||
    error instanceof SessionRegistryUnavailableError
  ) {
    return error.code;
  }
  return null;
}

export function mapCommandError(
  error: unknown,
  createDiagnosticId: () => string,
): SafeCommandError {
  const sourceCode = trustedErrorCode(error);
  const parsed = ErrorCodeSchema.safeParse(sourceCode);
  let code: ErrorCode = parsed.success ? parsed.data : "storage.worker_failed";
  if (sourceCode === "session.unavailable") code = "storage.corrupt";
  const routingError = error instanceof CommandRoutingError ? error : null;
  const safeMessage = SafeDiagnosticMessageSchema.safeParse(routingError?.safeMessage);
  const durableDiagnosticId = DiagnosticIdSchema.safeParse(routingError?.diagnosticId);
  const recoverable =
    code === "storage.busy" ||
    code === "storage.worker_failed" ||
    code === "provider.rate_limited";
  return {
    code,
    message: safeMessage.success
      ? safeMessage.data
      : (SAFE_MESSAGES[code] ?? "The command was rejected."),
    recoverable,
    diagnosticId: durableDiagnosticId.success
      ? durableDiagnosticId.data
      : createDiagnosticId(),
  };
}

export function mapReplayError(error: unknown): {
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
} {
  if (
    error instanceof SessionRegistryUnavailableError ||
    (error instanceof SessionActorError && error.code === "session.unavailable")
  ) {
    return {
      code: "storage.corrupt",
      message: "The requested session storage is unavailable.",
      recoverable: false,
    };
  }
  let storageError: StorageError | null = null;
  if (error instanceof StorageError) {
    storageError = error;
  } else if (error instanceof ReplaySubscriptionError && error.cause instanceof StorageError) {
    storageError = error.cause;
  }
  if (storageError !== null) {
    if (
      storageError.code === "storage.corrupt" ||
      storageError.code === "storage.migration_failed" ||
      storageError.code === "storage.session_uninitialized"
    ) {
      return {
        code: "storage.corrupt",
        message: "The requested session storage is unavailable.",
        recoverable: false,
      };
    }
    if (storageError.code === "storage.session_missing") {
      return {
        code: "replay.unknown_session",
        message: "The requested session does not exist.",
        recoverable: false,
      };
    }
  }
  if (error instanceof ReplaySubscriptionError) {
    switch (error.code) {
      case "replay.cursor_ahead":
        return {
          code: error.code,
          message: "The replay cursor is ahead of the committed session history.",
          recoverable: true,
        };
      case "replay.unknown_session":
        return {
          code: error.code,
          message: "The requested session does not exist.",
          recoverable: false,
        };
      case "replay.session_unavailable":
        return {
          code: "storage.corrupt",
          message: "The requested session storage is unavailable.",
          recoverable: false,
        };
      case "replay.subscriber_overflow":
        return {
          code: error.code,
          message: "The replay subscriber exceeded its bounded queue.",
          recoverable: true,
        };
      case "replay.sequence_conflict":
        return {
          code: error.code,
          message: "The session replay detected conflicting committed history.",
          recoverable: false,
        };
      case "replay.disconnected":
      case "replay.query_failed":
      case "replay.sequence_gap":
        return {
          code: error.code,
          message: "The session replay could not be completed safely.",
          recoverable: true,
        };
    }
  }
  return {
    code: "replay.query_failed",
    message: "The session subscription could not be completed safely.",
    recoverable: true,
  };
}
