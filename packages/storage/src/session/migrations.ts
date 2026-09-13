import { readFileSync } from "node:fs";

import type { Migration } from "../common/migrations.js";
import { SESSION_SCHEMA_VERSION } from "../types.js";

export const sessionMigrations: readonly Migration[] = [
  {
    version: 1,
    sql: readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
  },
  {
    version: 2,
    sql: readFileSync(new URL("./migration-v2.sql", import.meta.url), "utf8"),
  },
  {
    version: 3,
    sql: readFileSync(new URL("./migration-v3.sql", import.meta.url), "utf8"),
  },
  {
    version: 4,
    sql: readFileSync(new URL("./migration-v4.sql", import.meta.url), "utf8"),
  },
  {
    version: 5,
    sql: readFileSync(new URL("./migration-v5.sql", import.meta.url), "utf8"),
  },
];

export { SESSION_SCHEMA_VERSION };
