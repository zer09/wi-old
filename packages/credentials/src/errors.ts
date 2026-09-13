export type CredentialErrorCode =
  | "credential.invalid_configuration"
  | "credential.unsupported_filesystem"
  | "credential.unsafe_path"
  | "credential.not_found"
  | "credential.malformed"
  | "credential.binding_mismatch"
  | "credential.unsafe_file"
  | "credential.io_failed"
  | "credential.environment_missing"
  | "credential.environment_invalid"
  | "credential.environment_changed"
  | "credential.process_epoch_mismatch"
  | "credential.read_only"
  | "credential.stage_missing"
  | "credential.reference_invalid"
  | "credential.recovery_already_claimed"
  | "credential.scan_incomplete";

const SAFE_MESSAGES: Readonly<Record<CredentialErrorCode, string>> = {
  "credential.invalid_configuration": "Credential storage configuration is invalid",
  "credential.unsupported_filesystem": "Credential storage requires a supported Linux filesystem",
  "credential.unsafe_path": "Credential storage path is unsafe",
  "credential.not_found": "The selected credential was not found",
  "credential.malformed": "The selected credential is invalid",
  "credential.binding_mismatch": "The selected credential does not match its connection",
  "credential.unsafe_file": "The selected credential file is unsafe",
  "credential.io_failed": "The credential operation failed",
  "credential.environment_missing": "The selected environment credential is unavailable",
  "credential.environment_invalid": "The selected environment credential exceeds its private byte limit",
  "credential.environment_changed": "The selected environment credential changed after run acceptance",
  "credential.process_epoch_mismatch": "The environment credential lease belongs to an earlier backend process",
  "credential.read_only": "The selected credential backend is read-only",
  "credential.stage_missing": "The staged credential is unavailable; stage it again",
  "credential.reference_invalid": "The credential reference is invalid",
  "credential.recovery_already_claimed": "The credential recovery evidence was already claimed",
  "credential.scan_incomplete": "Credential recovery scan could not complete safely",
};

export class CredentialError extends Error {
  constructor(
    readonly code: CredentialErrorCode,
    options?: ErrorOptions,
  ) {
    super(SAFE_MESSAGES[code], options);
    this.name = "CredentialError";
  }
}

export function credentialError(error: unknown, fallback: CredentialErrorCode): CredentialError {
  return error instanceof CredentialError ? error : new CredentialError(fallback, { cause: error });
}
