import { canonicalJson, type RunState, type SessionEvent } from "@wi/protocol";

import {
  MAXIMUM_BROWSER_SESSION_EVENT_CODE_UNITS,
  MAXIMUM_BROWSER_SESSION_EVENTS,
  type BrowserRunState,
  type BrowserSessionIntegrityError,
  type BrowserSessionState,
} from "./model.js";

const terminalRunStates = new Set<RunState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const allowedRunTransitions: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  created: new Set(["running"]),
  queued: new Set(["running"]),
  running: new Set([
    "waiting_for_user",
    "cancelling",
    "completed",
    "failed",
    "interrupted",
  ]),
  waiting_for_user: new Set(["running", "cancelling", "failed", "interrupted"]),
  cancelling: new Set(["cancelled", "interrupted"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
};

function sameJsonValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fatal(
  state: BrowserSessionState,
  errorCode: BrowserSessionIntegrityError,
): BrowserSessionState {
  return { ...state, status: "error", errorCode };
}

function runTransition(event: SessionEvent): BrowserRunState | null {
  switch (event.eventType) {
    case "run.created":
      return {
        runId: event.data.runId,
        state: "created",
        ...(event.data.eventVersion === 2
          ? { providerSelection: event.data.providerSelection }
          : {}),
      };
    case "run.started":
      return { runId: event.data.runId, state: "running" };
    case "run.waiting_for_user":
      return { runId: event.data.runId, state: "waiting_for_user" };
    case "run.cancel.requested":
      return { runId: event.data.runId, state: "cancelling" };
    case "run.cancelled":
      return { runId: event.data.runId, state: "cancelled" };
    case "run.completed":
      return { runId: event.data.runId, state: "completed" };
    case "run.failed":
      return { runId: event.data.runId, state: "failed" };
    case "run.interrupted":
      return { runId: event.data.runId, state: "interrupted" };
    default:
      return null;
  }
}

function applyRunTransition(
  state: BrowserSessionState,
  transition: BrowserRunState | null,
): BrowserSessionState {
  if (transition === null) return state;
  const current = state.activeRun;
  if (current === null) {
    if (state.queuedRuns.length > 0 || transition.state !== "created") {
      return fatal(state, "impossible_run_transition");
    }
    return { ...state, activeRun: transition };
  }
  if (current.runId === transition.runId) {
    if (!allowedRunTransitions[current.state].has(transition.state)) {
      return fatal(state, "impossible_run_transition");
    }
    return {
      ...state,
      activeRun: {
        ...transition,
        ...(current.providerSelection === undefined
          ? {}
          : { providerSelection: current.providerSelection }),
      },
    };
  }
  if (transition.state === "created") {
    if (state.queuedRuns.some((run) => run.runId === transition.runId)) {
      return fatal(state, "impossible_run_transition");
    }
    if (terminalRunStates.has(current.state) && state.queuedRuns.length === 0) {
      return { ...state, activeRun: transition };
    }
    return {
      ...state,
      queuedRuns: [...state.queuedRuns, { ...transition, state: "queued" }],
    };
  }
  if (!terminalRunStates.has(current.state)) return fatal(state, "second_active_run");
  const queued = state.queuedRuns[0];
  if (
    queued === undefined ||
    queued.runId !== transition.runId ||
    !allowedRunTransitions[queued.state].has(transition.state)
  ) {
    return fatal(state, "impossible_run_transition");
  }
  return {
    ...state,
    activeRun: {
      ...transition,
      ...(queued.providerSelection === undefined
        ? {}
        : { providerSelection: queued.providerSelection }),
    },
    queuedRuns: state.queuedRuns.slice(1),
  };
}

function removeInteractionsForRun<T extends { readonly runId: string }>(
  interactions: Readonly<Record<string, T>>,
  runId: string,
): Readonly<Record<string, T>> {
  const remaining = { ...interactions };
  for (const [id, interaction] of Object.entries(interactions)) {
    if (interaction.runId === runId) delete remaining[id];
  }
  return remaining;
}

function applyEventData(state: BrowserSessionState, event: SessionEvent): BrowserSessionState {
  const transitioned = applyRunTransition(state, runTransition(event));
  if (transitioned.errorCode !== null) return transitioned;

  let title = transitioned.title;
  let lastMessagePreview = transitioned.lastMessagePreview;
  let providerDefault = transitioned.providerDefault;
  let pendingApprovals = transitioned.pendingApprovals;
  let pendingInputs = transitioned.pendingInputs;

  switch (event.eventType) {
    case "session.created":
      title = event.data.title;
      break;
    case "session.provider_default.set":
      providerDefault = event.data.default;
      break;
    case "user.message.appended":
      lastMessagePreview = event.data.text.slice(0, 200);
      break;
    case "tool.approval.requested":
      pendingApprovals = {
        ...pendingApprovals,
        [event.data.approvalId]: {
          approvalId: event.data.approvalId,
          runId: event.data.runId,
          callId: event.data.callId,
          toolName: event.data.toolName,
          summary: event.data.summary,
        },
      };
      break;
    case "tool.approval.resolved": {
      const remaining = { ...pendingApprovals };
      delete remaining[event.data.approvalId];
      pendingApprovals = remaining;
      break;
    }
    case "input.requested":
      pendingInputs = {
        ...pendingInputs,
        [event.data.inputId]: {
          inputId: event.data.inputId,
          runId: event.data.runId,
          prompt: event.data.prompt,
        },
      };
      break;
    case "input.resolved": {
      const remaining = { ...pendingInputs };
      delete remaining[event.data.inputId];
      pendingInputs = remaining;
      break;
    }
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "run.interrupted":
      pendingApprovals = removeInteractionsForRun(pendingApprovals, event.data.runId);
      pendingInputs = removeInteractionsForRun(pendingInputs, event.data.runId);
      break;
  }

  return {
    ...transitioned,
    title,
    lastMessagePreview,
    ...(providerDefault === undefined ? {} : { providerDefault }),
    pendingApprovals,
    pendingInputs,
  };
}

export function reduceSessionEvent(
  state: BrowserSessionState,
  event: SessionEvent,
): BrowserSessionState {
  if (state.errorCode !== null) return state;
  if (event.sessionId !== state.sessionId) return fatal(state, "session_mismatch");

  const existingSequence = state.appliedEventSequencesById[event.eventId];
  if (existingSequence !== undefined && existingSequence !== event.sequence) {
    return fatal(state, "event_id_conflict");
  }
  if (event.sequence <= state.lastAppliedSequence) {
    const existing = state.appliedEvents[event.sequence];
    if (existing !== undefined && sameJsonValue(existing, event)) return state;
    return fatal(state, "event_conflict");
  }
  if (event.sequence !== state.lastAppliedSequence + 1) {
    return { ...state, status: "gap" };
  }

  const eventCodeUnits = canonicalJson(event).length;
  if (
    state.timeline.length >= MAXIMUM_BROWSER_SESSION_EVENTS ||
    eventCodeUnits > MAXIMUM_BROWSER_SESSION_EVENT_CODE_UNITS - state.retainedEventCodeUnits
  ) {
    // Exact duplicate and event-ID checks need retained history. Fail visibly instead of
    // silently discarding integrity evidence or allowing an unbounded browser projection.
    return fatal(state, "history_limit_exceeded");
  }

  const next = applyEventData(state, event);
  if (next.errorCode !== null) return next;
  return {
    ...next,
    lastAppliedSequence: event.sequence,
    timeline: [...state.timeline, event],
    appliedEvents: { ...state.appliedEvents, [event.sequence]: event },
    appliedEventSequencesById: {
      ...state.appliedEventSequencesById,
      [event.eventId]: event.sequence,
    },
    retainedEventCodeUnits: state.retainedEventCodeUnits + eventCodeUnits,
  };
}
