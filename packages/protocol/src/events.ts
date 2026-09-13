import { z } from "zod";

import { CanonicalJsonValueSchema } from "./canonical-json.js";
import {
  ErrorCodeSchema,
  LegacyFailureMessageSchema,
  SafeDiagnosticMessageSchema,
} from "./errors.js";
import { EventSequenceSchema, ProtocolVersionSchema, TimestampMsSchema } from "./envelope.js";
import {
  ApprovalIdSchema,
  DiagnosticIdSchema,
  EventIdSchema,
  InputIdSchema,
  MessageIdSchema,
  PartIdSchema,
  ProjectIdSchema,
  ProviderStepIdSchema,
  RunIdSchema,
  SessionIdSchema,
  ToolCallIdSchema,
} from "./ids.js";
import {
  RunProviderSelectionSnapshotSchema,
  SessionProviderDefaultSchema,
} from "./providers.js";
import { ApprovalResolutionSchema, ToolEffectClassSchema } from "./tools.js";

export const SESSION_EVENT_TYPES = [
  "session.created",
  "session.provider_default.set",
  "user.message.appended",
  "run.created",
  "run.started",
  "run.waiting_for_user",
  "run.cancel.requested",
  "run.cancelled",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "provider.step.started",
  "provider.text.delta",
  "provider.tool_call.staged",
  "provider.tool_call.reused",
  "provider.step.completed",
  "provider.step.interrupted",
  "provider.step.failed",
  "assistant.message.completed",
  "tool.call.requested",
  "tool.approval.requested",
  "tool.approval.resolved",
  "tool.execution.started",
  "tool.execution.recovered",
  "tool.execution.completed",
  "tool.execution.failed",
  "tool.execution.outcome_unknown",
  "input.requested",
  "input.resolved",
] as const;

export const SessionEventTypeSchema = z.enum(SESSION_EVENT_TYPES);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

export const RunStateSchema = z.enum([
  "created",
  "queued",
  "running",
  "waiting_for_user",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunState = z.infer<typeof RunStateSchema>;

const EventBaseSchema = z.strictObject({
  v: ProtocolVersionSchema,
  kind: z.literal("event"),
  sessionId: SessionIdSchema,
  sequence: EventSequenceSchema,
  eventId: EventIdSchema,
  createdAtMs: TimestampMsSchema,
});

const VersionSchema = z.literal(1);
const SafeFailureVersionSchema = z.literal(2);
const runData = { eventVersion: VersionSchema, runId: RunIdSchema } as const;
const stepData = {
  eventVersion: VersionSchema,
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
} as const;
const toolData = {
  eventVersion: VersionSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
} as const;

const runFailureV1 = z.strictObject({
  eventVersion: VersionSchema,
  runId: RunIdSchema,
  code: ErrorCodeSchema,
  message: LegacyFailureMessageSchema,
  diagnosticId: DiagnosticIdSchema,
});
const runFailureV2 = z.strictObject({
  eventVersion: SafeFailureVersionSchema,
  runId: RunIdSchema,
  code: ErrorCodeSchema,
  message: SafeDiagnosticMessageSchema,
  diagnosticId: DiagnosticIdSchema,
});
const runFailureData = z.discriminatedUnion("eventVersion", [runFailureV1, runFailureV2]);

const stepFailureV1 = z.strictObject({
  eventVersion: VersionSchema,
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
  code: ErrorCodeSchema,
  message: LegacyFailureMessageSchema,
  diagnosticId: DiagnosticIdSchema,
});
const stepFailureV2 = z.strictObject({
  eventVersion: SafeFailureVersionSchema,
  runId: RunIdSchema,
  stepId: ProviderStepIdSchema,
  code: ErrorCodeSchema,
  message: SafeDiagnosticMessageSchema,
  diagnosticId: DiagnosticIdSchema,
});
const stepFailureData = z.discriminatedUnion("eventVersion", [stepFailureV1, stepFailureV2]);

const toolFailureV1 = z.strictObject({
  eventVersion: VersionSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
  code: ErrorCodeSchema,
  message: LegacyFailureMessageSchema,
  diagnosticId: DiagnosticIdSchema,
});
const toolFailureV2 = z.strictObject({
  eventVersion: SafeFailureVersionSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
  code: ErrorCodeSchema,
  message: SafeDiagnosticMessageSchema,
  diagnosticId: DiagnosticIdSchema,
});
const toolFailureData = z.discriminatedUnion("eventVersion", [toolFailureV1, toolFailureV2]);

const toolOutcomeUnknownV1 = z.strictObject({
  eventVersion: VersionSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
  code: z.literal("tool.outcome_unknown"),
  message: LegacyFailureMessageSchema,
  diagnosticId: DiagnosticIdSchema,
});
const toolOutcomeUnknownV2 = z.strictObject({
  eventVersion: SafeFailureVersionSchema,
  runId: RunIdSchema,
  callId: ToolCallIdSchema,
  code: z.literal("tool.outcome_unknown"),
  message: SafeDiagnosticMessageSchema,
  diagnosticId: DiagnosticIdSchema,
});
const toolOutcomeUnknownData = z.discriminatedUnion("eventVersion", [
  toolOutcomeUnknownV1,
  toolOutcomeUnknownV2,
]);

function eventMessage<TType extends SessionEventType, TData extends z.ZodType>(
  eventType: TType,
  data: TData,
) {
  return EventBaseSchema.extend({
    eventType: z.literal(eventType),
    data,
  });
}

export const SessionCreatedEventSchema = eventMessage(
  "session.created",
  z.strictObject({
    eventVersion: VersionSchema,
    title: z.string(),
    projectId: ProjectIdSchema.optional(),
  }),
);

export const SessionProviderDefaultSetEventSchema = eventMessage(
  "session.provider_default.set",
  z.strictObject({
    eventVersion: VersionSchema,
    default: SessionProviderDefaultSchema,
  }),
);

export const UserMessageAppendedEventSchema = eventMessage(
  "user.message.appended",
  z.strictObject({
    eventVersion: VersionSchema,
    messageId: MessageIdSchema,
    runId: RunIdSchema,
    text: z.string(),
  }),
);

const RunCreatedDataSchema = z.discriminatedUnion("eventVersion", [
  z.strictObject(runData),
  z.strictObject({
    eventVersion: z.literal(2),
    runId: RunIdSchema,
    providerSelection: RunProviderSelectionSnapshotSchema,
  }),
]);
export const RunCreatedEventSchema = eventMessage("run.created", RunCreatedDataSchema);
export const RunStartedEventSchema = eventMessage("run.started", z.strictObject(runData));
export const RunWaitingForUserEventSchema = eventMessage(
  "run.waiting_for_user",
  z.discriminatedUnion("reason", [
    z.strictObject({
      ...runData,
      reason: z.literal("approval"),
      approvalId: ApprovalIdSchema,
    }),
    z.strictObject({
      ...runData,
      reason: z.literal("input"),
      inputId: InputIdSchema,
    }),
  ]),
);
export const RunCancelRequestedEventSchema = eventMessage(
  "run.cancel.requested",
  z.strictObject(runData),
);
export const RunCancelledEventSchema = eventMessage("run.cancelled", z.strictObject(runData));
export const RunCompletedEventSchema = eventMessage("run.completed", z.strictObject(runData));
export const RunFailedEventSchema = eventMessage("run.failed", runFailureData);
export const RunInterruptedEventSchema = eventMessage("run.interrupted", runFailureData);

export const ProviderStepStartedEventSchema = eventMessage(
  "provider.step.started",
  z.strictObject({ ...stepData, stepIndex: z.number().int().nonnegative().safe() }),
);
export const ProviderTextDeltaEventSchema = eventMessage(
  "provider.text.delta",
  z.strictObject({
    ...stepData,
    messageId: MessageIdSchema,
    partId: PartIdSchema,
    text: z.string(),
  }),
);
export const ProviderToolCallStagedEventSchema = eventMessage(
  "provider.tool_call.staged",
  z.strictObject({
    ...stepData,
    callId: ToolCallIdSchema,
    name: z.string().min(1),
    argumentsJson: z.string(),
  }),
);
export const ProviderToolCallReusedEventSchema = eventMessage(
  "provider.tool_call.reused",
  z.strictObject({
    ...stepData,
    callId: ToolCallIdSchema,
    originalStepId: ProviderStepIdSchema,
  }),
);
export const ProviderStepCompletedEventSchema = eventMessage(
  "provider.step.completed",
  z.strictObject(stepData),
);
export const ProviderStepInterruptedEventSchema = eventMessage(
  "provider.step.interrupted",
  stepFailureData,
);
export const ProviderStepFailedEventSchema = eventMessage(
  "provider.step.failed",
  stepFailureData,
);

export const AssistantMessageCompletedEventSchema = eventMessage(
  "assistant.message.completed",
  z.strictObject({ ...runData, messageId: MessageIdSchema }),
);

export const ToolCallRequestedEventSchema = eventMessage(
  "tool.call.requested",
  z.strictObject({
    ...stepData,
    callId: ToolCallIdSchema,
    name: z.string().min(1),
    argumentsJson: z.string(),
    argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
    effectClass: ToolEffectClassSchema,
  }),
);
export const ToolApprovalRequestedEventSchema = eventMessage(
  "tool.approval.requested",
  z.strictObject({
    ...toolData,
    approvalId: ApprovalIdSchema,
    toolName: z.string().min(1),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string(),
  }),
);
export const ToolApprovalResolvedEventSchema = eventMessage(
  "tool.approval.resolved",
  z.strictObject({
    ...toolData,
    approvalId: ApprovalIdSchema,
    resolution: ApprovalResolutionSchema,
  }),
);
export const ToolExecutionStartedEventSchema = eventMessage(
  "tool.execution.started",
  z.strictObject(toolData),
);
export const ToolExecutionRecoveredEventSchema = eventMessage(
  "tool.execution.recovered",
  z.strictObject({ ...toolData, attemptCount: z.number().int().positive().safe() }),
);
export const ToolExecutionCompletedEventSchema = eventMessage(
  "tool.execution.completed",
  z.strictObject({ ...toolData, result: CanonicalJsonValueSchema }),
);
export const ToolExecutionFailedEventSchema = eventMessage(
  "tool.execution.failed",
  toolFailureData,
);
export const ToolExecutionOutcomeUnknownEventSchema = eventMessage(
  "tool.execution.outcome_unknown",
  toolOutcomeUnknownData,
);

export const InputRequestedEventSchema = eventMessage(
  "input.requested",
  z.strictObject({
    ...runData,
    inputId: InputIdSchema,
    prompt: z.string(),
  }),
);
export const InputResolvedEventSchema = eventMessage(
  "input.resolved",
  z.strictObject({
    ...runData,
    inputId: InputIdSchema,
    value: CanonicalJsonValueSchema,
  }),
);

const BrowserRunFailedEventSchema = eventMessage("run.failed", runFailureV2);
const BrowserRunInterruptedEventSchema = eventMessage("run.interrupted", runFailureV2);
const BrowserProviderStepInterruptedEventSchema = eventMessage(
  "provider.step.interrupted",
  stepFailureV2,
);
const BrowserProviderStepFailedEventSchema = eventMessage(
  "provider.step.failed",
  stepFailureV2,
);
const BrowserToolExecutionFailedEventSchema = eventMessage(
  "tool.execution.failed",
  toolFailureV2,
);
const BrowserToolExecutionOutcomeUnknownEventSchema = eventMessage(
  "tool.execution.outcome_unknown",
  toolOutcomeUnknownV2,
);

export const SessionEventSchema = z.discriminatedUnion("eventType", [
  SessionCreatedEventSchema,
  SessionProviderDefaultSetEventSchema,
  UserMessageAppendedEventSchema,
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunWaitingForUserEventSchema,
  RunCancelRequestedEventSchema,
  RunCancelledEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunInterruptedEventSchema,
  ProviderStepStartedEventSchema,
  ProviderTextDeltaEventSchema,
  ProviderToolCallStagedEventSchema,
  ProviderToolCallReusedEventSchema,
  ProviderStepCompletedEventSchema,
  ProviderStepInterruptedEventSchema,
  ProviderStepFailedEventSchema,
  AssistantMessageCompletedEventSchema,
  ToolCallRequestedEventSchema,
  ToolApprovalRequestedEventSchema,
  ToolApprovalResolvedEventSchema,
  ToolExecutionStartedEventSchema,
  ToolExecutionRecoveredEventSchema,
  ToolExecutionCompletedEventSchema,
  ToolExecutionFailedEventSchema,
  ToolExecutionOutcomeUnknownEventSchema,
  InputRequestedEventSchema,
  InputResolvedEventSchema,
]);

export const BrowserSessionEventSchema = z.discriminatedUnion("eventType", [
  SessionCreatedEventSchema,
  SessionProviderDefaultSetEventSchema,
  UserMessageAppendedEventSchema,
  RunCreatedEventSchema,
  RunStartedEventSchema,
  RunWaitingForUserEventSchema,
  RunCancelRequestedEventSchema,
  RunCancelledEventSchema,
  RunCompletedEventSchema,
  BrowserRunFailedEventSchema,
  BrowserRunInterruptedEventSchema,
  ProviderStepStartedEventSchema,
  ProviderTextDeltaEventSchema,
  ProviderToolCallStagedEventSchema,
  ProviderToolCallReusedEventSchema,
  ProviderStepCompletedEventSchema,
  BrowserProviderStepInterruptedEventSchema,
  BrowserProviderStepFailedEventSchema,
  AssistantMessageCompletedEventSchema,
  ToolCallRequestedEventSchema,
  ToolApprovalRequestedEventSchema,
  ToolApprovalResolvedEventSchema,
  ToolExecutionStartedEventSchema,
  ToolExecutionRecoveredEventSchema,
  ToolExecutionCompletedEventSchema,
  BrowserToolExecutionFailedEventSchema,
  BrowserToolExecutionOutcomeUnknownEventSchema,
  InputRequestedEventSchema,
  InputResolvedEventSchema,
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type BrowserSessionEvent = z.infer<typeof BrowserSessionEventSchema>;

export const LEGACY_FAILURE_BROWSER_MESSAGE =
  "A failure recorded by an earlier Wi version was hidden for safety. Use the diagnostic ID for details.";

function safeBrowserProjection(event: SessionEvent): unknown {
  switch (event.eventType) {
    case "run.failed":
    case "run.interrupted":
    case "provider.step.failed":
    case "provider.step.interrupted":
    case "tool.execution.failed":
    case "tool.execution.outcome_unknown":
      if (event.data.eventVersion === 1) {
        return {
          ...event,
          data: {
            ...event.data,
            eventVersion: 2,
            message: LEGACY_FAILURE_BROWSER_MESSAGE,
          },
        };
      }
      return event;
    default:
      return event;
  }
}

export function toBrowserSessionEvent(event: SessionEvent): BrowserSessionEvent {
  return BrowserSessionEventSchema.parse(safeBrowserProjection(event));
}
