import { readFile, rm } from "node:fs/promises";
import { URL } from "node:url";

import Database from "../../packages/storage/node_modules/better-sqlite3/lib/index.js";
import {
  resolveStoragePath,
  sessionDatabaseRelativePath,
  SessionStoreManager,
} from "@wi/storage";

const [homeDirectory, mode] = process.argv.slice(2);
if (homeDirectory === undefined || mode === undefined) process.exit(64);

const sessionId = "ses_v3Retained";
const databasePath = resolveStoragePath(
  homeDirectory,
  sessionDatabaseRelativePath(sessionId),
);
const failureTriggerName = "fixture_fail_session_v4_migration";

function hasTable(database, name) {
  return database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function snapshot(database) {
  const rows = (table, orderBy) =>
    database.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
  return {
    userVersion: database.pragma("user_version", { simple: true }),
    schema: database
      .prepare(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master " +
          "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all(),
    manifest: rows("manifest", "singleton"),
    events: rows("events", "sequence"),
    acceptedCommands: rows("accepted_commands", "command_id"),
    runs: rows("runs", "run_id"),
    messages: rows("messages", "message_id"),
    messageParts: rows("message_parts", "part_id"),
    providerSteps: rows("provider_steps", "step_id"),
    toolExecutions: rows("tool_executions", "call_id"),
    toolCallOccurrences: rows("tool_call_occurrences", "step_id, call_id"),
    approvals: rows("approvals", "approval_id"),
    pendingInputs: rows("pending_inputs", "input_id"),
    creationProvenance: hasTable(database, "creation_provenance")
      ? rows("creation_provenance", "singleton")
      : null,
  };
}

if (mode === "snapshot") {
  const database = new Database(databasePath, { readonly: true });
  try {
    process.stdout.write(`${JSON.stringify(snapshot(database))}\n`);
  } finally {
    database.close();
  }
  process.exit(0);
}

if (mode === "drop-failure") {
  const database = new Database(databasePath);
  try {
    database.exec(`DROP TRIGGER ${failureTriggerName}`);
    const userVersion = database.pragma("user_version", { simple: true });
    process.exit(userVersion === 3 && !hasTable(database, "creation_provenance") ? 0 : 70);
  } finally {
    database.close();
  }
}

if (mode === "verify-v5") {
  const database = new Database(databasePath);
  try {
    let updateRejected = false;
    let deleteRejected = false;
    try {
      database.prepare("UPDATE events SET payload_json = '{}' WHERE sequence = 1").run();
    } catch {
      updateRejected = true;
    }
    try {
      database.prepare("DELETE FROM events WHERE sequence = 1").run();
    } catch {
      deleteRejected = true;
    }
    const userVersion = database.pragma("user_version", { simple: true });
    const manifest = database
      .prepare("SELECT schema_version AS schemaVersion FROM manifest WHERE singleton = 1")
      .get();
    const provenanceCount = database
      .prepare("SELECT COUNT(*) AS count FROM creation_provenance")
      .get();
    process.exit(
      userVersion === 5 &&
          manifest?.schemaVersion === 5 &&
          provenanceCount?.count === 0 &&
          updateRejected &&
          deleteRejected
        ? 0
        : 71,
    );
  } finally {
    database.close();
  }
}

if (mode !== "seed-valid" && mode !== "seed-failure") process.exit(65);

// Create only the catalog identity through current code. The session database is
// then replaced by a database built directly from the frozen retained-v3 DDL.
const storage = new SessionStoreManager({
  homeDirectory,
  now: () => 1_000,
  ids: {
    sessionId: () => sessionId,
    eventId: () => "evt_v3SessionCreated",
  },
  sessionWorkers: { size: 1 },
});
try {
  await storage.createSession({
    v: 1,
    kind: "command",
    commandId: "cmd_v3SessionCreate",
    method: "session.create",
    params: { title: "Retained session v3" },
  });
} finally {
  await storage.close();
}

await rm(databasePath, { force: true });
await rm(`${databasePath}-wal`, { force: true });
await rm(`${databasePath}-shm`, { force: true });
const schemaV3 = await readFile(
  new URL("./fixtures/session-v3-schema.sql", import.meta.url),
  "utf8",
);
const database = new Database(databasePath);
try {
  database.exec(schemaV3);
  database.pragma("user_version = 3");
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO manifest (
           singleton, session_id, project_id, created_at_ms, schema_version,
           format_version, title, last_event_sequence
         ) VALUES (1, ?, NULL, 1000, 3, 1, 'Retained session v3', 12)`,
      )
      .run(sessionId);

    const events = [
      ["evt_v3SessionCreated", "session.created", 1_000, null,
        { eventVersion: 1, title: "Retained session v3" }],
      ["evt_v3ApprovalMessage", "user.message.appended", 2_000, "run_v3Approval",
        { eventVersion: 1, messageId: "msg_v3Approval", runId: "run_v3Approval", text: "Approve retained tool" }],
      ["evt_v3ApprovalRun", "run.created", 2_001, "run_v3Approval",
        { eventVersion: 1, runId: "run_v3Approval" }],
      ["evt_v3ApprovalStep", "provider.step.completed", 2_002, "run_v3Approval",
        { eventVersion: 1, runId: "run_v3Approval", stepId: "step_v3Approval" }],
      ["evt_v3ToolRequested", "tool.call.requested", 2_003, "run_v3Approval",
        { eventVersion: 1, runId: "run_v3Approval", stepId: "step_v3Approval", callId: "call_v3Approval", name: "echo", argumentsJson: "{\"text\":\"retained\"}", argumentsHash: "a".repeat(64), effectClass: "pure" }],
      ["evt_v3ApprovalRequested", "tool.approval.requested", 2_004, "run_v3Approval",
        { eventVersion: 1, runId: "run_v3Approval", callId: "call_v3Approval", approvalId: "approval_v3Pending", toolName: "echo", actionDigest: "b".repeat(64), summary: "Approve retained echo" }],
      ["evt_v3InputMessage", "user.message.appended", 2_100, "run_v3Input",
        { eventVersion: 1, messageId: "msg_v3Input", runId: "run_v3Input", text: "Retained input run" }],
      ["evt_v3InputRun", "run.created", 2_101, "run_v3Input",
        { eventVersion: 1, runId: "run_v3Input" }],
      ["evt_v3InputRequested", "input.requested", 2_102, "run_v3Input",
        { eventVersion: 1, runId: "run_v3Input", inputId: "input_v3Pending", prompt: "Retained question?" }],
      ["evt_v3FailedRunCreated", "run.created", 3_000, "run_v3Failed",
        { eventVersion: 1, runId: "run_v3Failed" }],
      ["evt_v3FailedStep", "provider.step.failed", 3_001, "run_v3Failed",
        { eventVersion: 1, runId: "run_v3Failed", stepId: "step_v3Failed", code: "provider.protocol_error", message: "Retained provider failure", diagnosticId: "err_v3Failed" }],
      ["evt_v3FailedRun", "run.failed", 3_002, "run_v3Failed",
        { eventVersion: 1, runId: "run_v3Failed", code: "provider.protocol_error", message: "Retained provider failure", diagnosticId: "err_v3Failed" }],
    ];
    const insertEvent = database.prepare(
      `INSERT INTO events (
         event_id, event_type, event_version, created_at_ms, run_id, item_id, payload_json
       ) VALUES (?, ?, 1, ?, ?, NULL, ?)`,
    );
    for (const [eventId, eventType, createdAtMs, runId, data] of events) {
      insertEvent.run(eventId, eventType, createdAtMs, runId, JSON.stringify(data));
    }

    database
      .prepare(
        `INSERT INTO accepted_commands (
           command_id, command_method, payload_hash, accepted_sequence, run_id,
           result_json, accepted_at_ms
         ) VALUES (?, 'message.submit', ?, 6, ?, ?, 2000)`,
      )
      .run(
        "cmd_v3Submit",
        "c".repeat(64),
        "run_v3Approval",
        JSON.stringify({ runId: "run_v3Approval" }),
      );

    const insertRun = database.prepare(
      `INSERT INTO runs (
         run_id, state, provider_id, provider_config_json, created_at_ms,
         started_at_ms, completed_at_ms, cancelled_at_ms, failure_category,
         failure_message, active_provider_step_id
       ) VALUES (?, ?, 'fake', ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    );
    insertRun.run("run_v3Approval", "waiting_for_user", '{"scenario":"guarded-echo"}', 2_001, 2_001, null, null, null);
    insertRun.run("run_v3Input", "waiting_for_user", '{"scenario":"plain-text"}', 2_101, 2_101, null, null, null);
    insertRun.run("run_v3Failed", "failed", '{"scenario":"provider-failure"}', 3_000, 3_000, 3_002, "provider.protocol_error", "Retained provider failure");

    const insertMessage = database.prepare(
      `INSERT INTO messages (
         message_id, run_id, role, state, created_at_ms, completed_at_ms
       ) VALUES (?, ?, 'user', 'completed', ?, ?)`,
    );
    insertMessage.run("msg_v3Approval", "run_v3Approval", 2_000, 2_000);
    insertMessage.run("msg_v3Input", "run_v3Input", 2_100, 2_100);
    const insertPart = database.prepare(
      `INSERT INTO message_parts (
         part_id, message_id, part_index, part_type, text_content, data_json
       ) VALUES (?, ?, 0, 'text', ?, NULL)`,
    );
    insertPart.run("part_v3Approval", "msg_v3Approval", "Approve retained tool");
    insertPart.run("part_v3Input", "msg_v3Input", "Retained input run");

    const insertStep = database.prepare(
      `INSERT INTO provider_steps (
         step_id, run_id, step_index, state, started_at_ms, completed_at_ms,
         response_id, error_category, error_message, diagnostic_id
       ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertStep.run("step_v3Approval", "run_v3Approval", "completed", 2_001, 2_002, "response_v3Approval", null, null, null);
    insertStep.run("step_v3Failed", "run_v3Failed", "failed", 3_000, 3_001, "response_v3Failed", "provider.protocol_error", "Retained provider failure", "err_v3Failed");

    database
      .prepare(
        `INSERT INTO tool_executions (
           call_id, run_id, step_id, tool_name, arguments_json, arguments_hash,
           effect_class, state, attempt_count, requested_at_ms, started_at_ms,
           completed_at_ms, result_json, error_json
         ) VALUES (?, ?, ?, 'echo', ?, ?, 'pure', 'awaiting_approval', 0, 2003,
                   NULL, NULL, NULL, NULL)`,
      )
      .run(
        "call_v3Approval",
        "run_v3Approval",
        "step_v3Approval",
        JSON.stringify({ text: "retained" }),
        "a".repeat(64),
      );
    database
      .prepare(
        `INSERT INTO tool_call_occurrences (
           step_id, call_id, run_id, occurred_at_ms
         ) VALUES (?, ?, ?, 2003)`,
      )
      .run("step_v3Approval", "call_v3Approval", "run_v3Approval");
    database
      .prepare(
        `INSERT INTO approvals (
           approval_id, run_id, call_id, state, action_digest, requested_at_ms,
           resolved_at_ms, resolution, resolved_by_client_id
         ) VALUES (?, ?, ?, 'pending', ?, 2004, NULL, NULL, NULL)`,
      )
      .run(
        "approval_v3Pending",
        "run_v3Approval",
        "call_v3Approval",
        "b".repeat(64),
      );
    database
      .prepare(
        `INSERT INTO pending_inputs (
           input_id, run_id, state, prompt, requested_at_ms, resolved_at_ms, value_json
         ) VALUES (?, ?, 'pending', 'Retained question?', 2102, NULL, NULL)`,
      )
      .run("input_v3Pending", "run_v3Input");
  })();

  if (mode === "seed-failure") {
    database.exec(
      `CREATE TRIGGER ${failureTriggerName}
       BEFORE UPDATE OF schema_version ON manifest
       WHEN NEW.schema_version = 4
       BEGIN
         SELECT RAISE(ABORT, 'injected v4 migration failure');
       END`,
    );
  }
} finally {
  database.close();
}
