import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  beginReplaySubscription,
  FifoSemaphore,
  ReplaySubscriptionError,
  type ReplayConnectionBudget,
  type ReplayDeliveredIdentity,
  type ReplaySubscription,
  type SessionActor,
} from "@wi/harness-core";
import {
  canonicalJson,
  createId,
  toBrowserSessionEvent,
  type ClientMessage,
  type ProtocolErrorCode,
  type ServerMessage,
  type SubscribeMessage,
} from "@wi/protocol";
import type { SessionClient } from "@wi/storage";
import WebSocket, { type RawData } from "ws";
import type { WiRuntime } from "../composition.js";
import type { RecoveryIngressRegistration } from "../provider-connections/recovery-ingress.js";
import { nonThrowingLogger, type Logger } from "../logging/logger.js";
import { malformedPayloadMetadata } from "../logging/redaction.js";
import { CommandRoutingError } from "./command-router.js";
import { durableCommandPayloadBytes } from "./durable-command-limits.js";
import { mapCommandError, mapReplayError } from "./error-mapping.js";
import {
  decodeClientFrame,
  FrameDecodeError,
  type FrameLimits,
} from "./frame-decoder.js";
import {
  OutboundQueue,
  SLOW_CONSUMER_CLOSE_CODE,
  type OutboundQueueLimits,
  type OutboundTransport,
} from "./outbound-queue.js";

interface ActiveSubscription {
  readonly requestId: string;
  readonly subscriberId: string;
  readonly actor: SessionActor;
  readonly replay: ReplaySubscription;
  intentional: boolean;
}

export interface ConnectionLimits {
  readonly frame: FrameLimits;
  readonly outbound: OutboundQueueLimits;
  readonly maximumPendingInboundMessages: number;
  readonly maximumPendingInboundBytes: number;
  readonly maximumProtocolViolations: number;
  readonly maximumSubscriptions: number;
  readonly replayLiveEvents: number;
  readonly replayLiveBytes: number;
  readonly replaySingleEventBytes: number;
  readonly replayPageEvents: number;
  readonly replayPageBytes: number;
  readonly replayPageSingleEventBytes: number;
  readonly replayQueueWaitTimeoutMs: number;
  readonly maximumDurableCommandPayloadBytes: number;
}

export interface ConnectionHeartbeatOptions {
  readonly intervalMs: number;
  readonly helloTimeoutMs: number;
}

export interface ConnectionReplayHooks {
  readonly beforeHeadCapture?: (sessionId: string) => void | Promise<void>;
  readonly afterHeadCaptured?: (
    sessionId: string,
    throughSequence: number,
  ) => void | Promise<void>;
  readonly afterHistoricalRead?: (
    sessionId: string,
    throughSequence: number,
  ) => void | Promise<void>;
  readonly afterReplayComplete?: (
    sessionId: string,
    throughSequence: number,
  ) => void | Promise<void>;
}

export interface ConnectionCommandHooks {
  readonly beforeRoute?: (
    command: Extract<ClientMessage, { readonly kind: "command" }>,
  ) => void | Promise<void>;
  readonly afterRouteBeforeSend?: (
    command: Extract<ClientMessage, { readonly kind: "command" }>,
    accepted: Extract<ServerMessage, { readonly kind: "command.accepted" }>,
  ) => void | Promise<void>;
  readonly afterSend?: (
    command: Extract<ClientMessage, { readonly kind: "command" }>,
    accepted: Extract<ServerMessage, { readonly kind: "command.accepted" }>,
    sent: boolean,
  ) => void | Promise<void>;
}

export interface ConnectionSnapshot {
  readonly connectionId: string;
  readonly clientId: string | null;
  readonly subscriptions: number;
  readonly protocolViolations: number;
  readonly pendingInboundMessages: number;
  readonly pendingInboundBytes: number;
  readonly replayBacklogEvents: number;
  readonly replayBacklogBytes: number;
  readonly replayDuplicateEvents: number;
  readonly replayDuplicateBytes: number;
  readonly replayHistoricalPages: number;
  readonly heartbeatActive: boolean;
  readonly closed: boolean;
}

class UnknownSessionError extends Error {}

function sourceBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.concat(data);
}

function randomId(kind: Parameters<typeof createId>[0]): string {
  return createId(kind, () => randomUUID().replaceAll("-", ""));
}

interface CachedDeliveredIdentity {
  readonly identity: ReplayDeliveredIdentity;
  readonly bytes: number;
}

class ConnectionReplayBudget implements ReplayConnectionBudget {
  private readonly historicalPages = new FifoSemaphore(1);
  private readonly deliveredIdentities = new Map<string, CachedDeliveredIdentity>();
  private liveEvents = 0;
  private liveBytes = 0;
  private deliveredBytes = 0;

  constructor(
    private readonly maximumLiveEvents: number,
    private readonly maximumLiveBytes: number,
  ) {}

  get state(): {
    readonly liveEvents: number;
    readonly liveBytes: number;
    readonly deliveredEvents: number;
    readonly deliveredBytes: number;
    readonly historicalPages: number;
  } {
    return {
      liveEvents: this.liveEvents,
      liveBytes: this.liveBytes,
      deliveredEvents: this.deliveredIdentities.size,
      deliveredBytes: this.deliveredBytes,
      historicalPages: this.historicalPages.state.active,
    };
  }

  tryReserveLiveEvent(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      throw new RangeError("Replay reservation bytes must be a positive safe integer");
    }
    if (
      this.liveEvents >= this.maximumLiveEvents ||
      this.liveBytes > this.maximumLiveBytes - bytes
    ) {
      return false;
    }
    this.liveEvents += 1;
    this.liveBytes += bytes;
    return true;
  }

  releaseLiveEvent(bytes: number): void {
    if (this.liveEvents < 1 || bytes < 1 || bytes > this.liveBytes) {
      throw new Error("Replay connection budget release does not match a reservation");
    }
    this.liveEvents -= 1;
    this.liveBytes -= bytes;
  }

  acquireHistoricalPage(signal: AbortSignal): Promise<() => void> {
    return this.historicalPages.acquire(signal);
  }

  getDeliveredIdentity(
    sessionId: string,
    sequence: number,
  ): ReplayDeliveredIdentity | undefined {
    const key = this.deliveredKey(sessionId, sequence);
    const cached = this.deliveredIdentities.get(key);
    if (cached === undefined) return undefined;
    this.deliveredIdentities.delete(key);
    this.deliveredIdentities.set(key, cached);
    return cached.identity;
  }

  rememberDeliveredIdentity(
    sessionId: string,
    sequence: number,
    identity: ReplayDeliveredIdentity,
  ): void {
    const key = this.deliveredKey(sessionId, sequence);
    const previous = this.deliveredIdentities.get(key);
    if (previous !== undefined) {
      this.deliveredIdentities.delete(key);
      this.deliveredBytes -= previous.bytes;
    }
    const bytes =
      64 +
      Buffer.byteLength(sessionId) +
      Buffer.byteLength(String(sequence)) +
      Buffer.byteLength(identity.eventId) +
      Buffer.byteLength(identity.fingerprint);
    if (bytes > this.maximumLiveBytes) return;
    while (
      this.deliveredIdentities.size >= this.maximumLiveEvents ||
      this.deliveredBytes > this.maximumLiveBytes - bytes
    ) {
      const oldest = this.deliveredIdentities.entries().next().value as
        | readonly [string, CachedDeliveredIdentity]
        | undefined;
      if (oldest === undefined) break;
      this.deliveredIdentities.delete(oldest[0]);
      this.deliveredBytes -= oldest[1].bytes;
    }
    this.deliveredIdentities.set(key, { identity, bytes });
    this.deliveredBytes += bytes;
  }

  private deliveredKey(sessionId: string, sequence: number): string {
    return `${sessionId}\u0000${sequence}`;
  }
}

function webSocketTransport(socket: WebSocket): OutboundTransport {
  return {
    send: (data, callback) => {
      if (socket.readyState !== WebSocket.OPEN) {
        callback(new Error("WebSocket is not open"));
        return;
      }
      socket.send(data, callback);
    },
    close: (code, reason) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
    },
  };
}

export class BrowserConnection {
  readonly connectionId = randomId("connection");
  private readonly outbound: OutboundQueue;
  private readonly logger: Logger;
  private readonly replayBudget: ConnectionReplayBudget;
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly subscriptionCleanups = new Map<string, Promise<void>>();
  private clientId: string | null = null;
  private welcomed = false;
  private alive = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private protocolViolations = 0;
  private pendingInboundMessages = 0;
  private pendingInboundBytes = 0;
  private inboundTail = Promise.resolve();
  private closed = false;
  private cleanupPromise: Promise<void> | null = null;
  private readonly heartbeatInterval: number;
  private readonly socketClosed: Promise<void>;
  private resolveSocketClosed: () => void = () => undefined;

  constructor(
    private readonly socket: WebSocket,
    request: IncomingMessage,
    private readonly runtime: WiRuntime,
    logger: Logger,
    private readonly limits: ConnectionLimits,
    heartbeat: ConnectionHeartbeatOptions,
    private readonly replayHooks: ConnectionReplayHooks = {},
    private readonly commandHooks: ConnectionCommandHooks = {},
  ) {
    this.logger = nonThrowingLogger(logger);
    this.heartbeatInterval = heartbeat.intervalMs;
    this.replayBudget = new ConnectionReplayBudget(
      limits.replayLiveEvents,
      limits.replayLiveBytes,
    );
    this.socketClosed = new Promise<void>((resolve) => {
      this.resolveSocketClosed = resolve;
    });
    this.outbound = new OutboundQueue(
      webSocketTransport(socket),
      limits.outbound,
      (error) => {
        const diagnosticId = runtime.diagnosticId();
        this.logger.error("websocket_send_failed", error, {
          diagnosticId,
          connectionId: this.connectionId,
          clientId: this.clientId,
        });
      },
      (reason) => {
        if (reason === "slow_consumer") {
          const diagnosticId = runtime.diagnosticId();
          this.logger.warn("websocket_slow_consumer", {
            diagnosticId,
            connectionId: this.connectionId,
            clientId: this.clientId,
          });
        }
        queueMicrotask(() => {
          void this.cleanup();
        });
      },
    );
    this.socket.on("message", (data, isBinary) => this.acceptFrame(data, isBinary));
    this.socket.on("pong", () => {
      this.alive = true;
    });
    this.socket.on("error", (error) => {
      const diagnosticId = this.runtime.diagnosticId();
      this.logger.error("websocket_connection_error", error, {
        diagnosticId,
        connectionId: this.connectionId,
        clientId: this.clientId,
      });
    });
    this.socket.on("close", () => {
      this.resolveSocketClosed();
      void this.cleanup();
    });
    this.heartbeatTimer = setInterval(() => this.heartbeat(), heartbeat.intervalMs);
    this.heartbeatTimer.unref();
    this.helloTimer = setTimeout(() => {
      if (!this.welcomed && !this.closed) {
        this.socket.close(1008, "hello timeout");
        void this.cleanup();
      }
    }, heartbeat.helloTimeoutMs);
    this.helloTimer.unref();
    this.logger.info("websocket_connected", {
      connectionId: this.connectionId,
      remoteAddress: request.socket.remoteAddress,
    });
  }

  get snapshot(): ConnectionSnapshot {
    const replay = this.replayBudget.state;
    return {
      connectionId: this.connectionId,
      clientId: this.clientId,
      subscriptions: this.subscriptions.size,
      protocolViolations: this.protocolViolations,
      pendingInboundMessages: this.pendingInboundMessages,
      pendingInboundBytes: this.pendingInboundBytes,
      replayBacklogEvents: replay.liveEvents,
      replayBacklogBytes: replay.liveBytes,
      replayDuplicateEvents: replay.deliveredEvents,
      replayDuplicateBytes: replay.deliveredBytes,
      replayHistoricalPages: replay.historicalPages,
      heartbeatActive: this.heartbeatTimer !== null,
      closed: this.closed,
    };
  }

  private acceptFrame(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    const bytes = sourceBytes(data);
    if (
      this.pendingInboundMessages >= this.limits.maximumPendingInboundMessages ||
      this.pendingInboundBytes > this.limits.maximumPendingInboundBytes - bytes.byteLength
    ) {
      this.socket.close(1009, "inbound queue limit");
      void this.cleanup();
      return;
    }
    let recoveryIngress: RecoveryIngressRegistration | null = null;
    try {
      const candidate = decodeClientFrame(bytes, isBinary, this.limits.frame);
      if (
        this.welcomed &&
        candidate.kind === "command" &&
        candidate.method === "providerConnection.recover"
      ) {
        const commandBytes = Math.max(
          bytes.byteLength,
          Buffer.byteLength(canonicalJson(candidate), "utf8"),
        );
        const registration = this.runtime.providerConnections.registerRecoveryIngress(
          candidate.commandId,
          candidate.params.recoveryEpochId,
          {
            expected: candidate.params.expected,
            displayName: candidate.params.displayName,
          },
          commandBytes,
        );
        if (registration.state === "saturated") {
          const safe = mapCommandError(
            new CommandRoutingError(
              "provider.rate_limited",
              "The provider connection recovery queue is temporarily full.",
            ),
            this.runtime.diagnosticId,
          );
          this.logger.warn("websocket_recovery_ingress_rejected", {
            diagnosticId: safe.diagnosticId,
            connectionId: this.connectionId,
            clientId: this.clientId,
            commandId: candidate.commandId,
            code: safe.code,
          });
          this.send({
            v: 1,
            kind: "command.rejected",
            commandId: candidate.commandId,
            code: safe.code,
            message: safe.message,
            diagnosticId: safe.diagnosticId,
            recoverable: safe.recoverable,
          });
          return;
        }
        recoveryIngress = registration;
      }
    } catch {
      // The serialized frame processor emits the bounded protocol error.
    }
    this.pendingInboundMessages += 1;
    this.pendingInboundBytes += bytes.byteLength;
    this.inboundTail = this.inboundTail
      .then(() => this.processFrame(bytes, isBinary, recoveryIngress))
      .catch((error: unknown) => this.internalConnectionFailure(error))
      .finally(() => {
        recoveryIngress?.release();
        this.pendingInboundMessages -= 1;
        this.pendingInboundBytes -= bytes.byteLength;
      });
  }

  private async processFrame(
    bytes: Uint8Array,
    isBinary: boolean,
    recoveryIngress: RecoveryIngressRegistration | null = null,
  ): Promise<void> {
    if (this.closed) return;
    let message: ClientMessage;
    try {
      message = decodeClientFrame(bytes, isBinary, this.limits.frame);
    } catch (error) {
      if (!(error instanceof FrameDecodeError)) throw error;
      const diagnosticId = this.runtime.diagnosticId();
      this.logger.warn("websocket_protocol_error", {
        diagnosticId,
        connectionId: this.connectionId,
        clientId: this.clientId,
        code: error.code,
        payload: malformedPayloadMetadata(bytes),
      });
      this.protocolError(error.code, error.message, diagnosticId, !error.fatal);
      this.protocolViolations += 1;
      if (error.fatal || this.protocolViolations >= this.limits.maximumProtocolViolations) {
        let closeCode = 1008;
        if (error.fatal) {
          closeCode = error.code === "protocol.message_too_large" ? 1009 : 1007;
        }
        this.socket.close(closeCode, "invalid frame");
        void this.cleanup();
      }
      return;
    }

    if (!this.welcomed && message.kind !== "hello") {
      this.protocolViolation("A hello message is required before other messages.");
      return;
    }
    switch (message.kind) {
      case "hello":
        await this.hello(message);
        return;
      case "subscribe":
        await this.safeSubscribe(message);
        return;
      case "unsubscribe":
        await this.unsubscribe(message.sessionId);
        return;
      case "command":
        await this.command(message, recoveryIngress);
        return;
      case "heartbeat":
        this.send({ v: 1, kind: "heartbeat", serverTimeMs: this.runtime.now() });
        return;
    }
  }

  private async hello(message: Extract<ClientMessage, { readonly kind: "hello" }>): Promise<void> {
    if (this.welcomed) {
      this.protocolViolation("The connection has already completed hello.");
      return;
    }
    if (message.resume.length > this.limits.maximumSubscriptions) {
      this.protocolError(
        "protocol.message_too_large",
        "The hello message contains too many session cursors.",
        this.runtime.diagnosticId(),
        false,
      );
      this.socket.close(1008, "too many subscriptions");
      void this.cleanup();
      return;
    }
    this.welcomed = true;
    if (this.helloTimer !== null) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    this.clientId = message.clientId;
    this.send({
      v: 1,
      kind: "welcome",
      connectionId: this.connectionId,
      serverTimeMs: this.runtime.now(),
      heartbeatIntervalMs: this.heartbeatInterval,
    });
    for (const cursor of message.resume) {
      if (this.closed) return;
      await this.safeSubscribe({
        v: 1,
        kind: "subscribe",
        requestId: randomId("request"),
        sessionId: cursor.sessionId,
        afterSequence: cursor.afterSequence,
      });
    }
  }

  private async runCommandHook(
    boundary: string,
    hook: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    if (hook === undefined) return;
    try {
      await hook();
    } catch (error) {
      this.logger.error("websocket_command_hook_failed", error, {
        diagnosticId: this.runtime.diagnosticId(),
        connectionId: this.connectionId,
        clientId: this.clientId,
        boundary,
      });
    }
  }

  private async command(
    message: Extract<ClientMessage, { readonly kind: "command" }>,
    recoveryIngress: RecoveryIngressRegistration | null,
  ): Promise<void> {
    try {
      if (durableCommandPayloadBytes(message) > this.limits.maximumDurableCommandPayloadBytes) {
        throw new CommandRoutingError(
          "protocol.message_too_large",
          "The durable command payload exceeds the configured byte limit.",
        );
      }
      await this.runCommandHook("before_route", () => this.commandHooks.beforeRoute?.(message));
      const accepted = await this.runtime.commandRouter.route(
        message,
        this.clientId ?? "unknown",
        recoveryIngress === null ? {} : { recoveryIngressRegistration: recoveryIngress },
      );
      await this.runCommandHook("after_route_before_send", () =>
        this.commandHooks.afterRouteBeforeSend?.(message, accepted),
      );
      const sent = this.send(accepted);
      await this.runCommandHook("after_send", () =>
        this.commandHooks.afterSend?.(message, accepted, sent),
      );
    } catch (error) {
      const safe = mapCommandError(error, this.runtime.diagnosticId);
      this.logger.error("websocket_command_rejected", error, {
        diagnosticId: safe.diagnosticId,
        connectionId: this.connectionId,
        clientId: this.clientId,
        commandId: message.commandId,
        sessionId: "sessionId" in message ? message.sessionId : undefined,
        code: safe.code,
      });
      this.send({
        v: 1,
        kind: "command.rejected",
        commandId: message.commandId,
        code: safe.code,
        message: safe.message,
        diagnosticId: safe.diagnosticId,
        recoverable: safe.recoverable,
      });
    }
  }

  private async safeSubscribe(message: SubscribeMessage): Promise<void> {
    try {
      await this.subscribe(message);
    } catch (error) {
      if (this.closed) return;
      const diagnosticId = this.runtime.diagnosticId();
      const safe = mapReplayError(error);
      this.logger.error("websocket_subscription_setup_failed", error, {
        diagnosticId,
        connectionId: this.connectionId,
        clientId: this.clientId,
        requestId: message.requestId,
        sessionId: message.sessionId,
        code: safe.code,
      });
      this.protocolError(
        safe.code,
        safe.message,
        diagnosticId,
        safe.recoverable,
        { requestId: message.requestId, sessionId: message.sessionId },
      );
    }
  }

  private async subscribe(message: SubscribeMessage): Promise<void> {
    await this.waitForSubscriptionCleanup(message.sessionId);
    if (this.closed) return;
    const previous = this.subscriptions.get(message.sessionId);
    if (previous === undefined && this.subscriptions.size >= this.limits.maximumSubscriptions) {
      this.protocolError(
        "replay.subscriber_overflow",
        "This connection has reached its session subscription limit.",
        this.runtime.diagnosticId(),
        false,
        { requestId: message.requestId, sessionId: message.sessionId },
      );
      return;
    }

    const summary = await this.runtime.storage.catalog.getSession(message.sessionId);
    if (summary === null || summary.status === "missing") {
      this.protocolError(
        "replay.unknown_session",
        "The requested session does not exist.",
        this.runtime.diagnosticId(),
        false,
        { requestId: message.requestId, sessionId: message.sessionId },
      );
      return;
    }
    if (summary.status === "unavailable") {
      this.protocolError(
        "storage.corrupt",
        "The requested session storage is unavailable.",
        this.runtime.diagnosticId(),
        false,
        { requestId: message.requestId, sessionId: message.sessionId },
      );
      return;
    }

    if (previous !== undefined) {
      const source = await this.runtime.storage.openSession(message.sessionId);
      if (this.closed) return;
      if (this.subscriptions.get(message.sessionId) !== previous) {
        await this.waitForSubscriptionCleanup(message.sessionId);
        await this.subscribe(message);
        return;
      }

      // A retry replaces the replay generation, but retains the one actor subscriber.
      this.subscriptions.delete(message.sessionId);
      previous.intentional = true;
      previous.replay.unsubscribe();
      await previous.replay.drain();
      if (this.closed) {
        await previous.actor
          .postSubscriberDisconnected(previous.subscriberId)
          .catch(() => undefined);
        return;
      }
      try {
        this.startReplay(message, source, previous.actor, previous.subscriberId);
      } catch (error) {
        await previous.actor
          .postSubscriberDisconnected(previous.subscriberId)
          .catch(() => undefined);
        throw error;
      }
      return;
    }

    const subscriberId = `${this.connectionId}:${message.sessionId}`;
    const lease = await this.runtime.actors.acquire(message.sessionId);
    const actor = lease.actor;
    try {
      await actor.subscriberConnected(subscriberId);
    } finally {
      lease.release();
    }
    if (this.closed) {
      await actor.postSubscriberDisconnected(subscriberId).catch(() => undefined);
      return;
    }

    let source: SessionClient;
    try {
      source = await this.runtime.storage.openSession(message.sessionId);
    } catch (error) {
      await actor.postSubscriberDisconnected(subscriberId).catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      await actor.postSubscriberDisconnected(subscriberId).catch(() => undefined);
      return;
    }

    try {
      this.startReplay(message, source, actor, subscriberId);
    } catch (error) {
      await actor.postSubscriberDisconnected(subscriberId).catch(() => undefined);
      throw error;
    }
  }

  private startReplay(
    message: SubscribeMessage,
    source: SessionClient,
    actor: SessionActor,
    subscriberId: string,
  ): void {
    let active: ActiveSubscription | null = null;
    const replay = beginReplaySubscription({
      sessionId: message.sessionId,
      afterSequence: message.afterSequence,
      source: {
        getHeadSequence: async (signal) => {
          signal.throwIfAborted();
          await this.replayHooks.beforeHeadCapture?.(message.sessionId);
          signal.throwIfAborted();
          const current = await this.runtime.storage.catalog.getSession(message.sessionId);
          if (current === null || current.status === "missing") throw new UnknownSessionError();
          if (current.status === "unavailable") {
            throw new ReplaySubscriptionError(
              "replay.session_unavailable",
              "Session storage became unavailable during replay",
            );
          }
          const head = await source.getHeadSequence(signal);
          signal.throwIfAborted();
          await this.replayHooks.afterHeadCaptured?.(message.sessionId, head);
          signal.throwIfAborted();
          return head;
        },
        getEventPageAfter: async (input, signal) => {
          signal.throwIfAborted();
          const page = await source.getEventPageAfter(input, signal);
          signal.throwIfAborted();
          await this.replayHooks.afterHistoricalRead?.(
            message.sessionId,
            input.throughSequence,
          );
          signal.throwIfAborted();
          return page;
        },
      },
      hub: this.runtime.eventHub,
      callbacks: {
        deliver: async (event, signal) => {
          if (!(await this.sendReplay(toBrowserSessionEvent(event), signal))) {
            throw new ReplaySubscriptionError(
              "replay.subscriber_overflow",
              "The outbound queue is closed",
            );
          }
        },
        replayComplete: async (throughSequence, signal) => {
          if (
            !(await this.sendReplay(
              {
                v: 1,
                kind: "replay.complete",
                requestId: message.requestId,
                sessionId: message.sessionId,
                throughSequence,
              },
              signal,
            ))
          ) {
            throw new ReplaySubscriptionError(
              "replay.subscriber_overflow",
              "The outbound queue is closed",
            );
          }
          await this.replayHooks.afterReplayComplete?.(message.sessionId, throughSequence);
        },
        onLiveError: (error) => {
          if (active === null) {
            this.internalConnectionFailure(error);
            return;
          }
          return this.replayFailed(message.sessionId, active, error);
        },
      },
      isUnknownSessionError: (error) => error instanceof UnknownSessionError,
      maxBufferedLiveEvents: this.limits.replayLiveEvents,
      maxBufferedLiveBytes: this.limits.replayLiveBytes,
      maxSingleEventBytes: this.limits.replaySingleEventBytes,
      maximumPageEvents: this.limits.replayPageEvents,
      maximumPageBytes: this.limits.replayPageBytes,
      maximumPageSingleEventBytes: this.limits.replayPageSingleEventBytes,
      connectionBudget: this.replayBudget,
    });
    const registered: ActiveSubscription = {
      requestId: message.requestId,
      subscriberId,
      actor,
      replay,
      intentional: false,
    };
    active = registered;
    this.subscriptions.set(message.sessionId, registered);
    void replay.ready.catch((error: unknown) =>
      this.replayFailed(message.sessionId, registered, error),
    );
  }

  private async replayFailed(
    sessionId: string,
    active: ActiveSubscription,
    error: unknown,
  ): Promise<void> {
    if (this.subscriptions.get(sessionId) !== active) return;
    this.subscriptions.delete(sessionId);
    active.replay.unsubscribe();
    const diagnosticId = this.runtime.diagnosticId();
    const cleanup = (async (): Promise<void> => {
      await active.replay.drain().catch(() => undefined);
      try {
        await active.actor.postSubscriberDisconnected(active.subscriberId);
      } catch (disconnectError) {
        this.logger.error("websocket_subscriber_cleanup_failed", disconnectError, {
          diagnosticId,
          connectionId: this.connectionId,
          clientId: this.clientId,
          requestId: active.requestId,
          sessionId,
        });
      }
    })();
    this.subscriptionCleanups.set(sessionId, cleanup);
    try {
      await cleanup;
      if (active.intentional || this.closed) return;
      const safe = mapReplayError(error);
      this.logger.error("websocket_replay_failed", error, {
        diagnosticId,
        connectionId: this.connectionId,
        clientId: this.clientId,
        requestId: active.requestId,
        sessionId,
      });
      if (
        error instanceof ReplaySubscriptionError &&
        error.code === "replay.subscriber_overflow"
      ) {
        this.socket.close(SLOW_CONSUMER_CLOSE_CODE, "slow consumer");
        void this.cleanup();
        return;
      }
      this.protocolError(
        safe.code,
        safe.message,
        diagnosticId,
        safe.recoverable,
        { requestId: active.requestId, sessionId },
      );
    } finally {
      if (this.subscriptionCleanups.get(sessionId) === cleanup) {
        this.subscriptionCleanups.delete(sessionId);
      }
    }
  }

  private async waitForSubscriptionCleanup(sessionId: string): Promise<void> {
    await this.subscriptionCleanups.get(sessionId);
  }

  private async unsubscribe(sessionId: string): Promise<void> {
    await this.waitForSubscriptionCleanup(sessionId);
    const active = this.subscriptions.get(sessionId);
    if (active === undefined) return;
    this.subscriptions.delete(sessionId);
    active.intentional = true;
    active.replay.unsubscribe();
    await active.replay.drain();
    await active.actor.postSubscriberDisconnected(active.subscriberId).catch(() => undefined);
  }

  private protocolViolation(message: string): void {
    this.protocolViolations += 1;
    this.protocolError(
      "protocol.invalid_message",
      message,
      this.runtime.diagnosticId(),
      true,
    );
    if (this.protocolViolations >= this.limits.maximumProtocolViolations) {
      this.socket.close(1008, "protocol violations");
      void this.cleanup();
    }
  }

  private protocolError(
    code: ProtocolErrorCode,
    message: string,
    diagnosticId: string,
    recoverable: boolean,
    context: { readonly requestId?: string; readonly sessionId?: string } = {},
  ): void {
    this.logger.warn("websocket_protocol_rejected", {
      diagnosticId,
      connectionId: this.connectionId,
      clientId: this.clientId,
      requestId: context.requestId,
      sessionId: context.sessionId,
      code,
      recoverable,
    });
    this.send({
      v: 1,
      kind: "protocol.error",
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      code,
      message,
      diagnosticId,
      recoverable,
    });
  }

  private send(message: ServerMessage): boolean {
    return this.outbound.enqueue(message);
  }

  private sendReplay(message: ServerMessage, signal: AbortSignal): Promise<boolean> {
    return this.outbound.enqueueWhenAvailable(message, {
      timeoutMs: this.limits.replayQueueWaitTimeoutMs,
      signal,
    });
  }

  private heartbeat(): void {
    if (this.closed) return;
    if (!this.alive) {
      this.socket.terminate();
      void this.cleanup();
      return;
    }
    this.alive = false;
    try {
      this.socket.ping();
    } catch (error) {
      this.internalConnectionFailure(error);
      return;
    }
    if (this.welcomed) {
      this.send({ v: 1, kind: "heartbeat", serverTimeMs: this.runtime.now() });
    }
  }

  private internalConnectionFailure(error: unknown): void {
    if (this.closed) return;
    const diagnosticId = this.runtime.diagnosticId();
    this.logger.error("websocket_internal_failure", error, {
      diagnosticId,
      connectionId: this.connectionId,
      clientId: this.clientId,
    });
    this.socket.close(1011, "internal error");
    void this.cleanup();
  }

  async shutdown(): Promise<void> {
    if (!this.closed && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close(1001, "server shutdown");
    }
    await this.cleanup();
    if (this.socket.readyState === WebSocket.CLOSED) this.resolveSocketClosed();
    await this.socketClosed;
  }

  disconnect(code: number, reason: string): void {
    if (this.closed) return;
    this.socket.close(code, reason);
    void this.cleanup();
  }

  terminate(): void {
    this.socket.terminate();
    void this.cleanup();
  }

  private cleanup(): Promise<void> {
    if (this.cleanupPromise !== null) return this.cleanupPromise;
    this.closed = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.helloTimer !== null) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    this.outbound.stop();
    const subscriptions = [...this.subscriptions.entries()];
    const pendingSubscriptionCleanups = [...this.subscriptionCleanups.values()];
    this.subscriptions.clear();
    this.cleanupPromise = Promise.all([
      ...subscriptions.map(async ([sessionId, active]) => {
        active.intentional = true;
        active.replay.unsubscribe();
        await active.replay.drain();
        await active.actor.postSubscriberDisconnected(active.subscriberId).catch(() => undefined);
        try {
          this.logger.debug("websocket_unsubscribed", {
            connectionId: this.connectionId,
            clientId: this.clientId,
            sessionId,
          });
        } catch {
          // A custom logger cannot prevent transport and subscription cleanup.
        }
      }),
      ...pendingSubscriptionCleanups,
    ]).then(async () => {
      // Commands already dispatched before transport loss may still be committing. Drain only the
      // bounded per-connection chain; this never owns or waits for the backend run it may start.
      await this.inboundTail.catch(() => undefined);
      try {
        this.logger.info("websocket_disconnected", {
          connectionId: this.connectionId,
          clientId: this.clientId,
        });
      } catch {
        // A custom logger cannot prevent transport and subscription cleanup.
      }
    });
    return this.cleanupPromise;
  }
}
