import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as createHttpRequest } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionRegistryUnavailableError } from "../../packages/harness-core/dist/session-registry.js";
import type { ProviderContext, ProviderEvent, ProviderRequest } from "@wi/provider-contract";
import {
  FileCredentialStore,
  StoredCredential,
  initializeCredentialRoots,
} from "@wi/credentials";
import {
  BootstrapResponseSchema,
  MAXIMUM_BOOTSTRAP_SESSIONS,
  hashCommandContent,
  SAFE_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type SessionEvent,
} from "@wi/protocol";
import {
  FakeProviderAdapter,
  fakeProviderGateLabel,
  type FakeProviderConfiguration,
} from "@wi/provider-fake";
import {
  resolveStoragePath,
  SESSION_EVENT_PAGE_BOUNDS,
  sessionDatabaseRelativePath,
  SessionStoreManager,
  StorageError,
  stableSessionWorkerIndex,
  type CatalogObservationFailure,
  type SessionClient,
  type SessionWorkerBarrier,
} from "@wi/storage";
import { sessionWorkerPoolForTest } from "../../packages/storage/dist/testing.js";
import { EchoInputSchema, ToolRegistry } from "@wi/tools";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WiRuntime, type WiRuntimeOptions } from "../../apps/server/src/composition.js";
import {
  MAX_HTTP_SHUTDOWN_TIMEOUT_MS,
  WiServer,
  type WiServerOptions,
} from "../../apps/server/src/http/server.js";
import {
  JsonLogger,
  type Logger,
  type LogRecord,
} from "../../apps/server/src/logging/logger.js";
import {
  BrowserConnection,
  type ConnectionCommandHooks,
  type ConnectionReplayHooks,
} from "../../apps/server/src/websocket/connection.js";
import {
  DURABLE_EVENT_ENVELOPE_RESERVE_BYTES,
  maximumDurableCommandPayloadBytes,
} from "../../apps/server/src/websocket/durable-command-limits.js";
import { MINIMUM_WI_V1_CLIENT_FRAME_DEPTH } from "../../apps/server/src/websocket/frame-decoder.js";
import { WEBSOCKET_LIMIT_CAPS } from "../../apps/server/src/websocket/gateway.js";
import { LoopbackRequestPolicy } from "../../apps/server/src/websocket/origin-policy.js";
import { SLOW_CONSUMER_CLOSE_CODE } from "../../apps/server/src/websocket/outbound-queue.js";

type EventFrame = Extract<ServerMessage, { readonly kind: "event" }>;
type CommandAcceptedFrame = Extract<ServerMessage, { readonly kind: "command.accepted" }>;
type CommandRejectedFrame = Extract<ServerMessage, { readonly kind: "command.rejected" }>;
type ProtocolErrorFrame = Extract<ServerMessage, { readonly kind: "protocol.error" }>;
type ReplayCompleteFrame = Extract<ServerMessage, { readonly kind: "replay.complete" }>;
type WelcomeFrame = Extract<ServerMessage, { readonly kind: "welcome" }>;

const servers = new Set<WiServer>();
const homes = new Set<string>();

interface Fixture {
  readonly homeDirectory: string;
  readonly runtime: WiRuntime;
  readonly server: WiServer;
  readonly records: LogRecord[];
}

const PROVIDER_SECRET = "AUDIT_PROVIDER_BEARER_SECRET";
const TOOL_SECRET = "AUDIT_TOOL_BEARER_SECRET";
const HTTP_SECRET = "AUDIT_HTTP_BEARER_SECRET";
const previousNodeEnv = process.env.NODE_ENV;
const previousFailpointGate = process.env.WI_ALLOW_TEST_FAILPOINTS;

function sessionWorkers(storage: SessionStoreManager) {
  return sessionWorkerPoolForTest(storage);
}

class ThrowingSecretProvider extends FakeProviderAdapter {
  override async *stream(
    request: ProviderRequest,
    context: ProviderContext,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    void request;
    void context;
    signal.throwIfAborted();
    yield* [] as ProviderEvent[];
    throw new Error(
      `Provider rejected Bearer ${PROVIDER_SECRET}`.padEnd(8 * 1_024 * 1_024, "x"),
    );
  }
}

function failingEchoRegistry(effectClass: "pure" | "idempotent_external"): ToolRegistry {
  return new ToolRegistry([
    {
      name: "echo",
      description: "Throw an injected error for diagnostic-correlation coverage.",
      inputSchema: EchoInputSchema,
      effectClass,
      approval: "never",
      executionMode: "cooperative_in_process",
      timeoutMs: 5_000,
      execute: async () => {
        throw new Error(
          `Tool rejected Bearer ${TOOL_SECRET}`.padEnd(8 * 1_024 * 1_024, "x"),
        );
      },
    },
  ]);
}

class ReportedSecretProvider extends FakeProviderAdapter {
  override async *stream(
    request: ProviderRequest,
    context: ProviderContext,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    void context;
    signal.throwIfAborted();
    yield {
      type: "response.started",
      runId: request.runId,
      stepId: request.stepId,
      stepIndex: request.stepIndex,
      responseId: "response_secretFailure",
    };
    yield {
      type: "response.failed",
      runId: request.runId,
      stepId: request.stepId,
      stepIndex: request.stepIndex,
      category: "terminal",
      message: `Provider rejected Bearer ${PROVIDER_SECRET}`,
      retryable: false,
    };
  }
}

async function startFixture(options: {
  readonly homeDirectory?: string;
  readonly providerConfiguration?: FakeProviderConfiguration;
  readonly runtime?: Omit<WiRuntimeOptions, "homeDirectory" | "logger" | "providerConfiguration">;
  readonly gateway?: WiServerOptions["gateway"];
  readonly httpShutdownTimeoutMs?: number;
  readonly webRoot?: string;
} = {}): Promise<Fixture> {
  const homeDirectory =
    options.homeDirectory ?? (await mkdtemp(join(tmpdir(), "wi-milestone5-")));
  homes.add(homeDirectory);
  const records: LogRecord[] = [];
  const logger = new JsonLogger({ write: (record) => records.push(record) });
  const runtime = new WiRuntime({
    homeDirectory,
    logger,
    ...(options.providerConfiguration === undefined
      ? {}
      : { providerConfiguration: options.providerConfiguration }),
    ...options.runtime,
  });
  const server = new WiServer({
    runtime,
    port: 0,
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    ...(options.httpShutdownTimeoutMs === undefined
      ? {}
      : { httpShutdownTimeoutMs: options.httpShutdownTimeoutMs }),
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
  });
  servers.add(server);
  await server.start();
  return { homeDirectory, runtime, server, records };
}

afterEach(async () => {
  const active = [...servers];
  servers.clear();
  await Promise.allSettled(active.map((server) => server.close()));
  const paths = [...homes];
  homes.clear();
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousFailpointGate === undefined) delete process.env.WI_ALLOW_TEST_FAILPOINTS;
  else process.env.WI_ALLOW_TEST_FAILPOINTS = previousFailpointGate;
});

class TestSocket {
  readonly all: ServerMessage[] = [];
  private readonly inbox: ServerMessage[] = [];
  private closed = false;
  private closeInfo: { code: number; reason: string } | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) throw new Error("Server emitted an unexpected binary message");
      const parsed = ServerMessageSchema.parse(JSON.parse(data.toString()) as unknown);
      this.all.push(parsed);
      this.inbox.push(parsed);
    });
    socket.on("close", (code, reason) => {
      this.closed = true;
      this.closeInfo = { code, reason: reason.toString() };
    });
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  async take<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    timeoutMs = 8_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.inbox.findIndex(predicate);
      if (index >= 0) {
        const [message] = this.inbox.splice(index, 1);
        if (message !== undefined && predicate(message)) return message;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for server message; received ${JSON.stringify(this.all)}`);
  }

  takeKind<K extends ServerMessage["kind"]>(kind: K, timeoutMs?: number): Promise<Extract<ServerMessage, { kind: K }>> {
    return this.take(
      (message): message is Extract<ServerMessage, { kind: K }> => message.kind === kind,
      timeoutMs,
    );
  }

  async waitForClose(timeoutMs = 8_000): Promise<{ code: number; reason: string }> {
    if (this.closed) return this.closeInfo ?? { code: 1006, reason: "" };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), timeoutMs);
      this.socket.once("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed || this.socket.readyState === WebSocket.CLOSED) return;
    const closed = this.waitForClose();
    this.socket.close(1000, "test complete");
    await closed;
  }
}

async function bootstrap(server: WiServer): Promise<{
  readonly cookie: string;
  readonly response: Response;
  readonly body: unknown;
}> {
  const response = await fetch(`${server.origin}/bootstrap`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Bootstrap did not issue a cookie");
  const cookie = setCookie.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Bootstrap cookie is malformed");
  return { cookie, response, body: await response.json() };
}

async function connect(
  server: WiServer,
  cookie: string,
  options: { readonly origin?: string; readonly host?: string; readonly protocol?: string } = {},
): Promise<TestSocket> {
  const socket = new WebSocket(
    `${server.origin.replace("http:", "ws:")}/ws`,
    options.protocol ?? "wi.v1",
    {
      origin: options.origin ?? server.origin,
      headers: {
        Cookie: cookie,
        ...(options.host === undefined ? {} : { Host: options.host }),
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return new TestSocket(socket);
}

interface RejectedUpgradeResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: unknown;
}

async function rejectedUpgradeDetails(
  server: WiServer,
  options: {
    readonly cookie?: string;
    readonly origin?: string;
    readonly host?: string;
    readonly protocol?: string | null;
    readonly path?: string;
  },
): Promise<RejectedUpgradeResponse> {
  const url = `${server.origin.replace("http:", "ws:")}${options.path ?? "/ws"}`;
  const webSocketOptions = {
    origin: options.origin ?? server.origin,
    headers: {
      ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
      ...(options.host === undefined ? {} : { Host: options.host }),
    },
  };
  const socket =
    options.protocol === null
      ? new WebSocket(url, webSocketOptions)
      : new WebSocket(url, options.protocol ?? "wi.v1", webSocketOptions);
  return new Promise<RejectedUpgradeResponse>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(text) as unknown,
        });
      });
      response.once("error", reject);
    });
    socket.once("open", () => reject(new Error("Rejected WebSocket unexpectedly opened")));
    socket.once("error", () => undefined);
  });
}

async function rejectedUpgrade(
  server: WiServer,
  options: Parameters<typeof rejectedUpgradeDetails>[1],
): Promise<number> {
  return (await rejectedUpgradeDetails(server, options)).statusCode;
}

async function openRawSocket(server: WiServer): Promise<Socket> {
  const address = server.address;
  if (address === null) throw new Error("Server is not listening");
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function openRawWebSocketPeer(server: WiServer, cookie: string): Promise<Socket> {
  const address = server.address;
  if (address === null) throw new Error("Server is not listening");
  const socket = await openRawSocket(server);
  socket.on("error", () => undefined);
  const response = new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket upgrade")), 8_000);
    const onData = (chunk: Buffer): void => {
      text += chunk.toString("latin1");
      if (!text.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(text);
    };
    socket.on("data", onData);
  });
  socket.write(
    `GET /ws HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${address.port}\r\n` +
      `Origin: ${server.origin}\r\n` +
      `Cookie: ${cookie}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
      "Sec-WebSocket-Protocol: wi.v1\r\n\r\n",
  );
  const handshake = await response;
  if (!handshake.startsWith("HTTP/1.1 101")) {
    socket.destroy();
    throw new Error(`WebSocket upgrade failed: ${handshake}`);
  }
  return socket;
}

async function directHttpRequest(
  server: WiServer,
  options: {
    readonly path: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<{
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: unknown;
}> {
  const address = server.address;
  if (address === null) throw new Error("Server is not listening");
  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: options.path,
        method: options.method ?? "GET",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: JSON.parse(text) as unknown,
          });
        });
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function rawTcpRequest(server: WiServer, request: string): Promise<string> {
  const address = server.address;
  if (address === null) throw new Error("Server is not listening");
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    let response = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Timed out waiting for raw HTTP response"));
    }, 8_000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("end", finish);
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function hello(client: TestSocket, suffix: string, resume: unknown[] = []): Promise<WelcomeFrame> {
  client.send({ v: 1, kind: "hello", clientId: `client_${suffix}`, resume });
  return client.takeKind("welcome");
}

async function createSession(client: TestSocket, suffix: string): Promise<CommandAcceptedFrame> {
  client.send({
    v: 1,
    kind: "command",
    commandId: `cmd_create_${suffix}`,
    method: "session.create",
    params: { title: `Session ${suffix}` },
  });
  return client.take(
    (message): message is CommandAcceptedFrame =>
      message.kind === "command.accepted" && message.commandId === `cmd_create_${suffix}`,
  );
}

async function subscribe(
  client: TestSocket,
  sessionId: string,
  suffix: string,
  afterSequence = 0,
): Promise<ReplayCompleteFrame> {
  client.send({
    v: 1,
    kind: "subscribe",
    requestId: `req_subscribe_${suffix}`,
    sessionId,
    afterSequence,
  });
  return client.take(
    (message): message is ReplayCompleteFrame =>
      message.kind === "replay.complete" && message.requestId === `req_subscribe_${suffix}`,
  );
}

async function submitMessage(
  client: TestSocket,
  sessionId: string,
  suffix: string,
  text = "Run the explicit fake scenario.",
): Promise<CommandAcceptedFrame> {
  client.send({
    v: 1,
    kind: "command",
    commandId: `cmd_submit_${suffix}`,
    sessionId,
    method: "message.submit",
    params: { text },
  });
  return client.take(
    (message): message is CommandAcceptedFrame =>
      message.kind === "command.accepted" && message.commandId === `cmd_submit_${suffix}`,
  );
}

function eventFor<T extends EventFrame["eventType"]>(
  sessionId: string,
  eventType: T,
): (message: ServerMessage) => message is Extract<EventFrame, { readonly eventType: T }>;
function eventFor(sessionId: string): (message: ServerMessage) => message is EventFrame;
function eventFor(
  sessionId: string,
  eventType?: EventFrame["eventType"],
): (message: ServerMessage) => message is EventFrame {
  return (message): message is EventFrame =>
    message.kind === "event" &&
    message.sessionId === sessionId &&
    (eventType === undefined || message.eventType === eventType);
}

function replayInputEventAtBytes(
  sessionId: string,
  targetBytes: number,
  suffix: string,
): {
  readonly eventId: string;
  readonly eventType: "input.requested";
  readonly createdAtMs: number;
  readonly data: {
    readonly eventVersion: 1;
    readonly runId: string;
    readonly inputId: string;
    readonly prompt: string;
  };
} {
  const data = {
    eventVersion: 1 as const,
    runId: `run_${suffix}`,
    inputId: `input_${suffix}`,
    prompt: "",
  };
  const event = {
    v: 1 as const,
    kind: "event" as const,
    sessionId,
    sequence: 2,
    eventId: `evt_${suffix}`,
    eventType: "input.requested" as const,
    createdAtMs: 20_000,
    data,
  };
  const emptyBytes = Buffer.byteLength(JSON.stringify(event));
  if (targetBytes < emptyBytes) throw new RangeError("Target replay event is too small");
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    createdAtMs: event.createdAtMs,
    data: { ...data, prompt: "x".repeat(targetBytes - emptyBytes) },
  };
}

function jsonStringWithCanonicalBytes(targetBytes: number): string {
  if (targetBytes < 2) throw new RangeError("Canonical JSON string target is too small");
  return "x".repeat(targetBytes - 2);
}

async function seedReplayEvents(
  session: SessionClient,
  count: number,
  textBytes = 32,
): Promise<void> {
  for (let offset = 0; offset < count; offset += 50) {
    const batchSize = Math.min(50, count - offset);
    await session.appendTransaction({
      events: Array.from({ length: batchSize }, (_, index) => {
        const item = offset + index + 1;
        return {
          eventId: `evt_largeReplay${item}`,
          eventType: "provider.text.delta" as const,
          createdAtMs: 10_000 + item,
          data: {
            eventVersion: 1 as const,
            runId: "run_largeReplay",
            stepId: "step_largeReplay",
            messageId: "msg_largeReplay",
            partId: "part_largeReplay",
            text: "x".repeat(textBytes),
          },
        };
      }),
      projections: [],
    });
  }
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe("Milestone 5 loopback server and WebSocket gateway", () => {
  it("serves health/bootstrap with strict headers and enforces host, origin, and cookie", async () => {
    const fixture = await startFixture();
    const health = await fetch(`${fixture.server.origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");

    const bootstrapped = await bootstrap(fixture.server);
    expect(bootstrapped.response.status).toBe(200);
    expect(bootstrapped.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(bootstrapped.response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(BootstrapResponseSchema.parse(bootstrapped.body).sessions).toEqual([]);
    expect(JSON.stringify(bootstrapped.body)).not.toContain(bootstrapped.cookie.split("=")[1]);
    const unsafeHttp = await fetch(`${fixture.server.origin}/bootstrap`, { method: "POST" });
    expect(unsafeHttp.status).toBe(405);
    expect(unsafeHttp.headers.get("set-cookie")).toBeNull();
    expect((await fetch(`${fixture.server.origin}/files/not-implemented`)).status).toBe(401);
    expect(
      (
        await fetch(`${fixture.server.origin}/files/not-implemented`, {
          headers: { Cookie: bootstrapped.cookie },
        })
      ).status,
    ).toBe(501);

    expect(await rejectedUpgrade(fixture.server, {})).toBe(401);
    expect(
      await rejectedUpgrade(fixture.server, {
        cookie: bootstrapped.cookie,
        origin: "http://evil.invalid",
      }),
    ).toBe(403);
    expect(
      await rejectedUpgrade(fixture.server, {
        cookie: bootstrapped.cookie,
        host: "evil.invalid",
      }),
    ).toBe(421);
    expect(
      await rejectedUpgrade(fixture.server, {
        cookie: bootstrapped.cookie,
        protocol: null,
      }),
    ).toBe(426);
    expect(
      await rejectedUpgrade(fixture.server, {
        cookie: bootstrapped.cookie,
        protocol: "unsupported.v2",
      }),
    ).toBe(426);

    const address = fixture.server.address;
    if (address === null) throw new Error("Server is not listening");
    for (const host of [
      `127.0.0.1:${address.port + 1}`,
      `evil127.0.0.1:${address.port}`,
      `127.0.0.1.evil:${address.port}`,
      `user@127.0.0.1:${address.port}`,
    ]) {
      expect(
        await rejectedUpgrade(fixture.server, { cookie: bootstrapped.cookie, host }),
      ).toBe(421);
    }
    for (const origin of [
      `${fixture.server.origin}.evil`,
      `http://evil@127.0.0.1:${address.port}`,
      `http://127.0.0.1:${address.port + 1}`,
      `${fixture.server.origin}/path`,
    ]) {
      expect(
        await rejectedUpgrade(fixture.server, { cookie: bootstrapped.cookie, origin }),
      ).toBe(403);
    }
    const [cookieName, cookieValue] = bootstrapped.cookie.split("=", 2);
    if (cookieName === undefined || cookieValue === undefined) {
      throw new Error("Bootstrap cookie is malformed");
    }
    const forgedValue = `${cookieValue[0] === "A" ? "B" : "A"}${cookieValue.slice(1)}`;
    expect(
      await rejectedUpgrade(fixture.server, { cookie: `${cookieName}=${forgedValue}` }),
    ).toBe(401);
    expect(
      await rejectedUpgrade(fixture.server, {
        cookie: `${bootstrapped.cookie}; ${bootstrapped.cookie}`,
      }),
    ).toBe(401);

    const authenticated = await connect(fixture.server, bootstrapped.cookie);
    await hello(authenticated, "security");
    await authenticated.close();
    const serializedLogs = JSON.stringify(fixture.records);
    expect(serializedLogs).not.toContain(bootstrapped.cookie.split("=")[1]);
  });

  it("lists browser-safe session summaries in bootstrap", async () => {
    const fixture = await startFixture();
    const first = await bootstrap(fixture.server);
    const client = await connect(fixture.server, first.cookie);
    await hello(client, "bootstrapSummary");
    const created = await createSession(client, "bootstrapSummary");
    await client.close();

    const second = await bootstrap(fixture.server);
    const parsed = BootstrapResponseSchema.parse(second.body);
    expect(parsed.sessions).toEqual([
      expect.objectContaining({
        sessionId: created.sessionId,
        title: "Session bootstrapSummary",
        status: "ready",
        lastEventSequence: 1,
      }),
    ]);
    expect(JSON.stringify(parsed)).not.toContain("dbRelativePath");
    expect(JSON.stringify(parsed)).not.toContain("sqlite");
  });

  it("bounds bootstrap rows and recovery candidates inside catalog worker queries", async () => {
    const fixture = await startFixture();
    const oversizedTitle = "😀".repeat(1_000);
    const oversizedPreview = "p".repeat(300_000);
    for (let index = 0; index < MAXIMUM_BOOTSTRAP_SESSIONS + 2; index += 1) {
      await fixture.runtime.storage.catalog.createSessionIndex({
        sessionId: `ses_boundedBootstrap${index}`,
        projectId: null,
        dbRelativePath: `sessions/bounded-${index}.sqlite3`,
        title: index === 0 ? oversizedTitle : `Bounded ${index}`,
        status: "ready",
        createdAtMs: index + 1,
        updatedAtMs: index === 0 ? 2_000_000 : index + 1,
        lastEventSequence: index,
        lastRunState: null,
        lastMessagePreview: index === 0 ? oversizedPreview : null,
        requiresAttention: false,
        pendingApprovalCount: 0,
        pendingInputCount: 0,
        sessionSchemaVersion: 1,
        recoveryCandidate: true,
      });
    }

    const firstRecoveryPage = await fixture.runtime.storage.listRecoveryCandidatePage();
    expect(firstRecoveryPage.sessionIds).toHaveLength(1_000);
    expect(firstRecoveryPage.nextCursor).not.toBeNull();
    const secondRecoveryPage = await fixture.runtime.storage.listRecoveryCandidatePage(
      firstRecoveryPage.nextCursor,
    );
    expect(secondRecoveryPage.sessionIds).toHaveLength(2);
    expect(secondRecoveryPage.nextCursor).not.toBeNull();
    await expect(
      fixture.runtime.storage.listRecoveryCandidatePage(secondRecoveryPage.nextCursor),
    ).resolves.toEqual({ sessionIds: [], nextCursor: null });

    const response = await bootstrap(fixture.server);
    expect(response.response.status).toBe(200);
    const parsed = BootstrapResponseSchema.parse(response.body);
    expect(parsed.sessions).toHaveLength(MAXIMUM_BOOTSTRAP_SESSIONS);
    expect(parsed.sessionsTruncated).toBe(true);
    expect(parsed.sessions[0]).toMatchObject({
      sessionId: "ses_boundedBootstrap0",
      title: oversizedTitle.slice(0, 512),
      lastMessagePreview: oversizedPreview.slice(0, 256),
    });
  }, 15_000);

  it("advertises browser command limits from the actual gateway configuration", async () => {
    const fixture = await startFixture({
      gateway: { limits: { frame: { maximumBytes: 32 * 1_024, maximumDepth: 20 } } },
    });
    const response = await bootstrap(fixture.server);
    const parsed = BootstrapResponseSchema.parse(response.body);

    expect(parsed.commandLimits).toMatchObject({
      v: 1,
      maximumFrameBytes: 32 * 1_024,
      maximumRawInputCodeUnits: 32 * 1_024,
      maximumRawInputUtf8Bytes: 32 * 1_024,
      maximumJsonDepth: 18,
    });
    expect(parsed.commandLimits.maximumDurablePayloadBytes).toBeGreaterThan(
      parsed.commandLimits.maximumFrameBytes,
    );
  });

  it("serves bounded application assets with strict content types and caching", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "wi-web-assets-"));
    homes.add(webRoot);
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Wi test</title>");
    await writeFile(join(webRoot, "assets", "app-test.js"), "globalThis.__wiLoaded = true;");
    const fixture = await startFixture({ webRoot });

    const index = await fetch(`${fixture.server.origin}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await index.text()).toContain("Wi test");

    const asset = await fetch(`${fixture.server.origin}/assets/app-test.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${fixture.server.origin}/assets/../catalog.sqlite3`)).status).toBe(404);
  });

  it("correlates direct HTTP rejections without logging credentials or request targets", async () => {
    const fixture = await startFixture();
    const cookieSecret = "AUDIT_HTTP_COOKIE_SECRET";
    const targetSecret = "AUDIT_HTTP_TARGET_SECRET";
    const cases = [
      {
        expected: { statusCode: 421, code: "http.invalid_host", reason: "invalid_host" },
        request: { path: "/health", headers: { Host: "evil.invalid" } },
      },
      {
        expected: { statusCode: 401, code: "http.unauthorized", reason: "unauthorized" },
        request: {
          path: `/files/probe?token=${targetSecret}`,
          headers: { Cookie: `wi_browser_session=${cookieSecret}` },
        },
      },
      {
        expected: {
          statusCode: 405,
          code: "http.method_not_allowed",
          reason: "method_not_allowed",
        },
        request: { path: `/health?token=${targetSecret}`, method: "POST" },
      },
      {
        expected: { statusCode: 404, code: "http.not_found", reason: "route_not_found" },
        request: { path: `/missing?token=${targetSecret}` },
      },
    ] as const;

    for (const value of cases) {
      const response = await directHttpRequest(fixture.server, value.request);
      const body = response.body as {
        readonly code?: unknown;
        readonly diagnosticId?: unknown;
        readonly message?: unknown;
      };
      expect(response.statusCode).toBe(value.expected.statusCode);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(body).toMatchObject({
        code: value.expected.code,
        message: expect.any(String),
        diagnosticId: expect.stringMatching(/^err_/u),
      });
      expect(response.headers["x-wi-diagnostic-id"]).toBe(body.diagnosticId);
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "http_request_rejected",
          diagnosticId: body.diagnosticId,
          statusCode: value.expected.statusCode,
          code: value.expected.code,
          reason: value.expected.reason,
        }),
      );
    }

    const serializedLogs = JSON.stringify(fixture.records);
    expect(serializedLogs).not.toContain(cookieSecret);
    expect(serializedLogs).not.toContain(targetSecret);
    expect(serializedLogs).not.toContain("/files/probe");
    expect(serializedLogs).not.toContain("/missing");
  });

  it.each([
    ["invalid host", { host: "evil.invalid" }, 421, "websocket.invalid_host"],
    ["invalid origin", { origin: "http://evil.invalid" }, 403, "websocket.invalid_origin"],
    [
      "unsupported subprotocol",
      { protocol: "unsupported.v2" },
      426,
      "websocket.unsupported_subprotocol",
    ],
    ["unauthorized", {}, 401, "websocket.unauthorized"],
  ] as const)(
    "correlates %s upgrade rejection responses with redacted server diagnostics",
    async (_case, options, statusCode, code) => {
      const fixture = await startFixture();
      const { cookie } = await bootstrap(fixture.server);
      const response = await rejectedUpgradeDetails(fixture.server, {
        ...options,
        ...(code === "websocket.unauthorized" ? {} : { cookie }),
      });
      const body = response.body as {
        readonly code?: unknown;
        readonly diagnosticId?: unknown;
        readonly message?: unknown;
      };

      expect(response.statusCode).toBe(statusCode);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(body).toMatchObject({ code, message: expect.any(String) });
      expect(body.diagnosticId).toMatch(/^err_/u);
      expect(response.headers["x-wi-diagnostic-id"]).toBe(body.diagnosticId);
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "websocket_upgrade_rejected",
          diagnosticId: body.diagnosticId,
        }),
      );
      expect(JSON.stringify(response)).not.toContain(cookie.split("=")[1]);
    },
  );

  it("correlates wrong-endpoint and shutdown-time upgrade rejections", async () => {
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const wrongEndpoint = await rejectedUpgradeDetails(fixture.server, {
      cookie,
      path: "/wrong-path",
    });
    fixture.server.gateway.stopAccepting();
    const unavailable = await rejectedUpgradeDetails(fixture.server, { cookie });

    for (const [response, expected] of [
      [wrongEndpoint, { statusCode: 404, code: "websocket.not_found", reason: "endpoint_not_found" }],
      [unavailable, { statusCode: 503, code: "websocket.unavailable", reason: "gateway_unavailable" }],
    ] as const) {
      const body = response.body as {
        readonly code?: unknown;
        readonly diagnosticId?: unknown;
      };
      expect(response.statusCode).toBe(expected.statusCode);
      expect(body).toMatchObject({
        code: expected.code,
        diagnosticId: expect.stringMatching(/^err_/u),
      });
      expect(response.headers["x-wi-diagnostic-id"]).toBe(body.diagnosticId);
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "websocket_upgrade_rejected",
          diagnosticId: body.diagnosticId,
          reason: expected.reason,
        }),
      );
    }
  });

  it("rejects duplicate raw Host and Origin fields for authenticated upgrades", async () => {
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const address = fixture.server.address;
    if (address === null) throw new Error("Server is not listening");
    const allowedHost = `127.0.0.1:${address.port}`;

    const httpResponse = await rawTcpRequest(
      fixture.server,
      `GET /health HTTP/1.1\r\nHost: ${allowedHost}\r\nHost: evil.invalid\r\nConnection: close\r\n\r\n`,
    );
    expect(httpResponse).toMatch(/^HTTP\/1\.1 421 /u);

    const upgradeResponse = await rawTcpRequest(
      fixture.server,
      `GET /ws HTTP/1.1\r\nHost: ${allowedHost}\r\nHost: evil.invalid\r\nOrigin: ${fixture.server.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: wi.v1\r\n\r\n`,
    );
    expect(upgradeResponse).toMatch(/^HTTP\/1\.1 421 /u);

    const duplicateOriginResponse = await rawTcpRequest(
      fixture.server,
      `GET /ws HTTP/1.1\r\nHost: ${allowedHost}\r\nOrigin: ${fixture.server.origin}\r\nOrigin: http://evil.invalid\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: wi.v1\r\n\r\n`,
    );
    expect(duplicateOriginResponse).toMatch(/^HTTP\/1\.1 403 /u);
  });

  it("correlates empty subprotocol tokens and malformed handshake fields before ws", async () => {
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const address = fixture.server.address;
    if (address === null) throw new Error("Server is not listening");
    const cases = [
      { protocol: "wi.v1,", version: "13", key: "dGhlIHNhbXBsZSBub25jZQ==", status: 426, reason: "unsupported_subprotocol" },
      { protocol: ",wi.v1", version: "13", key: "dGhlIHNhbXBsZSBub25jZQ==", status: 426, reason: "unsupported_subprotocol" },
      { protocol: "wi.v1,,", version: "13", key: "dGhlIHNhbXBsZSBub25jZQ==", status: 426, reason: "unsupported_subprotocol" },
      { protocol: "wi.v1", version: "12", key: "dGhlIHNhbXBsZSBub25jZQ==", status: 400, reason: "invalid_handshake" },
      { protocol: "wi.v1", version: "13", key: "invalid-key", status: 400, reason: "invalid_handshake" },
    ] as const;

    for (const value of cases) {
      const response = await rawTcpRequest(
        fixture.server,
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nOrigin: ${fixture.server.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: ${value.version}\r\nSec-WebSocket-Key: ${value.key}\r\nSec-WebSocket-Protocol: ${value.protocol}\r\n\r\n`,
      );
      expect(response).toMatch(new RegExp(`^HTTP/1\\.1 ${value.status} `, "u"));
      const diagnosticId = /\r\nX-Wi-Diagnostic-Id: (err_[^\r\n]+)\r\n/iu.exec(response)?.[1];
      expect(diagnosticId).toMatch(/^err_/u);
      expect(response).toContain(`"diagnosticId":"${diagnosticId}"`);
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "websocket_upgrade_rejected",
          diagnosticId,
          reason: value.reason,
        }),
      );
    }
  });

  it("fingerprints HTTP parser exceptions instead of logging their messages", async () => {
    const fixture = await startFixture();
    const address = fixture.server.address;
    if (address === null) throw new Error("Server is not listening");
    const response = await rawTcpRequest(
      fixture.server,
      `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nX-Bad: \u0000Bearer ${HTTP_SECRET}\r\n\r\n`,
    );
    expect(response).toMatch(/^HTTP\/1\.1 400 /u);
    const diagnosticId = /\r\nX-Wi-Diagnostic-Id: (err_[^\r\n]+)\r\n/iu.exec(response)?.[1];
    expect(diagnosticId).toMatch(/^err_/u);
    expect(response).toContain(`"diagnosticId":"${diagnosticId}"`);
    await eventually(() => {
      const record = fixture.records.find((candidate) => candidate.event === "http_client_error");
      expect(record).toMatchObject({
        level: "error",
        diagnosticId,
        parserCode: expect.any(String),
        error: {
          type: "error",
          message: {
            sourceUnit: "utf16_code_units",
            sourceLength: expect.any(Number),
            sampledByteLength: expect.any(Number),
            sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            truncated: expect.any(Boolean),
          },
        },
      });
    });
    expect(JSON.stringify(fixture.records)).not.toContain(HTTP_SECRET);
  });

  it("keeps upgrade, frame, and HTTP parser boundaries deterministic when logging throws", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-throwing-logger-"));
    homes.add(homeDirectory);
    const attempted: string[] = [];
    const failLog = (event: string): never => {
      attempted.push(event);
      throw new Error(`injected ${event} logger failure`);
    };
    const logger: Logger = {
      debug: (event) => failLog(event),
      info: (event) => failLog(event),
      warn: (event) => failLog(event),
      error: (event) => failLog(event),
    };
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
    const runtime = new WiRuntime({ homeDirectory, logger });
    const server = new WiServer({ runtime, port: 0 });
    servers.add(server);

    try {
      await server.start();
      const unauthorized = await rejectedUpgradeDetails(server, {});
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.body).toMatchObject({
        code: "websocket.unauthorized",
        diagnosticId: expect.stringMatching(/^err_/u),
      });

      const { cookie } = await bootstrap(server);
      const client = await connect(server, cookie);
      await hello(client, "throwingLogger");
      for (let violation = 0; violation < 3; violation += 1) {
        client.socket.send('{"malformed"');
        expect((await client.takeKind("protocol.error")).code).toBe("protocol.invalid_json");
      }
      expect((await client.waitForClose()).code).toBe(1008);
      await eventually(() => expect(server.gateway.connectionSnapshots).toEqual([]));

      const address = server.address;
      if (address === null) throw new Error("Server is not listening");
      const parserResponse = await rawTcpRequest(
        server,
        `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nX-Bad: \u0000secret\r\n\r\n`,
      );
      expect(parserResponse).toMatch(/^HTTP\/1\.1 400 /u);
      expect((await fetch(`${server.origin}/health`)).status).toBe(200);
      await server.close();
      servers.delete(server);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
    }

    expect(uncaught).toEqual([]);
    expect(unhandled).toEqual([]);
    expect(attempted).toEqual(
      expect.arrayContaining([
        "server_started",
        "websocket_upgrade_rejected",
        "websocket_connected",
        "websocket_protocol_error",
        "websocket_disconnected",
        "http_client_error",
      ]),
    );
  });

  it("closes a concurrent startup without leaving an HTTP listener", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-start-close-"));
    homes.add(homeDirectory);
    const runtime = new WiRuntime({ homeDirectory });
    const server = new WiServer({ runtime, port: 0 });
    servers.add(server);

    const starting = server.start();
    const closing = server.close();
    await expect(Promise.all([starting, closing])).resolves.toEqual([undefined, undefined]);
    expect(server.address).toBeNull();
    expect(server.gateway.connectionSnapshots).toEqual([]);
  });

  it("closes the listener when startup fails after listen succeeds", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-post-listen-failure-"));
    homes.add(homeDirectory);
    let listenedPort: number | null = null;
    const setListeningPort = vi
      .spyOn(LoopbackRequestPolicy.prototype, "setListeningPort")
      .mockImplementation((port) => {
        listenedPort = port;
        throw new Error("post-listen policy failure");
      });
    const runtime = new WiRuntime({ homeDirectory });
    const server = new WiServer({ runtime, port: 0 });
    servers.add(server);

    try {
      await expect(server.start()).rejects.toThrow("post-listen policy failure");
    } finally {
      setListeningPort.mockRestore();
    }
    expect(listenedPort).not.toBeNull();
    expect(server.address).toBeNull();
    expect(server.gateway.connectionSnapshots).toEqual([]);
    await expect(
      fetch(`http://127.0.0.1:${String(listenedPort)}/health`),
    ).rejects.toBeDefined();
  });

  it("bounds shutdown with incomplete headers and a stalled keep-alive connection", async () => {
    const fixture = await startFixture({ httpShutdownTimeoutMs: 50 });
    const address = fixture.server.address;
    if (address === null) throw new Error("Server is not listening");
    const incomplete = await openRawSocket(fixture.server);
    const keepAlive = await openRawSocket(fixture.server);
    incomplete.on("error", () => undefined);
    keepAlive.on("error", () => undefined);
    const incompleteClosed = new Promise<void>((resolve) =>
      incomplete.once("close", () => resolve()),
    );
    const keepAliveClosed = new Promise<void>((resolve) =>
      keepAlive.once("close", () => resolve()),
    );
    incomplete.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${address.port}`);
    let responseText = "";
    const keepAliveResponse = new Promise<void>((resolve) => {
      keepAlive.on("data", (chunk) => {
        responseText += chunk.toString("utf8");
        if (responseText.includes("HTTP/1.1 200")) resolve();
      });
    });
    keepAlive.write(
      `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: keep-alive\r\n\r\n`,
    );
    await keepAliveResponse;

    const startedAt = Date.now();
    const closing = fixture.server.close();
    expect(fixture.server.address).toBeNull();
    await closing;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await Promise.all([incompleteClosed, keepAliveClosed]);
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "http_shutdown_forced",
        diagnosticId: expect.stringMatching(/^err_/u),
        connectionCount: expect.any(Number),
      }),
    );
  });

  it("bounds gateway shutdown when cleanup logging throws and a raw peer ignores close", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-gateway-cleanup-"));
    homes.add(homeDirectory);
    const records: LogRecord[] = [];
    const sink = new JsonLogger({ write: (record) => records.push(record) });
    const logger: Logger = {
      debug: (event, fields) => sink.debug(event, fields),
      info: (event, fields) => {
        if (event === "websocket_disconnected") {
          throw new Error("injected disconnect logger failure");
        }
        sink.info(event, fields);
      },
      warn: (event, fields) => sink.warn(event, fields),
      error: (event, error, fields) => sink.error(event, error, fields),
    };
    const runtime = new WiRuntime({ homeDirectory, logger });
    const server = new WiServer({
      runtime,
      port: 0,
      gateway: { shutdownTimeoutMs: 50 },
    });
    servers.add(server);
    await server.start();
    const { cookie } = await bootstrap(server);
    const peer = await openRawWebSocketPeer(server, cookie);
    const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    await eventually(() => expect(server.gateway.connectionSnapshots).toHaveLength(1));

    const startedAt = Date.now();
    await expect(server.close()).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await peerClosed;
    expect(server.gateway.connectionSnapshots).toEqual([]);
    servers.delete(server);
  });

  it("terminates an unresponsive peer when connection shutdown rejects", async () => {
    const secret = "AUDIT_WEBSOCKET_SHUTDOWN_SECRET";
    const fixture = await startFixture({ gateway: { shutdownTimeoutMs: 500 } });
    const { cookie } = await bootstrap(fixture.server);
    const peer = await openRawWebSocketPeer(fixture.server, cookie);
    const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
    await eventually(() => expect(fixture.server.gateway.connectionSnapshots).toHaveLength(1));
    const shutdown = vi
      .spyOn(BrowserConnection.prototype, "shutdown")
      .mockRejectedValue(new Error(`Cleanup failed with Bearer ${secret}`));

    try {
      await expect(fixture.server.close()).resolves.toBeUndefined();
      await peerClosed;
    } finally {
      shutdown.mockRestore();
    }
    expect(fixture.server.gateway.connectionSnapshots).toEqual([]);
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "websocket_shutdown_cleanup_failed",
        diagnosticId: expect.stringMatching(/^err_/u),
        phase: "connection_cleanup",
        error: expect.objectContaining({
          type: "error",
          message: expect.objectContaining({
            sourceUnit: "utf16_code_units",
            sourceLength: expect.any(Number),
            sampledByteLength: expect.any(Number),
            sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            truncated: expect.any(Boolean),
          }),
        }),
      }),
    );
    expect(JSON.stringify(fixture.records)).not.toContain(secret);
    servers.delete(fixture.server);
  });

  it("rejects runtime attempts to override gateway security dependencies", async () => {
    const fixture = await startFixture();
    const forbidden = {
      runtime: fixture.runtime,
      auth: { authenticate: () => true },
      requestPolicy: { validateUpgrade: () => null },
      logger: fixture.runtime.logger,
    };
    for (const [key, value] of Object.entries(forbidden)) {
      expect(
        () =>
          new WiServer({
            runtime: fixture.runtime,
            port: 0,
            gateway: { [key]: value } as NonNullable<WiServerOptions["gateway"]>,
          }),
      ).toThrow(new RegExp(`gateway option ${key} is reserved`, "u"));
    }
    expect(
      () => new WiServer({ runtime: fixture.runtime, port: 0, httpShutdownTimeoutMs: 0 }),
    ).toThrow(/HTTP shutdown timeout must be a positive safe integer/u);
  });

  it("fails before server construction when canonical storage cannot initialize", async () => {
    const base = await mkdtemp(join(tmpdir(), "wi-milestone5-invalid-home-"));
    homes.add(base);
    const invalidHome = join(base, "not-a-directory");
    await writeFile(invalidHome, "occupied");

    let failure: unknown;
    try {
      new WiRuntime({
        homeDirectory: invalidHome,
        logger: new JsonLogger({ write: () => undefined }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "storage.operational",
      message: "Catalog storage is unavailable",
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain(base);
    await expect(readFile(invalidHome, "utf8")).resolves.toBe("occupied");
  });

  it("reuses a durable failed session.create diagnostic on every WebSocket retry", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-failed-create-"));
    homes.add(homeDirectory);
    const command = {
      v: 1,
      kind: "command",
      commandId: "cmd_failedCreateRetry",
      method: "session.create",
      params: { title: "Corrupt partial creation" },
    } as const;
    const sessionId = "ses_failedCreateRetry";
    const setup = new SessionStoreManager({ homeDirectory });
    await setup.ready();
    await setup.catalog.reserveGlobalCommand({
      commandId: command.commandId,
      payloadHash: await hashCommandContent(command),
      reservedSessionId: sessionId,
      reservedEventId: "evt_failedCreateRetry",
      request: { title: command.params.title, projectId: null },
      updatedAtMs: 1_000,
    });
    await setup.close();
    const databasePath = resolveStoragePath(
      homeDirectory,
      sessionDatabaseRelativePath(sessionId),
    );
    await mkdir(dirname(databasePath), { recursive: true });
    await writeFile(databasePath, "not a sqlite database");

    const fixture = await startFixture({ homeDirectory });
    const durable = await fixture.runtime.storage.catalog.getGlobalCommand(command.commandId);
    expect(durable).toMatchObject({ state: "failed", diagnosticId: expect.stringMatching(/^err_/u) });
    if (durable?.diagnosticId === null || durable?.diagnosticId === undefined) {
      throw new Error("Failed global command has no durable diagnostic ID");
    }
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "failedCreateRetry");

    client.send(command);
    const first = await client.take(
      (message): message is Extract<ServerMessage, { readonly kind: "command.rejected" }> =>
        message.kind === "command.rejected" && message.commandId === command.commandId,
    );
    client.send(command);
    const retry = await client.take(
      (message): message is Extract<ServerMessage, { readonly kind: "command.rejected" }> =>
        message.kind === "command.rejected" && message.commandId === command.commandId,
    );

    expect(first).toMatchObject({
      code: durable.failureCode,
      message: durable.failureMessage,
      diagnosticId: durable.diagnosticId,
      recoverable: false,
    });
    expect(retry).toEqual(first);
    expect(
      fixture.records
        .filter(
          (record) =>
            record.event === "websocket_command_rejected" &&
            record.commandId === command.commandId,
        )
        .map((record) => record.diagnosticId),
    ).toEqual([durable.diagnosticId, durable.diagnosticId]);
    await client.close();
  });

  it("ignores forged safe command metadata from a synchronous collaborator failure", async () => {
    const secret = "AUDIT_UNTRUSTED_SAFE_MESSAGE_SECRET";
    const fixture = await startFixture({
      runtime: {
        selectProviderConfiguration: () => {
          throw Object.assign(new Error("provider selector failed"), {
            code: "storage.corrupt",
            safeMessage: `Unexpected provider detail: ${secret}`,
            diagnosticId: "err_attackerChosenDiagnostic",
          });
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "forgedCommandMetadata");
    const created = await createSession(client, "forgedCommandMetadata");
    if (created.sessionId === undefined) throw new Error("Session creation failed");

    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_forgedCommandMetadata",
      sessionId: created.sessionId,
      method: "message.submit",
      params: { text: "Do not trust collaborator error properties." },
    });
    const rejected = await client.take(
      (message): message is Extract<ServerMessage, { readonly kind: "command.rejected" }> =>
        message.kind === "command.rejected" &&
        message.commandId === "cmd_forgedCommandMetadata",
    );

    expect(rejected).toMatchObject({
      code: "storage.worker_failed",
      message: "The storage operation could not be completed safely.",
      recoverable: true,
      diagnosticId: expect.stringMatching(/^err_/u),
    });
    expect(rejected.diagnosticId).not.toBe("err_attackerChosenDiagnostic");
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "websocket_command_rejected",
        diagnosticId: rejected.diagnosticId,
      }),
    );
    expect(JSON.stringify(client.all)).not.toContain(secret);
    expect(JSON.stringify(client.all)).not.toContain("err_attackerChosenDiagnostic");
    await client.close();
  });

  it("classifies a faulted session actor as unavailable and non-recoverable", async () => {
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "unavailableActor");
    const created = await createSession(client, "unavailableActor");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    const sessionId = created.sessionId;
    const originalRoute = fixture.runtime.commandRouter.route.bind(
      fixture.runtime.commandRouter,
    );
    fixture.runtime.commandRouter.route = async (command, clientId) => {
      if (command.commandId === "cmd_unavailableActor") {
        throw new SessionRegistryUnavailableError(
          sessionId,
          new Error("injected actor quarantine"),
        );
      }
      return originalRoute(command, clientId);
    };

    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_unavailableActor",
      sessionId,
      method: "message.submit",
      params: { text: "This command must not be retried as transient." },
    });
    const rejected = await client.take(
      (message): message is Extract<ServerMessage, { readonly kind: "command.rejected" }> =>
        message.kind === "command.rejected" &&
        message.commandId === "cmd_unavailableActor",
    );
    expect(rejected).toMatchObject({
      code: "storage.corrupt",
      message: "The requested session storage is unavailable.",
      recoverable: false,
      diagnosticId: expect.stringMatching(/^err_/u),
    });
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "websocket_command_rejected",
        diagnosticId: rejected.diagnosticId,
        code: "storage.corrupt",
      }),
    );
    await client.close();
  });

  it("rechecks catalog readiness after the command-router precheck before actor construction", async () => {
    const fixture = await startFixture();
    const created = await fixture.runtime.storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_create_statusRace",
      method: "session.create",
      params: { title: "Status race" },
    });
    const sessionId = created.session.sessionId;
    const databasePath = resolveStoragePath(fixture.homeDirectory, created.session.dbRelativePath);
    const identityBefore = await stat(databasePath);
    const headBefore = await sessionWorkers(fixture.runtime.storage).getHeadSequence(sessionId);
    const getSession = fixture.runtime.storage.catalog.getSession.bind(
      fixture.runtime.storage.catalog,
    );
    let targetReads = 0;
    const getSessionSpy = vi
      .spyOn(fixture.runtime.storage.catalog, "getSession")
      .mockImplementation(async (candidateId) => {
        const summary = await getSession(candidateId);
        if (candidateId === sessionId && targetReads === 0) {
          targetReads += 1;
          await fixture.runtime.storage.catalog.markSessionStatus({
            sessionId,
            status: "unavailable",
          });
          return summary;
        }
        return summary;
      });

    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "statusRace");
    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_statusRace",
      sessionId,
      method: "message.submit",
      params: { text: "Do not construct an actor after isolation." },
    });
    const rejected = await client.take(
      (message): message is CommandRejectedFrame =>
        message.kind === "command.rejected" && message.commandId === "cmd_statusRace",
    );
    getSessionSpy.mockRestore();

    expect(rejected).toMatchObject({
      code: "storage.corrupt",
      message: "The requested session storage is unavailable.",
      recoverable: false,
    });
    expect(targetReads).toBe(1);
    expect(fixture.runtime.actors.states().some((state) => state.sessionId === sessionId)).toBe(
      false,
    );
    expect(
      (await sessionWorkers(fixture.runtime.storage).getStats()).flatMap(
        (worker) => worker.openSessionIds,
      ),
    ).not.toContain(sessionId);
    await expect(fixture.runtime.storage.catalog.getSession(sessionId)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(sessionWorkers(fixture.runtime.storage).getHeadSequence(sessionId)).resolves.toBe(
      headBefore,
    );
    const identityAfter = await stat(databasePath);
    expect({ dev: identityAfter.dev, ino: identityAfter.ino }).toEqual({
      dev: identityBefore.dev,
      ino: identityBefore.ino,
    });
    await client.close();
  });

  it("reports an actually faulted registry actor as non-recoverable on reconnect", async () => {
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const first = await connect(fixture.server, cookie);
    await hello(first, "faultedRegistrySeed");
    const created = await createSession(first, "faultedRegistrySeed");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    const sessionId = created.sessionId;
    await first.close();

    const lease = await fixture.runtime.actors.acquire(sessionId);
    fixture.runtime.eventHub.publishCommitted({
      v: 1,
      kind: "event",
      sessionId,
      sequence: 2,
      eventId: "evt_faultedRegistryConflict",
      eventType: "run.created",
      createdAtMs: 2_000,
      data: { eventVersion: 1, runId: "run_faultedRegistryConflict" },
    });
    await lease.actor.submitMessage({
      v: 1,
      kind: "command",
      commandId: "cmd_faultedRegistryConflict",
      sessionId,
      method: "message.submit",
      params: { text: "Commit against conflicting live publication." },
    });
    lease.release();
    await expect(fixture.runtime.actors.acquire(sessionId)).rejects.toBeInstanceOf(
      SessionRegistryUnavailableError,
    );
    expect(await fixture.runtime.storage.catalog.getSession(sessionId)).toMatchObject({
      status: "ready",
    });

    const reconnect = await connect(fixture.server, cookie);
    await hello(reconnect, "faultedRegistryReconnect");
    reconnect.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_faultedRegistryReconnect",
      sessionId,
      afterSequence: 0,
    });
    const rejected = await reconnect.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" &&
        message.requestId === "req_faultedRegistryReconnect",
    );
    expect(rejected).toMatchObject({
      code: "storage.corrupt",
      message: "The requested session storage is unavailable.",
      recoverable: false,
      diagnosticId: expect.stringMatching(/^err_/u),
    });
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "websocket_subscription_setup_failed",
        diagnosticId: rejected.diagnosticId,
        sessionId,
        code: "storage.corrupt",
      }),
    );
    await reconnect.close();
  });

  it("rejects every runtime listen host except exact IPv4 loopback", async () => {
    const fixture = await startFixture();
    for (const host of ["0.0.0.0", "::", "", "localhost", "127.0.0.2"]) {
      expect(
        () =>
          new WiServer({
            runtime: fixture.runtime,
            host: host as "127.0.0.1",
            port: 0,
          }),
      ).toThrow(/host must be exactly 127\.0\.0\.1/u);
    }
  });

  it("rejects replay limits outside the bounded live and historical contract", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-invalid-replay-limit-"));
    homes.add(homeDirectory);
    const runtime = new WiRuntime({ homeDirectory });
    const constructed: WiServer[] = [];

    try {
      expect(() => {
        constructed.push(
          new WiServer({
            runtime,
            port: 0,
            gateway: {
              limits: {
                replayPageBytes: 1_023,
                replayPageSingleEventBytes: 1_023,
              },
            },
          }),
        );
      }).toThrow(/bounded storage contract/u);
      expect(
        () =>
          new WiServer({
            runtime,
            port: 0,
            gateway: {
              limits: {
                replaySingleEventBytes: 4_097,
                replayPageBytes:
                  4_096 + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
                replayPageSingleEventBytes: 4_096,
              },
            },
          }),
      ).toThrow(/must not exceed historical replay capacity/u);
      expect(
        () =>
          new WiServer({
            runtime,
            port: 0,
            gateway: {
              limits: {
                replaySingleEventBytes: 4_097,
                replayPageBytes:
                  4_096 + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
                replayPageSingleEventBytes: 4_097,
              },
            },
          }),
      ).toThrow(/bounded storage contract/u);
      expect(
        () =>
          new WiServer({
            runtime,
            port: 0,
            gateway: {
              limits: {
                outbound: {
                  maximumSingleMessageBytes: DURABLE_EVENT_ENVELOPE_RESERVE_BYTES,
                },
              },
            },
          }),
      ).toThrow(/event envelope reserve/u);
    } finally {
      const unexpectedServer = constructed[0];
      if (unexpectedServer === undefined) await runtime.close();
      else await unexpectedServer.close();
    }
  });

  it.each([1, 2])(
    "rejects frame depth %i before listener startup because wi.v1 requires depth 3",
    async (maximumDepth) => {
      const fixture = await startFixture();
      expect(
        () =>
          new WiServer({
            runtime: fixture.runtime,
            port: 0,
            gateway: { limits: { frame: { maximumDepth } } },
          }),
      ).toThrow(
        new RegExp(`frame depth.*at least ${MINIMUM_WI_V1_CLIENT_FRAME_DEPTH}`, "u"),
      );
    },
  );

  it("completes hello with one resume cursor at the minimum frame depth", async () => {
    const fixture = await startFixture({
      gateway: {
        limits: { frame: { maximumDepth: MINIMUM_WI_V1_CLIENT_FRAME_DEPTH } },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const first = await connect(fixture.server, cookie);
    await hello(first, "minimumDepthCreate");
    const created = await createSession(first, "minimumDepth");
    if (created.sessionId === undefined) throw new Error("Created session ID is missing");
    await first.close();

    const resumed = await connect(fixture.server, cookie);
    await expect(
      hello(resumed, "minimumDepthResume", [
        { sessionId: created.sessionId, afterSequence: 0 },
      ]),
    ).resolves.toMatchObject({ kind: "welcome" });
    await expect(resumed.takeKind("replay.complete")).resolves.toMatchObject({
      sessionId: created.sessionId,
    });
    await resumed.close();
  });

  it("rejects every public gateway and HTTP scalar above its server-owned cap", async () => {
    const fixture = await startFixture();
    const cases: ReadonlyArray<
      readonly [string, NonNullable<WiServerOptions["gateway"]>]
    > = [
      ["frame bytes", { limits: { frame: { maximumBytes: WEBSOCKET_LIMIT_CAPS.frame.maximumBytes + 1 } } }],
      ["frame depth", { limits: { frame: { maximumDepth: WEBSOCKET_LIMIT_CAPS.frame.maximumDepth + 1 } } }],
      ["outbound messages", { limits: { outbound: { maximumMessages: WEBSOCKET_LIMIT_CAPS.outbound.maximumMessages + 1 } } }],
      ["outbound bytes", { limits: { outbound: { maximumBytes: WEBSOCKET_LIMIT_CAPS.outbound.maximumBytes + 1 } } }],
      ["outbound single message", { limits: { outbound: { maximumSingleMessageBytes: WEBSOCKET_LIMIT_CAPS.outbound.maximumSingleMessageBytes + 1 } } }],
      ["pending inbound messages", { limits: { maximumPendingInboundMessages: WEBSOCKET_LIMIT_CAPS.maximumPendingInboundMessages + 1 } }],
      ["pending inbound bytes", { limits: { maximumPendingInboundBytes: WEBSOCKET_LIMIT_CAPS.maximumPendingInboundBytes + 1 } }],
      ["protocol violations", { limits: { maximumProtocolViolations: WEBSOCKET_LIMIT_CAPS.maximumProtocolViolations + 1 } }],
      ["subscriptions", { limits: { maximumSubscriptions: WEBSOCKET_LIMIT_CAPS.maximumSubscriptions + 1 } }],
      ["replay live events", { limits: { replayLiveEvents: WEBSOCKET_LIMIT_CAPS.replayLiveEvents + 1 } }],
      ["replay live bytes", { limits: { replayLiveBytes: WEBSOCKET_LIMIT_CAPS.replayLiveBytes + 1 } }],
      ["replay single event", { limits: { replaySingleEventBytes: WEBSOCKET_LIMIT_CAPS.replaySingleEventBytes + 1 } }],
      ["replay page events", { limits: { replayPageEvents: WEBSOCKET_LIMIT_CAPS.replayPageEvents + 1 } }],
      ["replay page bytes", { limits: { replayPageBytes: WEBSOCKET_LIMIT_CAPS.replayPageBytes + 1 } }],
      ["replay page single event", { limits: { replayPageSingleEventBytes: WEBSOCKET_LIMIT_CAPS.replayPageSingleEventBytes + 1 } }],
      ["replay queue wait", { limits: { replayQueueWaitTimeoutMs: WEBSOCKET_LIMIT_CAPS.replayQueueWaitTimeoutMs + 1 } }],
      ["heartbeat", { heartbeat: { intervalMs: WEBSOCKET_LIMIT_CAPS.heartbeatIntervalMs + 1 } }],
      ["hello timeout", { heartbeat: { helloTimeoutMs: WEBSOCKET_LIMIT_CAPS.helloTimeoutMs + 1 } }],
      ["shutdown timeout", { shutdownTimeoutMs: WEBSOCKET_LIMIT_CAPS.shutdownTimeoutMs + 1 }],
    ];

    for (const [description, gateway] of cases) {
      expect(
        () => new WiServer({ runtime: fixture.runtime, port: 0, gateway }),
        description,
      ).toThrow(/no greater than|between 10 and/u);
    }
    expect(
      () =>
        new WiServer({
          runtime: fixture.runtime,
          port: 0,
          httpShutdownTimeoutMs: MAX_HTTP_SHUTDOWN_TIMEOUT_MS + 1,
        }),
    ).toThrow(/HTTP shutdown timeout.*no greater than/u);
  });

  it("returns bounded protocol errors and keeps ordinary invalid input isolated", async () => {
    const fixture = await startFixture();
    const route = vi.spyOn(fixture.runtime.commandRouter, "route");
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);

    client.send({ v: 1, kind: "heartbeat", clientTimeMs: 1 });
    const helloRequired = await client.takeKind("protocol.error");
    expect(helloRequired.code).toBe("protocol.invalid_message");

    await hello(client, "protocol");
    const malformedSecret = "AUDIT_MALFORMED_BEARER_SECRET";
    client.socket.send(`{"authorization":"Bearer ${malformedSecret}"`);
    expect((await client.takeKind("protocol.error")).code).toBe("protocol.invalid_json");
    client.send({ v: 2, kind: "heartbeat", clientTimeMs: 1 });
    expect((await client.takeKind("protocol.error")).code).toBe("protocol.unsupported_version");
    expect((await client.waitForClose()).code).toBe(1008);
    const protocolLog = fixture.records.find(
      (record) => record.event === "websocket_protocol_error" && record.code === "protocol.invalid_json",
    );
    expect(protocolLog?.payload).toMatchObject({
      sourceUnit: "bytes",
      sourceLength: expect.any(Number),
      sampledByteLength: expect.any(Number),
      sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      truncated: expect.any(Boolean),
    });
    expect(JSON.stringify(fixture.records)).not.toContain(malformedSecret);

    const healthy = await connect(fixture.server, cookie);
    await hello(healthy, "protocolRecovery");
    healthy.send({ v: 1, kind: "heartbeat", clientTimeMs: 2 });
    expect((await healthy.takeKind("heartbeat")).kind).toBe("heartbeat");
    healthy.socket.send(`${"[".repeat(33)}0${"]".repeat(33)}`);
    expect((await healthy.takeKind("protocol.error")).code).toBe("protocol.invalid_message");
    expect((await fetch(`${fixture.server.origin}/health`)).status).toBe(200);
    await healthy.close();

    const invalidUtf8 = await connect(fixture.server, cookie);
    await hello(invalidUtf8, "invalidUtf8");
    invalidUtf8.socket.send(Buffer.from([0xc3, 0x28]), { binary: false });
    expect((await invalidUtf8.waitForClose()).code).toBe(1007);
    expect((await fetch(`${fixture.server.origin}/health`)).status).toBe(200);

    const oversized = await connect(fixture.server, cookie);
    await hello(oversized, "oversizedFrame");
    oversized.socket.send("x".repeat(64 * 1_024 + 1));
    expect((await oversized.waitForClose()).code).toBe(1009);
    expect((await fetch(`${fixture.server.origin}/health`)).status).toBe(200);

    const fragmented = await connect(fixture.server, cookie);
    await hello(fragmented, "fragmentedOversizedFrame");
    fragmented.socket.send("x".repeat(40 * 1_024), { fin: false });
    fragmented.socket.send("x".repeat(40 * 1_024), { fin: true });
    expect((await fragmented.waitForClose()).code).toBe(1009);
    expect((await fetch(`${fixture.server.origin}/health`)).status).toBe(200);
    expect(route).not.toHaveBeenCalled();
  });

  it("logs the exact diagnostic ID for ordinary in-band protocol rejections", async () => {
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    const assertLogged = (error: ProtocolErrorFrame): void => {
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "websocket_protocol_rejected",
          diagnosticId: error.diagnosticId,
          requestId: error.requestId,
          code: error.code,
          recoverable: error.recoverable,
        }),
      );
    };

    client.send({ v: 1, kind: "heartbeat", clientTimeMs: 1 });
    const preHello = await client.takeKind("protocol.error");
    assertLogged(preHello);
    await hello(client, "protocolCorrelation");
    const created = await createSession(client, "protocolCorrelation");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(client, created.sessionId, "protocolCorrelation");

    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_cursorAheadProtocolCorrelation",
      sessionId: created.sessionId,
      afterSequence: 99,
    });
    const cursorAhead = await client.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" &&
        message.requestId === "req_cursorAheadProtocolCorrelation",
    );
    assertLogged(cursorAhead);

    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_unknownProtocolCorrelation",
      sessionId: "ses_unknownProtocolCorrelation",
      afterSequence: 0,
    });
    const unknown = await client.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" &&
        message.requestId === "req_unknownProtocolCorrelation",
    );
    assertLogged(unknown);

    await client.close();
  });

  it("replays retained legacy failure events through a safe browser projection", async () => {
    const fixture = await startFixture();
    const created = await fixture.runtime.storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_create_legacyFailure",
      method: "session.create",
      params: { title: "Legacy failure" },
    });
    const sessionId = created.session.sessionId;
    const session = await fixture.runtime.storage.openSession(sessionId);
    const legacySecret = "Bearer LEGACY_REPLAY_SECRET";
    const legacyMessage = legacySecret.padEnd(700, "x");
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_legacyFailure",
          eventType: "run.failed",
          createdAtMs: 2_000,
          data: {
            eventVersion: 1,
            runId: "run_legacyFailure",
            code: "provider.protocol_error",
            message: legacyMessage,
            diagnosticId: "err_legacyFailure",
          },
        },
      ],
      projections: [],
    });
    const canonical = (await session.getEventsAfter(0)).find(
      (event) => event.eventId === "evt_legacyFailure",
    );
    if (canonical?.eventType !== "run.failed") {
      throw new Error("Legacy failure event was not retained canonically");
    }
    expect(canonical.data).toMatchObject({ eventVersion: 1, message: legacyMessage });

    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "legacyFailure");
    await subscribe(client, sessionId, "legacyFailure");
    const projected = await client.take(eventFor(sessionId, "run.failed"));
    expect(projected.data).toMatchObject({
      eventVersion: 2,
      diagnosticId: "err_legacyFailure",
    });
    expect(projected.data.message).not.toContain(legacySecret);
    expect(JSON.stringify(client.all)).not.toContain(legacySecret);
    await client.close();
  });

  it("keeps strict subscription errors while subscribe and unsubscribe retries are idempotent", async () => {
    const fixture = await startFixture({
      gateway: { limits: { maximumSubscriptions: 1 } },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "subscriptionRetries");

    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_unknownSession",
      sessionId: "ses_unknownSession",
      afterSequence: 0,
    });
    const unknown = await client.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" && message.requestId === "req_unknownSession",
    );
    expect(unknown.code).toBe("replay.unknown_session");

    const created = await createSession(client, "subscriptionRetries");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_cursorAhead",
      sessionId,
      afterSequence: 99,
    });
    const ahead = await client.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" && message.requestId === "req_cursorAhead",
    );
    expect(ahead.code).toBe("replay.cursor_ahead");
    client.send({
      v: 1,
      kind: "unsubscribe",
      requestId: "req_unsubscribeAfterReplayFailure",
      sessionId,
    });
    client.send({ v: 1, kind: "heartbeat", clientTimeMs: 0 });
    await client.takeKind("heartbeat");
    expect(
      client.all.some(
        (message) =>
          message.kind === "protocol.error" &&
          message.requestId === "req_unsubscribeAfterReplayFailure",
      ),
    ).toBe(false);
    expect(fixture.runtime.eventHub.subscriberCount(sessionId)).toBe(0);
    const failedActorLease = await fixture.runtime.actors.acquire(sessionId);
    try {
      expect(failedActorLease.actor.snapshot.subscriberCount).toBe(0);
    } finally {
      failedActorLease.release();
    }

    const subscribeRetry = {
      v: 1,
      kind: "subscribe",
      requestId: "req_subscriptionRetry",
      sessionId,
      afterSequence: 0,
    } as const;
    client.send(subscribeRetry);
    await eventually(() => {
      expect(
        client.all.filter(
          (message) =>
            message.kind === "replay.complete" &&
            message.requestId === subscribeRetry.requestId,
        ),
      ).toHaveLength(1);
    });
    // Simulate losing the first successful boundary: retry without consuming it.
    client.send(subscribeRetry);
    await eventually(() => {
      expect(
        client.all.filter(
          (message) =>
            message.kind === "replay.complete" &&
            message.requestId === subscribeRetry.requestId,
        ),
      ).toHaveLength(2);
    });
    const completedRetries = client.all.filter(
      (message): message is ReplayCompleteFrame =>
        message.kind === "replay.complete" && message.requestId === subscribeRetry.requestId,
    );
    expect(completedRetries[1]).toEqual(completedRetries[0]);
    expect(fixture.runtime.eventHub.subscriberCount(sessionId)).toBe(1);
    const actorLease = await fixture.runtime.actors.acquire(sessionId);
    try {
      expect(actorLease.actor.snapshot.subscriberCount).toBe(1);
    } finally {
      actorLease.release();
    }
    expect(fixture.server.gateway.connectionSnapshots).toEqual([
      expect.objectContaining({
        subscriptions: 1,
        protocolViolations: 0,
        replayBacklogEvents: 0,
        replayBacklogBytes: 0,
        closed: false,
      }),
    ]);

    const overflowSession = await createSession(client, "subscriptionOverflow");
    if (overflowSession.sessionId === undefined) throw new Error("Session creation failed");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_subscriptionOverflow",
      sessionId: overflowSession.sessionId,
      afterSequence: 0,
    });
    const overflow = await client.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" && message.requestId === "req_subscriptionOverflow",
    );
    expect(overflow.code).toBe("replay.subscriber_overflow");

    const unsubscribeRetry = {
      v: 1,
      kind: "unsubscribe",
      requestId: "req_unsubscribeRetry",
      sessionId,
    } as const;
    client.send(unsubscribeRetry);
    client.send({ v: 1, kind: "heartbeat", clientTimeMs: 1 });
    await client.takeKind("heartbeat");
    await eventually(() => {
      expect(fixture.server.gateway.connectionSnapshots).toEqual([
        expect.objectContaining({ pendingInboundMessages: 0 }),
      ]);
    });
    const snapshotAfterUnsubscribe = fixture.server.gateway.connectionSnapshots[0];
    if (snapshotAfterUnsubscribe === undefined) throw new Error("Connection snapshot missing");

    client.send(unsubscribeRetry);
    client.send({ v: 1, kind: "heartbeat", clientTimeMs: 2 });
    await client.takeKind("heartbeat");
    await eventually(() => {
      expect(fixture.server.gateway.connectionSnapshots).toEqual([snapshotAfterUnsubscribe]);
    });
    expect(
      client.all.some(
        (message) =>
          message.kind === "protocol.error" && message.requestId === unsubscribeRetry.requestId,
      ),
    ).toBe(false);
    expect(fixture.runtime.eventHub.subscriberCount(sessionId)).toBe(0);
    const unsubscribedActorLease = await fixture.runtime.actors.acquire(sessionId);
    try {
      expect(unsubscribedActorLease.actor.snapshot.subscriberCount).toBe(0);
    } finally {
      unsubscribedActorLease.release();
    }
    expect(snapshotAfterUnsubscribe).toEqual(
      expect.objectContaining({
        subscriptions: 0,
        protocolViolations: 0,
        replayBacklogEvents: 0,
        replayBacklogBytes: 0,
        closed: false,
      }),
    );

    const resubscribed = await subscribe(client, sessionId, "afterUnsubscribe");
    expect(resubscribed.throughSequence).toBe(1);
    await client.close();
  });

  it("replaces an in-progress subscribe without overlapping replay or leaking budget", async () => {
    let signalFirstCapture!: () => void;
    const firstCapture = new Promise<void>((resolve) => {
      signalFirstCapture = resolve;
    });
    let signalSecondCapture!: () => void;
    const secondCapture = new Promise<void>((resolve) => {
      signalSecondCapture = resolve;
    });
    let releaseFirstCapture!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstCapture = resolve;
    });
    let releaseSecondCapture!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecondCapture = resolve;
    });
    let captures = 0;
    let maximumHubSubscribers = 0;
    const fixture = await startFixture({
      gateway: {
        replayHooks: {
          afterHeadCaptured: async (sessionId) => {
            captures += 1;
            maximumHubSubscribers = Math.max(
              maximumHubSubscribers,
              fixture.runtime.eventHub.subscriberCount(sessionId),
            );
            if (captures === 1) {
              signalFirstCapture();
              await firstGate;
              return;
            }
            if (captures === 2) {
              signalSecondCapture();
              await secondGate;
            }
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "inProgressSubscribeRetry");
    const created = await createSession(client, "inProgressSubscribeRetry");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    const session = await fixture.runtime.storage.openSession(sessionId);

    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_inProgressOriginal",
      sessionId,
      afterSequence: 0,
    });
    await firstCapture;

    const duringOriginal = await session.appendTransaction({
      events: [
        {
          eventId: "evt_inProgressOriginal",
          eventType: "input.requested",
          createdAtMs: 2_000,
          data: {
            eventVersion: 1,
            runId: "run_inProgressSubscribeRetry",
            inputId: "input_inProgressOriginal",
            prompt: "Original replay?",
          },
        },
      ],
      projections: [],
    });
    const originalLive = duringOriginal.events[0];
    if (originalLive === undefined) throw new Error("Original live event did not commit");
    fixture.runtime.eventHub.publishCommitted(originalLive);
    await eventually(() => {
      expect(fixture.server.gateway.connectionSnapshots).toEqual([
        expect.objectContaining({ replayBacklogEvents: 1 }),
      ]);
    });

    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_inProgressReplacement",
      sessionId,
      afterSequence: 1,
    });
    await secondCapture;
    expect(fixture.runtime.eventHub.subscriberCount(sessionId)).toBe(1);
    expect(fixture.server.gateway.connectionSnapshots).toEqual([
      expect.objectContaining({
        subscriptions: 1,
        protocolViolations: 0,
        replayBacklogEvents: 0,
        replayBacklogBytes: 0,
        replayHistoricalPages: 0,
        closed: false,
      }),
    ]);
    releaseFirstCapture();

    const duringReplacement = await session.appendTransaction({
      events: [
        {
          eventId: "evt_inProgressReplacement",
          eventType: "input.requested",
          createdAtMs: 2_001,
          data: {
            eventVersion: 1,
            runId: "run_inProgressSubscribeRetry",
            inputId: "input_inProgressReplacement",
            prompt: "Replacement replay?",
          },
        },
      ],
      projections: [],
    });
    const replacementLive = duringReplacement.events[0];
    if (replacementLive === undefined) throw new Error("Replacement live event did not commit");
    fixture.runtime.eventHub.publishCommitted(replacementLive);
    await eventually(() => {
      expect(fixture.server.gateway.connectionSnapshots).toEqual([
        expect.objectContaining({ replayBacklogEvents: 1 }),
      ]);
    });
    releaseSecondCapture();

    const complete = await client.take(
      (message): message is ReplayCompleteFrame =>
        message.kind === "replay.complete" &&
        message.requestId === "req_inProgressReplacement",
    );
    expect(complete.throughSequence).toBe(2);
    await client.take(
      (message): message is EventFrame =>
        message.kind === "event" &&
        message.sessionId === sessionId &&
        message.sequence === 3,
    );
    const delivered = client.all
      .filter(eventFor(sessionId))
      .map((message) => message.sequence);
    expect(delivered).toEqual([2, 3]);
    expect(
      client.all.some(
        (message) =>
          message.kind === "replay.complete" &&
          message.requestId === "req_inProgressOriginal",
      ),
    ).toBe(false);
    expect(maximumHubSubscribers).toBe(1);
    expect(fixture.runtime.eventHub.subscriberCount(sessionId)).toBe(1);
    const actorLease = await fixture.runtime.actors.acquire(sessionId);
    try {
      expect(actorLease.actor.snapshot.subscriberCount).toBe(1);
    } finally {
      actorLease.release();
    }
    expect(fixture.server.gateway.connectionSnapshots).toEqual([
      expect.objectContaining({
        subscriptions: 1,
        protocolViolations: 0,
        replayBacklogEvents: 0,
        replayBacklogBytes: 0,
        replayHistoricalPages: 0,
        closed: false,
      }),
    ]);
    await client.close();
  });

  it("reports conflicting replay history as non-recoverable at the gateway", async () => {
    let historical: SessionEvent | null = null;
    let publishedConflict = false;
    const fixture = await startFixture({
      gateway: {
        replayHooks: {
          afterHeadCaptured: (sessionId, throughSequence) => {
            if (
              historical === null ||
              historical.sessionId !== sessionId ||
              historical.sequence > throughSequence ||
              publishedConflict
            ) {
              return;
            }
            publishedConflict = true;
            fixture.runtime.eventHub.publishCommitted({
              ...historical,
              eventId: "evt_conflictingHistory",
            });
          },
        },
      },
    });
    const created = await fixture.runtime.storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_create_conflictingHistory",
      method: "session.create",
      params: { title: "Conflicting history" },
    });
    historical = created.events[0] ?? null;
    if (historical === null) throw new Error("Session creation returned no event");

    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "conflictingHistory");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_conflictingHistory",
      sessionId: created.session.sessionId,
      afterSequence: 0,
    });
    const conflict = await client.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" && message.requestId === "req_conflictingHistory",
    );
    expect(conflict).toMatchObject({
      code: "replay.sequence_conflict",
      recoverable: false,
    });
    expect(client.all.filter(eventFor(created.session.sessionId))).toHaveLength(0);
    await client.close();
  });

  it("completes the fake-provider tool workflow and acknowledges only durable commands", async () => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "echo-tool-round-trip" },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "workflow");

    const created = await createSession(client, "workflow");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation returned no session ID");
    expect(created.acceptedSequence).toBe(1);
    expect((await subscribe(client, sessionId, "workflow")).throughSequence).toBe(1);
    const replayedCreated = await client.take(eventFor(sessionId, "session.created"));
    expect(replayedCreated.sequence).toBe(1);

    const accepted = await submitMessage(client, sessionId, "workflow");
    expect(accepted.acceptedSequence).toBeGreaterThanOrEqual(3);
    const runId = accepted.runId;
    if (runId === undefined) throw new Error("Message command returned no run ID");
    const completed = await client.take(eventFor(sessionId, "run.completed"));
    expect(completed.data.runId).toBe(runId);

    const session = await fixture.runtime.storage.openSession(sessionId);
    const durable = await session.getAcceptedCommand("cmd_submit_workflow");
    expect(durable?.runId).toBe(runId);
    expect(durable?.acceptedSequence).toBe(3);
    const tools = await session.getToolExecutionsForRun(runId);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.state).toBe("completed");

    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_create_workflow",
      method: "session.create",
      params: { title: "Session workflow" },
    });
    const duplicateCreate = await client.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_create_workflow",
    );
    expect(duplicateCreate).toMatchObject({
      sessionId,
      acceptedSequence: 1,
      duplicate: true,
    });
    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_create_workflow",
      method: "session.create",
      params: { title: "Conflicting title" },
    });
    const conflict = await client.take(
      (message): message is Extract<ServerMessage, { readonly kind: "command.rejected" }> =>
        message.kind === "command.rejected" && message.commandId === "cmd_create_workflow",
    );
    expect(conflict.code).toBe("protocol.command_id_conflict");
    await client.close();
  });

  it.each([
    ["thrown", () => new ThrowingSecretProvider()],
    ["reported", () => new ReportedSecretProvider()],
  ] as const)(
    "keeps %s provider failure details out of durable events and correlates redacted logs",
    async (kind, createProvider) => {
      const fixture = await startFixture({ runtime: { provider: createProvider() } });
      const { cookie } = await bootstrap(fixture.server);
      const client = await connect(fixture.server, cookie);
      await hello(client, `providerFailure_${kind}`);
      const created = await createSession(client, `providerFailure_${kind}`);
      if (created.sessionId === undefined) throw new Error("Session creation failed");
      await subscribe(client, created.sessionId, `providerFailure_${kind}`);
      const accepted = await submitMessage(
        client,
        created.sessionId,
        `providerFailure_${kind}`,
      );
      if (accepted.runId === undefined) throw new Error("Message command returned no run ID");

      const stepFailed = await client.take(
        eventFor(created.sessionId, "provider.step.failed"),
      );
      const runFailed = await client.take(eventFor(created.sessionId, "run.failed"));
      expect(stepFailed.data.diagnosticId).toBe(runFailed.data.diagnosticId);
      expect(stepFailed.data.message).toBe("The provider returned an invalid response.");
      expect(runFailed.data.message).toBe(stepFailed.data.message);
      expect(runFailed.data.message.length).toBeLessThanOrEqual(
        SAFE_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
      );

      const diagnostic = fixture.records.find(
        (record) =>
          record.event === "provider_operation_failed" &&
          record.diagnosticId === stepFailed.data.diagnosticId,
      );
      expect(diagnostic).toMatchObject({
        sessionId: created.sessionId,
        runId: accepted.runId,
        stepId: stepFailed.data.stepId,
        providerId: "fake",
        code: "provider.protocol_error",
        error:
          kind === "thrown"
            ? {
                type: "error",
                message: {
                  sampledByteLength: 4_096,
                  sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
                  truncated: true,
                },
              }
            : { type: "string" },
      });

      const session = await fixture.runtime.storage.openSession(created.sessionId);
      const run = await session.getRun(accepted.runId);
      expect(run?.failureMessage).toBe(stepFailed.data.message);
      expect(JSON.stringify(await session.getEventsAfter(0))).not.toContain(PROVIDER_SECRET);
      expect(JSON.stringify(fixture.records)).not.toContain(PROVIDER_SECRET);
      expect(JSON.stringify(client.all)).not.toContain(PROVIDER_SECRET);
      await client.close();
    },
  );

  it("correlates pure tool failures with one redacted server diagnostic", async () => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "echo-tool-round-trip" },
      runtime: { toolRegistry: failingEchoRegistry("pure") },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "toolFailure");
    const created = await createSession(client, "toolFailure");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(client, created.sessionId, "toolFailure");
    const accepted = await submitMessage(client, created.sessionId, "toolFailure");
    if (accepted.runId === undefined) throw new Error("Message command returned no run ID");

    const failed = await client.take(eventFor(created.sessionId, "tool.execution.failed"));
    await client.take(eventFor(created.sessionId, "run.completed"));
    const session = await fixture.runtime.storage.openSession(created.sessionId);
    const tool = await session.getToolExecution(failed.data.callId);
    expect(tool).not.toBeNull();
    const diagnostic = fixture.records.find(
      (record) =>
        record.event === "tool_operation_failed" &&
        record.diagnosticId === failed.data.diagnosticId,
    );
    expect(diagnostic).toMatchObject({
      sessionId: created.sessionId,
      runId: accepted.runId,
      stepId: tool?.stepId,
      callId: failed.data.callId,
      toolName: "echo",
      state: "failed",
      code: "tool.execution_failed",
      error: {
        type: "error",
        message: {
          sampledByteLength: 4_096,
          sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          truncated: true,
        },
      },
    });
    expect(JSON.stringify(fixture.records)).not.toContain(TOOL_SECRET);
    expect(JSON.stringify(await session.getEventsAfter(0))).not.toContain(TOOL_SECRET);
    expect(JSON.stringify(client.all)).not.toContain(TOOL_SECRET);
    await client.close();
  });

  it("reuses an unknown tool-outcome diagnostic for the interrupted run", async () => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "echo-tool-round-trip" },
      runtime: { toolRegistry: failingEchoRegistry("idempotent_external") },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "toolUnknown");
    const created = await createSession(client, "toolUnknown");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(client, created.sessionId, "toolUnknown");
    await submitMessage(client, created.sessionId, "toolUnknown");

    const unknown = await client.take(
      eventFor(created.sessionId, "tool.execution.outcome_unknown"),
    );
    const interrupted = await client.take(eventFor(created.sessionId, "run.interrupted"));
    expect(interrupted.data.diagnosticId).toBe(unknown.data.diagnosticId);
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "tool_operation_failed",
        diagnosticId: unknown.data.diagnosticId,
        callId: unknown.data.callId,
        state: "interrupted",
        code: "tool.outcome_unknown",
      }),
    );
    expect(JSON.stringify(fixture.records)).not.toContain(TOOL_SECRET);
    await client.close();
  });

  it.each([
    ["unknown", "unknown"],
    ["invalid", "invalid_echo"],
  ] as const)("correlates %s tool validation failures with server diagnostics", async (kind, roundTripTool) => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "echo-tool-round-trip", roundTripTool },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, `toolValidation_${kind}`);
    const created = await createSession(client, `toolValidation_${kind}`);
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(client, created.sessionId, `toolValidation_${kind}`);
    const accepted = await submitMessage(client, created.sessionId, `toolValidation_${kind}`);
    if (accepted.runId === undefined) throw new Error("Message command returned no run ID");

    const failed = await client.take(eventFor(created.sessionId, "tool.execution.failed"));
    await client.take(eventFor(created.sessionId, "run.completed"));
    const session = await fixture.runtime.storage.openSession(created.sessionId);
    const tool = await session.getToolExecution(failed.data.callId);
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "tool_operation_failed",
        diagnosticId: failed.data.diagnosticId,
        sessionId: created.sessionId,
        runId: accepted.runId,
        stepId: tool?.stepId,
        callId: failed.data.callId,
        toolName: tool?.toolName,
        state: "failed",
        code: kind === "unknown" ? "tool.unknown" : "tool.invalid_arguments",
      }),
    );
    await client.close();
  });

  it("correlates approval denial with its durable tool failure", async () => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "approval-round-trip" },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "approvalDenialDiagnostic");
    const created = await createSession(client, "approvalDenialDiagnostic");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(client, created.sessionId, "approvalDenialDiagnostic");
    const accepted = await submitMessage(client, created.sessionId, "approvalDenialDiagnostic");
    if (accepted.runId === undefined) throw new Error("Message command returned no run ID");
    const requested = await client.take(
      eventFor(created.sessionId, "tool.approval.requested"),
    );
    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_deny_diagnostic",
      sessionId: created.sessionId,
      method: "approval.resolve",
      params: { approvalId: requested.data.approvalId, resolution: "denied" },
    });
    await client.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_deny_diagnostic",
    );
    const failed = await client.take(eventFor(created.sessionId, "tool.execution.failed"));
    await client.take(eventFor(created.sessionId, "run.completed"));
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "tool_operation_failed",
        diagnosticId: failed.data.diagnosticId,
        sessionId: created.sessionId,
        runId: accepted.runId,
        callId: failed.data.callId,
        toolName: "guarded_echo",
        state: "failed",
        code: "tool.approval_denied",
      }),
    );
    await client.close();
  });

  it("correlates restart recovery events with one redacted server diagnostic", async () => {
    const fixture = await startFixture();
    const created = await fixture.runtime.storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_create_recoveryDiagnostic",
      method: "session.create",
      params: { title: "Recovery diagnostic" },
    });
    const sessionId = created.session.sessionId;
    const runId = "run_recoveryDiagnostic";
    const stepId = "step_recoveryDiagnostic";
    const session = await fixture.runtime.storage.openSession(sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_recoveryDiagnosticRunCreated",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId },
        },
        {
          eventId: "evt_recoveryDiagnosticRunStarted",
          eventType: "run.started",
          createdAtMs: 2_001,
          data: { eventVersion: 1, runId },
        },
        {
          eventId: "evt_recoveryDiagnosticStepStarted",
          eventType: "provider.step.started",
          createdAtMs: 2_002,
          data: { eventVersion: 1, runId, stepId, stepIndex: 0 },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId,
          state: "running",
          providerId: "fake",
          providerConfig: { scenario: "plain-text" },
          createdAtMs: 2_000,
          startedAtMs: 2_001,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: stepId,
        },
        {
          kind: "providerStep.put",
          stepId,
          runId,
          stepIndex: 0,
          state: "streaming",
          startedAtMs: 2_002,
          completedAtMs: null,
          responseId: null,
          errorCategory: null,
          errorMessage: null,
        },
      ],
    });

    const lease = await fixture.runtime.actors.acquire(sessionId);
    lease.release();
    const events = await session.getEventsAfter(0);
    const stepFailure = events.find(
      (event) => event.eventType === "provider.step.interrupted",
    );
    const runFailure = events.find((event) => event.eventType === "run.interrupted");
    if (stepFailure?.eventType !== "provider.step.interrupted") {
      throw new Error("Recovery did not interrupt the provider step");
    }
    if (runFailure?.eventType !== "run.interrupted") {
      throw new Error("Recovery did not interrupt the run");
    }
    expect(stepFailure.data.eventVersion).toBe(2);
    expect(runFailure.data).toMatchObject({
      eventVersion: 2,
      diagnosticId: stepFailure.data.diagnosticId,
    });
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "session_recovery_interrupted",
        diagnosticId: stepFailure.data.diagnosticId,
        sessionId,
        runId,
        stepIds: [stepId],
        callIds: [],
        code: "provider.incomplete",
      }),
    );
  });

  it("logs session worker failures and replacement with bounded identifiers", async () => {
    const fixture = await startFixture({
      runtime: { storage: { sessionWorkers: { allowTestOperations: true, size: 1 } } },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "storageDiagnostic");
    const created = await createSession(client, "storageDiagnostic");
    if (created.sessionId === undefined) throw new Error("Session creation failed");

    await expect(
      sessionWorkers(fixture.runtime.storage).malformedResponseForTest(created.sessionId),
    ).rejects.toBeDefined();
    await eventually(() => {
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "storage_session_operation_failed",
          sessionId: created.sessionId,
          diagnosticId: expect.stringMatching(/^err_/u),
        }),
      );
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "storage_worker_replaced",
          workerId: "session-0",
          replacementCount: 1,
        }),
      );
    });
    await client.close();
  });

  it("multiplexes two sessions over one socket", async () => {
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "multiplex");
    const first = await createSession(client, "multiA");
    const second = await createSession(client, "multiB");
    if (first.sessionId === undefined || second.sessionId === undefined) {
      throw new Error("Session creation failed");
    }
    await subscribe(client, first.sessionId, "multiA");
    await subscribe(client, second.sessionId, "multiB");
    await submitMessage(client, first.sessionId, "multiA");
    await submitMessage(client, second.sessionId, "multiB");
    await client.take(eventFor(first.sessionId, "run.completed"));
    await client.take(eventFor(second.sessionId, "run.completed"));
    expect(new Set(client.all.filter((message) => message.kind === "event").map((event) => event.sessionId))).toEqual(
      new Set([first.sessionId, second.sessionId]),
    );
    await client.close();
  });

  it("fans one session out to two sockets and reflects approval resolution to both", async () => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "approval-round-trip" },
    });
    const firstBootstrap = await bootstrap(fixture.server);
    const first = await connect(fixture.server, firstBootstrap.cookie);
    const second = await connect(fixture.server, firstBootstrap.cookie);
    await hello(first, "approvalA");
    await hello(second, "approvalB");
    const created = await createSession(first, "approval");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(first, created.sessionId, "approvalA");
    await subscribe(second, created.sessionId, "approvalB");

    await submitMessage(first, created.sessionId, "approval");
    const requestedA = await first.take(eventFor(created.sessionId, "tool.approval.requested"));
    const requestedB = await second.take(eventFor(created.sessionId, "tool.approval.requested"));
    expect(requestedB.data.approvalId).toBe(requestedA.data.approvalId);
    second.send({
      v: 1,
      kind: "command",
      commandId: "cmd_approve_shared",
      sessionId: created.sessionId,
      method: "approval.resolve",
      params: { approvalId: requestedA.data.approvalId, resolution: "approved" },
    });
    const approved = await second.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_approve_shared",
    );
    expect(approved.duplicate).toBe(false);
    await first.take(eventFor(created.sessionId, "tool.approval.resolved"));
    await second.take(eventFor(created.sessionId, "tool.approval.resolved"));
    await first.take(eventFor(created.sessionId, "run.completed"));
    await second.take(eventFor(created.sessionId, "run.completed"));
    await first.close();
    await second.close();
  });

  it("resumes a restored pending input after commit and fans the transition to two sockets", async () => {
    const fixture = await startFixture();
    const created = await fixture.runtime.storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_createSharedInput",
      method: "session.create",
      params: { title: "Shared pending input" },
    });
    const sessionId = created.session.sessionId;
    const session = await fixture.runtime.storage.openSession(sessionId);
    await session.appendTransaction({
      events: [
        {
          eventId: "evt_sharedInputRun",
          eventType: "run.created",
          createdAtMs: 2_000,
          data: { eventVersion: 1, runId: "run_sharedInput" },
        },
        {
          eventId: "evt_sharedInputRequested",
          eventType: "input.requested",
          createdAtMs: 2_001,
          data: {
            eventVersion: 1,
            runId: "run_sharedInput",
            inputId: "input_sharedInput",
            prompt: "Continue?",
          },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_sharedInput",
          state: "waiting_for_user",
          providerId: "fake",
          providerConfig: { scenario: "provider-never-completes-until-aborted" },
          createdAtMs: 2_000,
          startedAtMs: 2_000,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        {
          kind: "input.put",
          inputId: "input_sharedInput",
          runId: "run_sharedInput",
          state: "pending",
          prompt: "Continue?",
          requestedAtMs: 2_001,
        },
      ],
    });

    const { cookie } = await bootstrap(fixture.server);
    const first = await connect(fixture.server, cookie);
    const second = await connect(fixture.server, cookie);
    await hello(first, "inputA");
    await hello(second, "inputB");
    await subscribe(first, sessionId, "inputA");
    await subscribe(second, sessionId, "inputB");
    expect(fixture.runtime.provider.requests).toHaveLength(0);

    const command = {
      v: 1 as const,
      kind: "command" as const,
      commandId: "cmd_respondSharedInput",
      sessionId,
      method: "input.respond" as const,
      params: { inputId: "input_sharedInput", value: { answer: "yes" } },
    };
    second.send(command);
    const accepted = await second.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === command.commandId,
    );
    expect(accepted.duplicate).toBe(false);
    for (const client of [first, second]) {
      await client.take(eventFor(sessionId, "input.resolved"));
      await client.take(eventFor(sessionId, "run.started"));
    }
    await eventually(async () => {
      expect(await session.getRun("run_sharedInput")).toMatchObject({ state: "running" });
      expect(fixture.runtime.provider.requests).toHaveLength(1);
    });

    second.send(command);
    const duplicate = await second.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === command.commandId,
    );
    expect(duplicate).toMatchObject({ duplicate: true, runId: "run_sharedInput" });
    const durable = await session.getEventsAfter(0);
    expect(durable.filter((event) => event.eventType === "input.resolved")).toHaveLength(1);
    expect(
      durable.filter(
        (event) => event.eventType === "run.started" && event.data.runId === "run_sharedInput",
      ),
    ).toHaveLength(1);
    await first.close();
    await second.close();
  });

  it("keeps approval pending after the last subscriber closes and replays it exactly", async () => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "approval-round-trip" },
    });
    const { cookie } = await bootstrap(fixture.server);
    const first = await connect(fixture.server, cookie);
    await hello(first, "pendingApprovalFirst");
    const created = await createSession(first, "pendingApprovalReconnect");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(first, sessionId, "pendingApprovalFirst");
    const accepted = await submitMessage(first, sessionId, "pendingApprovalReconnect");
    const runId = accepted.runId;
    if (runId === undefined) throw new Error("Message command returned no run ID");
    const requested = await first.take(eventFor(sessionId, "tool.approval.requested"));
    await first.close();

    const session = await fixture.runtime.storage.openSession(sessionId);
    expect((await session.getRun(runId))?.state).toBe("waiting_for_user");
    expect(await session.getPendingApprovals()).toHaveLength(1);
    const expected = await session.getEventsAfter(0);

    const second = await connect(fixture.server, cookie);
    await hello(second, "pendingApprovalSecond");
    await subscribe(second, sessionId, "pendingApprovalSecond");
    expect(second.all.filter(eventFor(sessionId)).map((event) => event.sequence)).toEqual(
      expected.map((event) => event.sequence),
    );
    expect(
      second.all.filter(eventFor(sessionId, "tool.approval.requested")),
    ).toHaveLength(1);
    expect(second.all.filter(eventFor(sessionId, "run.cancel.requested"))).toHaveLength(0);

    second.send({
      v: 1,
      kind: "command",
      commandId: "cmd_approve_reconnected",
      sessionId,
      method: "approval.resolve",
      params: { approvalId: requested.data.approvalId, resolution: "approved" },
    });
    await second.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_approve_reconnected",
    );
    await second.take(eventFor(sessionId, "run.completed"));
    await second.close();
  });

  it("routes run.cancel over WebSocket and commits one cancellation", async () => {
    const provider = new FakeProviderAdapter();
    const fixture = await startFixture({
      providerConfiguration: { scenario: "cancel-before-output" },
      runtime: { provider },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "runCancel");
    const created = await createSession(client, "runCancel");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation did not return a session ID");
    await subscribe(client, sessionId, "runCancel");
    const submitted = await submitMessage(client, sessionId, "runCancel");
    const runId = submitted.runId;
    if (runId === null || runId === undefined) {
      throw new Error("Message submission did not return a run ID");
    }
    await provider.controller.waitUntilBlocked(fakeProviderGateLabel(runId, "before-output"));

    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_cancel_runCancel",
      sessionId,
      method: "run.cancel",
      params: { runId },
    });
    const accepted = await client.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_cancel_runCancel",
    );
    expect(accepted.runId).toBe(runId);
    expect((await client.take(eventFor(sessionId, "run.cancel.requested"))).data.runId).toBe(runId);
    expect((await client.take(eventFor(sessionId, "run.cancelled"))).data.runId).toBe(runId);

    const session = await fixture.runtime.storage.openSession(sessionId);
    const events = await session.getEventsAfter(0);
    expect(
      events.filter(
        (event) => event.eventType === "run.cancel.requested" && event.data.runId === runId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === "run.cancelled" && event.data.runId === runId),
    ).toHaveLength(1);
    await client.close();
  });

  it("keeps a run alive across disconnect and reconstructs the exact suffix on reconnect", async () => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "slow-stream" },
    });
    const { cookie } = await bootstrap(fixture.server);
    const first = await connect(fixture.server, cookie);
    await hello(first, "disconnectA");
    const created = await createSession(first, "disconnect");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(first, created.sessionId, "disconnectA");
    const accepted = await submitMessage(first, created.sessionId, "disconnect");
    const runId = accepted.runId;
    if (runId === undefined) throw new Error("Message command returned no run ID");
    const visible = await first.take(eventFor(created.sessionId, "provider.text.delta"));
    const cursor = visible.sequence;
    await fixture.runtime.provider.controller.waitUntilBlocked(
      fakeProviderGateLabel(runId, "slow"),
    );
    await first.close();

    const session = await fixture.runtime.storage.openSession(created.sessionId);
    expect((await session.getRun(runId))?.state).toBe("running");
    fixture.runtime.provider.controller.release(fakeProviderGateLabel(runId, "slow"));
    await eventually(async () => {
      expect((await session.getRun(runId))?.state).toBe("completed");
    });
    const expectedSuffix = await session.getEventsAfter(cursor);
    expect(expectedSuffix.some((event) => event.eventType === "run.cancel.requested")).toBe(false);

    const second = await connect(fixture.server, cookie);
    await hello(second, "disconnectB", [
      { sessionId: created.sessionId, afterSequence: cursor },
    ]);
    const replayComplete = await second.take(
      (message): message is ReplayCompleteFrame =>
        message.kind === "replay.complete" && message.sessionId === created.sessionId,
    );
    expect(replayComplete.throughSequence).toBe(expectedSuffix.at(-1)?.sequence ?? cursor);
    for (const expected of expectedSuffix) {
      const replayed = await second.take(
        (message): message is EventFrame =>
          message.kind === "event" &&
          message.sessionId === created.sessionId &&
          message.sequence === expected.sequence,
      );
      expect(replayed.eventId).toBe(expected.eventId);
    }

    second.send({
      v: 1,
      kind: "command",
      commandId: "cmd_submit_disconnect",
      sessionId: created.sessionId,
      method: "message.submit",
      params: { text: "Run the explicit fake scenario." },
    });
    const duplicate = await second.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_submit_disconnect",
    );
    expect(duplicate).toMatchObject({ duplicate: true, runId });
    expect(
      (await session.getEventsAfter(0)).filter(
        (event) => event.eventType === "user.message.appended",
      ),
    ).toHaveLength(1);
    await second.close();
  });

  it("accepts a retry exactly once when the first socket closes before sending the command", async () => {
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const first = await connect(fixture.server, cookie);
    await hello(first, "lostAckBeforeServerFirst");
    const created = await createSession(first, "lostAckBeforeServer");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    const command = {
      v: 1,
      kind: "command",
      commandId: "cmd_submit_lostAck_beforeServer",
      sessionId,
      method: "message.submit",
      params: { text: "Send this command only after reconnecting." },
    } as const;
    await first.close();

    const session = await fixture.runtime.storage.openSession(sessionId);
    await expect(session.getAcceptedCommand(command.commandId)).resolves.toBeNull();
    const retry = await connect(fixture.server, cookie);
    await hello(retry, "lostAckBeforeServerRetry");
    retry.send(command);
    const accepted = await retry.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === command.commandId,
    );
    expect(accepted.duplicate).toBe(false);
    await eventually(async () => {
      const events = await session.getEventsAfter(0);
      expect(
        events.filter((event) => event.eventType === "user.message.appended"),
      ).toHaveLength(1);
      expect(events.some((event) => event.eventType === "run.completed")).toBe(true);
    });
    await retry.close();
  });

  it("registers queued recovery ingress before an earlier command drains", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-recovery-ingress-"));
    const stateHome = `${homeDirectory}-state`;
    homes.add(stateHome);
    const roots = await initializeCredentialRoots({ wiHome: homeDirectory, xdgStateHome: stateHome });
    await new FileCredentialStore(roots.credentialRoot).put(
      "credref_queuedRecoveryIngress",
      new StoredCredential({
        version: 1,
        envelopeId: "envl_queuedRecoveryIngress",
        connectionId: "pconn_queuedRecoveryIngress",
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 1,
        updatedAtMs: 1,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: "queued-recovery-key" },
      }),
    );
    let entered!: () => void;
    const firstCommandEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await startFixture({
      homeDirectory,
      runtime: {
        credentialRoots: {
          credentialRoot: roots.credentialRoot,
          stagingRoot: roots.stagingRoot,
        },
      },
      gateway: {
        commandHooks: {
          beforeRoute: async (command) => {
            if (command.commandId !== "cmd_blockRecoveryIngress") return;
            entered();
            await gate;
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const socket = await connect(fixture.server, cookie);
    await hello(socket, "recoveryIngressQueue");
    socket.send({
      v: 1,
      kind: "command",
      commandId: "cmd_blockRecoveryIngress",
      method: "providerConnection.environment.create",
      params: {
        providerId: "openai_platform",
        authMode: "api_key",
        displayName: "Blocking command",
        variableName: "WI_RECOVERY_INGRESS_BLOCK",
      },
    });
    await firstCommandEntered;
    const scan = await fixture.runtime.providerConnections.startRecoveryScan();
    const candidate = scan.candidates[0]!;
    const recoveryExpectedSafeMetadata = {
      expected: {
        providerId: candidate.providerId,
        authMode: candidate.authMode,
        originalConnectionId: candidate.originalConnectionId,
        generation: candidate.generation,
        identity: candidate.identity,
        updatedAtMs: candidate.updatedAtMs,
      },
      displayName: "Queued recovery",
    };
    socket.send({
      v: 1,
      kind: "command",
      commandId: "cmd_queuedRecoveryIngress",
      method: "providerConnection.recover",
      params: {
        recoveryRef: candidate.recoveryRef,
        recoveryEpochId: scan.recoveryEpochId,
        expected: recoveryExpectedSafeMetadata.expected,
        displayName: recoveryExpectedSafeMetadata.displayName,
      },
    });

    await eventually(async () => {
      await expect(fixture.runtime.providerConnections.recoveryCommandStatus(
        "cmd_queuedRecoveryIngress",
        scan.recoveryEpochId,
        recoveryExpectedSafeMetadata,
      )).resolves.toMatchObject({ status: "admitting" });
    });
    const recoveryStatusUrl = `${fixture.server.origin}/api/provider-connections/recovery-commands/cmd_queuedRecoveryIngress/${scan.recoveryEpochId}`;
    await expect(fetch(recoveryStatusUrl, { headers: { cookie } })).resolves.toMatchObject({
      status: 400,
    });
    const recoveryHeaders = {
      cookie,
      "x-wi-recovery-operation-kind": "credential_recovery",
      "x-wi-recovery-expected-metadata": Buffer.from(
        JSON.stringify(recoveryExpectedSafeMetadata),
      ).toString("base64"),
    };
    await expect(fetch(recoveryStatusUrl, { headers: recoveryHeaders }).then(
      async (response) => response.json(),
    )).resolves.toMatchObject({ status: "admitting" });
    await expect(fetch(recoveryStatusUrl, {
      headers: {
        ...recoveryHeaders,
        "x-wi-recovery-expected-metadata": Buffer.from(JSON.stringify({
          ...recoveryExpectedSafeMetadata,
          displayName: "Wrong local metadata",
        })).toString("base64"),
      },
    }).then(async (response) => response.json())).resolves.toMatchObject({
      status: "conflict",
      failureCode: "protocol.command_id_conflict",
    });
    release();
    await socket.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" &&
        message.commandId === "cmd_blockRecoveryIngress",
    );
    await socket.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" &&
        message.commandId === "cmd_queuedRecoveryIngress",
    );
    await expect(fixture.runtime.providerConnections.recoveryCommandStatus(
      "cmd_queuedRecoveryIngress",
      scan.recoveryEpochId,
      recoveryExpectedSafeMetadata,
    )).resolves.toMatchObject({ status: "succeeded" });
    await socket.close();
  });

  it("enforces one aggregate recovery-ingress budget across authenticated WebSockets and direct routes", async () => {
    process.env.NODE_ENV = "test";
    process.env.WI_ALLOW_TEST_FAILPOINTS = "1";
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-recovery-ingress-aggregate-"));
    const stateHome = `${homeDirectory}-state`;
    homes.add(stateHome);
    const roots = await initializeCredentialRoots({ wiHome: homeDirectory, xdgStateHome: stateHome });
    const store = new FileCredentialStore(roots.credentialRoot);
    for (const [ref, connectionId, envelopeId] of [
      ["credref_aggregateA", "pconn_aggregateA", "envl_aggregateA"],
      ["credref_aggregateB", "pconn_aggregateB", "envl_aggregateB"],
    ] as const) {
      await store.put(ref, new StoredCredential({
        version: 1,
        envelopeId,
        connectionId,
        providerId: "openai_platform",
        authMode: "api_key",
        generation: 1,
        updatedAtMs: 1,
        identity: { status: "unverified" },
        credential: { type: "api_key", apiKey: `${ref}-secret` },
      }));
    }
    let preparedCount = 0;
    let markPrepared!: () => void;
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
    let releasePrepared!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepared = resolve; });
    const fixture = await startFixture({
      homeDirectory,
      runtime: {
        credentialRoots: {
          credentialRoot: roots.credentialRoot,
          stagingRoot: roots.stagingRoot,
        },
        providerConnectionFixture: {
          provider: new FakeProviderAdapter({ id: "openai_platform" }),
          capabilitiesForConnection: () => null,
          recoveryIngressBudget: { maximumFrames: 2, maximumBytes: 512 * 1_024 },
          afterRecoveryPrepare: async () => {
            preparedCount += 1;
            if (preparedCount === 2) markPrepared();
            await prepareGate;
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const first = await connect(fixture.server, cookie);
    const second = await connect(fixture.server, cookie);
    await hello(first, "aggregateIngressFirst");
    await hello(second, "aggregateIngressSecond");
    const scan = await fixture.runtime.providerConnections.startRecoveryScan();
    expect(scan.candidates).toHaveLength(2);
    const duplicateCandidate = scan.candidates[0]!;
    const duplicateExpected = {
      expected: {
        providerId: duplicateCandidate.providerId,
        authMode: duplicateCandidate.authMode,
        originalConnectionId: duplicateCandidate.originalConnectionId,
        generation: duplicateCandidate.generation,
        identity: duplicateCandidate.identity,
        updatedAtMs: duplicateCandidate.updatedAtMs,
      },
      displayName: "Duplicate budget probe",
    };
    const duplicateFirst = fixture.runtime.providerConnections.registerRecoveryIngress(
      "cmd_duplicateBudget",
      scan.recoveryEpochId,
      duplicateExpected,
      10,
    );
    const duplicateSecond = fixture.runtime.providerConnections.registerRecoveryIngress(
      "cmd_duplicateBudget",
      scan.recoveryEpochId,
      duplicateExpected,
      20,
    );
    expect(fixture.runtime.providerConnections.recoveryIngressSnapshot).toMatchObject({
      pendingFrames: 2,
      pendingBytes: 30,
    });
    duplicateFirst.release();
    duplicateFirst.release();
    duplicateSecond.release();
    expect(fixture.runtime.providerConnections.recoveryIngressSnapshot).toMatchObject({
      pendingFrames: 0,
      pendingBytes: 0,
    });
    const commandFor = (
      commandId: string,
      candidate: typeof scan.candidates[number],
    ) => ({
      v: 1 as const,
      kind: "command" as const,
      commandId,
      method: "providerConnection.recover" as const,
      params: {
        recoveryRef: candidate.recoveryRef,
        recoveryEpochId: scan.recoveryEpochId,
        expected: {
          providerId: candidate.providerId,
          authMode: candidate.authMode,
          originalConnectionId: candidate.originalConnectionId,
          generation: candidate.generation,
          identity: candidate.identity,
          updatedAtMs: candidate.updatedAtMs,
        },
        displayName: `Aggregate ${candidate.originalConnectionId}`,
      },
    });
    const firstCommand = commandFor("cmd_aggregateRecoveryA", scan.candidates[0]!);
    const secondCommand = commandFor("cmd_aggregateRecoveryB", scan.candidates[1]!);
    first.send(firstCommand);
    second.send(secondCommand);
    await prepared;
    expect(fixture.runtime.providerConnections.recoveryIngressSnapshot).toMatchObject({
      pendingFrames: 2,
      pendingBytes: expect.any(Number),
    });

    const rejectedCommand = commandFor("cmd_aggregateRecoveryRejected", scan.candidates[0]!);
    first.send(rejectedCommand);
    await expect(first.take(
      (message): message is CommandRejectedFrame =>
        message.kind === "command.rejected" &&
        message.commandId === rejectedCommand.commandId,
    )).resolves.toMatchObject({
      code: "provider.rate_limited",
      recoverable: true,
    });
    await expect(fixture.runtime.storage.catalog.getProviderLifecycleOperation(
      rejectedCommand.commandId,
    )).resolves.toBeNull();

    const directRejected = commandFor("cmd_aggregateDirectRejected", scan.candidates[0]!);
    await expect(fixture.runtime.providerConnections.route(directRejected)).rejects.toMatchObject({
      code: "provider.rate_limited",
    });
    await expect(fixture.runtime.storage.catalog.getProviderLifecycleOperation(
      directRejected.commandId,
    )).resolves.toBeNull();

    releasePrepared();
    await expect(first.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === firstCommand.commandId,
    )).resolves.toMatchObject({ duplicate: false });
    await expect(second.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === secondCommand.commandId,
    )).resolves.toMatchObject({ duplicate: false });
    expect(fixture.runtime.providerConnections.recoveryIngressSnapshot).toMatchObject({
      pendingFrames: 0,
      pendingBytes: 0,
    });
    await first.close();
    await second.close();
    await fixture.server.close();
    expect(fixture.runtime.providerConnections.recoveryIngressSnapshot).toMatchObject({
      pendingFrames: 0,
      pendingBytes: 0,
    });
  });

  it.each([
    ["before routing", "beforeRoute", false],
    ["after durable acceptance before acknowledgement", "afterRouteBeforeSend", false],
    ["after acknowledgement", "afterSend", true],
  ] as const)(
    "retries exactly once when a socket disconnects %s",
    async (_description, boundary, expectFirstAcknowledgement) => {
      const commandId = `cmd_submit_lostAck_${boundary}`;
      let entered!: () => void;
      const boundaryEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let paused = false;
      const pause = async (
        command: Extract<ClientMessage, { readonly kind: "command" }>,
      ): Promise<void> => {
        if (paused || command.commandId !== commandId) return;
        paused = true;
        entered();
        await gate;
      };
      let commandHooks: ConnectionCommandHooks;
      if (boundary === "beforeRoute") commandHooks = { beforeRoute: pause };
      else if (boundary === "afterRouteBeforeSend") {
        commandHooks = { afterRouteBeforeSend: pause };
      } else commandHooks = { afterSend: pause };

      const fixture = await startFixture({ gateway: { commandHooks } });
      const { cookie } = await bootstrap(fixture.server);
      const first = await connect(fixture.server, cookie);
      await hello(first, `lostAckFirst_${boundary}`);
      const created = await createSession(first, `lostAck_${boundary}`);
      const sessionId = created.sessionId;
      if (sessionId === undefined) throw new Error("Session creation failed");
      first.send({
        v: 1,
        kind: "command",
        commandId,
        sessionId,
        method: "message.submit",
        params: { text: "Retry this command after disconnect." },
      });
      await boundaryEntered;
      const firstAcknowledgement = expectFirstAcknowledgement
        ? await first.take(
            (message): message is CommandAcceptedFrame =>
              message.kind === "command.accepted" && message.commandId === commandId,
          )
        : null;
      await first.close();
      release();

      const retry = await connect(fixture.server, cookie);
      await hello(retry, `lostAckRetry_${boundary}`);
      retry.send({
        v: 1,
        kind: "command",
        commandId,
        sessionId,
        method: "message.submit",
        params: { text: "Retry this command after disconnect." },
      });
      const duplicate = await retry.take(
        (message): message is CommandAcceptedFrame =>
          message.kind === "command.accepted" && message.commandId === commandId,
      );
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.runId).toBeDefined();
      if (firstAcknowledgement !== null) {
        expect(duplicate.runId).toBe(firstAcknowledgement.runId);
      }

      const session = await fixture.runtime.storage.openSession(sessionId);
      await eventually(async () => {
        const events = await session.getEventsAfter(0);
        expect(
          events.filter((event) => event.eventType === "user.message.appended"),
        ).toHaveLength(1);
        expect(events.some((event) => event.eventType === "run.completed")).toBe(true);
      });
      await retry.close();
    },
  );

  it("uses the replay barrier when a commit lands after head capture", async () => {
    let captured!: (value: { sessionId: string; head: number }) => void;
    const capture = new Promise<{ sessionId: string; head: number }>((resolve) => {
      captured = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const fixture = await startFixture({
      gateway: {
        replayHooks: {
          afterHeadCaptured: async (sessionId, head) => {
            if (gated) return;
            gated = true;
            captured({ sessionId, head });
            await gate;
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "race");
    const created = await createSession(client, "race");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_subscribe_race",
      sessionId,
      afterSequence: 0,
    });
    const boundary = await capture;
    expect(boundary).toEqual({ sessionId, head: 1 });
    const accepted = await submitMessage(client, sessionId, "race");
    release();
    await client.take(eventFor(sessionId, "run.completed"));
    const completed = await client.take(
      (message): message is ReplayCompleteFrame =>
        message.kind === "replay.complete" && message.requestId === "req_subscribe_race",
    );
    expect(completed.throughSequence).toBe(1);

    const session = await fixture.runtime.storage.openSession(sessionId);
    const stored = await session.getEventsAfter(0);
    await eventually(() => {
      const delivered = client.all
        .filter(eventFor(sessionId))
        .map((event) => event.sequence);
      expect(delivered).toEqual(stored.map((event) => event.sequence));
      expect(new Set(delivered).size).toBe(delivered.length);
    });
    expect(accepted.acceptedSequence).toBe(3);
    const replayIndex = client.all.findIndex(
      (message) => message.kind === "replay.complete" && message.requestId === "req_subscribe_race",
    );
    const firstLiveIndex = client.all.findIndex(
      (message) => message.kind === "event" && message.sessionId === sessionId && message.sequence === 2,
    );
    expect(replayIndex).toBeGreaterThanOrEqual(0);
    expect(firstLiveIndex).toBeGreaterThan(replayIndex);
    await client.close();
  });

  it.each([
    ["before head capture", "beforeHeadCapture"],
    ["after head capture before historical read", "afterHeadCaptured"],
    ["after historical read before delivery", "afterHistoricalRead"],
    ["after replay.complete before live drain", "afterReplayComplete"],
  ] as const)("preserves exact connection replay order %s", async (_description, boundary) => {
    let entered!: () => void;
    const boundaryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const pause = async (): Promise<void> => {
      if (paused) return;
      paused = true;
      entered();
      await gate;
    };
    let replayHooks: ConnectionReplayHooks;
    if (boundary === "beforeHeadCapture") replayHooks = { beforeHeadCapture: pause };
    else if (boundary === "afterHeadCaptured") replayHooks = { afterHeadCaptured: pause };
    else if (boundary === "afterHistoricalRead") replayHooks = { afterHistoricalRead: pause };
    else replayHooks = { afterReplayComplete: pause };

    const fixture = await startFixture({ gateway: { replayHooks } });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, `replayBoundary_${boundary}`);
    const created = await createSession(client, `replayBoundary_${boundary}`);
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: `req_replayBoundary_${boundary}`,
      sessionId,
      afterSequence: 0,
    });
    await boundaryEntered;
    const accepted = await submitMessage(client, sessionId, `replayBoundary_${boundary}`);
    const runId = accepted.runId;
    if (runId === undefined) throw new Error("Message command returned no run ID");
    const session = await fixture.runtime.storage.openSession(sessionId);
    await eventually(async () => {
      expect((await session.getRun(runId))?.state).toBe("completed");
    });
    release();

    const complete = await client.take(
      (message): message is ReplayCompleteFrame =>
        message.kind === "replay.complete" &&
        message.requestId === `req_replayBoundary_${boundary}`,
    );
    const stored = await session.getEventsAfter(0);
    await eventually(() => {
      const delivered = client.all
        .filter(eventFor(sessionId))
        .map((event) => event.sequence);
      expect(delivered).toEqual(stored.map((event) => event.sequence));
      expect(new Set(delivered).size).toBe(delivered.length);
    });
    expect(complete.throughSequence).toBe(
      boundary === "beforeHeadCapture" ? stored.at(-1)?.sequence : 1,
    );
    const completeIndex = client.all.indexOf(complete);
    const firstLiveIndex = client.all.findIndex(
      (message) =>
        message.kind === "event" &&
        message.sessionId === sessionId &&
        message.sequence > complete.throughSequence,
    );
    if (firstLiveIndex >= 0) expect(firstLiveIndex).toBeGreaterThan(completeIndex);
    await client.close();
  });

  it("pages and paces a healthy replay beyond outbound count and byte limits", async () => {
    let pageReads = 0;
    const fixture = await startFixture({
      gateway: {
        limits: {
          replaySingleEventBytes: 16 * 1_024,
          replayPageEvents: 32,
          replayPageBytes: 64 * 1_024,
          replayPageSingleEventBytes: 16 * 1_024,
        },
        replayHooks: {
          afterHistoricalRead: () => {
            pageReads += 1;
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const creator = await connect(fixture.server, cookie);
    await hello(creator, "largeReplayCreator");
    const created = await createSession(creator, "largeReplay");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    await creator.close();

    const session = await fixture.runtime.storage.openSession(sessionId);
    await seedReplayEvents(session, 400, 4_096);
    const boundedPage = await session.getEventPageAfter({
      afterSequence: 0,
      throughSequence: 401,
      maximumEvents: 256,
      maximumBytes: 20_000,
      maximumSingleEventBytes: 8_000,
    });
    expect(boundedPage.events.length).toBeGreaterThan(0);
    expect(boundedPage.events.length).toBeLessThan(256);
    expect(boundedPage.serializedBytes).toBeLessThanOrEqual(20_000);
    expect(boundedPage.done).toBe(false);

    const client = await connect(fixture.server, cookie);
    await hello(client, "largeReplayConsumer");
    const complete = await subscribe(client, sessionId, "largeReplayConsumer");
    expect(complete.throughSequence).toBe(401);
    const sequences = client.all.filter(eventFor(sessionId)).map((event) => event.sequence);
    expect(sequences).toEqual(Array.from({ length: 401 }, (_, index) => index + 1));
    expect(pageReads).toBeGreaterThan(10);
    expect(fixture.server.gateway.connectionSnapshots).toEqual([
      expect.objectContaining({ closed: false, subscriptions: 1 }),
    ]);
    await client.close();
  }, 30_000);

  it("rejects a durable command that the accepted gateway configuration cannot replay", async () => {
    const fixture = await startFixture({
      gateway: { limits: { frame: { maximumBytes: 512 * 1_024 } } },
    });
    const { cookie } = await bootstrap(fixture.server);
    const live = await connect(fixture.server, cookie);
    await hello(live, "oversizedDurableCommandLive");
    const created = await createSession(live, "oversizedDurableCommand");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(live, sessionId, "oversizedDurableCommandLive");

    const session = await fixture.runtime.storage.openSession(sessionId);
    const headBefore = await session.getHeadSequence();
    const catalogBefore = await fixture.runtime.storage.catalog.getSession(sessionId);
    const route = vi.spyOn(fixture.runtime.commandRouter, "route");
    route.mockClear();
    live.send({
      v: 1,
      kind: "command",
      commandId: "cmd_submit_oversizedDurableCommand",
      sessionId,
      method: "message.submit",
      params: { text: "x".repeat(270 * 1_024) },
    });

    const rejected = await live.take(
      (message): message is CommandRejectedFrame =>
        message.kind === "command.rejected" &&
        message.commandId === "cmd_submit_oversizedDurableCommand",
      2_000,
    );
    expect(rejected).toMatchObject({ code: "protocol.message_too_large", recoverable: false });
    expect(route).not.toHaveBeenCalled();
    expect(await session.getHeadSequence()).toBe(headBefore);
    expect(await fixture.runtime.storage.catalog.getSession(sessionId)).toMatchObject({
      lastEventSequence: catalogBefore?.lastEventSequence,
    });
    expect(fixture.server.gateway.connectionSnapshots).toEqual([
      expect.objectContaining({
        closed: false,
        replayBacklogEvents: 0,
        replayBacklogBytes: 0,
        replayHistoricalPages: 0,
      }),
    ]);
    await live.close();

    const replay = await connect(fixture.server, cookie);
    await hello(replay, "oversizedDurableCommandReplay");
    const complete = await subscribe(
      replay,
      sessionId,
      "oversizedDurableCommandReplay",
      headBefore,
    );
    expect(complete.throughSequence).toBe(headBefore);
    expect(replay.all.filter(eventFor(sessionId))).toEqual([]);
    await replay.close();
  });

  it("accepts the exact message payload limit and rejects one byte over across frame overrides", async () => {
    const cases = [
      {
        suffix: "defaultFrame",
        singleEventBytes: 20 * 1_024,
        gateway: {
          limits: {
            outbound: { maximumSingleMessageBytes: 20 * 1_024 },
            replaySingleEventBytes: 20 * 1_024,
            replayPageBytes: 20 * 1_024 + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
            replayPageSingleEventBytes: 20 * 1_024,
          },
        },
      },
      {
        suffix: "largeFrame",
        singleEventBytes: 256 * 1_024,
        gateway: { limits: { frame: { maximumBytes: 1_024 * 1_024 } } },
      },
    ] as const;

    for (const testCase of cases) {
      const maximumPayloadBytes = maximumDurableCommandPayloadBytes({
        outboundSingleMessageBytes: testCase.singleEventBytes,
        replayLiveSingleEventBytes: testCase.singleEventBytes,
        replayPageSingleEventBytes: testCase.singleEventBytes,
      });
      const fixture = await startFixture({ gateway: testCase.gateway });
      const { cookie } = await bootstrap(fixture.server);
      const live = await connect(fixture.server, cookie);
      await hello(live, `exactMessage_${testCase.suffix}`);
      const created = await createSession(live, `exactMessage_${testCase.suffix}`);
      const sessionId = created.sessionId;
      if (sessionId === undefined) throw new Error("Session creation failed");
      await subscribe(live, sessionId, `exactMessage_${testCase.suffix}`);
      const session = await fixture.runtime.storage.openSession(sessionId);
      const headBeforeExact = await session.getHeadSequence();
      const exactText = jsonStringWithCanonicalBytes(maximumPayloadBytes);

      const exactCommandId = `cmd_exactMessage_${testCase.suffix}`;
      live.send({
        v: 1,
        kind: "command",
        commandId: exactCommandId,
        sessionId,
        method: "message.submit",
        params: { text: exactText },
      });
      const accepted = await live.take(
        (message): message is CommandAcceptedFrame =>
          message.kind === "command.accepted" && message.commandId === exactCommandId,
      );
      expect(accepted.duplicate).toBe(false);
      const liveEvent = await live.take(eventFor(sessionId, "user.message.appended"));
      expect(liveEvent.data.text).toBe(exactText);
      await live.close();

      const replay = await connect(fixture.server, cookie);
      await hello(replay, `exactMessageReplay_${testCase.suffix}`);
      await subscribe(
        replay,
        sessionId,
        `exactMessageReplay_${testCase.suffix}`,
        headBeforeExact,
      );
      const replayed = await replay.take(eventFor(sessionId, "user.message.appended"));
      expect(replayed).toMatchObject({ eventId: liveEvent.eventId, data: { text: exactText } });
      if (accepted.runId === undefined) throw new Error("Exact message returned no run ID");
      await eventually(async () => {
        expect((await session.getRun(accepted.runId as string))?.state).toMatch(
          /^(?:completed|failed|cancelled|interrupted)$/u,
        );
      });

      const route = vi.spyOn(fixture.runtime.commandRouter, "route");
      route.mockClear();
      const headBeforeRejected = await session.getHeadSequence();
      const overCommandId = `cmd_overMessage_${testCase.suffix}`;
      replay.send({
        v: 1,
        kind: "command",
        commandId: overCommandId,
        sessionId,
        method: "message.submit",
        params: { text: jsonStringWithCanonicalBytes(maximumPayloadBytes + 1) },
      });
      const rejected = await replay.take(
        (message): message is CommandRejectedFrame =>
          message.kind === "command.rejected" && message.commandId === overCommandId,
      );
      expect(rejected).toMatchObject({ code: "protocol.message_too_large", recoverable: false });
      expect(rejected.message.length).toBeLessThanOrEqual(SAFE_DIAGNOSTIC_MESSAGE_MAX_LENGTH);
      expect(route).not.toHaveBeenCalled();
      expect(await session.getHeadSequence()).toBe(headBeforeRejected);
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "websocket_command_rejected",
          diagnosticId: rejected.diagnosticId,
          commandId: overCommandId,
          code: "protocol.message_too_large",
        }),
      );
      expect(JSON.stringify(fixture.records)).not.toContain("x".repeat(1_024));
      expect(fixture.server.gateway.connectionSnapshots).toEqual([
        expect.objectContaining({
          closed: false,
          replayBacklogEvents: 0,
          replayBacklogBytes: 0,
          replayHistoricalPages: 0,
        }),
      ]);
      await replay.close();
    }
  }, 30_000);

  it("bounds session titles and complete input JSON before durable acceptance", async () => {
    const singleEventBytes = 20 * 1_024;
    const maximumPayloadBytes = maximumDurableCommandPayloadBytes({
      outboundSingleMessageBytes: singleEventBytes,
      replayLiveSingleEventBytes: singleEventBytes,
      replayPageSingleEventBytes: singleEventBytes,
    });
    const fixture = await startFixture({
      gateway: {
        limits: {
          frame: { maximumBytes: 1_024 * 1_024 },
          outbound: { maximumSingleMessageBytes: singleEventBytes },
          replaySingleEventBytes: singleEventBytes,
          replayPageBytes: singleEventBytes + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
          replayPageSingleEventBytes: singleEventBytes,
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "durablePayloadVariants");

    const exactTitle = jsonStringWithCanonicalBytes(maximumPayloadBytes);
    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_exactTitle",
      method: "session.create",
      params: { title: exactTitle },
    });
    const exactTitleAccepted = await client.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_exactTitle",
    );
    const titleSessionId = exactTitleAccepted.sessionId;
    if (titleSessionId === undefined) throw new Error("Exact-limit title returned no session ID");
    await subscribe(client, titleSessionId, "exactTitle");
    const titleEvent = await client.take(eventFor(titleSessionId, "session.created"));
    expect(titleEvent.data.title).toBe(exactTitle);

    const catalogCountBeforeRejectedTitle = (await fixture.runtime.storage.catalog.listSessions())
      .length;
    const route = vi.spyOn(fixture.runtime.commandRouter, "route");
    route.mockClear();
    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_overTitle",
      method: "session.create",
      params: { title: jsonStringWithCanonicalBytes(maximumPayloadBytes + 1) },
    });
    const titleRejected = await client.take(
      (message): message is CommandRejectedFrame =>
        message.kind === "command.rejected" && message.commandId === "cmd_overTitle",
    );
    expect(titleRejected.code).toBe("protocol.message_too_large");
    expect(route).not.toHaveBeenCalled();
    expect(await fixture.runtime.storage.catalog.getGlobalCommand("cmd_overTitle")).toBeNull();
    expect(await fixture.runtime.storage.catalog.listSessions()).toHaveLength(
      catalogCountBeforeRejectedTitle,
    );

    const pending = await createSession(client, "boundedInputValue");
    const inputSessionId = pending.sessionId;
    if (inputSessionId === undefined) throw new Error("Input session creation failed");
    const inputSession = await fixture.runtime.storage.openSession(inputSessionId);
    const seededInput = await inputSession.appendTransaction({
      events: [
        {
          eventId: "evt_boundedInputRun",
          eventType: "run.created",
          createdAtMs: 3_000,
          data: { eventVersion: 1, runId: "run_boundedInput" },
        },
        {
          eventId: "evt_boundedInputRequestedA",
          eventType: "input.requested",
          createdAtMs: 3_001,
          data: {
            eventVersion: 1,
            runId: "run_boundedInput",
            inputId: "input_boundedInputA",
            prompt: "First?",
          },
        },
        {
          eventId: "evt_boundedInputRequestedB",
          eventType: "input.requested",
          createdAtMs: 3_002,
          data: {
            eventVersion: 1,
            runId: "run_boundedInput",
            inputId: "input_boundedInputB",
            prompt: "Second?",
          },
        },
      ],
      projections: [
        {
          kind: "run.put",
          runId: "run_boundedInput",
          state: "waiting_for_user",
          providerId: "fake",
          providerConfig: { scenario: "plain-text" },
          createdAtMs: 3_000,
          startedAtMs: 3_000,
          completedAtMs: null,
          cancelledAtMs: null,
          failureCategory: null,
          failureMessage: null,
          activeProviderStepId: null,
        },
        {
          kind: "input.put",
          inputId: "input_boundedInputA",
          runId: "run_boundedInput",
          state: "pending",
          prompt: "First?",
          requestedAtMs: 3_001,
        },
        {
          kind: "input.put",
          inputId: "input_boundedInputB",
          runId: "run_boundedInput",
          state: "pending",
          prompt: "Second?",
          requestedAtMs: 3_002,
        },
      ],
    });
    for (const event of seededInput.events) fixture.runtime.eventHub.publishCommitted(event);
    await subscribe(client, inputSessionId, "boundedInputValue");
    const headBeforeInput = await inputSession.getHeadSequence();

    route.mockClear();
    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_overInputValue",
      sessionId: inputSessionId,
      method: "input.respond",
      params: {
        inputId: "input_boundedInputA",
        value: jsonStringWithCanonicalBytes(maximumPayloadBytes + 1),
      },
    });
    const inputRejected = await client.take(
      (message): message is CommandRejectedFrame =>
        message.kind === "command.rejected" && message.commandId === "cmd_overInputValue",
    );
    expect(inputRejected.code).toBe("protocol.message_too_large");
    expect(route).not.toHaveBeenCalled();
    expect(await inputSession.getHeadSequence()).toBe(headBeforeInput);
    expect(await inputSession.getAcceptedCommand("cmd_overInputValue")).toBeNull();

    const exactValue = jsonStringWithCanonicalBytes(maximumPayloadBytes);
    client.send({
      v: 1,
      kind: "command",
      commandId: "cmd_exactInputValue",
      sessionId: inputSessionId,
      method: "input.respond",
      params: { inputId: "input_boundedInputA", value: exactValue },
    });
    await client.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_exactInputValue",
    );
    const resolved = await client.take(eventFor(inputSessionId, "input.resolved"));
    expect(resolved.data.value).toBe(exactValue);
    expect(await inputSession.getHeadSequence()).toBe(headBeforeInput + 1);
    await client.close();

    const replay = await connect(fixture.server, cookie);
    await hello(replay, "boundedInputValueReplay");
    const complete = await subscribe(
      replay,
      inputSessionId,
      "boundedInputValueReplay",
      headBeforeInput,
    );
    expect(complete.throughSequence).toBe(headBeforeInput + 1);
    const replayedResolved = await replay.take(eventFor(inputSessionId, "input.resolved"));
    expect(replayedResolved).toMatchObject({
      eventId: resolved.eventId,
      data: { value: exactValue },
    });
    await replay.close();
  }, 30_000);

  it("delivers and replays an event at the exact live single-event limit", async () => {
    const singleEventBytes = 256 * 1_024;
    const fixture = await startFixture();
    const { cookie } = await bootstrap(fixture.server);
    const live = await connect(fixture.server, cookie);
    await hello(live, "exactReplayLimitLive");
    const created = await createSession(live, "exactReplayLimit");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(live, sessionId, "exactReplayLimitLive");

    const session = await fixture.runtime.storage.openSession(sessionId);
    const committed = await session.appendTransaction({
      events: [replayInputEventAtBytes(sessionId, singleEventBytes, "exactReplayLimit")],
      projections: [],
    });
    const event = committed.events[0];
    if (event === undefined) throw new Error("Near-limit event did not commit");
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(singleEventBytes);
    fixture.runtime.eventHub.publishCommitted(event);
    await live.take(eventFor(sessionId, "input.requested"));
    await live.close();

    const page = await session.getEventPageAfter({
      afterSequence: 1,
      throughSequence: 2,
      maximumEvents: 1,
      maximumBytes: singleEventBytes + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
      maximumSingleEventBytes: singleEventBytes,
    });
    expect(page.events).toHaveLength(1);
    expect(page.serializedBytes).toBeLessThanOrEqual(
      singleEventBytes + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
    );

    const replay = await connect(fixture.server, cookie);
    await hello(replay, "exactReplayLimitReplay");
    const complete = await subscribe(replay, sessionId, "exactReplayLimitReplay", 1);
    expect(complete.throughSequence).toBe(2);
    expect(replay.all.filter(eventFor(sessionId)).map((message) => message.sequence)).toEqual([2]);
    await replay.close();
  }, 30_000);

  it("disconnects one byte above live capacity and replays after capacity increases", async () => {
    const singleEventBytes = 32 * 1_024;
    const homeDirectory = await mkdtemp(join(tmpdir(), "wi-milestone5-replay-boundary-"));
    homes.add(homeDirectory);
    const limited = await startFixture({
      homeDirectory,
      gateway: {
        limits: {
          replaySingleEventBytes: singleEventBytes,
          replayPageBytes:
            singleEventBytes + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
          replayPageSingleEventBytes: singleEventBytes,
        },
      },
    });
    const firstBootstrap = await bootstrap(limited.server);
    const live = await connect(limited.server, firstBootstrap.cookie);
    await hello(live, "overReplayLimitLive");
    const created = await createSession(live, "overReplayLimit");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(live, sessionId, "overReplayLimitLive");

    const session = await limited.runtime.storage.openSession(sessionId);
    const committed = await session.appendTransaction({
      events: [
        replayInputEventAtBytes(sessionId, singleEventBytes + 1, "overReplayLimit"),
      ],
      projections: [],
    });
    const event = committed.events[0];
    if (event === undefined) throw new Error("Over-limit event did not commit");
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(singleEventBytes + 1);
    limited.runtime.eventHub.publishCommitted(event);
    expect((await live.waitForClose()).code).toBe(SLOW_CONSUMER_CLOSE_CODE);
    await limited.server.close();

    const recovered = await startFixture({
      homeDirectory,
      gateway: {
        limits: {
          replaySingleEventBytes: singleEventBytes + 1,
          replayPageBytes:
            singleEventBytes + 1 + SESSION_EVENT_PAGE_BOUNDS.envelopeReserveBytes,
          replayPageSingleEventBytes: singleEventBytes + 1,
        },
      },
    });
    const secondBootstrap = await bootstrap(recovered.server);
    const replay = await connect(recovered.server, secondBootstrap.cookie);
    await hello(replay, "overReplayLimitReplay");
    const complete = await subscribe(replay, sessionId, "overReplayLimitReplay", 1);
    expect(complete.throughSequence).toBe(2);
    expect(replay.all.filter(eventFor(sessionId)).map((message) => message.sequence)).toEqual([2]);
    await replay.close();
  }, 30_000);

  it("correlates mixed hello resumes by session and distinguishes unavailable state", async () => {
    const fixture = await startFixture();
    const createStoredSession = async (suffix: string): Promise<string> => {
      const created = await fixture.runtime.storage.createSession({
        v: 1,
        kind: "command",
        commandId: `cmd_create_mixedResume${suffix}`,
        method: "session.create",
        params: { title: `Mixed resume ${suffix}` },
      });
      return created.session.sessionId;
    };
    const readySessionId = await createStoredSession("Ready");
    const aheadSessionId = await createStoredSession("Ahead");
    const unavailableSessionId = await createStoredSession("Unavailable");
    await fixture.runtime.storage.catalog.markSessionStatus({
      sessionId: unavailableSessionId,
      status: "unavailable",
    });

    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "mixedResume", [
      { sessionId: readySessionId, afterSequence: 0 },
      { sessionId: "ses_unknownMixedResume", afterSequence: 0 },
      { sessionId: aheadSessionId, afterSequence: 99 },
      { sessionId: unavailableSessionId, afterSequence: 0 },
    ]);

    await client.take(
      (message): message is ReplayCompleteFrame =>
        message.kind === "replay.complete" && message.sessionId === readySessionId,
    );
    const expected = new Map([
      ["ses_unknownMixedResume", "replay.unknown_session"],
      [aheadSessionId, "replay.cursor_ahead"],
      [unavailableSessionId, "storage.corrupt"],
    ]);
    for (const [sessionId, code] of expected) {
      const error = await client.take(
        (message): message is ProtocolErrorFrame =>
          message.kind === "protocol.error" && message.sessionId === sessionId,
      );
      expect(error).toMatchObject({ sessionId, code, recoverable: code === "replay.cursor_ahead" });
      expect(fixture.records).toContainEqual(
        expect.objectContaining({
          event: "websocket_protocol_rejected",
          diagnosticId: error.diagnosticId,
          sessionId,
          code,
        }),
      );
    }
    await client.close();
  });

  it("reports catalog unavailability discovered during replay as storage corruption", async () => {
    let entered!: () => void;
    const headCheckEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await startFixture({
      gateway: {
        replayHooks: {
          beforeHeadCapture: async () => {
            entered();
            await gate;
          },
        },
      },
    });
    const created = await fixture.runtime.storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_create_unavailableDuringReplay",
      method: "session.create",
      params: { title: "Unavailable during replay" },
    });
    const sessionId = created.session.sessionId;
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "unavailableDuringReplay");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_unavailableDuringReplay",
      sessionId,
      afterSequence: 0,
    });
    await headCheckEntered;
    await fixture.runtime.storage.catalog.markSessionStatus({
      sessionId,
      status: "unavailable",
    });
    release();

    const error = await client.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" &&
        message.requestId === "req_unavailableDuringReplay",
    );
    expect(error).toMatchObject({
      sessionId,
      code: "storage.corrupt",
      recoverable: false,
    });
    await client.close();
  });

  it("keeps permanent storage corruption non-recoverable when replay wraps the page failure", async () => {
    const fixture = await startFixture({
      runtime: {
        storage: { sessionWorkers: { allowTestOperations: true, size: 1 } },
      },
      gateway: {
        replayHooks: {
          afterHeadCaptured: async (sessionId) => {
            await sessionWorkers(fixture.runtime.storage).corruptManifestForTest(sessionId);
          },
        },
      },
    });
    const created = await fixture.runtime.storage.createSession({
      v: 1,
      kind: "command",
      commandId: "cmd_create_wrappedReplayCorruption",
      method: "session.create",
      params: { title: "Wrapped replay corruption" },
    });
    const sessionId = created.session.sessionId;
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "wrappedReplayCorruption");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_wrappedReplayCorruption",
      sessionId,
      afterSequence: 0,
    });

    const error = await client.take(
      (message): message is ProtocolErrorFrame =>
        message.kind === "protocol.error" &&
        message.requestId === "req_wrappedReplayCorruption",
    );
    expect(error).toMatchObject({
      sessionId,
      code: "storage.corrupt",
      recoverable: false,
    });
    await eventually(async () => {
      expect(await fixture.runtime.storage.catalog.getSession(sessionId)).toMatchObject({
        status: "unavailable",
      });
    });
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "websocket_protocol_rejected",
        diagnosticId: error.diagnosticId,
        sessionId,
        code: "storage.corrupt",
        recoverable: false,
      }),
    );
    await client.close();
  });

  it("resumes the maximum 64 sessions through bounded multi-page histories", async () => {
    let activeHistoricalPages = 0;
    let maximumActiveHistoricalPages = 0;
    const fixture = await startFixture({
      gateway: {
        limits: {
          replayLiveEvents: 128,
          replayLiveBytes: 64 * 1_024,
          replaySingleEventBytes: 16 * 1_024,
          replayPageEvents: 32,
          replayPageBytes: 64 * 1_024,
          replayPageSingleEventBytes: 16 * 1_024,
        },
        replayHooks: {
          afterHistoricalRead: async () => {
            activeHistoricalPages += 1;
            maximumActiveHistoricalPages = Math.max(
              maximumActiveHistoricalPages,
              activeHistoricalPages,
            );
            try {
              await new Promise<void>((resolve) => setImmediate(resolve));
            } finally {
              activeHistoricalPages -= 1;
            }
          },
        },
      },
    });
    const resume: Array<{ sessionId: string; afterSequence: number }> = [];
    for (let index = 0; index < 64; index += 1) {
      const created = await fixture.runtime.storage.createSession({
        v: 1,
        kind: "command",
        commandId: `cmd_create_resumeMany${index}`,
        method: "session.create",
        params: { title: `Resume ${index}` },
      });
      const session = await fixture.runtime.storage.openSession(created.session.sessionId);
      await seedReplayEvents(session, 70, 128);
      resume.push({ sessionId: created.session.sessionId, afterSequence: 0 });
    }

    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "resumeMany", resume);
    for (const cursor of resume) {
      const complete = await client.take(
        (message): message is ReplayCompleteFrame =>
          message.kind === "replay.complete" && message.sessionId === cursor.sessionId,
        30_000,
      );
      expect(complete.throughSequence).toBe(71);
      expect(client.all.filter(eventFor(cursor.sessionId))).toHaveLength(71);
    }
    expect(fixture.server.gateway.connectionSnapshots).toEqual([
      expect.objectContaining({
        subscriptions: 64,
        replayBacklogEvents: 0,
        replayBacklogBytes: 0,
        replayDuplicateEvents: 128,
        replayDuplicateBytes: expect.any(Number),
        closed: false,
      }),
    ]);
    const [snapshot] = fixture.server.gateway.connectionSnapshots;
    expect(snapshot?.replayDuplicateBytes).toBeLessThanOrEqual(64 * 1_024);
    expect(maximumActiveHistoricalPages).toBe(1);
    await client.close();
  }, 60_000);

  it("enforces one aggregate replay backlog across multiplexed subscriptions", async () => {
    const capturedSessions = new Set<string>();
    let signalHeadsCaptured!: () => void;
    const headsCaptured = new Promise<void>((resolve) => {
      signalHeadsCaptured = resolve;
    });
    let releaseReplay!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let holdReplay = true;
    const fixture = await startFixture({
      gateway: {
        limits: {
          replayLiveEvents: 4,
          replayLiveBytes: 7_500,
          replaySingleEventBytes: 5_000,
        },
        replayHooks: {
          afterHeadCaptured: async (sessionId) => {
            if (!holdReplay) return;
            capturedSessions.add(sessionId);
            if (capturedSessions.size === 2) signalHeadsCaptured();
            await replayGate;
          },
        },
      },
    });
    const sessions: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await fixture.runtime.storage.createSession({
        v: 1,
        kind: "command",
        commandId: `cmd_create_aggregateReplay${index}`,
        method: "session.create",
        params: { title: `Aggregate replay ${index}` },
      });
      sessions.push(created.session.sessionId);
    }

    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "aggregateReplay");
    for (const [index, sessionId] of sessions.entries()) {
      client.send({
        v: 1,
        kind: "subscribe",
        requestId: `req_aggregateReplay${index}`,
        sessionId,
        afterSequence: 0,
      });
    }
    await headsCaptured;

    for (const [index, sessionId] of sessions.entries()) {
      const session = await fixture.runtime.storage.openSession(sessionId);
      const committed = await session.appendTransaction({
        events: [replayInputEventAtBytes(sessionId, 4_500, `aggregateReplay${index}`)],
        projections: [],
      });
      const event = committed.events[0];
      if (event === undefined) throw new Error("Aggregate replay event did not commit");
      fixture.runtime.eventHub.publishCommitted(event);
      if (index === 0) {
        expect(fixture.server.gateway.connectionSnapshots).toHaveLength(1);
      }
    }

    const close = await client.waitForClose();
    holdReplay = false;
    releaseReplay();
    expect(close.code).toBe(SLOW_CONSUMER_CLOSE_CODE);
    await eventually(() => {
      expect(fixture.server.gateway.connectionSnapshots).toHaveLength(0);
    });

    const recovered = await connect(fixture.server, cookie);
    await hello(recovered, "aggregateReplayRecovered");
    for (const [index, sessionId] of sessions.entries()) {
      const complete = await subscribe(
        recovered,
        sessionId,
        `aggregateReplayRecovered${index}`,
      );
      expect(complete.throughSequence).toBe(2);
      expect(recovered.all.filter(eventFor(sessionId)).map((event) => event.sequence)).toEqual([
        1,
        2,
      ]);
    }
    await recovered.close();
  });

  it("disconnects replay live-backlog overflow and recovers every durable event", async () => {
    const fixture = await startFixture({
      gateway: { limits: { replayLiveEvents: 1 } },
    });
    const { cookie } = await bootstrap(fixture.server);
    const overflowed = await connect(fixture.server, cookie);
    await hello(overflowed, "liveOverflow");
    const created = await createSession(overflowed, "liveOverflow");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(overflowed, sessionId, "liveOverflow");

    overflowed.send({
      v: 1,
      kind: "command",
      commandId: "cmd_submit_liveOverflow",
      sessionId: created.sessionId,
      method: "message.submit",
      params: { text: "Overflow the live replay backlog." },
    });
    expect((await overflowed.waitForClose()).code).toBe(SLOW_CONSUMER_CLOSE_CODE);

    const session = await fixture.runtime.storage.openSession(sessionId);
    await eventually(async () => {
      const stored = await session.getEventsAfter(0);
      expect(stored.some((event) => event.eventType === "run.completed")).toBe(true);
      expect(fixture.server.gateway.connectionSnapshots).toHaveLength(0);
      const lease = await fixture.runtime.actors.acquire(sessionId);
      try {
        expect(lease.actor.snapshot.subscriberCount).toBe(0);
      } finally {
        lease.release();
      }
    });
    const expected = await session.getEventsAfter(0);

    const recovered = await connect(fixture.server, cookie);
    await hello(recovered, "liveOverflowRecovered");
    await subscribe(recovered, sessionId, "liveOverflowRecovered");
    for (const event of expected) {
      const received = await recovered.take(
        (message): message is EventFrame =>
          message.kind === "event" &&
          message.sessionId === created.sessionId &&
          message.sequence === event.sequence,
      );
      expect(received.eventId).toBe(event.eventId);
    }
    await recovered.close();
  });

  it("cleans a connection that closes during replay without affecting the session", async () => {
    let entered!: () => void;
    const replayEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await startFixture({
      gateway: {
        replayHooks: {
          afterHeadCaptured: async () => {
            entered();
            await gate;
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "closeReplay");
    const created = await createSession(client, "closeReplay");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_closeReplay",
      sessionId: created.sessionId,
      afterSequence: 0,
    });
    await replayEntered;
    await client.close();
    release();
    await eventually(() => {
      expect(fixture.server.gateway.connectionSnapshots).toHaveLength(0);
      const state = fixture.runtime.actors.states().find((entry) => entry.sessionId === created.sessionId);
      expect(state?.actorIdle).toBe(true);
    });
  });

  it("aborts an in-flight storage replay request when the subscriber disconnects", async () => {
    let blocked!: () => void;
    const workerBlocked = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const barrier: { current?: SessionWorkerBarrier } = {};
    const fixture = await startFixture({
      runtime: {
        storage: { sessionWorkers: { allowTestOperations: true, size: 1 } },
      },
      gateway: {
        replayHooks: {
          afterHeadCaptured: async (sessionId) => {
            barrier.current =
              await sessionWorkers(fixture.runtime.storage).blockWorkerForTest(sessionId);
            blocked();
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "abortReplayQuery");
    const created = await createSession(client, "abortReplayQuery");
    const sessionId = created.sessionId;
    if (sessionId === undefined) throw new Error("Session creation failed");
    client.send({
      v: 1,
      kind: "subscribe",
      requestId: "req_abortReplayQuery",
      sessionId,
      afterSequence: 0,
    });
    await workerBlocked;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.close();
    const installedBarrier = barrier.current;
    if (installedBarrier === undefined) {
      throw new Error("Session worker barrier was not installed");
    }
    await installedBarrier.release();

    await eventually(async () => {
      expect(fixture.server.gateway.connectionSnapshots).toHaveLength(0);
      const lease = await fixture.runtime.actors.acquire(sessionId);
      try {
        expect(lease.actor.snapshot.subscriberCount).toBe(0);
      } finally {
        lease.release();
      }
    });
  });

  it("keeps another session and HTTP responsive while one session worker is busy", async () => {
    const candidateIds = Array.from({ length: 16 }, (_value, index) =>
      `ses_busyWorkerDeterministic${index}`
    );
    const sessionIds = [0, 1].map((workerIndex) => {
      const sessionId = candidateIds.find((candidate) =>
        stableSessionWorkerIndex(candidate, 2) === workerIndex
      );
      if (sessionId === undefined) throw new Error("Deterministic worker session ID is missing");
      return sessionId;
    });
    let sessionIdIndex = 0;
    let storageEventIndex = 0;
    const fixture = await startFixture({
      runtime: {
        storage: {
          ids: {
            sessionId: () => sessionIds[sessionIdIndex++]!,
            eventId: () => `evt_busyWorkerStorage${++storageEventIndex}`,
          },
          sessionWorkers: { allowTestOperations: true, size: 2 },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "busyWorker");
    const first = await createSession(client, "busyWorkerFirst");
    if (first.sessionId === undefined) throw new Error("Session creation failed");
    const second = await createSession(client, "busyWorkerOther");
    const secondSessionId = second.sessionId;
    if (secondSessionId === undefined) throw new Error("Second session creation failed");
    expect(sessionWorkers(fixture.runtime.storage).workerIndexFor(secondSessionId)).not.toBe(
      sessionWorkers(fixture.runtime.storage).workerIndexFor(first.sessionId),
    );

    const barrier = await sessionWorkers(fixture.runtime.storage).blockWorkerForTest(first.sessionId);
    try {
      const accepted = await submitMessage(client, secondSessionId, "busyWorkerResponsive");
      const runId = accepted.runId;
      if (runId === undefined) throw new Error("Message command returned no run ID");
      expect((await fetch(`${fixture.server.origin}/health`)).status).toBe(200);
      const responsiveSession = await fixture.runtime.storage.openSession(secondSessionId);
      await eventually(async () => {
        expect((await responsiveSession.getRun(runId))?.state).toBe("completed");
      });
    } finally {
      await barrier.release();
    }
    await client.close();
  });

  it("logs failed post-commit catalog observations without affecting durable publication", async () => {
    const secret = "AUDIT_CATALOG_OBSERVATION_SECRET";
    const failures: CatalogObservationFailure[] = [];
    const fixture = await startFixture({
      runtime: {
        storage: {
          catalogProjectionWriter: async () => {
            throw new StorageError(
              "storage.disk_full",
              `Catalog write failed with Bearer ${secret}`,
            );
          },
          onCatalogObservationError: (failure) => {
            failures.push(failure);
            throw new Error("injected catalog diagnostic callback failure");
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "catalogDiagnostic");
    const created = await createSession(client, "catalogDiagnostic");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(client, created.sessionId, "catalogDiagnostic");
    await submitMessage(client, created.sessionId, "catalogDiagnostic");
    await client.take(eventFor(created.sessionId, "user.message.appended"));
    await client.take(eventFor(created.sessionId, "run.completed"));
    await fixture.runtime.storage.drainCatalogObservations();

    expect(failures).not.toHaveLength(0);
    expect(failures).toContainEqual(
      expect.objectContaining({
        diagnosticId: expect.stringMatching(/^err_/u),
        sessionId: created.sessionId,
        headSequence: expect.any(Number),
        code: "storage.disk_full",
      }),
    );
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "storage_catalog_observation_failed",
        diagnosticId: expect.stringMatching(/^err_/u),
        sessionId: created.sessionId,
        headSequence: expect.any(Number),
        code: "storage.disk_full",
        error: expect.objectContaining({
          type: "error",
          code: "storage.disk_full",
          message: expect.objectContaining({
            sourceUnit: "utf16_code_units",
            sourceLength: expect.any(Number),
            sampledByteLength: expect.any(Number),
            sampledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            truncated: expect.any(Boolean),
          }),
        }),
      }),
    );
    expect(JSON.stringify(fixture.records)).not.toContain(secret);
    await client.close();
  });

  it("publishes committed events without waiting for a blocked catalog observation", async () => {
    let release!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let block = false;
    const fixture = await startFixture({
      runtime: {
        storage: {
          catalogProjectionWriter: async (catalog, update, signal) => {
            if (block) await catalogGate;
            signal.throwIfAborted();
            await catalog.updateSessionProjection(update);
          },
        },
      },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "catalogBoundary");
    const created = await createSession(client, "catalogBoundary");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(client, created.sessionId, "catalogBoundary");
    block = true;
    const accepted = await submitMessage(client, created.sessionId, "catalogBoundary");
    expect(accepted.acceptedSequence).toBe(3);
    await client.take(eventFor(created.sessionId, "user.message.appended"));
    const health = await fetch(`${fixture.server.origin}/health`);
    expect(health.status).toBe(200);
    release();
    await client.take(eventFor(created.sessionId, "run.completed"));
    await client.close();
  });

  it("paces replay through a constrained queue without dropping approval or terminal events", async () => {
    const seeded = await startFixture({
      providerConfiguration: { scenario: "approval-round-trip" },
    });
    const firstBootstrap = await bootstrap(seeded.server);
    const first = await connect(seeded.server, firstBootstrap.cookie);
    await hello(first, "seedSlow");
    const created = await createSession(first, "seedSlow");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    await subscribe(first, created.sessionId, "seedSlow");
    await submitMessage(first, created.sessionId, "seedSlow");
    const requested = await first.take(
      eventFor(created.sessionId, "tool.approval.requested"),
    );
    first.send({
      v: 1,
      kind: "command",
      commandId: "cmd_approve_seedSlow",
      sessionId: created.sessionId,
      method: "approval.resolve",
      params: { approvalId: requested.data.approvalId, resolution: "approved" },
    });
    await first.take(
      (message): message is CommandAcceptedFrame =>
        message.kind === "command.accepted" && message.commandId === "cmd_approve_seedSlow",
    );
    await first.take(eventFor(created.sessionId, "run.completed"));
    const session = await seeded.runtime.storage.openSession(created.sessionId);
    const expected = await session.getEventsAfter(0);
    expect(expected.some((event) => event.eventType === "tool.approval.requested")).toBe(true);
    expect(expected.some((event) => event.eventType === "tool.approval.resolved")).toBe(true);
    expect(expected.some((event) => event.eventType === "run.completed")).toBe(true);
    await first.close();
    await seeded.server.close();
    servers.delete(seeded.server);

    const constrained = await startFixture({
      homeDirectory: seeded.homeDirectory,
      gateway: {
        limits: {
          outbound: {
            maximumMessages: 2,
            maximumBytes: 1_024 * 1_024,
            maximumSingleMessageBytes: 256 * 1_024,
          },
        },
      },
    });
    const constrainedBootstrap = await bootstrap(constrained.server);
    expect(
      await rejectedUpgrade(constrained.server, { cookie: firstBootstrap.cookie }),
    ).toBe(401);
    const client = await connect(constrained.server, constrainedBootstrap.cookie);
    await hello(client, "pacedReplay");
    await subscribe(client, created.sessionId, "pacedReplay");
    for (const event of expected) {
      const received = await client.take(
        (message): message is EventFrame =>
          message.kind === "event" &&
          message.sessionId === created.sessionId &&
          message.sequence === event.sequence,
      );
      expect(received.eventId).toBe(event.eventId);
    }
    expect(constrained.server.gateway.connectionSnapshots).toHaveLength(1);
    await client.close();
  });

  it("shuts down active work in explicit bounded order without leaking connections", async () => {
    const fixture = await startFixture({
      providerConfiguration: { scenario: "provider-never-completes-until-aborted" },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "shutdown");
    const created = await createSession(client, "shutdown");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    const accepted = await submitMessage(client, created.sessionId, "shutdown");
    const runId = accepted.runId;
    if (runId === undefined) throw new Error("Message command returned no run ID");
    await fixture.runtime.provider.controller.waitUntilBlocked(
      fakeProviderGateLabel(runId, "never"),
    );

    const clientClosed = client.waitForClose();
    await fixture.server.close();
    await clientClosed;
    servers.delete(fixture.server);

    const restarted = await startFixture({ homeDirectory: fixture.homeDirectory });
    const session = await restarted.runtime.storage.openSession(created.sessionId);
    expect((await session.getRun(runId))?.state).toBe("interrupted");
    const events = await session.getEventsAfter(0);
    const stepInterrupted = events.find(
      (event) =>
        event.eventType === "provider.step.interrupted" && event.data.runId === runId,
    );
    const runInterrupted = events.find(
      (event) => event.eventType === "run.interrupted" && event.data.runId === runId,
    );
    if (stepInterrupted?.eventType !== "provider.step.interrupted") {
      throw new Error("Shutdown provider interruption event is missing");
    }
    if (runInterrupted?.eventType !== "run.interrupted") {
      throw new Error("Shutdown run interruption event is missing");
    }
    expect(runInterrupted.data.diagnosticId).toBe(stepInterrupted.data.diagnosticId);
    expect(fixture.records).toContainEqual(
      expect.objectContaining({
        event: "provider_operation_failed",
        diagnosticId: stepInterrupted.data.diagnosticId,
        sessionId: created.sessionId,
        runId,
        state: "interrupted",
        code: "provider.cancelled",
      }),
    );
    expect(
      fixture.records.some(
        (record) => record.event === "run_task_failed" && record.runId === runId,
      ),
    ).toBe(false);
    expect(restarted.server.gateway.connectionSnapshots).toHaveLength(0);
  });

  it("terminates a peer that stops answering protocol Ping frames", async () => {
    const fixture = await startFixture({
      gateway: { heartbeat: { intervalMs: 20, helloTimeoutMs: 200 } },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    client.socket.pong = () => undefined;
    await hello(client, "missedPong");

    expect((await client.waitForClose()).code).toBe(1006);
    await eventually(() => expect(fixture.server.gateway.connectionSnapshots).toEqual([]));
  });

  it("keeps client and server heartbeats out of durable session history", async () => {
    const fixture = await startFixture({
      gateway: { heartbeat: { intervalMs: 20, helloTimeoutMs: 200 } },
    });
    const { cookie } = await bootstrap(fixture.server);
    const client = await connect(fixture.server, cookie);
    await hello(client, "heartbeatPersistence");
    const created = await createSession(client, "heartbeatPersistence");
    if (created.sessionId === undefined) throw new Error("Session creation failed");
    const session = await fixture.runtime.storage.openSession(created.sessionId);
    const headBefore = await session.getHeadSequence();

    client.send({ v: 1, kind: "heartbeat", clientTimeMs: 1 });
    await client.takeKind("heartbeat");
    await eventually(() => {
      expect(client.all.filter((message) => message.kind === "heartbeat").length).toBeGreaterThan(1);
    });

    expect(await session.getHeadSequence()).toBe(headBefore);
    expect(await session.getEventsAfter(headBefore)).toEqual([]);
    await client.close();
  });

  it("cleans heartbeat timers and rejects a connection that never sends hello", async () => {
    const fixture = await startFixture({
      gateway: { heartbeat: { intervalMs: 20, helloTimeoutMs: 40 } },
    });
    const { cookie } = await bootstrap(fixture.server);
    const invalid = await connect(fixture.server, cookie);
    expect((await invalid.waitForClose()).code).toBe(1008);

    const client = await connect(fixture.server, cookie);
    await hello(client, "heartbeat");
    expect(fixture.server.gateway.connectionSnapshots).toEqual([
      expect.objectContaining({ heartbeatActive: true, closed: false }),
    ]);
    await client.close();
    await eventually(() => {
      expect(fixture.server.gateway.connectionSnapshots).toHaveLength(0);
    });
  });
});
