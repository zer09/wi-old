import { useEffect, useMemo, useRef, useState } from "react";
import {
  beginReplay,
  completeReplay,
  createBrowserSessionState,
  reduceSessionEvent,
  type BrowserSessionState,
} from "@wi/client-state";
import {
  createId,
  type ApprovalResolution,
  type BrowserCommandLimits,
  type BrowserSessionSummary,
  type CanonicalJsonValue,
  type CommandMessage,
  type ServerMessage,
} from "@wi/protocol";

import { fetchBootstrap, websocketUrl } from "./api/bootstrap.js";
import { ApprovalPanel } from "./components/ApprovalPanel.js";
import { Composer } from "./components/Composer.js";
import { ConnectionStatus } from "./components/ConnectionStatus.js";
import { PendingInputPanel } from "./components/PendingInputPanel.js";
import { ProviderConnectionsPanel } from "./components/ProviderConnectionsPanel.js";
import { RunStatus } from "./components/RunStatus.js";
import { SessionList } from "./components/SessionList.js";
import { Timeline } from "./components/Timeline.js";
import { replayRecoveryAction } from "./state/replay-recovery.js";
import {
  BrowserCommandJournalError,
  createBrowserCommandJournal,
  inputDraftKey,
  messageDraftKey,
  sessionTitleDraftKey,
  type JournalDraftKey,
  type JournalDraftReference,
} from "./state/command-journal.js";
import {
  createBrowserSessionIndex,
  initialSessionIdFromLocation,
  projectSessionSummary,
  upsertSessionSummary,
  type BrowserSessionIndex,
} from "./state/session-index.js";
import { BrowserCommandLimitError } from "./socket/command-size.js";
import {
  WiSocketClient,
  type ConnectionSnapshot,
  type PendingCommand,
} from "./socket/client.js";

interface Notice {
  readonly id: number;
  readonly tone: "error" | "info";
  readonly text: string;
  readonly code?: string;
}

interface FocusRecovery {
  readonly sessionId: string;
  readonly kind: "approval" | "cancel" | "input";
  readonly targetId: string;
  readonly initiatingElement: HTMLElement | null;
}

const INITIAL_CONNECTION: ConnectionSnapshot = {
  status: "idle",
  reconnectDelayMs: null,
  closeCode: null,
  detail: null,
};

const TERMINAL_CONNECTION_STATES = new Set(["closed", "error"]);

function idSource(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function updateLocationSession(sessionId: string): void {
  const url = new URL(globalThis.location.href);
  url.searchParams.set("session", sessionId);
  globalThis.history.replaceState(null, "", url);
}

function restoredDrafts(
  drafts: Readonly<Record<JournalDraftKey, string>>,
  prefix: "input:" | "message:",
): Readonly<Record<string, string>> {
  const restored: Record<string, string> = {};
  for (const [key, value] of Object.entries(drafts)) {
    if (key.startsWith(prefix)) restored[key.slice(prefix.length)] = value;
  }
  return restored;
}

export function App() {
  const [commandJournal] = useState(() => createBrowserCommandJournal());
  const socket = useRef<WiSocketClient | null>(null);
  const sessionStates = useRef<Readonly<Record<string, BrowserSessionState>>>({});
  const noticeId = useRef(0);
  const resyncingSessions = useRef(new Set<string>());
  const selectedSessionIdRef = useRef<string | null>(null);
  const sessionProtocolErrorsRef = useRef<Readonly<Record<string, string>>>({});
  const focusRecovery = useRef<FocusRecovery | null>(null);
  const [bootstrapState, setBootstrapState] = useState<"loading" | "ready" | "error">("loading");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [connection, setConnection] = useState(INITIAL_CONNECTION);
  const [commandLimits, setCommandLimits] = useState<BrowserCommandLimits | null>(null);
  const [sessionIndex, setSessionIndex] = useState<BrowserSessionIndex>(() =>
    createBrowserSessionIndex([], false),
  );
  const [sessions, setSessions] = useState<Readonly<Record<string, BrowserSessionState>>>({});
  const [sessionProtocolErrors, setSessionProtocolErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionTitleDraft, setSessionTitleDraft] = useState(
    () => commandJournal.drafts()[sessionTitleDraftKey()] ?? "",
  );
  const [messageDrafts, setMessageDrafts] = useState<Readonly<Record<string, string>>>(() =>
    restoredDrafts(commandJournal.drafts(), "message:"),
  );
  const [inputDrafts, setInputDrafts] = useState<Readonly<Record<string, string>>>(() =>
    restoredDrafts(commandJournal.drafts(), "input:"),
  );
  const [pendingCommands, setPendingCommands] = useState<readonly PendingCommand[]>([]);
  const [notices, setNotices] = useState<readonly Notice[]>([]);

  function addNotice(
    text: string,
    tone: Notice["tone"] = "info",
    code?: string,
  ): void {
    noticeId.current += 1;
    const notice = {
      id: noticeId.current,
      text,
      tone,
      ...(code === undefined ? {} : { code }),
    };
    setNotices((current) => [...current.slice(-4), notice]);
  }

  function storeSession(next: BrowserSessionState, durableEventTimestampMs?: number): void {
    const nextSessions = { ...sessionStates.current, [next.sessionId]: next };
    sessionStates.current = nextSessions;
    setSessions(nextSessions);
    setSessionIndex((current) => {
      const previous = current.summaries.find(
        (summary) => summary.sessionId === next.sessionId,
      );
      const replacement = projectSessionSummary(previous, next, durableEventTimestampMs);
      return replacement === null
        ? current
        : upsertSessionSummary(current, replacement, selectedSessionIdRef.current);
    });
  }

  function openSession(sessionId: string): void {
    let state = sessionStates.current[sessionId];
    if (selectedSessionIdRef.current === sessionId && state !== undefined) {
      setSelectedSessionId(sessionId);
      updateLocationSession(sessionId);
      return;
    }

    const previousSessionId = selectedSessionIdRef.current;
    if (previousSessionId !== null && previousSessionId !== sessionId) {
      focusRecovery.current = null;
      socket.current?.closeSession(previousSessionId);
      resyncingSessions.current.delete(previousSessionId);
      const previousState = sessionStates.current[previousSessionId];
      if (
        previousState?.errorCode === null &&
        sessionProtocolErrorsRef.current[previousSessionId] === undefined
      ) {
        const remaining = { ...sessionStates.current };
        delete remaining[previousSessionId];
        sessionStates.current = remaining;
        setSessions(remaining);
      }
    }

    if (state === undefined) state = createBrowserSessionState(sessionId);
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    updateLocationSession(sessionId);
    if (state.errorCode !== null || sessionProtocolErrorsRef.current[sessionId] !== undefined) {
      storeSession(state);
      return;
    }
    state = beginReplay(state);
    storeSession(state);
    socket.current?.openSession(sessionId, state.lastAppliedSequence);
  }

  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let socketClient: WiSocketClient | null = null;

    void fetchBootstrap(abort.signal).then(
      (bootstrap) => {
        if (!active) return;
        setSessionIndex(
          createBrowserSessionIndex(bootstrap.sessions, bootstrap.sessionsTruncated),
        );
        setCommandLimits(bootstrap.commandLimits);
        const initialSessionId = initialSessionIdFromLocation(
          globalThis.location.href,
          bootstrap.sessions,
        );

        socketClient = new WiSocketClient({
          url: websocketUrl(bootstrap.websocketPath),
          protocol: bootstrap.websocketProtocol,
          commandLimits: bootstrap.commandLimits,
          journal: commandJournal,
          refreshConnection: async (signal) => {
            const refreshed = await fetchBootstrap(signal);
            if (active) setCommandLimits(refreshed.commandLimits);
            return {
              url: websocketUrl(refreshed.websocketPath),
              protocol: refreshed.websocketProtocol,
              commandLimits: refreshed.commandLimits,
            };
          },
          onConnectionChange: (next) => {
            if (!active) return;
            if (TERMINAL_CONNECTION_STATES.has(next.status)) focusRecovery.current = null;
            setConnection(next);
            if (next.status === "handshaking") {
              resyncingSessions.current.clear();
              for (const state of Object.values(sessionStates.current)) {
                storeSession(beginReplay(state));
              }
            }
          },
          onPendingCommandsChange: (commands) => {
            if (active) setPendingCommands(commands);
          },
          onLocalCommandError: (_commandId, message) => {
            if (active) addNotice(message, "error");
          },
          onMessage: (message) => {
            if (!active || socketClient === null) return;
            handleServerMessage(message, socketClient);
          },
        });
        socket.current = socketClient;
        setBootstrapState("ready");
        if (initialSessionId !== null) openSession(initialSessionId);
        socketClient.connect();
      },
      (error: unknown) => {
        if (!active || abort.signal.aborted) return;
        setBootstrapState("error");
        setBootstrapError(error instanceof Error ? error.message : "Bootstrap failed");
      },
    );

    function handleServerMessage(message: ServerMessage, client: WiSocketClient): void {
      if (message.kind === "event") {
        if (!client.hasOpenSession(message.sessionId)) return;
        const previous =
          sessionStates.current[message.sessionId] ?? createBrowserSessionState(message.sessionId);
        const reduced = reduceSessionEvent(previous, message);
        if (reduced.status === "gap") {
          if (!resyncingSessions.current.has(message.sessionId)) {
            resyncingSessions.current.add(message.sessionId);
            addNotice("A sequence gap was detected. Replaying from the last trusted event.", "error");
            const replaying = beginReplay(reduced);
            storeSession(replaying, message.createdAtMs);
            client.resubscribe(message.sessionId, previous.lastAppliedSequence);
          }
          return;
        }
        storeSession(reduced, message.createdAtMs);
        if (reduced.errorCode !== null) {
          resyncingSessions.current.delete(message.sessionId);
          client.closeSession(message.sessionId);
          return;
        }
        if (reduced.lastAppliedSequence > previous.lastAppliedSequence) {
          client.updateCursor(message.sessionId, reduced.lastAppliedSequence);
        }
        return;
      }
      if (message.kind === "replay.complete") {
        if (!client.hasOpenSession(message.sessionId)) return;
        const previous = sessionStates.current[message.sessionId];
        if (previous === undefined) return;
        const completed = completeReplay(previous, message.throughSequence);
        client.completeSessionReplay(message.sessionId);
        if (completed.status === "gap") {
          addNotice("Replay did not reach the advertised sequence. Resynchronizing.", "error");
          resyncingSessions.current.add(message.sessionId);
          storeSession(beginReplay(completed));
          client.resubscribe(message.sessionId, completed.lastAppliedSequence);
        } else {
          storeSession(completed);
          resyncingSessions.current.delete(message.sessionId);
        }
        return;
      }
      if (message.kind === "command.accepted") {
        const pending = client.getPending(message.commandId);
        const command = pending?.command;
        if (pending?.draft !== undefined) clearAcceptedDraft(pending.draft);
        if (command?.method === "session.create" && message.sessionId !== undefined) {
          const created: BrowserSessionSummary = {
            sessionId: message.sessionId,
            title: command.params.title ?? "Untitled session",
            status: "ready",
            createdAtMs: 0,
            updatedAtMs: 0,
            lastEventSequence: 0,
            lastRunState: null,
            lastMessagePreview: null,
            requiresAttention: false,
            pendingApprovalCount: 0,
            pendingInputCount: 0,
          };
          setSessionIndex((current) =>
            upsertSessionSummary(
              current,
              created,
              message.sessionId ?? null,
              !current.summaries.some((summary) => summary.sessionId === message.sessionId),
            ),
          );
          openSession(message.sessionId);
        }
        addNotice(message.duplicate ? "Command reconciled after reconnect." : "Command accepted.");
        return;
      }
      if (message.kind === "command.rejected") {
        const rejected = client.getPending(message.commandId)?.command;
        if (
          rejected?.method === "approval.resolve" ||
          rejected?.method === "input.respond" ||
          rejected?.method === "run.cancel"
        ) {
          focusRecovery.current = null;
        }
        addNotice(
          `${message.message} Diagnostic: ${message.diagnosticId}`,
          "error",
          message.code,
        );
        return;
      }
      if (message.kind === "protocol.error") {
        if (message.sessionId !== undefined && !client.hasOpenSession(message.sessionId)) return;
        addNotice(`${message.message} Diagnostic: ${message.diagnosticId}`, "error");
        if (!message.recoverable && message.sessionId !== undefined) {
          const nextErrors = {
            ...sessionProtocolErrorsRef.current,
            [message.sessionId]: `${message.message} Diagnostic: ${message.diagnosticId}`,
          };
          sessionProtocolErrorsRef.current = nextErrors;
          setSessionProtocolErrors(nextErrors);
          resyncingSessions.current.delete(message.sessionId);
          client.closeSession(message.sessionId);
        }
        const recovery = replayRecoveryAction(message);
        if (recovery !== "none" && message.sessionId !== undefined) {
          const previous = sessionStates.current[message.sessionId];
          if (previous !== undefined && previous.errorCode === null) {
            const replaying =
              recovery === "reset"
                ? beginReplay(createBrowserSessionState(message.sessionId))
                : beginReplay(previous);
            resyncingSessions.current.add(message.sessionId);
            storeSession(replaying);
            client.retrySession(message.sessionId, replaying.lastAppliedSequence);
          }
        }
      }
    }

    return () => {
      active = false;
      abort.abort();
      socket.current = null;
      socketClient?.stop();
    };
  }, [commandJournal]);

  const selectedSession = selectedSessionId === null ? null : sessions[selectedSessionId] ?? null;
  const selectedSummary =
    selectedSessionId === null
      ? undefined
      : sessionIndex.summaries.find((summary) => summary.sessionId === selectedSessionId);

  useEffect(() => {
    const clearOnNewFocus = (event: FocusEvent): void => {
      const recovery = focusRecovery.current;
      const target = event.target;
      if (
        recovery !== null &&
        target instanceof HTMLElement &&
        target.isConnected &&
        target !== recovery.initiatingElement
      ) {
        focusRecovery.current = null;
      }
    };
    globalThis.document.addEventListener("focusin", clearOnNewFocus);
    return () => {
      focusRecovery.current = null;
      globalThis.document.removeEventListener("focusin", clearOnNewFocus);
    };
  }, []);

  useEffect(() => {
    const recovery = focusRecovery.current;
    if (
      recovery === null ||
      selectedSession === null ||
      recovery.sessionId !== selectedSession.sessionId
    ) {
      return;
    }
    const controlRemoved =
      (recovery.kind === "approval" &&
        selectedSession.pendingApprovals[recovery.targetId] === undefined) ||
      (recovery.kind === "input" && selectedSession.pendingInputs[recovery.targetId] === undefined) ||
      (recovery.kind === "cancel" &&
        (selectedSession.activeRun?.runId !== recovery.targetId ||
          selectedSession.activeRun.state === "cancelling" ||
          ["cancelled", "completed", "failed", "interrupted"].includes(
            selectedSession.activeRun.state,
          )));
    if (!controlRemoved) return;
    focusRecovery.current = null;
    const activeElement = globalThis.document.activeElement;
    const focusStayedOnInitiator = activeElement === recovery.initiatingElement;
    const focusFellToDocument =
      activeElement === null ||
      activeElement === globalThis.document.body ||
      activeElement === globalThis.document.documentElement;
    if (!focusStayedOnInitiator && !focusFellToDocument) return;
    for (const selector of [
      '[data-focus-target="approval"]:not([disabled])',
      '[data-focus-target="input"]:not([disabled])',
      '[data-focus-target="run"]',
      '#message-composer:not([disabled])',
    ]) {
      const target = globalThis.document.querySelector<HTMLElement>(selector);
      if (target !== null) {
        target.focus();
        return;
      }
    }
  }, [selectedSession]);

  const selectedPendingCommands = useMemo(
    () =>
      selectedSessionId === null
        ? []
        : pendingCommands.filter(
            (pending) =>
              "sessionId" in pending.command &&
              pending.command.sessionId === selectedSessionId,
          ),
    [pendingCommands, selectedSessionId],
  );
  const pendingByMethod = useMemo(() => {
    const result = new Map<CommandMessage["method"], number>();
    for (const pending of selectedPendingCommands) {
      result.set(pending.command.method, (result.get(pending.command.method) ?? 0) + 1);
    }
    return result;
  }, [selectedPendingCommands]);

  const pendingApprovalIds = useMemo(
    () =>
      new Set(
        selectedPendingCommands.flatMap((pending) =>
          pending.command.method === "approval.resolve"
            ? [pending.command.params.approvalId]
            : [],
        ),
      ),
    [selectedPendingCommands],
  );
  const pendingInputIds = useMemo(
    () =>
      new Set(
        selectedPendingCommands.flatMap((pending) =>
          pending.command.method === "input.respond" ? [pending.command.params.inputId] : [],
        ),
      ),
    [selectedPendingCommands],
  );

  function updateDraft(key: JournalDraftKey, value: string): string | null {
    try {
      commandJournal.setDraft(key, value);
      if (key === "session-title") setSessionTitleDraft(value);
      else if (key.startsWith("message:")) {
        const sessionId = key.slice("message:".length);
        setMessageDrafts((current) => ({ ...current, [sessionId]: value }));
      } else {
        const inputId = key.slice("input:".length);
        setInputDrafts((current) => ({ ...current, [inputId]: value }));
      }
      return null;
    } catch (error) {
      return error instanceof BrowserCommandJournalError
        ? error.message
        : "The draft could not be saved in this browser tab.";
    }
  }

  function clearAcceptedDraft(reference: JournalDraftReference): void {
    try {
      if (!commandJournal.clearDraftIfUnchanged(reference)) return;
    } catch {
      addNotice("The accepted draft could not be removed from temporary browser storage.", "error");
      return;
    }
    if (reference.key === "session-title") {
      setSessionTitleDraft((current) => (current === reference.value ? "" : current));
    } else if (reference.key.startsWith("message:")) {
      const sessionId = reference.key.slice("message:".length);
      setMessageDrafts((current) => {
        if (current[sessionId] !== reference.value) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    } else {
      const inputId = reference.key.slice("input:".length);
      setInputDrafts((current) => {
        if (current[inputId] !== reference.value) return current;
        const next = { ...current };
        delete next[inputId];
        return next;
      });
    }
  }

  function send(command: CommandMessage, draft?: JournalDraftReference): string | null {
    const client = socket.current;
    if (client === null) return "The browser connection is not initialized.";
    try {
      client.sendCommand(command, draft);
      return null;
    } catch (error) {
      const message =
        error instanceof BrowserCommandLimitError || error instanceof BrowserCommandJournalError
          ? error.message
          : "The command could not be validated for sending.";
      return message;
    }
  }

  function createSession(title: string): string | null {
    return send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      method: "session.create",
      params: { title },
    }, { key: sessionTitleDraftKey(), value: sessionTitleDraft });
  }

  function submitMessage(text: string): string | null {
    if (selectedSessionId === null) return "Select a session before sending a message.";
    return send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: selectedSessionId,
      method: "message.submit",
      params: { text },
    }, {
      key: messageDraftKey(selectedSessionId),
      value: messageDrafts[selectedSessionId] ?? "",
    });
  }

  function armFocusRecovery(
    sessionId: string,
    kind: FocusRecovery["kind"],
    targetId: string,
  ): void {
    const activeElement = globalThis.document.activeElement;
    focusRecovery.current = {
      sessionId,
      kind,
      targetId,
      initiatingElement: activeElement instanceof HTMLElement ? activeElement : null,
    };
  }

  function cancelRun(runId: string): void {
    if (selectedSessionId === null) return;
    armFocusRecovery(selectedSessionId, "cancel", runId);
    const error = send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: selectedSessionId,
      method: "run.cancel",
      params: { runId },
    });
    if (error !== null) {
      focusRecovery.current = null;
      addNotice(error, "error");
    }
  }

  function resolveApproval(approvalId: string, resolution: ApprovalResolution): void {
    if (selectedSessionId === null) return;
    armFocusRecovery(selectedSessionId, "approval", approvalId);
    const error = send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: selectedSessionId,
      method: "approval.resolve",
      params: { approvalId, resolution },
    });
    if (error !== null) {
      focusRecovery.current = null;
      addNotice(error, "error");
    }
  }

  function respondToInput(inputId: string, value: CanonicalJsonValue): string | null {
    if (selectedSessionId === null) return "Select a session before responding.";
    armFocusRecovery(selectedSessionId, "input", inputId);
    const error = send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: selectedSessionId,
      method: "input.respond",
      params: { inputId, value },
    }, {
      key: inputDraftKey(inputId),
      value: inputDrafts[inputId] ?? "",
    });
    if (error !== null) focusRecovery.current = null;
    return error;
  }

  if (bootstrapState === "loading") {
    return <main className="boot" role="status">Loading Wi…</main>;
  }
  if (bootstrapState === "error") {
    return <main className="boot" role="alert">{bootstrapError}</main>;
  }
  if (commandLimits === null) {
    return <main className="boot" role="alert">Bootstrap command limits are unavailable.</main>;
  }

  const terminalConnection = TERMINAL_CONNECTION_STATES.has(connection.status);
  const selectedProtocolError =
    selectedSessionId === null ? undefined : sessionProtocolErrors[selectedSessionId];
  const selectedHasIntegrityError =
    (selectedSession !== null && selectedSession.errorCode !== null) ||
    selectedProtocolError !== undefined;
  const sessionMutationsDisabled = terminalConnection || selectedHasIntegrityError;
  const historyLimitExceeded = selectedSession?.errorCode === "history_limit_exceeded";

  return (
    <div className="app-shell">
      <SessionList
        sessions={sessionIndex.summaries}
        sessionsTruncated={sessionIndex.truncated}
        selectedSessionId={selectedSessionId}
        title={sessionTitleDraft}
        commandLimits={commandLimits}
        createPending={pendingCommands.some(
          (pending) => pending.command.method === "session.create",
        )}
        createDisabled={terminalConnection}
        onTitleChange={(title) => updateDraft(sessionTitleDraftKey(), title)}
        onCreate={createSession}
        onSelect={openSession}
      />
      <main className="workspace">
        <header className="workspace__header">
          <div>
            <h2>
              {selectedSession?.title.slice(0, 512) ||
                selectedSummary?.title ||
                selectedSessionId ||
                "Select a session"}
            </h2>
            {selectedSession === null ? null : (
              <p className={`replay-state replay-state--${selectedSession.status}`} role="status">
                Session state: {selectedSession.status} · sequence {selectedSession.lastAppliedSequence}
              </p>
            )}
          </div>
          <ConnectionStatus connection={connection} />
        </header>

        <ProviderConnectionsPanel
          selectedSessionId={selectedSessionId}
          selectedDefault={selectedSession?.providerDefault ?? null}
          disabled={terminalConnection}
          onCommand={(command) => send(command)}
          onNotice={(message, error = false) => addNotice(message, error ? "error" : "info")}
        />

        {selectedSessionId !== null && selectedSummary === undefined ? (
          <p className="session-target-status" role="status">
            Requested session {selectedSessionId} is outside the bounded session list. Verifying
            that exact session from durable storage.
          </p>
        ) : null}
        {selectedSummary?.status === "unavailable" ? (
          <p className="session-target-status" role="alert">
            Requested session {selectedSummary.sessionId} is marked unavailable. No fallback
            session was selected.
          </p>
        ) : null}

        {terminalConnection ? (
          <div className="integrity-error" role="alert">
            The connection cannot recover automatically. State-changing controls are disabled.
            <button type="button" onClick={() => globalThis.location.reload()}>
              Reload Wi
            </button>
          </div>
        ) : null}

        {notices.length === 0 ? null : (
          <section className="notices" aria-label="Command and connection notices">
            {notices.map((notice) => (
              <p key={notice.id} className={`notice notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
                <span data-error-code={notice.code}>{notice.text}</span>
              </p>
            ))}
          </section>
        )}

        {selectedSession === null ? (
          <section className="welcome">
            <h2>Create or select a session</h2>
            <p>The backend owns runs. Closing this page does not cancel them.</p>
          </section>
        ) : (
          <>
            {selectedHasIntegrityError ? (
              <div className="integrity-error" role="alert">
                {historyLimitExceeded ? (
                  <p>
                    This session exceeds the bounded browser history limit. Start a new session;
                    this projection will not accept more events.
                  </p>
                ) : (
                  <>
                    <p>
                      Session integrity error: {selectedProtocolError ?? selectedSession.errorCode}.
                      Reload from durable storage before continuing.
                    </p>
                    <button type="button" onClick={() => globalThis.location.reload()}>
                      Reload session
                    </button>
                  </>
                )}
              </div>
            ) : null}
            <RunStatus
              run={selectedSession.activeRun}
              cancelPending={(pendingByMethod.get("run.cancel") ?? 0) > 0}
              disabled={sessionMutationsDisabled}
              onCancel={cancelRun}
            />
            <ApprovalPanel
              approvals={Object.values(selectedSession.pendingApprovals)}
              pendingApprovalIds={pendingApprovalIds}
              disabled={sessionMutationsDisabled}
              onResolve={resolveApproval}
            />
            <PendingInputPanel
              inputs={Object.values(selectedSession.pendingInputs)}
              commandLimits={commandLimits}
              pendingInputIds={pendingInputIds}
              drafts={inputDrafts}
              disabled={sessionMutationsDisabled}
              onDraftChange={(inputId, value) => updateDraft(inputDraftKey(inputId), value)}
              onRespond={respondToInput}
            />
            <Timeline session={selectedSession} />
            <Composer
              sessionId={selectedSession.sessionId}
              text={messageDrafts[selectedSession.sessionId] ?? ""}
              commandLimits={commandLimits}
              disabled={sessionMutationsDisabled}
              pending={(pendingByMethod.get("message.submit") ?? 0) > 0}
              onTextChange={(text) =>
                updateDraft(messageDraftKey(selectedSession.sessionId), text)
              }
              onSubmit={submitMessage}
            />
          </>
        )}
      </main>
    </div>
  );
}
