import { readFileSync } from "node:fs";

import type { Migration } from "../common/migrations.js";
import { CATALOG_SCHEMA_VERSION } from "../types.js";

export const catalogMigrations: readonly Migration[] = [
  {
    version: 1,
    sql: readFileSync(new URL("./schema-v1.sql", import.meta.url), "utf8"),
  },
  {
    version: 2,
    sql: `
      ALTER TABLE catalog_commands ADD COLUMN failure_code TEXT;
      ALTER TABLE catalog_commands ADD COLUMN failure_message TEXT;
      ALTER TABLE catalog_commands ADD COLUMN diagnostic_id TEXT;
      ALTER TABLE catalog_commands ADD COLUMN quarantined_relative_path TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE catalog_repair_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        reason TEXT NOT NULL CHECK (reason IN ('catalog_new', 'catalog_corrupt', 'explicit'))
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE sessions ADD COLUMN recovery_candidate INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX sessions_recovery_candidate_idx
        ON sessions(recovery_candidate, status, updated_at_ms, session_id);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE sessions ADD COLUMN unavailable_reason TEXT
        CHECK (unavailable_reason IS NULL OR unavailable_reason = 'quarantined');
    `,
  },
  {
    version: 6,
    sql: readFileSync(new URL("./migration-v6.sql", import.meta.url), "utf8"),
  },
];

export { CATALOG_SCHEMA_VERSION };
