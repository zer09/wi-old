import {
  BrowserCommandLimitsSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  canonicalJson,
  createId,
  type BrowserCommandLimits,
  type CommandMessage,
  type ServerMessage,
} from "@wi/protocol";

import {
  type BrowserCommandJournal,
  type JournalDraftReference,
} from "../state/command-journal.js";
import { assertBrowserCommandSize } from "./command-size.js";
import { ReconnectPolicy, type ReconnectPolicyOptions } from "./reconnect.js";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "handshaking"
  | "connected"
  | "reconnecting"
  | "closed"
  | "error";

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  readonly reconnectDelayMs: number | null;
  readonly closeCode: number | null;
  readonly detail: string | null;
}

export interface PendingCommand {
  readonly command: CommandMessage;
  readonly phase: "queued" | "sent";
  readonly draft?: JournalDraftReference;
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocol: string) => WebSocketLike;

export interface RefreshedConnection {
  readonly url: string;
  readonly protocol: string;
  readonly commandLimits: BrowserCommandLimits;
}

type TimerHandle = unknown;

const PRE_WELCOME_FAILURES_BEFORE_REFRESH = 2;
const MAXIMUM_AUTHENTICATION_REFRESH_ATTEMPTS = 2;

interface SessionReplayRetry {
  readonly policy: ReconnectPolicy;
  timer: TimerHandle | null;
  delayMs: number | null;
}

export interface WiSocketClientOptions {
  readonly url: string;
  readonly protocol: string;
  readonly commandLimits: BrowserCommandLimits;
  readonly journal: BrowserCommandJournal;
  readonly clientId?: string;
  readonly socketFactory?: WebSocketFactory;
  readonly reconnect?: ReconnectPolicyOptions;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  readonly idSource?: () => string;
  readonly refreshConnection?: (signal: AbortSignal) => Promise<RefreshedConnection>;
  readonly onMessage: (message: ServerMessage) => void;
  readonly onLocalCommandError?: (commandId: string, message: string) => void;
  readonly onConnectionChange: (snapshot: ConnectionSnapshot) => void;
  readonly onPendingCommandsChange: (commands: readonly PendingCommand[]) => void;
}

function defaultSocketFactory(url: string, protocol: string): WebSocketLike {
  return new WebSocket(url, protocol);
}

function defaultIdSource(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

function textFrame(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  throw new TypeError("The server sent a non-text WebSocket frame");
}

export class WiSocketClient {
  private readonly clientId: string;
  private readonly socketFactory: WebSocketFactory;
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly idSource: () => string;
  private commandLimits: BrowserCommandLimits;
  private url: string;
  private protocol: string;
  private readonly sessions = new Map<string, number>();
  private readonly helloSessions = new Map<string, number>();
  private readonly sessionReplayRetries = new Map<string, SessionReplayRetry>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly locallyBlockedCommands = new Set<string>();
  private socket: WebSocketLike | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private refreshAbort: AbortController | null = null;
  private refreshPromise: Promise<void> | null = null;
  private preWelcomeFailures = 0;
  private authenticationRefreshAttempts = 0;
  private welcomed = false;
  private stopped = false;
  private snapshotValue: ConnectionSnapshot = {
    status: "idle",
    reconnectDelayMs: null,
    closeCode: null,
    detail: null,
  };

  constructor(private readonly options: WiSocketClientOptions) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectPolicy = new ReconnectPolicy(options.reconnect);
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
    this.idSource = options.idSource ?? defaultIdSource;
    this.commandLimits = BrowserCommandLimitsSchema.parse(options.commandLimits);
    this.url = validatedWebSocketUrl(options.url);
    this.protocol = validatedWebSocketProtocol(options.protocol);
    this.clientId = options.clientId ?? createId("client", this.idSource);
    for (const restored of options.journal.commands()) {
      this.pending.set(restored.command.commandId, {
        command: restored.command,
        phase: "queued",
        ...(restored.draft === undefined ? {} : { draft: restored.draft }),
      });
    }
    this.notifyPending();
  }

  get snapshot(): ConnectionSnapshot {
    return this.snapshotValue;
  }

  getPendingCommand(commandId: string): CommandMessage | undefined {
    return this.pending.get(commandId)?.command;
  }

  getPending(commandId: string): PendingCommand | undefined {
    return this.pending.get(commandId);
  }

  updateCommandLimits(limits: BrowserCommandLimits): void {
    this.commandLimits = BrowserCommandLimitsSchema.parse(limits);
    this.locallyBlockedCommands.clear();
    this.sendPendingCommands();
  }

  hasOpenSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  connect(): void {
    if (this.stopped || this.socket !== null || this.reconnectTimer !== null) return;
    this.openSocket(this.snapshotValue.status === "idle" ? "connecting" : "reconnecting");
  }

  openSession(sessionId: string, afterSequence: number): void {
    const existed = this.sessions.has(sessionId);
    this.sessions.set(sessionId, afterSequence);
    if (!existed && this.welcomed) this.sendSubscribe(sessionId, afterSequence);
  }

  updateCursor(sessionId: string, afterSequence: number): void {
    if (this.sessions.has(sessionId)) this.sessions.set(sessionId, afterSequence);
  }

  resubscribe(sessionId: string, afterSequence: number): void {
    this.clearSessionReplayRetry(sessionId);
    this.sessions.set(sessionId, afterSequence);
    if (this.welcomed) this.sendSubscribe(sessionId, afterSequence);
  }

  retrySession(sessionId: string, afterSequence: number): number | null {
    this.sessions.set(sessionId, afterSequence);
    if (!this.welcomed) return null;
    let retry = this.sessionReplayRetries.get(sessionId);
    if (retry === undefined) {
      retry = {
        policy: new ReconnectPolicy(this.options.reconnect),
        timer: null,
        delayMs: null,
      };
      this.sessionReplayRetries.set(sessionId, retry);
    }
    if (retry.timer !== null) return retry.delayMs;
    const delayMs = retry.policy.nextDelayMs();
    retry.delayMs = delayMs;
    retry.timer = this.setTimer(() => {
      retry.timer = null;
      retry.delayMs = null;
      if (this.welcomed && this.sessions.has(sessionId)) {
        this.sendSubscribe(sessionId, this.sessions.get(sessionId) ?? afterSequence);
      }
    }, delayMs);
    return delayMs;
  }

  completeSessionReplay(sessionId: string): void {
    this.clearSessionReplayRetry(sessionId);
  }

  closeSession(sessionId: string): void {
    this.clearSessionReplayRetry(sessionId);
    if (!this.sessions.delete(sessionId) || !this.welcomed) return;
    this.sendUnsubscribe(sessionId);
  }

  sendCommand(command: CommandMessage, draft?: JournalDraftReference): void {
    const parsed = assertBrowserCommandSize(command, this.commandLimits);
    const existing = this.pending.get(parsed.commandId);
    if (existing !== undefined) {
      if (
        canonicalJson(existing.command) !== canonicalJson(parsed) ||
        canonicalJson(existing.draft ?? null) !== canonicalJson(draft ?? null)
      ) {
        throw new Error("A pending command ID cannot be reused with different content");
      }
      return;
    }
    // Recovery references are process-bound bearer material. Keep the complete
    // recovery command memory-only; it must never enter sessionStorage.
    if (parsed.method !== "providerConnection.recover") {
      this.options.journal.addCommand(parsed, draft);
    }
    this.pending.set(parsed.commandId, {
      command: parsed,
      phase: "queued",
      ...(draft === undefined ? {} : { draft }),
    });
    this.notifyPending();
    this.sendPendingCommands();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.welcomed = false;
    this.helloSessions.clear();
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearSessionReplayRetries();
    this.refreshAbort?.abort();
    this.refreshAbort = null;
    this.refreshPromise = null;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close(1000, "client closed");
    }
    this.updateConnection({
      status: "closed",
      reconnectDelayMs: null,
      closeCode: 1000,
      detail: null,
    });
  }

  private openSocket(status: "connecting" | "reconnecting"): void {
    this.updateConnection({ status, reconnectDelayMs: null, closeCode: null, detail: null });
    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(this.url, this.protocol);
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : "Connection failed");
      return;
    }
    this.socket = socket;
    this.welcomed = false;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.updateConnection({
        status: "handshaking",
        reconnectDelayMs: null,
        closeCode: null,
        detail: null,
      });
      const resume = [...this.sessions];
      this.helloSessions.clear();
      for (const [sessionId, afterSequence] of resume) {
        this.helloSessions.set(sessionId, afterSequence);
      }
      this.send({
        v: 1,
        kind: "hello",
        clientId: this.clientId,
        resume: resume.map(([sessionId, afterSequence]) => ({ sessionId, afterSequence })),
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) return;
      const closedBeforeWelcome = !this.welcomed;
      this.socket = null;
      this.welcomed = false;
      this.helloSessions.clear();
      this.clearSessionReplayRetries();
      for (const [commandId, pending] of this.pending) {
        this.pending.set(commandId, { ...pending, phase: "queued" });
      }
      this.notifyPending();
      if ([1002, 1003, 1007, 1008, 1009].includes(event.code)) {
        this.updateConnection({
          status: "error",
          reconnectDelayMs: null,
          closeCode: event.code,
          detail: event.reason || "The server rejected the connection.",
        });
        return;
      }
      if (closedBeforeWelcome && this.options.refreshConnection !== undefined) {
        this.preWelcomeFailures += 1;
        if (this.preWelcomeFailures >= PRE_WELCOME_FAILURES_BEFORE_REFRESH) {
          this.beginAuthenticationRefresh(event.code);
          return;
        }
      } else if (!closedBeforeWelcome) {
        this.preWelcomeFailures = 0;
        this.authenticationRefreshAttempts = 0;
      }
      this.scheduleReconnect(event.reason || "Connection lost", event.code);
    };
    socket.onerror = () => {
      if (this.socket !== socket || this.stopped) return;
      this.updateConnection({
        ...this.snapshotValue,
        detail: "The WebSocket reported a transport error.",
      });
    };
  }

  private receive(frame: unknown): void {
    let message: ServerMessage;
    try {
      message = ServerMessageSchema.parse(JSON.parse(textFrame(frame)));
    } catch {
      this.updateConnection({
        status: "error",
        reconnectDelayMs: null,
        closeCode: 1002,
        detail: "The server sent an invalid protocol message.",
      });
      const socket = this.socket;
      this.socket = null;
      this.welcomed = false;
      this.helloSessions.clear();
      socket?.close(1002, "invalid server message");
      return;
    }

    if (message.kind === "welcome") {
      this.welcomed = true;
      this.preWelcomeFailures = 0;
      this.authenticationRefreshAttempts = 0;
      for (const sessionId of this.helloSessions.keys()) {
        if (!this.sessions.has(sessionId)) this.sendUnsubscribe(sessionId);
      }
      for (const [sessionId, afterSequence] of this.sessions) {
        if (this.helloSessions.get(sessionId) !== afterSequence) {
          this.sendSubscribe(sessionId, afterSequence);
        }
      }
      this.helloSessions.clear();
      this.reconnectPolicy.reset();
      this.updateConnection({
        status: "connected",
        reconnectDelayMs: null,
        closeCode: null,
        detail: null,
      });
      this.options.onMessage(message);
      this.sendPendingCommands();
      return;
    }

    this.options.onMessage(message);
    if (message.kind === "command.accepted" || message.kind === "command.rejected") {
      try {
        this.options.journal.removeCommand(message.commandId);
      } catch {
        // The in-memory command can still settle; a stale stored retry remains idempotent.
      }
      this.locallyBlockedCommands.delete(message.commandId);
      this.pending.delete(message.commandId);
      this.notifyPending();
    }
  }

  private sendPendingCommands(): void {
    if (!this.welcomed) return;
    for (const [commandId, pending] of this.pending) {
      if (pending.phase === "sent") continue;
      try {
        assertBrowserCommandSize(pending.command, this.commandLimits);
      } catch (error) {
        if (!this.locallyBlockedCommands.has(commandId)) {
          this.locallyBlockedCommands.add(commandId);
          this.options.onLocalCommandError?.(
            commandId,
            error instanceof Error
              ? error.message
              : "The restored command exceeds the current server limits.",
          );
        }
        continue;
      }
      if (!this.send(pending.command)) return;
      try {
        this.options.journal.markCommandSent(commandId);
      } catch {
        // Keeping the stored phase queued causes a safe same-ID retry after reload.
      }
      this.pending.set(commandId, { ...pending, phase: "sent" });
    }
    this.notifyPending();
  }

  private clearSessionReplayRetry(sessionId: string): void {
    const retry = this.sessionReplayRetries.get(sessionId);
    if (retry !== undefined && retry.timer !== null) this.clearTimer(retry.timer);
    this.sessionReplayRetries.delete(sessionId);
  }

  private clearSessionReplayRetries(): void {
    for (const sessionId of this.sessionReplayRetries.keys()) {
      this.clearSessionReplayRetry(sessionId);
    }
  }

  private sendSubscribe(sessionId: string, afterSequence: number): void {
    this.send({
      v: 1,
      kind: "subscribe",
      requestId: createId("request", this.idSource),
      sessionId,
      afterSequence,
    });
  }

  private sendUnsubscribe(sessionId: string): void {
    this.send({
      v: 1,
      kind: "unsubscribe",
      requestId: createId("request", this.idSource),
      sessionId,
    });
  }

  private send(message: Parameters<typeof ClientMessageSchema.parse>[0]): boolean {
    if (this.socket === null || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(ClientMessageSchema.parse(message)));
    return true;
  }

  private beginAuthenticationRefresh(closeCode: number): void {
    if (this.stopped || this.refreshPromise !== null) return;
    const refreshConnection = this.options.refreshConnection;
    if (refreshConnection === undefined) {
      this.scheduleReconnect("Connection lost", closeCode);
      return;
    }
    if (this.authenticationRefreshAttempts >= MAXIMUM_AUTHENTICATION_REFRESH_ATTEMPTS) {
      this.updateConnection({
        status: "error",
        reconnectDelayMs: null,
        closeCode,
        detail: "The browser session could not be refreshed. Reload Wi to reconnect.",
      });
      return;
    }
    this.authenticationRefreshAttempts += 1;
    this.preWelcomeFailures = 0;
    const abort = new AbortController();
    this.refreshAbort = abort;
    this.updateConnection({
      status: "reconnecting",
      reconnectDelayMs: 0,
      closeCode,
      detail: "Refreshing the local browser session.",
    });
    this.refreshPromise = (async () => {
      try {
        const connection = await refreshConnection(abort.signal);
        if (this.stopped || abort.signal.aborted || this.refreshAbort !== abort) return;
        this.url = validatedWebSocketUrl(connection.url);
        this.protocol = validatedWebSocketProtocol(connection.protocol);
        this.commandLimits = BrowserCommandLimitsSchema.parse(connection.commandLimits);
        this.locallyBlockedCommands.clear();
        this.refreshAbort = null;
        this.refreshPromise = null;
        this.openSocket("reconnecting");
      } catch (error) {
        if (this.stopped || abort.signal.aborted || this.refreshAbort !== abort) return;
        this.refreshAbort = null;
        this.refreshPromise = null;
        const detail = error instanceof Error ? error.message : "Browser session refresh failed";
        if (this.authenticationRefreshAttempts >= MAXIMUM_AUTHENTICATION_REFRESH_ATTEMPTS) {
          this.updateConnection({
            status: "error",
            reconnectDelayMs: null,
            closeCode,
            detail: `${detail} Reload Wi to reconnect.`,
          });
        } else {
          this.scheduleReconnect(detail, closeCode);
        }
      }
    })();
  }

  private scheduleReconnect(detail: string, closeCode: number | null = null): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const delay = this.reconnectPolicy.nextDelayMs();
    this.updateConnection({
      status: "reconnecting",
      reconnectDelayMs: delay,
      closeCode,
      detail,
    });
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.openSocket("reconnecting");
    }, delay);
  }

  private notifyPending(): void {
    this.options.onPendingCommandsChange([...this.pending.values()]);
  }

  private updateConnection(snapshot: ConnectionSnapshot): void {
    this.snapshotValue = snapshot;
    this.options.onConnectionChange(snapshot);
  }
}

function validatedWebSocketUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new TypeError("The refreshed WebSocket URL must use ws or wss");
  }
  return parsed.toString();
}

function validatedWebSocketProtocol(value: string): string {
  if (value !== "wi.v1") throw new TypeError("The refreshed WebSocket protocol is unsupported");
  return value;
}
