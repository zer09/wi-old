ALTER TABLE runs ADD COLUMN provider_snapshot_json TEXT;
ALTER TABLE runs ADD COLUMN provider_chain_id TEXT;

CREATE TABLE session_provider_default (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    default_json TEXT NOT NULL,
    updated_sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL
) STRICT;

UPDATE manifest SET schema_version = 5 WHERE singleton = 1;
