# Wi v0.1 plus v0.2 Milestone 11 session event catalog

Source of truth: `packages/protocol/src/events.ts`. Every canonical session event is committed to exactly one session database before publication.

## Common envelope

```json
{
  "v": 1,
  "kind": "event",
  "sessionId": "ses_...",
  "sequence": 1,
  "eventId": "evt_...",
  "createdAtMs": 1730000000000,
  "eventType": "session.created",
  "data": { "eventVersion": 1 }
}
```

- `sequence` is positive, contiguous, and monotonically increasing within one session.
- `eventId` identifies immutable content. Reusing it at another sequence or changing same-sequence content is an integrity error.
- Event rows are append-only; SQLite triggers reject update and delete.
- Data schemas are strict. Unknown envelope/data fields are rejected.
- Most data payloads use `eventVersion: 1`. Failure payloads also accept canonical legacy version 1; browser projection converts those messages to safe version 2 text before delivery.

## Session and message events

| Event | Data fields beyond `eventVersion` | Meaning |
|---|---|---|
| `session.created` | `title`, optional `projectId` | Canonical creation identity and initial title |
| `session.provider_default.set` | complete nonsecret `default` selection | Future-run explicit provider connection/model default committed with its projection |
| `user.message.appended` | `messageId`, `runId`, `text` | User message accepted for a run |
| `assistant.message.completed` | `runId`, `messageId` | Assistant message is complete and no longer streaming |

## Run events

| Event | Data fields beyond `eventVersion` | Meaning |
|---|---|---|
| `run.created` | version 1: `runId`; version 2: `runId`, complete immutable `providerSelection` | Durable run created; selected M11 runs pin server-authored connection, credential generation, capabilities, model, prompt/tool identity, transport, and provider chain |
| `run.started` | `runId` | Run entered provider/tool execution |
| `run.waiting_for_user` | `runId`, `reason: approval`, `approvalId`; or `reason: input`, `inputId` | Run is durable and waiting without requiring a browser |
| `run.cancel.requested` | `runId` | Durable cancellation accepted |
| `run.cancelled` | `runId` | Terminal cancelled state |
| `run.completed` | `runId` | Terminal successful state |
| `run.failed` | `runId`, `code`, safe `message`, `diagnosticId` | Terminal definite failure |
| `run.interrupted` | `runId`, `code`, safe `message`, `diagnosticId` | Terminal interruption where continuation was not safe |

Run states are `created`, `queued`, `running`, `waiting_for_user`, `cancelling`, `completed`, `failed`, `cancelled`, and `interrupted`. Terminal runs never transition back.

## Provider events

| Event | Data fields beyond `eventVersion` | Meaning |
|---|---|---|
| `provider.step.started` | `runId`, `stepId`, `stepIndex` | Provider operation began |
| `provider.text.delta` | `runId`, `stepId`, `messageId`, `partId`, `text` | Committed bounded assistant-text delta |
| `provider.tool_call.staged` | `runId`, `stepId`, `callId`, `name`, `argumentsJson` | Complete call observed, but still non-executable |
| `provider.tool_call.reused` | `runId`, `stepId`, `callId`, `originalStepId` | Identical durable call identity reused |
| `provider.step.completed` | `runId`, `stepId` | Valid terminal completion committed; staged calls may now promote |
| `provider.step.interrupted` | `runId`, `stepId`, `code`, safe `message`, `diagnosticId` | Provider step ended after output or another non-retryable interruption |
| `provider.step.failed` | `runId`, `stepId`, `code`, safe `message`, `diagnosticId` | Provider step failed definitely |

Provider transport events are provisional. A `provider.tool_call.staged` event never authorizes execution by itself.

## Tool and approval events

| Event | Data fields beyond `eventVersion` | Meaning |
|---|---|---|
| `tool.call.requested` | `runId`, `stepId`, `callId`, `name`, `argumentsJson`, `argumentsHash`, `effectClass` | Promoted ledger identity after provider completion |
| `tool.approval.requested` | `runId`, `callId`, `approvalId`, `toolName`, `actionDigest`, `summary` | Durable approval wait created |
| `tool.approval.resolved` | `runId`, `callId`, `approvalId`, `resolution` | First valid `approved`/`denied` resolution won |
| `tool.execution.started` | `runId`, `callId` | Execution start committed before effect invocation |
| `tool.execution.recovered` | `runId`, `callId`, `attemptCount` | Recoverable effect resumed under ledger policy |
| `tool.execution.completed` | `runId`, `callId`, canonical JSON `result` | Result committed |
| `tool.execution.failed` | `runId`, `callId`, `code`, safe `message`, `diagnosticId` | Definite terminal tool failure |
| `tool.execution.outcome_unknown` | `runId`, `callId`, `code: tool.outcome_unknown`, safe `message`, `diagnosticId` | Non-idempotent effect may have occurred; never retried automatically |

Effect classes are `pure`, `local_transactional`, `idempotent_external`, and `non_idempotent`. Duplicate `callId` with identical tool/arguments reuses the ledger result; changed identity is a provider protocol error.

## Pending-input events

| Event | Data fields beyond `eventVersion` | Meaning |
|---|---|---|
| `input.requested` | `runId`, `inputId`, `prompt` | Durable structured input wait |
| `input.resolved` | `runId`, `inputId`, canonical JSON `value` | First valid input response committed |

## Failure messages and diagnostics

Failure events store an allowlisted error `code`, bounded message, and `diagnosticId`. Canonical version-1 failure events from retained databases may contain legacy text. `toBrowserSessionEvent` replaces that text with a fixed safe message and emits browser data version 2; it does not rewrite canonical history.

Detailed causes remain in bounded redacted server logs and are correlated using `diagnosticId`.

## Related protocol messages

Session events are one member of the server-message union. Other server messages are `welcome`, `command.accepted`, `command.rejected`, `replay.complete`, `protocol.error`, and `heartbeat`. See [the browser protocol](../architecture/browser-protocol.md) for complete wire examples.
