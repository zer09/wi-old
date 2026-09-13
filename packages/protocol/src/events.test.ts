import { describe, expect, it } from "vitest";

import {
  LEGACY_FAILURE_MESSAGE_MAX_BYTES,
  SAFE_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
} from "./errors.js";
import {
  BrowserSessionEventSchema,
  LEGACY_FAILURE_BROWSER_MESSAGE,
  SESSION_EVENT_TYPES,
  SessionEventSchema,
  toBrowserSessionEvent,
  type SessionEventType,
} from "./events.js";

const run = { eventVersion: 1, runId: "run_A" } as const;
const step = { ...run, stepId: "step_A" } as const;
const tool = { ...run, callId: "call_A" } as const;
const safeRun = { eventVersion: 2, runId: "run_A" } as const;
const safeStep = { ...safeRun, stepId: "step_A" } as const;
const safeTool = { ...safeRun, callId: "call_A" } as const;
const failure = {
  code: "provider.protocol_error",
  message: "Safe failure.",
  diagnosticId: "err_A",
} as const;
const digest = "a".repeat(64);

const eventData: Record<SessionEventType, unknown> = {
  "session.created": { eventVersion: 1, title: "Session A" },
  "session.provider_default.set": {
    eventVersion: 1,
    default: {
      version: 1,
      policy: { kind: "explicit", connectionId: "pconn_A" },
      modelId: "fixture-model",
      capabilitiesVersion: "capver_A",
      promptVersion: "prompt-v1",
      toolSchemaHash: digest,
      reasoning: { effort: "none", summary: "none" },
      transportMode: "no_network_fixture",
    },
  },
  "user.message.appended": { ...run, messageId: "msg_user", text: "hello" },
  "run.created": run,
  "run.started": run,
  "run.waiting_for_user": { ...run, reason: "approval", approvalId: "approval_A" },
  "run.cancel.requested": run,
  "run.cancelled": run,
  "run.completed": run,
  "run.failed": { ...safeRun, ...failure },
  "run.interrupted": { ...safeRun, ...failure },
  "provider.step.started": { ...step, stepIndex: 0 },
  "provider.text.delta": {
    ...step,
    messageId: "msg_assistant",
    partId: "part_A",
    text: "working",
  },
  "provider.tool_call.staged": {
    ...step,
    callId: "call_A",
    name: "echo",
    argumentsJson: '{"text":"hello"}',
  },
  "provider.tool_call.reused": { ...step, callId: "call_A", originalStepId: "step_original" },
  "provider.step.completed": step,
  "provider.step.interrupted": { ...safeStep, ...failure },
  "provider.step.failed": { ...safeStep, ...failure },
  "assistant.message.completed": { ...run, messageId: "msg_assistant" },
  "tool.call.requested": {
    ...step,
    callId: "call_A",
    name: "echo",
    argumentsJson: '{"text":"hello"}',
    argumentsHash: digest,
    effectClass: "pure",
  },
  "tool.approval.requested": {
    ...tool,
    approvalId: "approval_A",
    toolName: "guarded_echo",
    actionDigest: digest,
    summary: "Echo hello",
  },
  "tool.approval.resolved": { ...tool, approvalId: "approval_A", resolution: "approved" },
  "tool.execution.started": tool,
  "tool.execution.recovered": { ...tool, attemptCount: 1 },
  "tool.execution.completed": { ...tool, result: { text: "hello" } },
  "tool.execution.failed": { ...safeTool, ...failure, code: "tool.execution_failed" },
  "tool.execution.outcome_unknown": {
    ...safeTool,
    code: "tool.outcome_unknown",
    message: "Outcome cannot be proven.",
    diagnosticId: "err_A",
  },
  "input.requested": { ...run, inputId: "input_A", prompt: "Continue?" },
  "input.resolved": { ...run, inputId: "input_A", value: "yes" },
};

describe("durable session events", () => {
  it.each(SESSION_EVENT_TYPES)("decodes %s", (eventType) => {
    expect(
      SessionEventSchema.safeParse({
        v: 1,
        kind: "event",
        sessionId: "ses_A",
        sequence: 1,
        eventId: "evt_A",
        eventType,
        createdAtMs: 100,
        data: eventData[eventType],
      }).success,
    ).toBe(true);
  });

  it("bounds durable failure messages", () => {
    const base = {
      v: 1,
      kind: "event",
      sessionId: "ses_A",
      sequence: 1,
      eventId: "evt_A",
      eventType: "run.failed",
      createdAtMs: 100,
    } as const;
    expect(
      SessionEventSchema.safeParse({
        ...base,
        data: {
          ...safeRun,
          ...failure,
          message: "x".repeat(SAFE_DIAGNOSTIC_MESSAGE_MAX_LENGTH),
        },
      }).success,
    ).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        ...base,
        data: {
          ...safeRun,
          ...failure,
          message: "x".repeat(SAFE_DIAGNOSTIC_MESSAGE_MAX_LENGTH + 1),
        },
      }).success,
    ).toBe(false);
  });

  it("decodes bounded legacy v1 failures and projects them safely for the browser", () => {
    const base = {
      v: 1,
      kind: "event",
      sessionId: "ses_A",
      sequence: 1,
      eventId: "evt_legacyFailure",
      eventType: "run.failed",
      createdAtMs: 100,
    } as const;
    const legacySecret = "Bearer LEGACY_PROVIDER_SECRET";
    const legacy = SessionEventSchema.parse({
      ...base,
      data: {
        ...run,
        ...failure,
        message: legacySecret.padEnd(700, "x"),
      },
    });

    expect(BrowserSessionEventSchema.safeParse(legacy).success).toBe(false);
    const projected = toBrowserSessionEvent(legacy);
    expect(projected.data).toMatchObject({
      eventVersion: 2,
      message: LEGACY_FAILURE_BROWSER_MESSAGE,
      diagnosticId: "err_A",
    });
    expect(JSON.stringify(projected)).not.toContain(legacySecret);
    expect(
      SessionEventSchema.safeParse({
        ...base,
        data: { ...run, ...failure, message: "x".repeat(LEGACY_FAILURE_MESSAGE_MAX_BYTES) },
      }).success,
    ).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        ...base,
        data: {
          ...run,
          ...failure,
          message: "x".repeat(LEGACY_FAILURE_MESSAGE_MAX_BYTES + 1),
        },
      }).success,
    ).toBe(false);
  });

  it("decodes input-specific waiting payload", () => {
    expect(
      SessionEventSchema.safeParse({
        v: 1,
        kind: "event",
        sessionId: "ses_A",
        sequence: 1,
        eventId: "evt_A",
        eventType: "run.waiting_for_user",
        createdAtMs: 100,
        data: { eventVersion: 1, runId: "run_A", reason: "input", inputId: "input_A" },
      }).success,
    ).toBe(true);
  });

  it.each([
    { eventVersion: 1, runId: "run_A", reason: "approval" },
    { eventVersion: 1, runId: "run_A", reason: "approval", inputId: "input_A" },
    { eventVersion: 1, runId: "run_A", reason: "input", approvalId: "approval_A" },
    {
      eventVersion: 1,
      runId: "run_A",
      reason: "input",
      approvalId: "approval_A",
      inputId: "input_A",
    },
  ])("rejects contradictory waiting payload %#", (data) => {
    expect(
      SessionEventSchema.safeParse({
        v: 1,
        kind: "event",
        sessionId: "ses_A",
        sequence: 1,
        eventId: "evt_A",
        eventType: "run.waiting_for_user",
        createdAtMs: 100,
        data,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown event types, versions, and payload fields", () => {
    const base = {
      v: 1,
      kind: "event",
      sessionId: "ses_A",
      sequence: 1,
      eventId: "evt_A",
      createdAtMs: 100,
    };

    expect(
      SessionEventSchema.safeParse({ ...base, sequence: 0, eventType: "run.started", data: run })
        .success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse({ ...base, eventType: "unknown", data: { eventVersion: 1 } })
        .success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse({
        ...base,
        eventType: "run.started",
        data: { ...run, eventVersion: 2 },
      }).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse({
        ...base,
        eventType: "run.started",
        data: { ...run, unexpected: true },
      }).success,
    ).toBe(false);
  });
});
