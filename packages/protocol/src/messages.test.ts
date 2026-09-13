import { describe, expect, it } from "vitest";

import {
  ClientMessageSchema,
  CommandMessageSchema,
  hashCommandContent,
} from "./commands.js";
import { ServerMessageSchema } from "./server-messages.js";

const sessionId = "ses_A";
const commandId = "cmd_A";
const requestId = "req_A";

describe("v1 client messages", () => {
  it.each([
    { v: 1, kind: "hello", clientId: "client_A", resume: [{ sessionId, afterSequence: 4 }] },
    { v: 1, kind: "subscribe", requestId, sessionId, afterSequence: 4 },
    { v: 1, kind: "unsubscribe", requestId, sessionId },
    { v: 1, kind: "heartbeat", clientTimeMs: 100 },
    { v: 1, kind: "command", commandId, method: "session.create", params: {} },
    {
      v: 1,
      kind: "command",
      commandId,
      sessionId,
      method: "message.submit",
      params: { text: "Inspect the tests." },
    },
    {
      v: 1,
      kind: "command",
      commandId,
      sessionId,
      method: "run.cancel",
      params: { runId: "run_A" },
    },
    {
      v: 1,
      kind: "command",
      commandId,
      sessionId,
      method: "approval.resolve",
      params: { approvalId: "approval_A", resolution: "approved" },
    },
    {
      v: 1,
      kind: "command",
      commandId,
      sessionId,
      method: "input.respond",
      params: { inputId: "input_A", value: { answer: 42 } },
    },
    {
      v: 1,
      kind: "command",
      commandId,
      method: "providerConnection.environment.revalidate",
      params: {
        connectionId: "pconn_A",
        expectedLifecycleRevision: 2,
        expectedGeneration: 1,
      },
    },
  ])("decodes a valid $kind message", (message) => {
    expect(ClientMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    { v: 2, kind: "heartbeat", clientTimeMs: 100 },
    { v: 1, kind: "unknown" },
    { v: 1, kind: "command", commandId, method: "unknown", params: {} },
    {
      v: 1,
      kind: "command",
      commandId,
      sessionId,
      method: "message.submit",
      params: { text: "hello", unexpected: true },
    },
    {
      v: 1,
      kind: "command",
      commandId,
      method: "providerConnection.environment.revalidate",
      params: {
        connectionId: "pconn_A",
        expectedLifecycleRevision: 2,
        expectedGeneration: 1,
        variableName: "MUST_NOT_BE_CLIENT_SUPPLIED",
      },
    },
    { v: 1, kind: "heartbeat", clientTimeMs: Number.POSITIVE_INFINITY },
  ])("rejects invalid message %#", (message) => {
    expect(ClientMessageSchema.safeParse(message).success).toBe(false);
  });

  it("rejects session identity on session.create and requires it otherwise", () => {
    expect(
      CommandMessageSchema.safeParse({
        v: 1,
        kind: "command",
        commandId,
        sessionId,
        method: "session.create",
        params: {},
      }).success,
    ).toBe(false);
    expect(
      CommandMessageSchema.safeParse({
        v: 1,
        kind: "command",
        commandId,
        method: "message.submit",
        params: { text: "hello" },
      }).success,
    ).toBe(false);
  });

  it("hashes equivalent command content identically", async () => {
    const first = CommandMessageSchema.parse({
      v: 1,
      kind: "command",
      commandId: "cmd_first",
      sessionId,
      method: "message.submit",
      params: { text: "hello" },
    });
    const second = CommandMessageSchema.parse({
      params: { text: "hello" },
      method: "message.submit",
      sessionId,
      commandId: "cmd_second",
      kind: "command",
      v: 1,
    });

    await expect(hashCommandContent(first)).resolves.toBe(await hashCommandContent(second));
  });
});

describe("v1 server messages", () => {
  it.each([
    {
      v: 1,
      kind: "welcome",
      connectionId: "conn_A",
      serverTimeMs: 100,
      heartbeatIntervalMs: 15_000,
    },
    {
      v: 1,
      kind: "command.accepted",
      commandId,
      sessionId,
      acceptedSequence: 2,
      runId: "run_A",
      result: {},
      duplicate: false,
    },
    {
      v: 1,
      kind: "command.rejected",
      commandId,
      code: "protocol.command_id_conflict",
      message: "Command ID conflict.",
      diagnosticId: "err_A",
      recoverable: false,
    },
    { v: 1, kind: "replay.complete", requestId, sessionId, throughSequence: 8 },
    {
      v: 1,
      kind: "protocol.error",
      sessionId,
      code: "protocol.invalid_message",
      message: "Invalid message.",
      diagnosticId: "err_A",
      recoverable: true,
    },
    { v: 1, kind: "heartbeat", serverTimeMs: 100 },
    {
      v: 1,
      kind: "event",
      sessionId,
      sequence: 1,
      eventId: "evt_A",
      eventType: "session.created",
      createdAtMs: 100,
      data: { eventVersion: 1, title: "Session A" },
    },
  ])("decodes a valid $kind message", (message) => {
    expect(ServerMessageSchema.safeParse(message).success).toBe(true);
  });

  it("rejects unknown fields", () => {
    expect(
      ServerMessageSchema.safeParse({
        v: 1,
        kind: "heartbeat",
        serverTimeMs: 100,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});
