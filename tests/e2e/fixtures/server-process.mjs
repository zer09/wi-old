import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { JsonLogger, WiRuntime, WiServer } from "../../../apps/server/dist/index.js";
import {
  CredentialProvisioner,
  FileCredentialStore,
  StoredCredential,
  initializeCredentialRoots,
} from "../../../packages/credentials/dist/index.js";
import { FakeProviderAdapter, fakeProviderGateLabel } from "../../../packages/provider-fake/dist/index.js";
import { MAXIMUM_BOOTSTRAP_SESSIONS } from "../../../packages/protocol/dist/index.js";
import { sessionWorkerPoolForTest } from "../../../packages/storage/dist/testing.js";
import { ToolExecutor } from "../../../packages/tools/dist/index.js";

const [
  homeDirectory,
  frameMaximumBytesArgument,
  fixedPortArgument,
  frameMaximumDepthArgument,
  replayLiveEventsArgument,
  recoveryModeArgument,
  providerScenarioArgument,
] = process.argv.slice(2);
if (homeDirectory === undefined || typeof process.send !== "function") process.exit(64);
const credentialStateRoot = `${homeDirectory}-credential-state`;
const credentialRoot = join(credentialStateRoot, "wi", "credentials");
const stagingRoot = join(credentialStateRoot, "wi", "credential-staging");
if (recoveryModeArgument === "recovery") {
  await initializeCredentialRoots({
    wiHome: homeDirectory,
    credentialRoot,
    stagingRoot,
  });
  await new FileCredentialStore(credentialRoot).put(
    "credref_e2eRecovery",
    new StoredCredential({
      version: 1,
      envelopeId: "envl_e2eRecovery",
      connectionId: "pconn_e2eRecovery",
      providerId: "openai_platform",
      authMode: "api_key",
      generation: 2,
      updatedAtMs: 10,
      identity: { status: "unverified" },
      credential: { type: "api_key", apiKey: "e2e-recovery-private-key" },
    }),
  );
}

const optionalNumber = (value) =>
  value === undefined || value === "-" ? undefined : Number(value);
const frameMaximumBytes = optionalNumber(frameMaximumBytesArgument);
const fixedPort = optionalNumber(fixedPortArgument);
const frameMaximumDepth = optionalNumber(frameMaximumDepthArgument);
const replayLiveEvents = optionalNumber(replayLiveEventsArgument);
if (
  (frameMaximumBytes !== undefined &&
    (!Number.isSafeInteger(frameMaximumBytes) || frameMaximumBytes < 1)) ||
  (fixedPort !== undefined && (!Number.isSafeInteger(fixedPort) || fixedPort < 1)) ||
  (frameMaximumDepth !== undefined &&
    (!Number.isSafeInteger(frameMaximumDepth) || frameMaximumDepth < 1)) ||
  (replayLiveEvents !== undefined &&
    (!Number.isSafeInteger(replayLiveEvents) || replayLiveEvents < 1))
) {
  process.exit(65);
}

const send = (message) => process.send?.(message);
const auditSecret = "AUDIT_MILESTONE9_SECRET";
const logPath = join(homeDirectory, "e2e-server.log");
const toolExecutionPath = join(homeDirectory, "e2e-tool-executions.log");
const logger = new JsonLogger({
  write: (record) => appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8"),
});
logger.info("e2e_secret_probe", {
  authorization: `Bearer ${auditSecret}`,
  cookie: auditSecret,
});
const providerRequests = [];
const providerControllersByRun = new Map();
const releasedProviderRuns = new Set();
const acceptedMessages = new Map();
const acknowledgementGates = new Map();
const blockedAcknowledgementCommands = new Set();
const beforeRouteGates = new Map();
const lifecyclePrepareGates = new Map();
let recoveryBeforeRouteArmed = false;
let lifecyclePrepareArmed = false;
let armedProviderFailpoint = null;
const blockedBeforeRouteCommands = new Set();
const replayGates = new Map();
const armedReplaySessions = new Set();
const approvalAcknowledgementGates = new Map();
const approvalRaceGates = new Map();
let approvalAcknowledgementArmed = false;
let approvalRaceArmed = false;
let routedCommandCount = 0;

const dynamicProviderFailpoints = {
  name: "after_recovery_admission",
  exitCode: 199,
  is: (name) => armedProviderFailpoint === name,
  matches: (name) => armedProviderFailpoint === name,
  takeRunIdForCommand: () => null,
  hit: (name) => {
    if (armedProviderFailpoint !== name) return;
    armedProviderFailpoint = null;
    process.kill(process.pid, "SIGKILL");
  },
};

class E2EProvider extends FakeProviderAdapter {
  async *stream(request, context, signal) {
    providerRequests.push(request);
    providerControllersByRun.set(request.runId, this.controller);
    send({
      type: "provider-request",
      runId: request.runId,
      sessionId: context.sessionId,
      scenario: request.providerConfig?.scenario,
    });
    const userText = request.input.findLast(
      (item) => item.type === "message" && item.role === "user",
    )?.text;
    if (userText?.startsWith("[xss]") && request.stepIndex === 0) {
      yield {
        type: "response.started",
        runId: request.runId,
        stepId: request.stepId,
        stepIndex: request.stepIndex,
        responseId: `response_${request.runId}_xss`,
      };
      yield {
        type: "text.delta",
        runId: request.runId,
        stepId: request.stepId,
        stepIndex: request.stepIndex,
        delta: '<img src=x onerror="globalThis.__wiXss=1"><script>globalThis.__wiXss=2</script>javascript:alert(1)',
      };
      yield {
        type: "response.completed",
        runId: request.runId,
        stepId: request.stepId,
        stepIndex: request.stepIndex,
        responseId: `response_${request.runId}_xss`,
      };
      return;
    }
    yield* super.stream(request, context, signal);
  }
}

const provider = new E2EProvider();
const providerConnectionFixtureProvider = new E2EProvider({ id: "openai_platform" });
const runtime = new WiRuntime({
  homeDirectory,
  logger,
  credentialRoots: { credentialRoot, stagingRoot },
  provider,
  ...(process.env.WI_E2E_PROVIDER_CONNECTION_FIXTURE === "1"
    ? {
        providerConnectionFixture: {
          provider: providerConnectionFixtureProvider,
          ...(providerScenarioArgument === undefined || providerScenarioArgument === "-"
            ? {}
            : { providerConfiguration: { scenario: providerScenarioArgument } }),
          afterLifecyclePrepare: async (operationKind, commandId, connectionId) => {
            if (!lifecyclePrepareArmed || !["replace", "enable"].includes(operationKind)) return;
            lifecyclePrepareArmed = false;
            send({ type: "lifecycle-prepare-blocked", commandId, connectionId });
            await new Promise((resolve) => lifecyclePrepareGates.set(commandId, resolve));
          },
          capabilitiesForConnection: (connection) => {
            const modelSuffix = connection.displayName.includes("Model B") ? "b" : "a";
            return {
              version: 1,
              connectionId: connection.connectionId,
              providerId: connection.providerId,
              authMode: connection.authMode,
              capabilitiesVersion: `capver_e2e_${modelSuffix}`,
              models: [{
                modelId: `fixture-model-${modelSuffix}`,
                label: `Fixture model ${modelSuffix.toUpperCase()}`,
                reasoningEfforts: ["none"],
                reasoningSummary: false,
                tools: true,
                transports: ["no_network_fixture"],
              }],
              promptCaching: false,
              usage: false,
              opaqueState: false,
              compaction: false,
              retrievalSource: "server_fixture",
              retrievedAtMs: 1,
              status: "current",
            };
          },
        },
      }
    : {}),
  ...(process.env.WI_E2E_PROVIDER_CONNECTION_FIXTURE === "1"
    ? { testFailpoints: dynamicProviderFailpoints }
    : {}),
  toolExecutor: new ToolExecutor({
    onExecutionStart: ({ sessionId, runId, callId }) => {
      appendFileSync(
        toolExecutionPath,
        `${JSON.stringify({ sessionId, runId, callId })}\n`,
        "utf8",
      );
    },
  }),
  storage: { sessionWorkers: { allowTestOperations: true } },
  selectProviderConfiguration: (command) => {
    const text = command.params.text;
    if (text.startsWith("[slow]")) return { scenario: "slow-stream" };
    if (text.startsWith("[echo]")) return { scenario: "echo-tool-round-trip" };
    if (text.startsWith("[approval]")) return { scenario: "approval-round-trip" };
    if (text.startsWith("[partial]")) return { scenario: "partial-tool-call-without-terminal" };
    if (text.startsWith("[interrupt]")) return { scenario: "failure-after-visible-output" };
    return { scenario: "plain-text" };
  },
});
if (process.env.WI_E2E_REVALIDATE_INITIAL === "1") {
  delete process.env.WI_E2E_REVALIDATE_KEY;
}
const server = new WiServer({
  runtime,
  port: fixedPort ?? 0,
  gateway: {
    ...(frameMaximumBytes === undefined &&
    frameMaximumDepth === undefined &&
    replayLiveEvents === undefined
      ? {}
      : {
          limits: {
            ...(frameMaximumBytes === undefined && frameMaximumDepth === undefined
              ? {}
              : {
                  frame: {
                    ...(frameMaximumBytes === undefined
                      ? {}
                      : { maximumBytes: frameMaximumBytes }),
                    ...(frameMaximumDepth === undefined
                      ? {}
                      : { maximumDepth: frameMaximumDepth }),
                  },
                }),
            ...(replayLiveEvents === undefined ? {} : { replayLiveEvents }),
          },
        }),
    commandHooks: {
      beforeRoute: async (command) => {
        routedCommandCount += 1;
        if (command.method.startsWith("providerConnection.")) {
          send({
            type: "provider-command-routed",
            method: command.method,
            commandId: command.commandId,
          });
        }
        if (command.method === "providerConnection.recover" && recoveryBeforeRouteArmed) {
          recoveryBeforeRouteArmed = false;
          send({ type: "recovery-before-route-blocked", commandId: command.commandId });
          await new Promise((resolve) => beforeRouteGates.set(command.commandId, resolve));
        }
        if (
          command.method === "message.submit" &&
          command.params.text.startsWith("[before-route]")
        ) {
          if (blockedBeforeRouteCommands.has(command.commandId)) {
            send({ type: "before-route-retried", commandId: command.commandId });
          } else {
            blockedBeforeRouteCommands.add(command.commandId);
            send({ type: "before-route-blocked", commandId: command.commandId });
            await new Promise((resolve) => beforeRouteGates.set(command.commandId, resolve));
          }
        }
        if (command.method === "approval.resolve" && approvalRaceArmed) {
          send({
            type: "approval-race-blocked",
            commandId: command.commandId,
            count: approvalRaceGates.size + 1,
          });
          await new Promise((resolve) => approvalRaceGates.set(command.commandId, resolve));
        }
      },
      afterRouteBeforeSend: async (command, accepted) => {
        if (command.method === "message.submit" && accepted.runId !== undefined) {
          acceptedMessages.set(command.params.text, {
            commandId: command.commandId,
            runId: accepted.runId,
          });
        }
        if (
          command.method === "message.submit" &&
          command.params.text.startsWith("[lost-ack]") &&
          !blockedAcknowledgementCommands.has(command.commandId)
        ) {
          blockedAcknowledgementCommands.add(command.commandId);
          send({ type: "acknowledgement-blocked", commandId: command.commandId });
          await new Promise((resolve) => acknowledgementGates.set(command.commandId, resolve));
        }
        if (command.method === "approval.resolve" && approvalAcknowledgementArmed) {
          approvalAcknowledgementArmed = false;
          send({ type: "approval-acknowledgement-blocked", commandId: command.commandId });
          await new Promise((resolve) =>
            approvalAcknowledgementGates.set(command.commandId, resolve),
          );
        }
      },
    },
    replayHooks: {
      afterHistoricalRead: async (sessionId) => {
        if (!armedReplaySessions.delete(sessionId)) return;
        send({ type: "replay-blocked", sessionId });
        await new Promise((resolve) => replayGates.set(sessionId, resolve));
      },
    },
  },
});
await server.start();
send({ type: "ready", origin: server.origin, pid: process.pid });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const gates of [
    acknowledgementGates,
    beforeRouteGates,
    lifecyclePrepareGates,
    replayGates,
    approvalAcknowledgementGates,
    approvalRaceGates,
  ]) {
    for (const release of gates.values()) release();
    gates.clear();
  }
  try {
    await server.close();
    send({ type: "closed" });
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
}

process.on("message", (message) => {
  if (message === null || typeof message !== "object") return;
  void (async () => {
    switch (message.type) {
      case "restore-provider-environment": {
        if (typeof message.requestId !== "string") {
          throw new Error("Provider environment restore request is invalid");
        }
        process.env.WI_E2E_REVALIDATE_KEY = "e2e-restored-environment-value";
        send({ type: "provider-environment-restored", requestId: message.requestId });
        return;
      }
      case "stage-provider-key": {
        if (typeof message.requestId !== "string" || typeof message.label !== "string") {
          throw new Error("Provider stage request is invalid");
        }
        const staged = await new CredentialProvisioner(stagingRoot).stageApiKey(
          "openai_platform",
          "api_key",
          `e2e-${message.label}-private-key`,
        );
        send({
          type: "provider-key-staged",
          requestId: message.requestId,
          provisioningRef: staged.provisioningRef,
        });
        return;
      }
      case "disconnect":
        send({
          type: "disconnected",
          requestId: message.requestId,
          count: server.gateway.disconnectActiveConnections(
            message.code ?? 1012,
            message.reason ?? "E2E forced reconnect",
          ),
        });
        return;
      case "release-ack": {
        const release = acknowledgementGates.get(message.commandId);
        acknowledgementGates.delete(message.commandId);
        release?.();
        return;
      }
      case "arm-recovery-before-route":
        recoveryBeforeRouteArmed = true;
        send({ type: "recovery-before-route-armed", requestId: message.requestId });
        return;
      case "arm-provider-failpoint":
        armedProviderFailpoint = message.name;
        send({ type: "provider-failpoint-armed", requestId: message.requestId, name: message.name });
        return;
      case "arm-lifecycle-prepare":
        lifecyclePrepareArmed = true;
        send({ type: "lifecycle-prepare-armed", requestId: message.requestId });
        return;
      case "release-lifecycle-prepare": {
        const release = lifecyclePrepareGates.get(message.commandId);
        lifecyclePrepareGates.delete(message.commandId);
        release?.();
        return;
      }
      case "release-before-route": {
        const release = beforeRouteGates.get(message.commandId);
        beforeRouteGates.delete(message.commandId);
        release?.();
        return;
      }
      case "arm-replay":
        armedReplaySessions.add(message.sessionId);
        send({ type: "replay-armed", requestId: message.requestId });
        return;
      case "release-replay": {
        const release = replayGates.get(message.sessionId);
        replayGates.delete(message.sessionId);
        release?.();
        send({ type: "replay-released", requestId: message.requestId });
        return;
      }
      case "connection-snapshots":
        send({
          type: "connection-snapshots",
          requestId: message.requestId,
          snapshots: server.gateway.connectionSnapshots,
        });
        return;
      case "arm-approval-acknowledgement":
        approvalAcknowledgementArmed = true;
        send({ type: "approval-acknowledgement-armed", requestId: message.requestId });
        return;
      case "release-approval-acknowledgement": {
        const release = approvalAcknowledgementGates.get(message.commandId);
        approvalAcknowledgementGates.delete(message.commandId);
        release?.();
        return;
      }
      case "arm-approval-race":
        approvalRaceArmed = true;
        send({ type: "approval-race-armed", requestId: message.requestId });
        return;
      case "release-approval-race":
        approvalRaceArmed = false;
        for (const release of approvalRaceGates.values()) release();
        approvalRaceGates.clear();
        return;
      case "release-provider": {
        const scenario = message.gate === "partial" ? "partial-tool-call-without-terminal" : "slow-stream";
        for (const request of providerRequests) {
          if (
            request.providerConfig?.scenario !== scenario ||
            releasedProviderRuns.has(request.runId)
          ) continue;
          const label = fakeProviderGateLabel(request.runId, message.gate);
          const controller = providerControllersByRun.get(request.runId) ?? provider.controller;
          await controller.waitUntilBlocked(label);
          controller.release(label);
          releasedProviderRuns.add(request.runId);
        }
        send({ type: "provider-released", requestId: message.requestId });
        return;
      }
      case "seed-bounded-session-index": {
        const title = "Omitted durable target";
        const omitted = await runtime.storage.createSession({
          v: 1,
          kind: "command",
          commandId: "cmd_e2eOmittedTarget",
          method: "session.create",
          params: { title },
        });
        const futureBase = Date.now() + 100_000;
        for (let index = 0; index < MAXIMUM_BOOTSTRAP_SESSIONS; index += 1) {
          await runtime.storage.catalog.createSessionIndex({
            sessionId: `ses_e2eBoundedVisible${index}`,
            projectId: null,
            dbRelativePath: `sessions/e2e-bounded-${index}/session.sqlite3`,
            title: `Visible bounded ${index}`,
            status: "ready",
            createdAtMs: futureBase + index,
            updatedAtMs: futureBase + index,
            lastEventSequence: 1,
            lastRunState: null,
            lastMessagePreview: null,
            requiresAttention: false,
            pendingApprovalCount: 0,
            pendingInputCount: 0,
            sessionSchemaVersion: 1,
          });
        }
        send({
          type: "bounded-session-index-seeded",
          requestId: message.requestId,
          omittedSessionId: omitted.session.sessionId,
          title,
        });
        return;
      }
      case "seed-unavailable-session": {
        const fallbackTitle = "Ready fallback must not open";
        const fallback = await runtime.storage.createSession({
          v: 1,
          kind: "command",
          commandId: "cmd_e2eUnavailableFallback",
          method: "session.create",
          params: { title: fallbackTitle },
        });
        const sessionId = "ses_e2eUnavailableTarget";
        const title = "Unavailable exact target";
        const now = Date.now() + 1;
        await runtime.storage.catalog.createSessionIndex({
          sessionId,
          projectId: null,
          dbRelativePath: "sessions/e2e-unavailable/session.sqlite3",
          title,
          status: "unavailable",
          createdAtMs: now,
          updatedAtMs: now,
          lastEventSequence: 0,
          lastRunState: null,
          lastMessagePreview: null,
          requiresAttention: false,
          pendingApprovalCount: 0,
          pendingInputCount: 0,
          sessionSchemaVersion: 1,
        });
        send({
          type: "unavailable-session-seeded",
          requestId: message.requestId,
          sessionId,
          title,
          fallbackSessionId: fallback.session.sessionId,
          fallbackTitle,
        });
        return;
      }
      case "command-route-count":
        send({
          type: "command-route-count",
          requestId: message.requestId,
          count: routedCommandCount,
        });
        return;
      case "provider-request-count":
        send({
          type: "provider-request-count",
          requestId: message.requestId,
          count: providerRequests.length,
        });
        return;
      case "provider-operation": {
        const operation = await runtime.storage.catalog.getProviderLifecycleOperation(
          message.commandId,
        );
        send({
          type: "provider-operation",
          requestId: message.requestId,
          phase: operation?.phase,
          targetConnectionId: operation?.targetConnectionId,
          result: operation?.result,
          failureCode: operation?.failureCode ?? null,
        });
        return;
      }
      case "accepted-message":
        send({
          type: "accepted-message",
          requestId: message.requestId,
          value: acceptedMessages.get(message.text) ?? null,
        });
        return;
      case "create-idle-session": {
        const created = await runtime.storage.createSession({
          v: 1,
          kind: "command",
          commandId: message.commandId,
          method: "session.create",
          params: { title: message.title },
        });
        send({
          type: "idle-session-created",
          requestId: message.requestId,
          sessionId: created.session.sessionId,
        });
        return;
      }
      case "tool-executions": {
        let executions = [];
        try {
          executions = readFileSync(toolExecutionPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        send({ type: "tool-executions", requestId: message.requestId, executions });
        return;
      }
      case "acceptance-storage": {
        const summaries = await runtime.storage.catalog.listSessions();
        const stats = await sessionWorkerPoolForTest(runtime.storage).getStats();
        send({
          type: "acceptance-storage",
          requestId: message.requestId,
          sessions: summaries.map(({ sessionId, dbRelativePath, title }) => ({
            sessionId,
            dbRelativePath,
            title,
          })),
          openSessionIds: stats.flatMap((value) => value.openSessionIds),
        });
        return;
      }
      case "mutate-event": {
        await runtime.storage.openSession(message.sessionId);
        let errorMessage = null;
        try {
          await sessionWorkerPoolForTest(runtime.storage).testMutateEvent(
            message.sessionId,
            message.action,
            1,
          );
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        send({
          type: "event-mutation",
          requestId: message.requestId,
          action: message.action,
          errorMessage,
        });
        return;
      }
      case "security-audit": {
        if (
          !Array.isArray(message.credentials) ||
          message.credentials.length === 0 ||
          message.credentials.some((value) => typeof value !== "string" || value.length === 0)
        ) {
          throw new Error("Security audit requires at least one browser credential");
        }
        const exportedSessions = [];
        for (const sessionId of message.sessionIds) {
          const session = await runtime.storage.openSession(sessionId);
          exportedSessions.push(await session.getEventsAfter(0));
        }
        const exportedCatalog = await runtime.storage.catalog.listSessions();
        let logs = "";
        let toolExecutions = "";
        try {
          logs = readFileSync(logPath, "utf8");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        try {
          toolExecutions = readFileSync(toolExecutionPath, "utf8");
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        const exports = JSON.stringify({ catalog: exportedCatalog, sessions: exportedSessions });
        const retainedArtifacts = `${logs}\n${toolExecutions}`;
        const containsCredential = (value) =>
          message.credentials.some((credential) => value.includes(credential));
        send({
          type: "security-audit",
          requestId: message.requestId,
          logsContainAuditSecret: logs.includes(auditSecret),
          exportsContainCredential: containsCredential(exports),
          retainedArtifactsContainCredential: containsCredential(retainedArtifacts),
        });
        return;
      }
      case "session-head": {
        const session = await runtime.storage.openSession(message.sessionId);
        send({
          type: "session-head",
          requestId: message.requestId,
          sequence: await session.getHeadSequence(),
        });
        return;
      }
      case "close":
        await close();
        return;
    }
  })().catch((error) => {
    send({
      type: "control-error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
