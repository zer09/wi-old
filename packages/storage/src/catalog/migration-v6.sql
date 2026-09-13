CREATE TABLE provider_catalog_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    catalog_revision INTEGER NOT NULL DEFAULT 0,
    rebuilt_epoch INTEGER NOT NULL DEFAULT 0,
    recovery_active INTEGER NOT NULL DEFAULT 0 CHECK (recovery_active IN (0, 1))
) STRICT;
INSERT INTO provider_catalog_state (
    singleton, catalog_revision, rebuilt_epoch, recovery_active
) VALUES (1, 0, 0, 0);

CREATE TABLE provider_connections (
    connection_id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL CHECK (provider_id IN ('openai_platform', 'openai_codex')),
    auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key', 'chatgpt_oauth')),
    display_name TEXT NOT NULL,
    credential_backend_kind TEXT NOT NULL CHECK (credential_backend_kind IN ('file', 'environment')),
    credential_internal_ref TEXT,
    environment_variable_name TEXT,
    envelope_id TEXT,
    credential_generation INTEGER NOT NULL CHECK (credential_generation >= 1),
    lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision >= 1),
    metadata_revision INTEGER NOT NULL CHECK (metadata_revision >= 1),
    lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('ready', 'reauth_required', 'disabled', 'rate_limited', 'unavailable')),
    identity_json TEXT NOT NULL,
    identity_verification_status TEXT NOT NULL CHECK (identity_verification_status IN ('unverified', 'authoritative')),
    capabilities_version TEXT,
    lifecycle_owner_command_id TEXT,
    lifecycle_owner_kind TEXT,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    recovery_tombstone INTEGER NOT NULL DEFAULT 0 CHECK (recovery_tombstone IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    CHECK (
      (credential_backend_kind = 'file' AND environment_variable_name IS NULL) OR
      (credential_backend_kind = 'environment' AND credential_internal_ref IS NULL AND envelope_id IS NULL AND environment_variable_name IS NOT NULL)
    )
) STRICT;
CREATE INDEX provider_connections_updated_idx ON provider_connections(updated_at_ms DESC, connection_id);
CREATE INDEX provider_connections_owner_idx ON provider_connections(lifecycle_owner_command_id);

CREATE TABLE provider_identity_claims (
    identity_key TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    stable_kind TEXT NOT NULL CHECK (stable_kind IN ('subject', 'account', 'project')),
    stable_value TEXT NOT NULL,
    workspace_presence TEXT NOT NULL CHECK (workspace_presence IN ('unknown', 'none', 'value')),
    workspace_value TEXT NOT NULL,
    connection_id TEXT NOT NULL UNIQUE REFERENCES provider_connections(connection_id),
    created_at_ms INTEGER NOT NULL,
    UNIQUE(provider_id, auth_mode, stable_kind, stable_value, workspace_presence, workspace_value)
) STRICT;

CREATE TABLE provider_capability_snapshots (
    connection_id TEXT NOT NULL REFERENCES provider_connections(connection_id),
    capabilities_version TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(connection_id, capabilities_version)
) STRICT;

CREATE TABLE provider_lifecycle_operations (
    command_id TEXT PRIMARY KEY,
    command_method TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    operation_kind TEXT NOT NULL,
    target_connection_id TEXT NOT NULL,
    expected_lifecycle_revision INTEGER,
    expected_generation INTEGER,
    reserved_lifecycle_revision INTEGER NOT NULL,
    reserved_generation INTEGER NOT NULL,
    owner_key TEXT NOT NULL,
    provisioning_id TEXT,
    staging_internal_ref TEXT,
    staging_file_identity_json TEXT,
    credential_backend_kind TEXT NOT NULL CHECK (credential_backend_kind IN ('file', 'environment')),
    credential_internal_ref TEXT,
    envelope_id TEXT,
    recovery_epoch_id TEXT,
    expected_safe_metadata_json TEXT,
    recovery_file_identity_json TEXT,
    phase TEXT NOT NULL CHECK (phase IN ('validating', 'prepared', 'file_observed', 'succeeded', 'failed', 'failed_after_effect')),
    result_json TEXT,
    failure_code TEXT,
    failure_message TEXT,
    diagnostic_id TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX provider_lifecycle_operations_phase_idx ON provider_lifecycle_operations(phase, updated_at_ms, command_id);

CREATE TABLE provider_lifecycle_owners (
    owner_key TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE REFERENCES provider_lifecycle_operations(command_id),
    connection_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL,
    lifecycle_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    acquired_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE provider_metadata_commands (
    command_id TEXT PRIMARY KEY,
    command_method TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES provider_connections(connection_id),
    result_json TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE provider_credential_claims (
    claim_kind TEXT NOT NULL CHECK (claim_kind IN ('provisioning', 'recovery')),
    claim_id TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE REFERENCES provider_lifecycle_operations(command_id),
    connection_id TEXT NOT NULL,
    envelope_id TEXT,
    claimed_at_ms INTEGER NOT NULL,
    consumed_at_ms INTEGER,
    PRIMARY KEY(claim_kind, claim_id)
) STRICT;
