import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommandIdSchema,
  CredentialRecoveryCommandStatusSchema,
  CredentialRecoveryExpectedSafeMetadataSchema,
  CredentialRecoveryScanResultSchema,
  MAXIMUM_BOOTSTRAP_SESSIONS,
  ProviderConnectionIdSchema,
  ProviderConnectionListSchema,
  ProviderCapabilitiesSnapshotSchema,
  RecoveryEpochIdSchema,
  type CredentialRecoveryExpectedSafeMetadata,
} from "@wi/protocol";
import type { WiRuntime } from "../composition.js";
import { nonThrowingLogger, type Logger } from "../logging/logger.js";
import { LocalBrowserAuth, handleBootstrap } from "./bootstrap.js";
import { handleHealth } from "./health.js";
import { correlatedHttpError, endRawHttpError } from "./rejection.js";
import { assetFoundationRejection, serveStaticAsset } from "./static.js";
import {
  WebSocketGateway,
  type WebSocketGatewayOptions,
} from "../websocket/gateway.js";
import { LoopbackRequestPolicy } from "../websocket/origin-policy.js";

export const MAX_HTTP_SHUTDOWN_TIMEOUT_MS = 30_000;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
].join("; ");

type ServerLifecycleState = "idle" | "starting" | "started" | "closing" | "closed";
type WiServerGatewayOptions = Omit<
  WebSocketGatewayOptions,
  "runtime" | "auth" | "requestPolicy" | "logger"
>;

const FORBIDDEN_GATEWAY_OPTION_KEYS = [
  "runtime",
  "auth",
  "requestPolicy",
  "logger",
] as const;

function parseGatewayOptions(value: unknown): WiServerGatewayOptions | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Wi server gateway options must be an object");
  }
  for (const key of FORBIDDEN_GATEWAY_OPTION_KEYS) {
    if (Object.hasOwn(value, key)) {
      throw new TypeError(`Wi server gateway option ${key} is reserved`);
    }
  }
  return value as WiServerGatewayOptions;
}

export interface WiServerOptions {
  readonly runtime: WiRuntime;
  readonly host?: "127.0.0.1";
  readonly port?: number;
  readonly httpShutdownTimeoutMs?: number;
  readonly webRoot?: string;
  readonly gateway?: WiServerGatewayOptions;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function uniqueBoundedHeader(
  request: IncomingMessage,
  name: string,
  maximumBytes: number,
): string | null {
  let value: string | null = null;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
    const candidate = request.rawHeaders[index + 1];
    if (value !== null || candidate === undefined || Buffer.byteLength(candidate) > maximumBytes) {
      return null;
    }
    value = candidate;
  }
  return value;
}

function recoveryStatusExpectedMetadata(
  request: IncomingMessage,
): CredentialRecoveryExpectedSafeMetadata | null {
  const operationKind = uniqueBoundedHeader(
    request,
    "x-wi-recovery-operation-kind",
    64,
  );
  const encoded = uniqueBoundedHeader(
    request,
    "x-wi-recovery-expected-metadata",
    8 * 1_024,
  );
  if (operationKind !== "credential_recovery" || encoded === null) return null;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength > 6 * 1_024 || bytes.toString("base64") !== encoded) return null;
    return CredentialRecoveryExpectedSafeMetadataSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

export class WiServer {
  readonly runtime: WiRuntime;
  private readonly logger: Logger;
  private readonly host: "127.0.0.1";
  private readonly port: number;
  private readonly httpShutdownTimeoutMs: number;
  private readonly webRoot: string;
  private readonly auth = new LocalBrowserAuth();
  private readonly requestPolicy: LoopbackRequestPolicy;
  private readonly httpServer: NodeHttpServer;
  private readonly httpConnections = new Set<Socket>();
  readonly gateway: WebSocketGateway;
  private lifecycleState: ServerLifecycleState = "idle";
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private httpListenerClosePromise: Promise<void> | null = null;

  constructor(options: WiServerOptions) {
    this.runtime = options.runtime;
    this.logger = nonThrowingLogger(this.runtime.logger);
    const host: unknown = options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1") {
      throw new RangeError("Wi server host must be exactly 127.0.0.1");
    }
    this.host = host;
    this.port = options.port ?? 4317;
    if (!Number.isSafeInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new RangeError("Server port must be an integer between 0 and 65535");
    }
    this.httpShutdownTimeoutMs = options.httpShutdownTimeoutMs ?? 2_000;
    if (
      !Number.isSafeInteger(this.httpShutdownTimeoutMs) ||
      this.httpShutdownTimeoutMs < 1 ||
      this.httpShutdownTimeoutMs > MAX_HTTP_SHUTDOWN_TIMEOUT_MS
    ) {
      throw new RangeError(
        `HTTP shutdown timeout must be a positive safe integer no greater than ${MAX_HTTP_SHUTDOWN_TIMEOUT_MS}`,
      );
    }
    const configuredWebRoot: unknown = options.webRoot;
    if (configuredWebRoot !== undefined && typeof configuredWebRoot !== "string") {
      throw new TypeError("Wi server web root must be a string");
    }
    this.webRoot = resolve(
      configuredWebRoot ?? fileURLToPath(new URL("../../../web/dist", import.meta.url)),
    );
    const gatewayOptions = parseGatewayOptions(options.gateway);
    this.requestPolicy = new LoopbackRequestPolicy();
    this.gateway = new WebSocketGateway({
      ...gatewayOptions,
      runtime: this.runtime,
      auth: this.auth,
      requestPolicy: this.requestPolicy,
      logger: this.logger,
    });
    this.httpServer = createServer(
      {
        maxHeaderSize: 16 * 1_024,
        headersTimeout: 5_000,
        requestTimeout: 10_000,
        keepAliveTimeout: 5_000,
      },
      (request, response) => this.handleRequest(request, response),
    );
    this.httpServer.on("connection", (socket) => {
      this.httpConnections.add(socket);
      socket.once("close", () => this.httpConnections.delete(socket));
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      // From upgrade entry onward, the gateway owns accepted and rejected raw sockets.
      this.httpConnections.delete(socket as Socket);
      this.gateway.handleUpgrade(request, socket, head);
    });
    this.httpServer.on("clientError", (error, socket) => {
      const diagnosticId = this.runtime.diagnosticId();
      this.logger.error("http_client_error", error, {
        diagnosticId,
        parserCode:
          "code" in error && typeof error.code === "string" ? error.code : undefined,
      });
      endRawHttpError(
        socket,
        400,
        correlatedHttpError(
          "http.invalid_request",
          "The HTTP request could not be parsed.",
          diagnosticId,
        ),
      );
    });
  }

  get address(): AddressInfo | null {
    const value = this.httpServer.address();
    return value !== null && typeof value === "object" ? value : null;
  }

  get origin(): string {
    const address = this.address;
    if (address === null) throw new Error("Server is not listening");
    return `http://${this.host}:${address.port}`;
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise;
    if (this.lifecycleState === "closing" || this.lifecycleState === "closed") {
      return Promise.reject(new Error("Cannot start a server that is closing or closed"));
    }
    this.lifecycleState = "starting";
    this.startPromise = this.finishStart();
    return this.startPromise;
  }

  private async finishStart(): Promise<void> {
    try {
      await this.runtime.ready();
      // close() may win while storage is becoming ready. In that case startup is cancelled
      // before a listener is created, and both callers can finish without leaking a socket.
      if (this.lifecycleState !== "starting") return;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          this.httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          this.httpServer.off("error", onError);
          resolve();
        };
        this.httpServer.once("error", onError);
        this.httpServer.once("listening", onListening);
        this.httpServer.listen(this.port, this.host);
      });
      if (this.lifecycleState !== "starting") return;
      const address = this.address;
      if (address === null) throw new Error("HTTP server started without a network address");
      this.requestPolicy.setListeningPort(address.port);
      this.lifecycleState = "started";
      this.logger.info("server_started", {
        host: this.host,
        port: address.port,
      });
    } catch (error) {
      const cleanupErrors = await this.cleanupFailedStart();
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Wi server startup and cleanup failed",
        );
      }
      throw error;
    }
  }

  private closeHttpListener(): Promise<void> {
    if (this.httpListenerClosePromise !== null) return this.httpListenerClosePromise;
    if (!this.httpServer.listening) return Promise.resolve();
    const gracefulClose = new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    this.httpListenerClosePromise = this.finishHttpListenerClose(gracefulClose);
    return this.httpListenerClosePromise;
  }

  private async finishHttpListenerClose(gracefulClose: Promise<void>): Promise<void> {
    const observedClose = gracefulClose.then(
      () => ({ outcome: "closed" as const }),
      (error: unknown) => ({ outcome: "failed" as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ readonly outcome: "timeout" }>((resolve) => {
      timer = setTimeout(
        () => resolve({ outcome: "timeout" }),
        this.httpShutdownTimeoutMs,
      );
      timer.unref();
    });
    const outcome = await Promise.race([observedClose, deadline]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.outcome === "closed") return;
    if (outcome.outcome === "failed") throw outcome.error;

    const connectionCount = this.httpConnections.size;
    this.httpServer.closeAllConnections();
    for (const socket of this.httpConnections) socket.destroy();
    this.httpConnections.clear();
    try {
      this.logger.warn("http_shutdown_forced", {
        diagnosticId: this.runtime.diagnosticId(),
        connectionCount,
      });
    } catch {
      // Monitoring cannot prevent bounded socket cleanup.
    }
    // Give local destroy callbacks one turn, but never reintroduce an unbounded wait.
    await Promise.race([
      observedClose,
      new Promise<void>((resolve) => setImmediate(resolve)),
    ]);
  }

  private async cleanupFailedStart(): Promise<unknown[]> {
    const errors: unknown[] = [];
    this.lifecycleState = "closing";
    this.gateway.stopAccepting();
    this.runtime.stopAcceptingCommands();
    const httpClose = this.closeHttpListener();
    try {
      await this.gateway.shutdown();
    } catch (error) {
      errors.push(error);
    }
    try {
      await httpClose;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.runtime.close();
    } catch (error) {
      errors.push(error);
    }
    this.lifecycleState = "closed";
    return errors;
  }

  private rejectHttp(
    response: ServerResponse,
    statusCode: number,
    code: string,
    message: string,
    reason: string,
  ): void {
    const diagnosticId = this.runtime.diagnosticId();
    this.logger.warn("http_request_rejected", {
      diagnosticId,
      statusCode,
      code,
      reason,
    });
    response.setHeader("x-wi-diagnostic-id", diagnosticId);
    writeJson(response, statusCode, { code, message, diagnosticId });
  }

  private internalHttpFailure(response: ServerResponse, error: unknown, operation: string): void {
    if (response.headersSent || response.writableEnded) return;
    const diagnosticId = this.runtime.diagnosticId();
    this.logger.error("http_request_failed", error, { diagnosticId, operation });
    response.setHeader("x-wi-diagnostic-id", diagnosticId);
    writeJson(response, 500, {
      code: "http.internal_error",
      message: "The request could not be completed.",
      diagnosticId,
    });
  }

  private async serveBootstrap(response: ServerResponse): Promise<void> {
    try {
      const catalogSessions = await this.runtime.storage.catalog.listBrowserSessionsBounded(
        MAXIMUM_BOOTSTRAP_SESSIONS + 1,
      );
      const sessionsTruncated = catalogSessions.length > MAXIMUM_BOOTSTRAP_SESSIONS;
      handleBootstrap(
        response,
        this.auth,
        catalogSessions.slice(0, MAXIMUM_BOOTSTRAP_SESSIONS),
        sessionsTruncated,
        this.gateway.browserCommandLimits,
      );
    } catch (error) {
      this.internalHttpFailure(response, error, "bootstrap");
    }
  }

  private async serveProviderRead(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    try {
      if (pathname === "/api/provider-connections") {
        writeJson(
          response,
          200,
          ProviderConnectionListSchema.parse(
            await this.runtime.providerConnections.listSafeConnections(),
          ),
        );
        return;
      }
      if (pathname === "/api/provider-connections/recovery-scan") {
        writeJson(
          response,
          200,
          CredentialRecoveryScanResultSchema.parse(
            await this.runtime.providerConnections.startRecoveryScan(),
          ),
        );
        return;
      }
      const recoveryStatusMatch = /^\/api\/provider-connections\/recovery-commands\/([^/]+)\/([^/]+)$/u.exec(pathname);
      if (recoveryStatusMatch !== null) {
        const commandId = CommandIdSchema.safeParse(recoveryStatusMatch[1]);
        const recoveryEpochId = RecoveryEpochIdSchema.safeParse(recoveryStatusMatch[2]);
        if (!commandId.success || !recoveryEpochId.success) {
          this.rejectHttp(response, 400, "http.invalid_target", "The recovery command status target is invalid.", "invalid_recovery_status_target");
          return;
        }
        const expectedSafeMetadata = recoveryStatusExpectedMetadata(request);
        if (expectedSafeMetadata === null) {
          this.rejectHttp(
            response,
            400,
            "http.invalid_target",
            "The recovery command status metadata is invalid.",
            "invalid_recovery_status_metadata",
          );
          return;
        }
        writeJson(response, 200, CredentialRecoveryCommandStatusSchema.parse(
          await this.runtime.providerConnections.recoveryCommandStatus(
            commandId.data,
            recoveryEpochId.data,
            expectedSafeMetadata,
          ),
        ));
        return;
      }
      const match = /^\/api\/provider-connections\/([^/]+)\/capabilities$/u.exec(pathname);
      if (match !== null) {
        const connectionId = ProviderConnectionIdSchema.safeParse(match[1]);
        if (!connectionId.success) {
          this.rejectHttp(response, 400, "http.invalid_target", "The provider connection ID is invalid.", "invalid_provider_connection_id");
          return;
        }
        const capabilities = await this.runtime.storage.catalog.getProviderCapabilities(connectionId.data);
        if (capabilities === null) {
          this.rejectHttp(response, 404, "provider.capabilities_unavailable", "Provider capabilities are unavailable.", "capabilities_unavailable");
          return;
        }
        writeJson(response, 200, ProviderCapabilitiesSnapshotSchema.parse(capabilities));
        return;
      }
      this.rejectHttp(response, 404, "http.not_found", "Route not found.", "route_not_found");
    } catch (error) {
      this.internalHttpFailure(response, error, "provider_read");
    }
  }

  private async serveApplication(response: ServerResponse, pathname: string): Promise<void> {
    try {
      if ((await serveStaticAsset(response, pathname, this.webRoot)) === "served") return;
      const assetRejection = assetFoundationRejection(pathname);
      if (assetRejection !== null) {
        this.rejectHttp(
          response,
          assetRejection.statusCode,
          assetRejection.code,
          assetRejection.message,
          assetRejection.reason,
        );
        return;
      }
      this.rejectHttp(response, 404, "http.not_found", "Route not found.", "route_not_found");
    } catch (error) {
      this.internalHttpFailure(response, error, "static_asset");
    }
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    securityHeaders(response);
    if (!this.requestPolicy.validateHttpHost(request)) {
      this.rejectHttp(
        response,
        421,
        "http.invalid_host",
        "The Host header is not allowed.",
        "invalid_host",
      );
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      this.rejectHttp(
        response,
        405,
        "http.method_not_allowed",
        "This HTTP method is not allowed.",
        "method_not_allowed",
      );
      return;
    }
    const requestTarget = request.url;
    if (
      requestTarget === undefined ||
      requestTarget.length > 4_096 ||
      !requestTarget.startsWith("/")
    ) {
      this.rejectHttp(
        response,
        400,
        "http.invalid_target",
        "The request target is invalid.",
        "invalid_target",
      );
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(requestTarget, "http://localhost").pathname;
    } catch {
      this.rejectHttp(
        response,
        400,
        "http.invalid_target",
        "The request target is invalid.",
        "invalid_target",
      );
      return;
    }

    if (pathname === "/health") {
      handleHealth(response);
      return;
    }
    if (pathname === "/bootstrap") {
      void this.serveBootstrap(response);
      return;
    }
    if (pathname.startsWith("/api/provider-connections")) {
      if (!this.auth.authenticate(request.headers.cookie)) {
        this.rejectHttp(response, 401, "http.unauthorized", "Browser authentication is required.", "unauthorized");
        return;
      }
      void this.serveProviderRead(request, response, pathname);
      return;
    }
    if (pathname === "/ws") {
      this.rejectHttp(
        response,
        426,
        "websocket.upgrade_required",
        "A WebSocket upgrade is required.",
        "websocket_upgrade_required",
      );
      return;
    }
    if (
      (pathname.startsWith("/blobs/") || pathname.startsWith("/files/")) &&
      !this.auth.authenticate(request.headers.cookie)
    ) {
      this.rejectHttp(
        response,
        401,
        "http.unauthorized",
        "Browser authentication is required.",
        "unauthorized",
      );
      return;
    }
    void this.serveApplication(response, pathname);
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.lifecycleState = "closing";
    this.gateway.stopAccepting();
    this.runtime.stopAcceptingCommands();
    const httpClose = this.httpServer.listening ? this.closeHttpListener() : null;
    const deadlineAtMs = Date.now() + this.runtime.getShutdownDeadlineMs();
    this.closePromise = this.finishClose(httpClose, deadlineAtMs);
    return this.closePromise;
  }

  private async finishClose(initialHttpClose: Promise<void> | null, deadlineAtMs: number): Promise<void> {
    const errors: unknown[] = [];
    const withinDeadline = async (component: string, operation: Promise<void>): Promise<void> => {
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) throw new Error(`Shutdown deadline elapsed before ${component}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${component} exceeded shutdown deadline`)), remaining);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    // Startup can itself be blocked on storage recovery. close() has already
    // changed lifecycleState, so a later startup completion cannot open the
    // listener; cleanup must not wait for that blocked promise.
    const httpClose = initialHttpClose ?? this.closeHttpListener();
    try {
      await withinDeadline("gateway", this.gateway.shutdown());
    } catch (error) {
      errors.push(error);
    }
    try {
      await withinDeadline("http", httpClose);
    } catch (error) {
      errors.push(error);
    }
    try {
      // Runtime receives the same server-owned absolute deadline, not a fresh budget.
      await this.runtime.close(deadlineAtMs);
    } catch (error) {
      errors.push(error);
    }
    this.lifecycleState = "closed";
    if (errors.length > 0) throw new AggregateError(errors, "Wi server shutdown failed");
  }
}
