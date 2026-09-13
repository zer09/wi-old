import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { URL } from "node:url";

import Database from "../../packages/storage/node_modules/better-sqlite3/lib/index.js";
import { resolveStoragePath, sessionDatabaseRelativePath } from "@wi/storage";

const [homeDirectory, mode] = process.argv.slice(2);
if (homeDirectory === undefined || mode === undefined) process.exit(64);

const catalogV5Sql = await readFile(
  new URL("./fixtures/catalog-v5.sql", import.meta.url),
  "utf8",
);
const sessionV4Sql = await readFile(
  new URL("./fixtures/session-v4.sql", import.meta.url),
  "utf8",
);
const catalogV6Sql = await readFile(
  new URL("../../packages/storage/dist/catalog/migration-v6.sql", import.meta.url),
  "utf8",
);
const sessionV5Sql = await readFile(
  new URL("../../packages/storage/dist/session/migration-v5.sql", import.meta.url),
  "utf8",
);
const retainedSessionId = "ses_retainedV4";
const retainedSessionPath = sessionDatabaseRelativePath(retainedSessionId);

async function createCatalogV5() {
  await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
  const database = new Database(resolveStoragePath(homeDirectory, "catalog.sqlite3"));
  try {
    database.exec(catalogV5Sql);
  } finally {
    database.close();
  }
}

function assertRollback(
  database,
  migrationSql,
  oldVersion,
  newTable,
  retainedQuery,
) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(migrationSql);
    throw new Error("injected migration failure after DDL");
  } catch {
    database.exec("ROLLBACK");
  }
  const version = database.pragma("user_version", { simple: true });
  const tableCount = database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(newTable).count;
  const retained = database.prepare(retainedQuery).get();
  if (version !== oldVersion || tableCount !== 0 || retained === undefined) process.exit(66);
}

if (mode === "catalog-v5") {
  await createCatalogV5();
  process.exit(0);
}

if (mode === "catalog-v6-failure") {
  const database = new Database(resolveStoragePath(homeDirectory, "catalog.sqlite3"));
  try {
    assertRollback(
      database,
      catalogV6Sql,
      5,
      "provider_catalog_state",
      "SELECT value FROM catalog_meta WHERE key = 'retained_fixture' AND value = 'catalog-v5'",
    );
  } finally {
    database.close();
  }
  process.exit(0);
}

if (mode === "session-v4") {
  await createCatalogV5();
  const catalog = new Database(resolveStoragePath(homeDirectory, "catalog.sqlite3"));
  try {
    catalog.prepare(
      `INSERT INTO sessions (
         session_id, project_id, db_relative_path, title, status,
         created_at_ms, updated_at_ms, last_event_sequence, last_run_state,
         last_message_preview, requires_attention, pending_approval_count,
         pending_input_count, session_schema_version, recovery_candidate,
         unavailable_reason
       ) VALUES (?, NULL, ?, 'Retained v4', 'ready', 1, 2, 1, 'completed', NULL, 0, 0, 0, 4, 0, NULL)`,
    ).run(retainedSessionId, retainedSessionPath);
  } finally {
    catalog.close();
  }
  const databasePath = resolveStoragePath(homeDirectory, retainedSessionPath);
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const session = new Database(databasePath);
  try {
    session.exec(sessionV4Sql);
  } finally {
    session.close();
  }
  process.stdout.write(`${retainedSessionId}\n`);
  process.exit(0);
}

if (mode === "session-v5-failure") {
  const session = new Database(resolveStoragePath(homeDirectory, retainedSessionPath));
  try {
    assertRollback(
      session,
      sessionV5Sql,
      4,
      "session_provider_default",
      "SELECT event_id FROM events WHERE event_id = 'evt_retainedV4'",
    );
    const runColumns = session.pragma("table_info(runs)");
    if (runColumns.some((column) => column.name === "provider_snapshot_json")) process.exit(67);
  } finally {
    session.close();
  }
  process.exit(0);
}

process.exit(65);
