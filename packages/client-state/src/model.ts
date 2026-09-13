import type {
  RunProviderSelectionSnapshot,
  RunState,
  SessionEvent,
  SessionProviderDefault,
} from "@wi/protocol";

export type BrowserSessionStatus = "loading" | "replaying" | "live" | "gap" | "error";

export interface BrowserRunState {
  readonly runId: string;
  readonly state: RunState;
  readonly providerSelection?: RunProviderSelectionSnapshot | null;
}

export interface BrowserApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly summary: string;
}

export interface BrowserPendingInput {
  readonly inputId: string;
  readonly runId: string;
  readonly prompt: string;
}

export type TimelineItem = SessionEvent;

export const MAXIMUM_BROWSER_SESSION_EVENTS = 2_000;
export const MAXIMUM_BROWSER_SESSION_EVENT_CODE_UNITS = 8 * 1_024 * 1_024;

export type BrowserSessionIntegrityError =
  | "event_conflict"
  | "event_id_conflict"
  | "session_mismatch"
  | "impossible_run_transition"
  | "second_active_run"
  | "history_limit_exceeded";

export interface BrowserSessionState {
  readonly sessionId: string;
  readonly title: string;
  readonly lastMessagePreview: string | null;
  readonly providerDefault?: SessionProviderDefault | null;
  readonly lastAppliedSequence: number;
  readonly status: BrowserSessionStatus;
  readonly timeline: readonly TimelineItem[];
  readonly activeRun: BrowserRunState | null;
  readonly queuedRuns: readonly BrowserRunState[];
  readonly pendingApprovals: Readonly<Record<string, BrowserApproval>>;
  readonly pendingInputs: Readonly<Record<string, BrowserPendingInput>>;
  readonly appliedEvents: Readonly<Record<number, SessionEvent>>;
  readonly appliedEventSequencesById: Readonly<Record<string, number>>;
  readonly retainedEventCodeUnits: number;
  readonly errorCode: BrowserSessionIntegrityError | null;
}

export function createBrowserSessionState(sessionId: string): BrowserSessionState {
  return {
    sessionId,
    title: "",
    lastMessagePreview: null,
    lastAppliedSequence: 0,
    status: "loading",
    timeline: [],
    activeRun: null,
    queuedRuns: [],
    pendingApprovals: {},
    pendingInputs: {},
    appliedEvents: {},
    appliedEventSequencesById: {},
    retainedEventCodeUnits: 0,
    errorCode: null,
  };
}
