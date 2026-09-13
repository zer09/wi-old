import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  CredentialError,
  CredentialProvisioner,
  CredentialRecoveryScanner,
  type ClaimedCredentialVerifier,
  EnvironmentCredentialLeaseManager,
  FileCredentialStore,
  StoredCredential,
  initializeCredentialRoots,
  internalStagingRef,
  type CredentialFileIdentity,
  type CredentialRootOptions,
  type CredentialRoots,
  type CredentialWithFileIdentity,
  type EnvironmentCredentialLease,
} from "@wi/credentials";
import {
  ExplicitProviderRouter,
  ProviderRoutingError,
  authoritativeIdentityKey,
  normalizeAuthoritativeIdentity,
} from "@wi/provider-connections";
import {
  CanonicalJsonValueSchema,
  CredentialRecoveryExpectedSafeMetadataSchema,
  CredentialRecoveryScanResultSchema,
  ProviderConnectionSafeViewSchema,
  canonicalJson,
  canonicalJsonHash,
  type CommandAcceptedMessage,
  type CredentialRecoveryCommandStatus,
  type CredentialRecoveryExpectedSafeMetadata,
  type CredentialRecoveryScanResult,
  type ProviderCapabilitiesSnapshot,
  type ProviderConnectionSafeView,
  type RunProviderSelectionSnapshot,
  type SessionProviderDefault,
  type SessionProviderDefaultRequest,
} from "@wi/protocol";
import type {
  ProviderConnectionRecord,
  ProviderLifecycleOperationRecord,
  RunRecord,
  SessionStoreManager,
} from "@wi/storage";

import type { IssuedProviderCredential } from "@wi/provider-contract";

import type { TestFailpointController, TestFailpointName } from "../testing/failpoints.js";
import {
  CommandRoutingError,
  type CommandRouteOptions,
  type ProviderConnectionCommand,
  type ProviderConnectionCommandHandler,
} from "../websocket/command-router.js";
import {
  RecoveryIngressBudget,
  type RecoveryIngressBudgetOptions,
  type RecoveryIngressRegistration,
  type RecoveryIngressReservation,
} from "./recovery-ingress.js";

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function recoveryIdentityClaim(
  providerId: "openai_platform" | "openai_codex",
  authMode: "api_key" | "chatgpt_oauth",
  identity: Parameters<typeof normalizeAuthoritativeIdentity>[2] | { readonly status: "unverified" },
) {
  if (
    identity.status !== "authoritative" ||
    identity.workspace.presence === "unknown"
  ) return null;
  const normalized = normalizeAuthoritativeIdentity(providerId, authMode, identity);
  const hasWorkspaceValue = normalized.workspace.startsWith("value:");
  let workspacePresence: "unknown" | "none" | "value";
  if (hasWorkspaceValue) workspacePresence = "value";
  else if (normalized.workspace === "none") workspacePresence = "none";
  else workspacePresence = "unknown";
  return {
    identityKey: authoritativeIdentityKey(providerId, authMode, identity),
    stableKind: normalized.stableKind,
    stableValue: normalized.stableValue,
    workspacePresence,
    workspaceValue: hasWorkspaceValue
      ? normalized.workspace.slice("value:".length)
      : "",
  };
}

function safeConnectionView(connection: ProviderConnectionRecord): ProviderConnectionSafeView {
  return ProviderConnectionSafeViewSchema.parse({
    connectionId: connection.connectionId,
    providerId: connection.providerId,
    authMode: connection.authMode,
    displayName: connection.displayName,
    credentialBackend: connection.credentialBackend,
    credentialGeneration: connection.credentialGeneration,
    lifecycleRevision: connection.lifecycleRevision,
    metadataRevision: connection.metadataRevision,
    lifecycleStatus: connection.lifecycleStatus,
    identity: connection.identity,
    identityVerificationStatus: connection.identityVerificationStatus,
    capabilitiesVersion: connection.capabilitiesVersion,
    lifecycleOwnerKind: connection.lifecycleOwnerKind,
    deleted: connection.deleted,
    recoveryTombstone: connection.recoveryTombstone,
    createdAtMs: connection.createdAtMs,
    updatedAtMs: connection.updatedAtMs,
  });
}

function accepted(
  commandId: string,
  connectionId: string,
  duplicate: boolean,
): CommandAcceptedMessage {
  return {
    v: 1,
    kind: "command.accepted",
    commandId,
    result: { connectionId },
    duplicate,
  };
}

export interface ProviderSelectionAuthority {
  readonly promptVersion: string;
  readonly toolSchemaHash: string;
  readonly toolsAvailable: boolean;
}

export interface CredentialRequestLease {
  withCredential<T>(
    use: (credential: IssuedProviderCredential | undefined) => T,
  ): T;
  release(): void;
}

export interface ProviderConnectionFixtureOptions {
  readonly capabilitiesForConnection?: (
    connection: ProviderConnectionSafeView,
  ) => ProviderCapabilitiesSnapshot | null;
  readonly adapterAvailable?: (connection: ProviderConnectionSafeView) => boolean;
  readonly beforeRecoveryScanPublication?: () => Promise<void>;
  readonly beforeRecoveryStatusRead?: () => Promise<void>;
  readonly afterRecoveryPrepare?: (commandId: string) => Promise<void>;
  readonly afterRecoveryFileObserved?: (commandId: string) => Promise<void>;
  readonly afterRecoveryStatusInitialLookup?: () => Promise<void>;
  readonly beforePostCommitMaintenance?: (kind: ProviderMaintenanceKind) => void;
  readonly afterLifecyclePrepare?: (
    operationKind: "create" | "replace" | "logout" | "delete" | "enable",
    commandId: string,
    connectionId: string,
  ) => Promise<void>;
  /** Constructor-only lower limits for deterministic tests; never browser-configurable. */
  readonly recoveryIngressBudget?: RecoveryIngressBudgetOptions;
}

export type ProviderMaintenanceKind = "capabilities" | "recovery_availability";

export class ProviderConnectionService implements ProviderConnectionCommandHandler {
  private readonly router = new ExplicitProviderRouter();
  private readonly environmentLeases: EnvironmentCredentialLeaseManager;
  private readonly leasesByRun = new Map<string, EnvironmentCredentialLease>();
  private readonly runAcceptanceReleases = new Map<string, () => void>();
  private readonly connectionLockTails = new Map<string, Promise<void>>();
  private readonly activeLifecycleTasks = new Map<
    string,
    { readonly contentHash: string; readonly result: Promise<CommandAcceptedMessage> }
  >();
  private readonly activeRequestLeases = new Map<string, string>();
  private readonly recoveryIngressBudget: RecoveryIngressBudget;
  private readonly recoveryIngress = new Map<
    string,
    {
      readonly commandId: string;
      readonly recoveryEpochId: string;
      readonly expectedSafeMetadata: CredentialRecoveryExpectedSafeMetadata;
      readonly reservations: Map<number, RecoveryIngressReservation>;
    }
  >();
  private readonly recoveryIngressReservations = new Map<
    RecoveryIngressRegistration,
    { readonly state: "registered" | "epoch_closed"; used: boolean }
  >();
  private nextRecoveryIngressReservationId = 0;
  private credentialRootsPromise: Promise<CredentialRoots> | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private recoveryScanner: CredentialRecoveryScanner | null = null;
  private recoveryScanPromise: Promise<CredentialRecoveryScanResult> | null = null;
  private recoveryScanResult: CredentialRecoveryScanResult | null = null;
  private catalogLossRecoveryRepresentedRefs = new Set<string>();
  private activeRecoveryStatusReads = 0;
  private recoveryStatusWindowStartedAt = performance.now();
  private recoveryStatusReadsInWindow = 0;
  private catalogLossRecoveryAvailable = false;
  private readonly pendingCapabilityRepairs = new Set<string>();
  private recoveryAvailabilityRepairPending = false;

  constructor(
    private readonly storage: SessionStoreManager,
    private readonly homeDirectory: string,
    private readonly credentialRootOptions: Omit<CredentialRootOptions, "wiHome">,
    private readonly now: () => number,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly processEpoch: string,
    private readonly selectionAuthority: Promise<ProviderSelectionAuthority>,
    private readonly fixtures: ProviderConnectionFixtureOptions = {},
    private readonly testFailpoints?: TestFailpointController,
    private readonly onMaintenanceFailure?: (
      kind: ProviderMaintenanceKind,
      error: unknown,
    ) => void,
  ) {
    this.environmentLeases = new EnvironmentCredentialLeaseManager(
      (name) => environment[name],
      { processEpoch },
    );
    this.recoveryIngressBudget = new RecoveryIngressBudget(
      fixtures.recoveryIngressBudget,
    );
  }

  async initialize(): Promise<void> {
    const roots = await this.credentialRoots();
    const credentialStore = new FileCredentialStore(roots.credentialRoot);
    await credentialStore.cleanupOrphanedTemporaryFiles();
    await this.refreshCatalogLossRecoveryAvailability(credentialStore);
    const listed = await this.storage.catalog.listProviderConnections();
    for (const connection of listed.connections) {
      await this.publishCapabilitiesAfterCommit(connection);
    }
  }

  private async refreshCatalogLossRecoveryAvailability(
    credentialStore?: FileCredentialStore,
  ): Promise<void> {
    const roots = credentialStore === undefined ? await this.credentialRoots() : null;
    const store = credentialStore ?? new FileCredentialStore(roots!.credentialRoot);
    const [connections, credentialRefs, state] = await Promise.all([
      this.storage.catalog.listProviderConnections(),
      store.listRefs(),
      this.storage.catalog.getProviderCatalogState(),
    ]);
    const representedRefs = new Set(
      connections.connections.flatMap((connection) =>
        connection.credentialInternalRef === null ? [] : [connection.credentialInternalRef]
      ),
    );
    const unresolvedCredentials = credentialRefs.filter((ref) => !representedRefs.has(ref));
    this.catalogLossRecoveryRepresentedRefs = representedRefs;
    let recoveryActive = state.recoveryActive;
    if (!recoveryActive && connections.connections.length === 0 && credentialRefs.length > 0) {
      recoveryActive = true;
      await this.storage.catalog.setProviderCatalogRecoveryActive(true);
    } else if (recoveryActive && unresolvedCredentials.length === 0) {
      recoveryActive = false;
      await this.storage.catalog.setProviderCatalogRecoveryActive(false);
    }
    this.catalogLossRecoveryAvailable = recoveryActive && unresolvedCredentials.length > 0;
  }

  close(deadlineAtMs: number): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.catalogLossRecoveryAvailable = false;
    this.closePromise = this.finishClose(deadlineAtMs);
    return this.closePromise;
  }

  private async finishClose(deadlineAtMs: number): Promise<void> {
    while (
      this.activeLifecycleTasks.size > 0 ||
      this.connectionLockTails.size > 0 ||
      this.activeRequestLeases.size > 0 ||
      this.recoveryIngress.size > 0 ||
      this.recoveryScanPromise !== null ||
      this.activeRecoveryStatusReads > 0
    ) {
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) {
        throw new Error("Provider connection work did not drain before shutdown deadline.");
      }
      const tasks = [...this.activeLifecycleTasks.values()].map((task) => task.result);
      await Promise.race([
        tasks.length === 0
          ? new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)))
          : Promise.allSettled(tasks).then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Provider connection work exceeded shutdown deadline.")),
            remaining,
          );
          timer.unref();
        }),
      ]);
    }
    this.recoveryScanner?.close();
    this.recoveryScanner = null;
    this.recoveryScanPromise = null;
    this.recoveryScanResult = null;
    this.leasesByRun.clear();
    this.environmentLeases.close();
  }

  async route(
    command: ProviderConnectionCommand,
    options: CommandRouteOptions = {},
  ): Promise<CommandAcceptedMessage> {
    try {
      if (this.closing) {
        throw new CommandRoutingError(
          "server.shutting_down",
          "Provider connection management is shutting down.",
        );
      }
      if (command.method === "providerConnection.file.create") {
        return await this.runLifecycleTask(command, () => this.createFileConnection(command));
      }
      if (command.method === "providerConnection.file.replace") {
        return await this.runLifecycleTask(command, () => this.replaceFileConnection(command));
      }
      if (command.method === "providerConnection.recover") {
        const provided = this.recoveryIngressReservations.get(
          options.recoveryIngressRegistration as RecoveryIngressRegistration,
        );
        const preRegistered = provided !== undefined && !provided.used
          ? { registration: options.recoveryIngressRegistration as RecoveryIngressRegistration, owns: false }
          : null;
        if (preRegistered !== null) {
          provided!.used = true;
        }
        const admission = preRegistered ?? {
          registration: this.registerRecoveryIngressForCommand(command),
          owns: true,
        };
        if (admission.registration.state === "saturated") {
          throw new CommandRoutingError(
            "provider.rate_limited",
            "The provider connection recovery queue is temporarily full.",
          );
        }
        try {
          return await this.runLifecycleTask(command, () =>
            this.routeRecoveryWithAdmission(command, admission.registration),
          );
        } finally {
          if (admission.owns) admission.registration.release();
        }
      }
      if (command.method === "providerConnection.rename") {
        const renamed = await this.storage.catalog.renameProviderConnection({
          commandId: command.commandId,
          contentHash: await canonicalJsonHash(command),
          connectionId: command.params.connectionId,
          expectedMetadataRevision: command.params.expectedMetadataRevision,
          displayName: command.params.displayName,
          updatedAtMs: this.now(),
        });
        return accepted(command.commandId, renamed.connection.connectionId, renamed.duplicate);
      }
      if (
        command.method === "providerConnection.disable" ||
        command.method === "providerConnection.logout" ||
        command.method === "providerConnection.delete"
      ) {
        return await this.runLifecycleTask(command, () =>
          this.applyAdministrativeLifecycle(command));
      }
      if (command.method === "providerConnection.environment.revalidate") {
        return await this.runLifecycleTask(command, () =>
          this.revalidateEnvironmentConnection(command));
      }
      if (command.method === "providerConnection.environment.create") {
        const variableValue = this.environment[command.params.variableName];
        const status = variableValue === undefined || variableValue.length === 0
          ? "unavailable"
          : "ready";
        const connectionId = id("pconn");
        const result = await this.storage.catalog.registerEnvironmentConnection({
          commandId: command.commandId,
          contentHash: await canonicalJsonHash(command),
          connectionId,
          providerId: command.params.providerId,
          authMode: "api_key",
          displayName: command.params.displayName,
          variableName: command.params.variableName,
          identity: { status: "unverified" },
          identityClaim: null,
          initialStatus: status,
          createdAtMs: this.now(),
        });
        await this.publishCapabilitiesAfterCommit(result.connection);
        return accepted(command.commandId, result.connection.connectionId, result.duplicate);
      }
      throw new CommandRoutingError(
        "provider.not_implemented",
        "This provider connection operation is not implemented in the no-network milestone fixture.",
      );
    } catch (error) {
      if (error instanceof CommandRoutingError) throw error;
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "storage.corrupt";
      if (code === "protocol.command_id_conflict" || code === "provider.operation_in_progress") {
        throw new CommandRoutingError(code, "The provider connection command conflicts with durable state.");
      }
      if (code.startsWith("credential.") || code.startsWith("provider.")) {
        throw new CommandRoutingError(code, "The provider credential operation failed safely.");
      }
      throw new CommandRoutingError("storage.corrupt", "Provider connection management failed.");
    }
  }

  private async runLifecycleTask(
    command: ProviderConnectionCommand,
    task: () => Promise<CommandAcceptedMessage>,
  ): Promise<CommandAcceptedMessage> {
    const contentHash = await canonicalJsonHash(command);
    const active = this.activeLifecycleTasks.get(command.commandId);
    if (active !== undefined) {
      if (active.contentHash !== contentHash) {
        throw new CommandRoutingError(
          "protocol.command_id_conflict",
          "The provider connection command ID was reused with different content.",
        );
      }
      return active.result;
    }
    const result = task();
    this.activeLifecycleTasks.set(command.commandId, { contentHash, result });
    try {
      return await result;
    } finally {
      if (this.activeLifecycleTasks.get(command.commandId)?.result === result) {
        this.activeLifecycleTasks.delete(command.commandId);
      }
    }
  }

  private async acquireConnectionLock(connectionId: string): Promise<() => void> {
    const previous = this.connectionLockTails.get(connectionId) ?? Promise.resolve();
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    this.connectionLockTails.set(connectionId, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTail();
      if (this.connectionLockTails.get(connectionId) === tail) {
        this.connectionLockTails.delete(connectionId);
      }
    };
  }

  private async withConnectionLock<T>(connectionId: string, task: () => Promise<T>): Promise<T> {
    const release = await this.acquireConnectionLock(connectionId);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private recoveryIngressKey(commandId: string, recoveryEpochId: string): string {
    return `${commandId}\u0000${recoveryEpochId}`;
  }

  registerRecoveryIngress(
    commandId: string,
    recoveryEpochId: string,
    expectedSafeMetadata: CredentialRecoveryExpectedSafeMetadata,
    commandBytes: number,
  ): RecoveryIngressRegistration {
    const expected = CredentialRecoveryExpectedSafeMetadataSchema.parse(expectedSafeMetadata);
    const existing = this.recoveryIngress.get(this.recoveryIngressKey(commandId, recoveryEpochId));
    const epochOpen = this.recoveryScanner?.isEpochOpen(recoveryEpochId) === true;
    if (this.closing || (existing === undefined && !epochOpen)) {
      let released = false;
      const registration: RecoveryIngressRegistration = {
        state: "epoch_closed",
        release: (): void => {
          if (released) return;
          released = true;
          this.recoveryIngressReservations.delete(registration);
        },
      };
      return this.trackRecoveryIngressRegistration(registration);
    }
    const budget = this.recoveryIngressBudget.reserve(commandBytes);
    if (budget.state === "saturated") {
      return { state: "saturated", release: () => undefined };
    }

    // The budget is reserved before this frame is added to the process-wide ingress map.
    const key = this.recoveryIngressKey(commandId, recoveryEpochId);
    const reservationId = ++this.nextRecoveryIngressReservationId;
    const entry = existing ?? {
      commandId,
      recoveryEpochId,
      expectedSafeMetadata: expected,
      reservations: new Map<number, RecoveryIngressReservation>(),
    };
    entry.reservations.set(reservationId, budget.reservation);
    if (existing === undefined) this.recoveryIngress.set(key, entry);

    let released = false;
    const registration: RecoveryIngressRegistration = {
      state: "registered",
      release: (): void => {
        if (released) return;
        released = true;
        const current = this.recoveryIngress.get(key);
        if (current === undefined || !current.reservations.delete(reservationId)) {
          throw new Error("Recovery ingress registration was released out of order");
        }
        if (current.reservations.size === 0) this.recoveryIngress.delete(key);
        this.recoveryIngressReservations.delete(registration);
        budget.reservation.release();
      },
    };
    this.recoveryIngressReservations.set(registration, { state: "registered", used: false });
    return registration;
  }

  private trackRecoveryIngressRegistration(
    registration: RecoveryIngressRegistration,
  ): RecoveryIngressRegistration {
    this.recoveryIngressReservations.set(registration, {
      state: registration.state === "registered" ? "registered" : "epoch_closed",
      used: false,
    });
    return registration;
  }

  private registerRecoveryIngressForCommand(
    command: Extract<ProviderConnectionCommand, { readonly method: "providerConnection.recover" }>,
  ): RecoveryIngressRegistration {
    const canonicalBytes = Buffer.byteLength(canonicalJson(command), "utf8");
    return this.registerRecoveryIngress(
      command.commandId,
      command.params.recoveryEpochId,
      {
        expected: command.params.expected,
        displayName: command.params.displayName,
      },
      canonicalBytes,
    );
  }

  finishRecoveryIngress(registration: RecoveryIngressRegistration): void {
    registration.release();
  }

  get recoveryIngressSnapshot() {
    return this.recoveryIngressBudget.snapshot;
  }

  private hitFailpoint(name: TestFailpointName, commandId: string): void {
    this.testFailpoints?.hit(name, { commandId });
  }

  async recoveryCommandStatus(
    commandId: string,
    recoveryEpochId: string,
    expectedSafeMetadata: CredentialRecoveryExpectedSafeMetadata,
  ): Promise<CredentialRecoveryCommandStatus> {
    if (this.closing) {
      throw new CommandRoutingError(
        "server.shutting_down",
        "Provider connection management is shutting down.",
      );
    }
    const expected = CredentialRecoveryExpectedSafeMetadataSchema.parse(expectedSafeMetadata);
    const now = performance.now();
    if (now - this.recoveryStatusWindowStartedAt >= 1_000) {
      this.recoveryStatusWindowStartedAt = now;
      this.recoveryStatusReadsInWindow = 0;
    }
    if (this.activeRecoveryStatusReads >= 32 || this.recoveryStatusReadsInWindow >= 128) {
      return {
        commandId,
        recoveryEpochId,
        status: "rate_limited",
        connectionId: null,
        result: null,
        failureCode: "provider.rate_limited",
        expectedSafeMetadata: null,
      };
    }
    this.activeRecoveryStatusReads += 1;
    this.recoveryStatusReadsInWindow += 1;
    try {
    await this.fixtures.beforeRecoveryStatusRead?.();
    const conflict = (): CredentialRecoveryCommandStatus => ({
      commandId,
      recoveryEpochId,
      status: "conflict",
      connectionId: null,
      result: null,
      failureCode: "protocol.command_id_conflict",
      expectedSafeMetadata: null,
    });
    const statusForOperation = (
      operation: ProviderLifecycleOperationRecord,
    ): CredentialRecoveryCommandStatus => {
      if (
        operation.operationKind !== "credential_recovery" ||
        operation.recoveryEpochId !== recoveryEpochId
      ) {
        return conflict();
      }
      const durableExpected = CredentialRecoveryExpectedSafeMetadataSchema.parse(
        operation.expectedSafeMetadata,
      );
      if (canonicalJson(durableExpected) !== canonicalJson(expected)) return conflict();
      return {
        commandId,
        recoveryEpochId,
        status: operation.phase,
        connectionId: operation.targetConnectionId,
        result: operation.result,
        failureCode: operation.failureCode,
        expectedSafeMetadata: durableExpected,
      };
    };
    const operation = await this.storage.catalog.getProviderLifecycleOperation(commandId);
    if (operation !== null) return statusForOperation(operation);
    await this.fixtures.afterRecoveryStatusInitialLookup?.();
    if (await this.storage.catalog.hasProviderMetadataCommand(commandId)) return conflict();
    const exactIngress = this.recoveryIngress.get(
      this.recoveryIngressKey(commandId, recoveryEpochId),
    );
    if (
      exactIngress !== undefined &&
      canonicalJson(exactIngress.expectedSafeMetadata) !== canonicalJson(expected)
    ) {
      return conflict();
    }
    if (
      exactIngress === undefined &&
      [...this.recoveryIngress.values()].some((ingress) => ingress.commandId === commandId)
    ) {
      return conflict();
    }
    if (exactIngress !== undefined) {
      return {
        commandId,
        recoveryEpochId,
        status: "admitting",
        connectionId: null,
        result: null,
        failureCode: null,
        expectedSafeMetadata: null,
      };
    }
    if (this.recoveryScanner?.isEpochOpen(recoveryEpochId) === true) {
      return {
        commandId,
        recoveryEpochId,
        status: "unobserved",
        connectionId: null,
        result: null,
        failureCode: null,
        expectedSafeMetadata: null,
      };
    }
    // Closed epoch plus drained ingress prevents later recovery admission. Re-read durable
    // ownership before making not_accepted final because the first read may have gone stale.
    const finalOperation = await this.storage.catalog.getProviderLifecycleOperation(commandId);
    if (finalOperation !== null) return statusForOperation(finalOperation);
    if (await this.storage.catalog.hasProviderMetadataCommand(commandId)) return conflict();
    return {
      commandId,
      recoveryEpochId,
      status: "not_accepted",
      connectionId: null,
      result: null,
      failureCode: null,
      expectedSafeMetadata: null,
    };
    } finally {
      this.activeRecoveryStatusReads -= 1;
    }
  }

  async listSafeConnections() {
    await this.repairPostCommitMaintenance();
    const listed = await this.storage.catalog.listProviderConnections();
    return {
      catalogRevision: listed.catalogRevision,
      connections: listed.connections.map(safeConnectionView),
      truncated: listed.truncated,
    };
  }

  private assertClaimedStage(
    operation: ProviderLifecycleOperationRecord,
    connection: ProviderConnectionRecord,
    staged: Awaited<ReturnType<CredentialProvisioner["readClaimedInternal"]>>,
    fileIdentity: CredentialFileIdentity,
  ): void {
    if (
      operation.provisioningId === null ||
      operation.stagingFileIdentity === null ||
      canonicalJson(fileIdentity) !== canonicalJson(operation.stagingFileIdentity) ||
      staged.provisioningId !== operation.provisioningId ||
      staged.providerId !== connection.providerId ||
      staged.authMode !== connection.authMode
    ) {
      throw new CredentialError("credential.binding_mismatch");
    }
  }

  private async canProveLifecycleEffectAbsent(
    operation: ProviderLifecycleOperationRecord,
    connection: ProviderConnectionRecord,
  ): Promise<boolean> {
    if (operation.phase !== "prepared" || operation.credentialInternalRef === null) return false;
    const roots = await this.credentialRoots();
    const store = new FileCredentialStore(roots.credentialRoot);
    if (
      operation.operationKind === "create" ||
      (operation.operationKind === "replace" &&
        operation.credentialInternalRef !== connection.credentialInternalRef)
    ) {
      return await store.get(operation.credentialInternalRef) === null;
    }
    const metadata = operation.expectedSafeMetadata;
    const record = metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata as Readonly<Record<string, unknown>>
      : null;
    const previousEnvelopeId = typeof record?.previousEnvelopeId === "string"
      ? record.previousEnvelopeId
      : connection.envelopeId;
    if (operation.expectedGeneration === null || previousEnvelopeId === null) return false;
    const retained = await store.getBound(operation.credentialInternalRef, {
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authMode: connection.authMode,
      generation: operation.expectedGeneration,
    });
    return retained?.metadata.envelopeId === previousEnvelopeId;
  }

  private async cleanupTerminalStage(
    stagingInternalRef: string | null,
    commandId?: string,
  ): Promise<void> {
    if (stagingInternalRef === null) return;
    try {
      const roots = await this.credentialRoots();
      await new CredentialProvisioner(roots.stagingRoot, this.now, undefined, {
        afterStageDeleteBeforeFlush: () => {
          if (commandId !== undefined) {
            this.hitFailpoint("after_provider_stage_delete_before_flush", commandId);
          }
        },
      }).deleteClaimedInternal(stagingInternalRef);
      if (commandId !== undefined) {
        this.hitFailpoint("after_provider_stage_cleanup", commandId);
      }
      await this.storage.catalog.markProviderStageCleaned(stagingInternalRef);
    } catch {
      // Terminal catalog state is authoritative; startup retries bounded cleanup.
    }
  }

  private async failOwnedOperation(
    operation: ProviderLifecycleOperationRecord,
    afterEffect: boolean,
    error: unknown,
  ): Promise<void> {
    const recoverySourceChanged =
      afterEffect && operation.operationKind === "credential_recovery";
    const code = recoverySourceChanged
      ? "credential.recovery_source_changed"
      : typeof error === "object" && error !== null && "code" in error
        ? String(error.code).slice(0, 128)
        : "credential.io_failed";
    let lifecycleStatus: "ready" | "unavailable" = "unavailable";
    const expectedMetadata = operation.expectedSafeMetadata;
    const expectedMetadataRecord =
      expectedMetadata !== null &&
      typeof expectedMetadata === "object" &&
      !Array.isArray(expectedMetadata)
        ? expectedMetadata as Readonly<Record<string, unknown>>
        : null;
    const previousEnvelopeId = typeof expectedMetadataRecord?.previousEnvelopeId === "string"
      ? expectedMetadataRecord.previousEnvelopeId
      : null;
    if (
      !afterEffect &&
      operation.operationKind === "replace" &&
      operation.expectedGeneration !== null &&
      operation.credentialInternalRef !== null &&
      previousEnvelopeId !== null
    ) {
      const connection = await this.storage.catalog.getProviderConnection(
        operation.targetConnectionId,
      );
      if (connection !== null) {
        try {
          const roots = await this.credentialRoots();
          const retained = await new FileCredentialStore(roots.credentialRoot).getBound(
            operation.credentialInternalRef,
            {
              connectionId: connection.connectionId,
              providerId: connection.providerId,
              authMode: connection.authMode,
              generation: operation.expectedGeneration,
            },
          );
          if (retained?.metadata.envelopeId === previousEnvelopeId) {
            lifecycleStatus = "ready";
          }
        } catch {
          // Unprovable old evidence remains unavailable.
        }
      }
    }
    await this.storage.catalog.completeProviderLifecycle({
      commandId: operation.commandId,
      contentHash: operation.contentHash,
      observedEnvelopeId: afterEffect ? operation.envelopeId : null,
      credentialInternalRef: operation.credentialInternalRef,
      terminalPhase: afterEffect ? "failed_after_effect" : "failed",
      lifecycleStatus,
      recoveryTombstone: recoverySourceChanged,
      result: null,
      failureCode: code,
      failureMessage: recoverySourceChanged
        ? "The claimed recovery source changed before it could be observed."
        : afterEffect
          ? "The credential effect could not be proven after a local failure."
          : "The credential operation failed before its file effect.",
      diagnosticId: null,
      updatedAtMs: this.now(),
    });
    await this.cleanupTerminalStage(operation.stagingInternalRef, operation.commandId);
  }

  private throwTerminalOperation(operation: ProviderLifecycleOperationRecord): never {
    throw new CommandRoutingError(
      operation.failureCode ?? "provider.connection_unavailable",
      operation.failureMessage ?? "The provider credential operation previously failed safely.",
    );
  }

  private assertOperationMatches(
    operation: { readonly commandMethod: string; readonly contentHash: string },
    command: ProviderConnectionCommand,
    contentHash: string,
  ): void {
    if (operation.commandMethod !== command.method || operation.contentHash !== contentHash) {
      throw new CommandRoutingError(
        "protocol.command_id_conflict",
        "The provider connection command ID was reused with different content.",
      );
    }
  }

  private async routeRecoveryWithAdmission(
    command: Extract<ProviderConnectionCommand, { readonly method: "providerConnection.recover" }>,
    registration: RecoveryIngressRegistration,
  ): Promise<CommandAcceptedMessage> {
    const existingOperation = await this.storage.catalog.getProviderLifecycleOperation(
      command.commandId,
    );
    if (existingOperation !== null) return this.recoverConnection(command);
    if (registration.state !== "registered" ||
      this.recoveryScanner?.isEpochOpen(command.params.recoveryEpochId) !== true) {
      throw new CommandRoutingError(
        "credential.recovery_ref_expired",
        "The credential recovery scan has expired.",
      );
    }
    return this.recoverConnection(command);
  }

  private async recoverConnection(
    command: Extract<ProviderConnectionCommand, { readonly method: "providerConnection.recover" }>,
  ): Promise<CommandAcceptedMessage> {
    const contentHash = await canonicalJsonHash(command);
    let claimedVerifier: ClaimedCredentialVerifier | null = null;
    let operation = await this.storage.catalog.getProviderLifecycleOperation(command.commandId);
    if (operation !== null) this.assertOperationMatches(operation, command, contentHash);
    if (operation?.phase === "succeeded") {
      return accepted(command.commandId, operation.targetConnectionId, true);
    }
    if (operation?.phase === "failed" || operation?.phase === "failed_after_effect") {
      this.throwTerminalOperation(operation);
    }
    if (operation === null) {
      operation = await this.storage.catalog.admitProviderRecovery({
        commandId: command.commandId,
        commandMethod: command.method,
        contentHash,
        connectionId: command.params.expected.originalConnectionId,
        generation: command.params.expected.generation,
        recoveryEpochId: command.params.recoveryEpochId,
        expectedSafeMetadata: CanonicalJsonValueSchema.parse({
          expected: command.params.expected,
          displayName: command.params.displayName,
        }),
        createdAtMs: this.now(),
      });
      this.hitFailpoint("after_recovery_admission", command.commandId);
    }
    if (operation.phase === "validating") {
      try {
        if (this.recoveryScanner === null) {
        throw new CommandRoutingError("credential.recovery_ref_expired", "The credential recovery scan has expired.");
      }
      const claimed = await this.recoveryScanner.claim(
        command.params.recoveryEpochId,
        command.params.recoveryRef,
        command.params.expected,
      );
      claimedVerifier = claimed.verifier;
      const identityClaim = recoveryIdentityClaim(
        command.params.expected.providerId,
        command.params.expected.authMode,
        command.params.expected.identity,
      );
      const reserved = await this.storage.catalog.reserveRecoveredProviderConnection({
        commandId: command.commandId,
        commandMethod: command.method,
        contentHash,
        connectionId: command.params.expected.originalConnectionId,
        providerId: command.params.expected.providerId,
        authMode: command.params.expected.authMode,
        displayName: command.params.displayName,
        identity: command.params.expected.identity,
        identityClaim,
        generation: command.params.expected.generation,
        credentialInternalRef: claimed.internalRef,
        envelopeId: claimed.envelopeId,
        recoveryEpochId: command.params.recoveryEpochId,
        recoveryFileIdentity: claimed.fileIdentity,
        createdAtMs: this.now(),
      });
        operation = reserved.operation;
        this.hitFailpoint("after_recovery_prepare", command.commandId);
        await this.fixtures.afterRecoveryPrepare?.(command.commandId);
      } catch (error) {
        claimedVerifier?.dispose();
        claimedVerifier = null;
        const failureCode = typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "credential.recovery_failed";
        await this.storage.catalog.failProviderRecovery({
          commandId: command.commandId,
          contentHash,
          failureCode,
          failureMessage: "Credential recovery validation or exact claim failed.",
          updatedAtMs: this.now(),
        });
        throw error;
      }
    }
    if (operation.credentialInternalRef === null || operation.envelopeId === null) {
      throw new CommandRoutingError("storage.corrupt", "The credential recovery reservation is incomplete.");
    }
    const roots = await this.credentialRoots();
    let credential: StoredCredential | null;
    try {
      const credentialRead = await new FileCredentialStore(roots.credentialRoot)
        .getWithFileIdentity(operation.credentialInternalRef);
      credential = credentialRead?.credential ?? null;
      const metadata = credential?.metadata;
      if (
        credentialRead === null ||
        metadata?.envelopeId !== operation.envelopeId ||
        metadata.connectionId !== operation.targetConnectionId ||
        metadata.providerId !== command.params.expected.providerId ||
        metadata.authMode !== command.params.expected.authMode ||
        metadata.generation !== operation.reservedGeneration ||
        operation.recoveryFileIdentity === null ||
        canonicalJson(credentialRead.fileIdentity) !== canonicalJson(operation.recoveryFileIdentity) ||
        (claimedVerifier !== null && !claimedVerifier.matchesCredential(credentialRead.credential))
      ) {
        throw new CommandRoutingError(
          "provider.credential_unavailable",
          "The recovery credential binding is unavailable.",
        );
      }
      claimedVerifier?.dispose();
      claimedVerifier = null;
    } catch (error) {
      claimedVerifier?.dispose();
      claimedVerifier = null;
      await this.failOwnedOperation(operation, true, error);
      throw error;
    }
    await this.storage.catalog.observeProviderLifecycleEffect({
      commandId: command.commandId,
      contentHash,
      observedEnvelopeId: operation.envelopeId,
      credentialInternalRef: operation.credentialInternalRef,
      updatedAtMs: this.now(),
    });
    this.hitFailpoint("after_provider_file_observed", command.commandId);
    await this.fixtures.afterRecoveryFileObserved?.(command.commandId);
    const completed = await this.storage.catalog.completeProviderLifecycle({
      commandId: command.commandId,
      contentHash,
      observedEnvelopeId: operation.envelopeId,
      credentialInternalRef: operation.credentialInternalRef,
      terminalPhase: "succeeded",
      lifecycleStatus: "ready",
      result: { connectionId: operation.targetConnectionId },
      failureCode: null,
      failureMessage: null,
      diagnosticId: null,
      updatedAtMs: this.now(),
    });
    this.hitFailpoint("after_provider_lifecycle_terminal_before_ack", command.commandId);
    await this.refreshRecoveryAvailabilityAfterCommit();
    return accepted(command.commandId, completed.connection.connectionId, completed.duplicate);
  }

  private async revalidateEnvironmentConnection(
    command: Extract<ProviderConnectionCommand, {
      readonly method: "providerConnection.environment.revalidate";
    }>,
  ): Promise<CommandAcceptedMessage> {
    const contentHash = await canonicalJsonHash(command);
    const existingOperation = await this.storage.catalog.getProviderLifecycleOperation(
      command.commandId,
    );
    if (
      existingOperation !== null &&
      (
        existingOperation.contentHash !== contentHash ||
        existingOperation.commandMethod !== command.method
      )
    ) {
      throw new CommandRoutingError(
        "protocol.command_id_conflict",
        "The provider connection command ID was reused with different content.",
      );
    }
    const current = await this.storage.catalog.getProviderConnection(
      existingOperation?.targetConnectionId ?? command.params.connectionId,
    );
    if (current === null) {
      throw new CommandRoutingError(
        "provider.connection_not_found",
        "The provider connection does not exist.",
      );
    }
    if (existingOperation !== null && ["succeeded", "failed", "failed_after_effect"].includes(existingOperation.phase)) {
      if (existingOperation.phase === "succeeded") {
        await this.publishCapabilitiesAfterCommit(current);
        return accepted(command.commandId, current.connectionId, true);
      }
      this.throwTerminalOperation(existingOperation);
    }
    if (existingOperation === null && current.lifecycleOwnerKind === null) {
      if (
        current.deleted ||
        current.credentialBackend.kind !== "environment" ||
        current.lifecycleStatus !== "unavailable"
      ) {
        throw new CommandRoutingError(
          "provider.connection_unavailable",
          "Environment revalidation requires an undeleted unavailable environment connection.",
        );
      }
      if (
        current.lifecycleRevision !== command.params.expectedLifecycleRevision ||
        current.credentialGeneration !== command.params.expectedGeneration
      ) {
        throw new CommandRoutingError(
          "provider.stale_revision",
          "Provider connection revision is stale.",
        );
      }
      try {
        this.environmentLeases.validate(current.credentialBackend.variableName);
      } catch (error) {
        if (error instanceof CredentialError) {
          throw new CommandRoutingError(error.code, error.message);
        }
        throw error;
      }
    }

    const prepared = await this.storage.catalog.prepareProviderLifecycle({
      commandId: command.commandId,
      commandMethod: command.method,
      contentHash,
      operationKind: "enable",
      connectionId: current.connectionId,
      expectedLifecycleRevision: command.params.expectedLifecycleRevision,
      expectedGeneration: command.params.expectedGeneration,
      credentialBackendKind: current.credentialBackend.kind,
      credentialInternalRef: current.credentialInternalRef,
      targetEnvelopeId: current.envelopeId,
      provisioningId: null,
      stagingInternalRef: null,
      stagingFileIdentity: null,
      recoveryEpochId: null,
      expectedSafeMetadata: null,
      createdAtMs: this.now(),
    });
    if (prepared.operation.phase === "succeeded") {
      await this.publishCapabilitiesAfterCommit(prepared.connection);
      return accepted(command.commandId, prepared.connection.connectionId, true);
    }
    if (prepared.operation.phase === "failed" || prepared.operation.phase === "failed_after_effect") {
      this.throwTerminalOperation(prepared.operation);
    }
    if (!prepared.duplicate) {
      this.hitFailpoint("after_provider_lifecycle_prepare", command.commandId);
      await this.fixtures.afterLifecyclePrepare?.(
        "enable",
        command.commandId,
        current.connectionId,
      );
    }
    if (current.credentialBackend.kind !== "environment") {
      const error = new CommandRoutingError(
        "provider.connection_unavailable",
        "Environment revalidation requires an environment credential.",
      );
      await this.failOwnedOperation(prepared.operation, false, error);
      throw error;
    }
    try {
      this.environmentLeases.validate(current.credentialBackend.variableName);
    } catch (error) {
      await this.failOwnedOperation(prepared.operation, false, error);
      if (error instanceof CredentialError) {
        throw new CommandRoutingError(error.code, error.message);
      }
      throw error;
    }
    const completed = await this.storage.catalog.completeProviderLifecycle({
      commandId: command.commandId,
      contentHash,
      observedEnvelopeId: null,
      credentialInternalRef: null,
      terminalPhase: "succeeded",
      lifecycleStatus: "ready",
      result: { connectionId: current.connectionId },
      failureCode: null,
      failureMessage: null,
      diagnosticId: null,
      updatedAtMs: this.now(),
    });
    this.hitFailpoint("after_provider_lifecycle_terminal_before_ack", command.commandId);
    await this.publishCapabilitiesAfterCommit(completed.connection);
    return accepted(
      command.commandId,
      completed.connection.connectionId,
      completed.duplicate,
    );
  }

  private async applyAdministrativeLifecycle(
    command: Extract<ProviderConnectionCommand, {
      readonly method:
        | "providerConnection.disable"
        | "providerConnection.logout"
        | "providerConnection.delete";
    }>,
  ): Promise<CommandAcceptedMessage> {
    const contentHash = await canonicalJsonHash(command);
    const operationKind = command.method.replace("providerConnection.", "") as
      "disable" | "logout" | "delete";
    if (operationKind === "disable") {
      return this.withConnectionLock(command.params.connectionId, async () => {
        const current = await this.storage.catalog.getProviderConnection(
          command.params.connectionId,
        );
        if (current === null) {
          throw new CommandRoutingError(
            "provider.connection_not_found",
            "The provider connection does not exist.",
          );
        }
        const disabled = await this.storage.catalog.disableProviderConnection({
          commandId: command.commandId,
          commandMethod: command.method,
          contentHash,
          operationKind: "disable",
          connectionId: current.connectionId,
          expectedLifecycleRevision: command.params.expectedLifecycleRevision,
          expectedGeneration: command.params.expectedGeneration,
          credentialBackendKind: current.credentialInternalRef === null ? "environment" : "file",
          credentialInternalRef: current.credentialInternalRef,
          targetEnvelopeId: null,
          provisioningId: null,
          stagingInternalRef: null,
          stagingFileIdentity: null,
          recoveryEpochId: null,
          expectedSafeMetadata: null,
          createdAtMs: this.now(),
        });
        if (
          disabled.operation.phase === "failed" ||
          disabled.operation.phase === "failed_after_effect"
        ) {
          this.throwTerminalOperation(disabled.operation);
        }
        this.hitFailpoint("after_provider_lifecycle_terminal_before_ack", command.commandId);
        return accepted(command.commandId, disabled.connection.connectionId, disabled.duplicate);
      });
    }
    let connection!: ProviderConnectionRecord;
    const prepared = await this.withConnectionLock(command.params.connectionId, async () => {
      const current = await this.storage.catalog.getProviderConnection(command.params.connectionId);
      if (current === null) {
        throw new CommandRoutingError(
          "provider.connection_not_found",
          "The provider connection does not exist.",
        );
      }
      connection = current;
      return this.storage.catalog.prepareProviderLifecycle({
        commandId: command.commandId,
        commandMethod: command.method,
        contentHash,
        operationKind,
        connectionId: current.connectionId,
        expectedLifecycleRevision: command.params.expectedLifecycleRevision,
        expectedGeneration: command.params.expectedGeneration,
        credentialBackendKind: current.credentialInternalRef === null ? "environment" : "file",
        credentialInternalRef: current.credentialInternalRef,
        targetEnvelopeId: operationKind === "logout" || operationKind === "delete"
          ? current.envelopeId
          : null,
        provisioningId: null,
        stagingInternalRef: null,
        stagingFileIdentity: null,
        recoveryEpochId: null,
        expectedSafeMetadata: null,
        createdAtMs: this.now(),
      });
    });
    if (!prepared.duplicate) {
      this.hitFailpoint("after_provider_lifecycle_prepare", command.commandId);
      await this.fixtures.afterLifecyclePrepare?.(
        operationKind,
        command.commandId,
        connection.connectionId,
      );
    }
    if (prepared.operation.phase === "succeeded") {
      return accepted(command.commandId, connection.connectionId, true);
    }
    if (prepared.operation.phase === "failed" || prepared.operation.phase === "failed_after_effect") {
      this.throwTerminalOperation(prepared.operation);
    }
    if (
      (operationKind === "logout" || operationKind === "delete") &&
      prepared.operation.credentialInternalRef !== null
    ) {
      const roots = await this.credentialRoots();
      if (connection.envelopeId === null) {
        const error = new CommandRoutingError(
          "provider.credential_unavailable",
          "The credential evidence is incomplete.",
        );
        await this.failOwnedOperation(prepared.operation, false, error);
        throw error;
      }
      try {
        await this.fileStore(roots.credentialRoot, command.commandId).deleteBound(
          prepared.operation.credentialInternalRef,
          {
            connectionId: connection.connectionId,
            providerId: connection.providerId,
            authMode: connection.authMode,
            generation: connection.credentialGeneration,
            envelopeId: connection.envelopeId,
          },
        );
      } catch (error) {
        await this.failOwnedOperation(prepared.operation, true, error);
        throw error;
      }
      this.hitFailpoint("after_provider_file_effect", command.commandId);
      await this.storage.catalog.observeProviderLifecycleEffect({
        commandId: command.commandId,
        contentHash,
        observedEnvelopeId: prepared.operation.envelopeId,
        credentialInternalRef: prepared.operation.credentialInternalRef,
        updatedAtMs: this.now(),
      });
      this.hitFailpoint("after_provider_file_observed", command.commandId);
    }
    const lifecycleStatus: "reauth_required" | "unavailable" =
      operationKind === "logout" ? "reauth_required" : "unavailable";
    const completed = await this.storage.catalog.completeProviderLifecycle({
      commandId: command.commandId,
      contentHash,
      observedEnvelopeId: prepared.operation.envelopeId,
      credentialInternalRef: prepared.operation.credentialInternalRef,
      terminalPhase: "succeeded",
      lifecycleStatus,
      result: { connectionId: connection.connectionId },
      failureCode: null,
      failureMessage: null,
      diagnosticId: null,
      updatedAtMs: this.now(),
    });
    this.hitFailpoint("after_provider_lifecycle_terminal_before_ack", command.commandId);
    return accepted(command.commandId, completed.connection.connectionId, completed.duplicate);
  }

  private fileStore(root: string, commandId?: string): FileCredentialStore {
    return new FileCredentialStore(root, commandId === undefined
      ? {}
      : {
          afterTemporaryFileSync: () => this.hitFailpoint(
            "after_provider_credential_temp_flush",
            commandId,
          ),
          afterCredentialRenameBeforeFlush: () => this.hitFailpoint(
            "after_provider_credential_rename_before_flush",
            commandId,
          ),
          afterCredentialUnlinkBeforeFlush: () => this.hitFailpoint(
            "after_provider_credential_unlink_before_flush",
            commandId,
          ),
        });
  }

  private credentialRoots(): Promise<CredentialRoots> {
    this.credentialRootsPromise ??= initializeCredentialRoots({
      wiHome: this.homeDirectory,
      ...this.credentialRootOptions,
    });
    return this.credentialRootsPromise;
  }

  private async createFileConnection(
    command: Extract<ProviderConnectionCommand, { readonly method: "providerConnection.file.create" }>,
  ): Promise<CommandAcceptedMessage> {
    const contentHash = await canonicalJsonHash(command);
    let operation = await this.storage.catalog.getProviderLifecycleOperation(command.commandId);
    if (operation !== null) this.assertOperationMatches(operation, command, contentHash);
    let connection = operation === null
      ? null
      : await this.storage.catalog.getProviderConnection(operation.targetConnectionId);
    if (operation?.phase === "succeeded" && connection !== null) {
      return accepted(command.commandId, connection.connectionId, true);
    }
    if (operation?.phase === "failed" || operation?.phase === "failed_after_effect") {
      this.throwTerminalOperation(operation);
    }
    const roots = await this.credentialRoots();
    const provisioner = new CredentialProvisioner(roots.stagingRoot, this.now);
    if (operation === null) {
      const stagedRead = await provisioner.readWithFileIdentity(command.params.provisioningRef, {
        allowExpiredClaimed: false,
      });
      const staged = stagedRead.credential;
      if (staged.providerId !== command.params.providerId || staged.authMode !== command.params.authMode) {
        throw new CommandRoutingError("provider.auth_mode_invalid", "The staged credential binding is invalid.");
      }
      const reserved = await this.storage.catalog.reserveFileProviderConnection({
        commandId: command.commandId,
        commandMethod: command.method,
        contentHash,
        connectionId: id("pconn"),
        providerId: command.params.providerId,
        authMode: command.params.authMode,
        displayName: command.params.displayName,
        identity: { status: "unverified" },
        credentialInternalRef: id("credref"),
        targetEnvelopeId: id("envl"),
        provisioningId: staged.provisioningId,
        stagingInternalRef: internalStagingRef(command.params.provisioningRef),
        stagingFileIdentity: stagedRead.fileIdentity,
        createdAtMs: this.now(),
      });
      operation = reserved.operation;
      if (reserved.connection === null) this.throwTerminalOperation(operation);
      connection = reserved.connection;
      this.hitFailpoint("after_provider_lifecycle_prepare", command.commandId);
      await this.fixtures.afterLifecyclePrepare?.(
        "create",
        command.commandId,
        connection.connectionId,
      );
    }
    if (
      operation.stagingInternalRef === null ||
      operation.credentialInternalRef === null ||
      operation.envelopeId === null ||
      connection === null
    ) {
      throw new CommandRoutingError("storage.corrupt", "The credential lifecycle reservation is incomplete.");
    }
    let staged: Awaited<ReturnType<CredentialProvisioner["readClaimedInternal"]>>;
    try {
      const stagedRead = await provisioner.readClaimedInternalWithFileIdentity(
        operation.stagingInternalRef,
      );
      staged = stagedRead.credential;
      this.assertClaimedStage(operation, connection, staged, stagedRead.fileIdentity);
    } catch (error) {
      await this.failOwnedOperation(operation, false, error);
      throw error;
    }
    const store = this.fileStore(roots.credentialRoot, command.commandId);
    try {
      await store.put(operation.credentialInternalRef, new StoredCredential({
      version: 1,
      envelopeId: operation.envelopeId,
      connectionId: connection.connectionId,
      providerId: connection.providerId,
      authMode: connection.authMode,
      generation: operation.reservedGeneration,
      updatedAtMs: this.now(),
      identity: connection.identity,
        credential: { type: "api_key", apiKey: staged.apiKey },
      }));
    } catch (error) {
      await this.failOwnedOperation(operation, true, error);
      throw error;
    }
    this.hitFailpoint("after_provider_file_effect", command.commandId);
    await this.storage.catalog.observeProviderLifecycleEffect({
      commandId: command.commandId,
      contentHash,
      observedEnvelopeId: operation.envelopeId,
      credentialInternalRef: operation.credentialInternalRef,
      updatedAtMs: this.now(),
    });
    this.hitFailpoint("after_provider_file_observed", command.commandId);
    const completed = await this.storage.catalog.completeProviderLifecycle({
      commandId: command.commandId,
      contentHash,
      observedEnvelopeId: operation.envelopeId,
      credentialInternalRef: operation.credentialInternalRef,
      terminalPhase: "succeeded",
      lifecycleStatus: "ready",
      result: { connectionId: connection.connectionId },
      failureCode: null,
      failureMessage: null,
      diagnosticId: null,
      updatedAtMs: this.now(),
    });
    this.hitFailpoint("after_provider_lifecycle_terminal_before_ack", command.commandId);
    await this.cleanupTerminalStage(operation.stagingInternalRef, command.commandId);
    await this.publishCapabilitiesAfterCommit(completed.connection);
    return accepted(command.commandId, completed.connection.connectionId, completed.duplicate);
  }

  private async replaceFileConnection(
    command: Extract<ProviderConnectionCommand, { readonly method: "providerConnection.file.replace" }>,
  ): Promise<CommandAcceptedMessage> {
    const contentHash = await canonicalJsonHash(command);
    let operation = await this.storage.catalog.getProviderLifecycleOperation(command.commandId);
    if (operation !== null) this.assertOperationMatches(operation, command, contentHash);
    let connection = await this.storage.catalog.getProviderConnection(command.params.connectionId);
    if (connection === null) {
      throw new CommandRoutingError("provider.connection_not_found", "The provider connection does not exist.");
    }
    if (operation?.phase === "succeeded") {
      return accepted(command.commandId, connection.connectionId, true);
    }
    if (connection.credentialInternalRef === null) {
      throw new CommandRoutingError("provider.credential_unavailable", "Only file credentials can be replaced by this operation.");
    }
    const roots = await this.credentialRoots();
    const provisioner = new CredentialProvisioner(roots.stagingRoot, this.now);
    if (operation === null) {
      const stagedRead = await provisioner.readWithFileIdentity(command.params.provisioningRef, {
        allowExpiredClaimed: false,
      });
      const staged = stagedRead.credential;
      if (staged.providerId !== connection.providerId || staged.authMode !== connection.authMode) {
        throw new CommandRoutingError("provider.auth_mode_invalid", "The staged credential binding is invalid.");
      }
      const prepared = await this.withConnectionLock(command.params.connectionId, async () => {
        const current = await this.storage.catalog.getProviderConnection(command.params.connectionId);
        if (current === null) {
          throw new CommandRoutingError(
            "provider.connection_not_found",
            "The provider connection does not exist.",
          );
        }
        if (current.credentialInternalRef === null) {
          throw new CommandRoutingError(
            "provider.credential_unavailable",
            "Only file credentials can be replaced by this operation.",
          );
        }
        connection = current;
        return this.storage.catalog.prepareProviderLifecycle({
          commandId: command.commandId,
          commandMethod: command.method,
          contentHash,
          operationKind: "replace",
          connectionId: current.connectionId,
          expectedLifecycleRevision: command.params.expectedLifecycleRevision,
          expectedGeneration: command.params.expectedGeneration,
          credentialBackendKind: "file",
          credentialInternalRef: current.recoveryTombstone
            ? id("credref")
            : current.credentialInternalRef,
          targetEnvelopeId: id("envl"),
          provisioningId: staged.provisioningId,
          stagingInternalRef: internalStagingRef(command.params.provisioningRef),
          stagingFileIdentity: stagedRead.fileIdentity,
          recoveryEpochId: null,
          expectedSafeMetadata: {
            previousEnvelopeId: current.envelopeId,
          },
          createdAtMs: this.now(),
        });
      });
      operation = prepared.operation;
      this.hitFailpoint("after_provider_lifecycle_prepare", command.commandId);
      await this.fixtures.afterLifecyclePrepare?.(
        "replace",
        command.commandId,
        connection.connectionId,
      );
    }
    if (
      operation.phase === "failed" ||
      operation.phase === "failed_after_effect" ||
      operation.stagingInternalRef === null ||
      operation.credentialInternalRef === null ||
      operation.envelopeId === null
    ) {
      throw new CommandRoutingError(
        operation.failureCode ?? "provider.operation_in_progress",
        operation.failureMessage ?? "The credential replacement could not acquire lifecycle ownership.",
      );
    }
    let staged: Awaited<ReturnType<CredentialProvisioner["readClaimedInternal"]>>;
    try {
      const stagedRead = await provisioner.readClaimedInternalWithFileIdentity(
        operation.stagingInternalRef,
      );
      staged = stagedRead.credential;
      this.assertClaimedStage(operation, connection, staged, stagedRead.fileIdentity);
    } catch (error) {
      await this.failOwnedOperation(operation, false, error);
      throw error;
    }
    if (connection.envelopeId === null) {
      const error = new CommandRoutingError(
        "provider.credential_unavailable",
        "The credential evidence is incomplete.",
      );
      await this.failOwnedOperation(operation, false, error);
      throw error;
    }
    try {
      const store = this.fileStore(roots.credentialRoot, command.commandId);
      const replacement = new StoredCredential({
        version: 1,
        envelopeId: operation.envelopeId,
        connectionId: connection.connectionId,
        providerId: connection.providerId,
        authMode: connection.authMode,
        generation: operation.reservedGeneration,
        updatedAtMs: this.now(),
        identity: connection.identity,
        credential: { type: "api_key", apiKey: staged.apiKey },
      });
      if (connection.recoveryTombstone) {
        await store.put(operation.credentialInternalRef, replacement);
      } else {
        await store.replaceBound(
          operation.credentialInternalRef,
          {
            connectionId: connection.connectionId,
            providerId: connection.providerId,
            authMode: connection.authMode,
            generation: operation.expectedGeneration ?? connection.credentialGeneration,
            envelopeId: connection.envelopeId,
          },
          replacement,
        );
      }
    } catch (error) {
      const afterEffect = !(error instanceof CredentialError &&
        error.code === "credential.binding_mismatch");
      await this.failOwnedOperation(operation, afterEffect, error);
      throw error;
    }
    this.hitFailpoint("after_provider_file_effect", command.commandId);
    await this.storage.catalog.observeProviderLifecycleEffect({
      commandId: command.commandId,
      contentHash,
      observedEnvelopeId: operation.envelopeId,
      credentialInternalRef: operation.credentialInternalRef,
      updatedAtMs: this.now(),
    });
    this.hitFailpoint("after_provider_file_observed", command.commandId);
    const completed = await this.storage.catalog.completeProviderLifecycle({
      commandId: command.commandId,
      contentHash,
      observedEnvelopeId: operation.envelopeId,
      credentialInternalRef: operation.credentialInternalRef,
      terminalPhase: "succeeded",
      lifecycleStatus: "ready",
      result: { connectionId: connection.connectionId },
      failureCode: null,
      failureMessage: null,
      diagnosticId: null,
      updatedAtMs: this.now(),
    });
    this.hitFailpoint("after_provider_lifecycle_terminal_before_ack", command.commandId);
    await this.cleanupTerminalStage(operation.stagingInternalRef, command.commandId);
    return accepted(command.commandId, completed.connection.connectionId, completed.duplicate);
  }

  private async exactPublishedLifecycleTarget(
    store: FileCredentialStore,
    operation: ProviderLifecycleOperationRecord,
    connection: ProviderConnectionRecord,
  ): Promise<CredentialWithFileIdentity | null> {
    if (operation.credentialInternalRef === null || operation.envelopeId === null) return null;
    const stored = await store.getWithFileIdentity(operation.credentialInternalRef);
    const metadata = stored?.credential.metadata;
    if (
      metadata?.envelopeId !== operation.envelopeId ||
      metadata.connectionId !== connection.connectionId ||
      metadata.providerId !== connection.providerId ||
      metadata.authMode !== connection.authMode ||
      metadata.generation !== operation.reservedGeneration ||
      canonicalJson(metadata.identity) !== canonicalJson(connection.identity)
    ) {
      return null;
    }
    return stored;
  }

  private claimedStageMatchesPublishedTarget(
    stagedApiKey: string,
    published: StoredCredential,
  ): boolean {
    let publishedApiKey = "";
    published.withApiKey((apiKey) => {
      publishedApiKey = apiKey;
    });
    const stagedDigest = createHash("sha256").update(stagedApiKey, "utf8").digest();
    const publishedDigest = createHash("sha256").update(publishedApiKey, "utf8").digest();
    return timingSafeEqual(stagedDigest, publishedDigest);
  }

  async recoverPreparedOperations(): Promise<void> {
    await this.storage.catalog.failValidatingProviderRecoveries(this.now());
    const operations = await this.storage.catalog.listPreparedProviderOperations();
    for (const operation of operations) {
      const connection = await this.storage.catalog.getProviderConnection(operation.targetConnectionId);
      if (connection === null) {
        await this.storage.catalog.failOrphanedProviderLifecycle({
          commandId: operation.commandId,
          contentHash: operation.contentHash,
          diagnosticId: null,
          updatedAtMs: this.now(),
        });
        continue;
      }
      let lifecycleStatus: "ready" | "reauth_required" | "disabled" | "unavailable" = "unavailable";
      if (
        operation.operationKind === "create" ||
        operation.operationKind === "replace" ||
        operation.operationKind === "reauthenticate" ||
        operation.operationKind === "refresh" ||
        operation.operationKind === "credential_recovery" ||
        operation.operationKind === "enable"
      ) {
        lifecycleStatus = "ready";
      } else if (operation.operationKind === "disable") {
        lifecycleStatus = "disabled";
      } else if (operation.operationKind === "logout") {
        lifecycleStatus = "reauth_required";
      }
      try {
        if (operation.operationKind === "enable") {
          if (
            connection.deleted ||
            connection.credentialBackend.kind !== "environment" ||
            connection.lifecycleStatus !== "unavailable"
          ) {
            throw new Error("Environment revalidation target is no longer unavailable.");
          }
          this.environmentLeases.validate(connection.credentialBackend.variableName);
        }
        if (operation.credentialBackendKind === "file" && operation.credentialInternalRef !== null) {
          const roots = await this.credentialRoots();
          const store = this.fileStore(roots.credentialRoot, operation.commandId);
          if (operation.operationKind === "logout" || operation.operationKind === "delete") {
            if (connection.envelopeId === null) throw new Error("Credential evidence is incomplete.");
            await store.deleteBound(operation.credentialInternalRef, {
              connectionId: connection.connectionId,
              providerId: connection.providerId,
              authMode: connection.authMode,
              generation: connection.credentialGeneration,
              envelopeId: connection.envelopeId,
            });
          } else if (
            operation.operationKind === "create" ||
            operation.operationKind === "replace" ||
            operation.operationKind === "reauthenticate" ||
            operation.operationKind === "refresh" ||
            operation.operationKind === "credential_recovery"
          ) {
            const publishedTarget = await this.exactPublishedLifecycleTarget(
              store,
              operation,
              connection,
            );
            if (operation.operationKind === "credential_recovery") {
              if (
                publishedTarget === null ||
                operation.recoveryFileIdentity === null ||
                canonicalJson(publishedTarget.fileIdentity) !==
                  canonicalJson(operation.recoveryFileIdentity)
              ) {
                throw new Error("Published credential target has mismatched binding evidence.");
              }
            } else if (publishedTarget !== null && operation.stagingInternalRef !== null) {
              const provisioner = new CredentialProvisioner(roots.stagingRoot, this.now);
              try {
                const stagedRead = await provisioner.readClaimedInternalWithFileIdentity(
                  operation.stagingInternalRef,
                );
                const staged = stagedRead.credential;
                this.assertClaimedStage(operation, connection, staged, stagedRead.fileIdentity);
                if (!this.claimedStageMatchesPublishedTarget(staged.apiKey, publishedTarget.credential)) {
                  throw new Error("Published credential target has mismatched secret evidence.");
                }
              } catch (error) {
                if (!(error instanceof CredentialError) || error.code !== "credential.stage_missing") {
                  throw error;
                }
              }
            } else if (publishedTarget === null) {
              if (operation.stagingInternalRef === null || operation.envelopeId === null) {
                throw new Error("Credential operation has no recoverable staged effect.");
              }
              const provisioner = new CredentialProvisioner(roots.stagingRoot, this.now);
              const stagedRead = await provisioner.readClaimedInternalWithFileIdentity(
                operation.stagingInternalRef,
              );
              const staged = stagedRead.credential;
              this.assertClaimedStage(operation, connection, staged, stagedRead.fileIdentity);
              const replacement = new StoredCredential({
                version: 1,
                envelopeId: operation.envelopeId,
                connectionId: connection.connectionId,
                providerId: connection.providerId,
                authMode: connection.authMode,
                generation: operation.reservedGeneration,
                updatedAtMs: this.now(),
                identity: connection.identity,
                credential: { type: "api_key", apiKey: staged.apiKey },
              });
              const publishesFreshTombstoneRef =
                operation.operationKind === "replace" &&
                connection.recoveryTombstone &&
                operation.credentialInternalRef !== connection.credentialInternalRef;
              if (operation.operationKind === "create" || publishesFreshTombstoneRef) {
                await store.put(operation.credentialInternalRef, replacement);
              } else {
                if (connection.envelopeId === null) throw new Error("Credential evidence is incomplete.");
                await store.replaceBound(operation.credentialInternalRef, {
                  connectionId: connection.connectionId,
                  providerId: connection.providerId,
                  authMode: connection.authMode,
                  generation: operation.expectedGeneration ?? connection.credentialGeneration,
                  envelopeId: connection.envelopeId,
                }, replacement);
              }
            }
          }
          if ([
            "create", "replace", "reauthenticate", "refresh", "credential_recovery", "logout", "delete",
          ].includes(operation.operationKind)) {
            await this.storage.catalog.observeProviderLifecycleEffect({
              commandId: operation.commandId,
              contentHash: operation.contentHash,
              observedEnvelopeId: operation.envelopeId,
              credentialInternalRef: operation.credentialInternalRef,
              updatedAtMs: this.now(),
            });
          }
        }
        await this.storage.catalog.completeProviderLifecycle({
          commandId: operation.commandId,
          contentHash: operation.contentHash,
          observedEnvelopeId: operation.envelopeId,
          credentialInternalRef: operation.credentialInternalRef,
          terminalPhase: "succeeded",
          lifecycleStatus,
          result: { connectionId: connection.connectionId },
          failureCode: null,
          failureMessage: null,
          diagnosticId: null,
          updatedAtMs: this.now(),
        });
        if (operation.stagingInternalRef !== null) {
          const roots = await this.credentialRoots();
          await new CredentialProvisioner(roots.stagingRoot, this.now)
            .deleteClaimedInternal(operation.stagingInternalRef);
        }
      } catch (error) {
        let afterEffect = operation.operationKind !== "enable";
        try {
          if (operation.operationKind !== "enable") {
            afterEffect = !(await this.canProveLifecycleEffectAbsent(operation, connection));
          }
        } catch {
          // Unprovable evidence remains an after-effect failure.
        }
        await this.failOwnedOperation(operation, afterEffect, error);
      }
    }
    const roots = await this.credentialRoots();
    const provisioner = new CredentialProvisioner(roots.stagingRoot, this.now);
    for (const stagingInternalRef of await this.storage.catalog.listTerminalProviderStages()) {
      await provisioner.deleteClaimedInternal(stagingInternalRef);
      await this.storage.catalog.markProviderStageCleaned(stagingInternalRef);
    }
    await provisioner.cleanupExpiredUnclaimed((provisioningId) =>
      this.storage.catalog.isProvisioningClaimActive(provisioningId));
  }

  async resolveSessionDefault(
    command: Parameters<ProviderConnectionCommandHandler["resolveSessionDefault"]>[0],
  ): Promise<SessionProviderDefault> {
    const authority = await this.selectionAuthority;
    const resolved = {
      ...command.params.default,
      promptVersion: authority.promptVersion,
      toolSchemaHash: authority.toolSchemaHash,
    };
    await this.resolveDefault(resolved, false, authority.toolsAvailable);
    return resolved;
  }

  async snapshotForRun(
    defaultValue: SessionProviderDefault,
    runId: string,
  ): Promise<RunProviderSelectionSnapshot> {
    const authority = await this.selectionAuthority;
    if (
      defaultValue.promptVersion !== authority.promptVersion ||
      defaultValue.toolSchemaHash !== authority.toolSchemaHash
    ) {
      throw new CommandRoutingError(
        "provider.capabilities_unavailable",
        "The selected prompt or tool schema changed after the session default was chosen.",
      );
    }
    // Resolve once without a lock so a concurrent cutoff can win before acceptance admission.
    await this.resolveDefault(defaultValue, true, authority.toolsAvailable);
    const connectionId = defaultValue.policy.connectionId;
    const release = await this.acquireConnectionLock(connectionId);
    let transferred = false;
    try {
      const selected = await this.resolveDefault(defaultValue, true, authority.toolsAvailable);
      if (selected.connection.credentialBackend.kind === "environment") {
        try {
          const lease = this.environmentLeases.accept({
            runId,
            connectionId: selected.connection.connectionId,
            generation: selected.connection.credentialGeneration,
            lifecycleRevision: selected.connection.lifecycleRevision,
            variableName: selected.connection.credentialBackend.variableName,
          });
          this.leasesByRun.set(runId, lease);
        } catch (error) {
          if (
            error instanceof CredentialError &&
            error.code === "credential.environment_invalid"
          ) {
            await this.storage.catalog.markEnvironmentConnectionUnavailable({
              connectionId: selected.connection.connectionId,
              expectedGeneration: selected.connection.credentialGeneration,
              expectedLifecycleRevision: selected.connection.lifecycleRevision,
              updatedAtMs: this.now(),
            });
            throw new CommandRoutingError(error.code, error.message);
          }
          throw error;
        }
      }
      const snapshot: RunProviderSelectionSnapshot = {
        version: 1,
        routingPolicy: defaultValue.policy,
        routingDecision: { kind: "explicit", connectionId: selected.connection.connectionId },
        connectionId: selected.connection.connectionId,
        credentialGeneration: selected.connection.credentialGeneration,
        lifecycleRevision: selected.connection.lifecycleRevision,
        credentialBackend: selected.connection.credentialBackend.kind === "environment"
          ? { kind: "environment", backendProcessEpoch: this.processEpoch }
          : { kind: "file" },
        providerId: selected.connection.providerId,
        authMode: selected.connection.authMode,
        identity: selected.connection.identity,
        modelId: defaultValue.modelId,
        capabilitiesVersion: selected.capabilities.capabilitiesVersion,
        acceptedCapabilities: {
          modelId: defaultValue.modelId,
          reasoning: defaultValue.reasoning,
          tools: authority.toolsAvailable,
          transportMode: defaultValue.transportMode,
        },
        promptVersion: defaultValue.promptVersion,
        toolSchemaHash: defaultValue.toolSchemaHash,
        reasoning: defaultValue.reasoning,
        transportMode: defaultValue.transportMode,
        providerChainId: id("pchain"),
      };
      this.runAcceptanceReleases.set(runId, release);
      transferred = true;
      return snapshot;
    } finally {
      if (!transferred) release();
    }
  }

  async startRecoveryScan(): Promise<CredentialRecoveryScanResult> {
    if (this.closing) {
      throw new CommandRoutingError(
        "server.shutting_down",
        "Provider connection management is shutting down.",
      );
    }
    if (!this.catalogLossRecoveryAvailable) {
      throw new CommandRoutingError(
        "provider.connection_unavailable",
        "Credential recovery scanning is unavailable while the provider catalog is authoritative.",
      );
    }
    if (
      this.recoveryScanResult !== null &&
      this.recoveryScanner?.isEpochOpen(this.recoveryScanResult.recoveryEpochId) === true
    ) {
      return this.recoveryScanResult;
    }
    if (this.recoveryScanPromise !== null) return this.recoveryScanPromise;
    const scan = (async () => {
      const roots = await this.credentialRoots();
      this.recoveryScanner?.close();
      const representedRefs = new Set(this.catalogLossRecoveryRepresentedRefs);
      const scanner = new CredentialRecoveryScanner(
        new FileCredentialStore(roots.credentialRoot),
        this.now,
        undefined,
        (internalRef) => !representedRefs.has(internalRef),
        () => {
          if (this.recoveryScanner !== scanner) return;
          this.recoveryScanner = null;
          this.recoveryScanResult = null;
        },
      );
      this.recoveryScanner = scanner;
      const result = CredentialRecoveryScanResultSchema.parse(
        await scanner.scanClosedRoot(),
      );
      await this.fixtures.beforeRecoveryScanPublication?.();
      if (
        this.recoveryScanner !== scanner ||
        !scanner.isEpochOpen(result.recoveryEpochId)
      ) {
        throw new CommandRoutingError(
          "credential.recovery_ref_expired",
          "The credential recovery scan expired before publication.",
        );
      }
      if (this.closing) {
        scanner.close();
        throw new CommandRoutingError(
          "server.shutting_down",
          "Provider connection management is shutting down.",
        );
      }
      this.recoveryScanResult = result;
      return result;
    })();
    this.recoveryScanPromise = scan;
    try {
      return await scan;
    } finally {
      if (this.recoveryScanPromise === scan) this.recoveryScanPromise = null;
    }
  }

  getEnvironmentLease(runId: string): EnvironmentCredentialLease | null {
    return this.leasesByRun.get(runId) ?? null;
  }

  shouldInterruptRestoredRun(run: RunRecord): boolean {
    const backend = run.providerSelection?.credentialBackend;
    return backend?.kind === "environment" && backend.backendProcessEpoch !== this.processEpoch;
  }

  completeRunAcceptance(runId: string): void {
    const release = this.runAcceptanceReleases.get(runId);
    if (release === undefined) return;
    this.runAcceptanceReleases.delete(runId);
    release();
  }

  discardRunLease(runId: string): void {
    this.completeRunAcceptance(runId);
    this.leasesByRun.delete(runId);
    this.environmentLeases.discard(runId);
  }

  async acquireCredentialRequestLease(
    runId: string,
    selection: RunProviderSelectionSnapshot | null,
  ): Promise<CredentialRequestLease> {
    if (this.closing) {
      throw new CommandRoutingError(
        "server.shutting_down",
        "Provider credential requests are shutting down.",
      );
    }
    if (selection === null) {
      return {
        withCredential: (use) => use(undefined),
        release: () => undefined,
      };
    }
    return this.withConnectionLock(selection.connectionId, async () => {
      let apiKey: string;
      const current = await this.storage.catalog.getProviderConnection(selection.connectionId);
      if (
        current === null ||
        current.deleted ||
        current.lifecycleStatus !== "ready" ||
        current.lifecycleOwnerKind !== null ||
        current.credentialGeneration !== selection.credentialGeneration ||
        current.lifecycleRevision !== selection.lifecycleRevision
      ) {
        throw new CommandRoutingError(
          "provider.connection_unavailable",
          "The selected provider connection changed before request issuance.",
        );
      }
      if (selection.credentialBackend.kind === "environment") {
        try {
          apiKey = this.environmentLeases.withCredential(
            runId,
            {
              connectionId: selection.connectionId,
              generation: selection.credentialGeneration,
              lifecycleRevision: selection.lifecycleRevision,
              processEpoch: selection.credentialBackend.backendProcessEpoch,
            },
            (value) => value,
          );
        } catch (error) {
          await this.storage.catalog.markEnvironmentConnectionUnavailable({
            connectionId: selection.connectionId,
            expectedGeneration: selection.credentialGeneration,
            expectedLifecycleRevision: selection.lifecycleRevision,
            updatedAtMs: this.now(),
          }).catch(() => undefined);
          throw error;
        }
      } else {
        if (current.credentialInternalRef === null || current.envelopeId === null) {
          throw new CommandRoutingError(
            "provider.credential_unavailable",
            "The selected file credential evidence is incomplete.",
          );
        }
        const roots = await this.credentialRoots();
        const credential = await new FileCredentialStore(roots.credentialRoot).getBound(
          current.credentialInternalRef,
          {
            connectionId: current.connectionId,
            providerId: current.providerId,
            authMode: current.authMode,
            generation: selection.credentialGeneration,
          },
        );
        if (credential === null || credential.metadata.envelopeId !== current.envelopeId) {
          throw new CommandRoutingError(
            "provider.credential_unavailable",
            "The selected file credential is unavailable.",
          );
        }
        apiKey = credential.withApiKey((value) => value);
      }
      const leaseId = id("requestLease");
      this.activeRequestLeases.set(leaseId, selection.connectionId);
      let released = false;
      return {
        withCredential: <T>(use: (credential: IssuedProviderCredential | undefined) => T): T => {
          if (released) {
            throw new CommandRoutingError(
              "provider.credential_unavailable",
              "The provider credential request lease was already released.",
            );
          }
          return use({ type: "api_key", apiKey });
        },
        release: (): void => {
          if (released) return;
          released = true;
          apiKey = "";
          this.activeRequestLeases.delete(leaseId);
        },
      };
    });
  }

  async withEnvironmentCredentialForRequest<T>(
    runId: string,
    selection: RunProviderSelectionSnapshot | null,
    use: () => T | Promise<T>,
  ): Promise<T> {
    const lease = await this.acquireCredentialRequestLease(runId, selection);
    try {
      return await lease.withCredential(() => use());
    } finally {
      lease.release();
    }
  }

  private async resolveDefault(
    defaultValue: SessionProviderDefault | SessionProviderDefaultRequest,
    requireAdapter: boolean,
    toolsAvailable: boolean,
  ) {
    const internal = await this.storage.catalog.getProviderConnection(defaultValue.policy.connectionId);
    if (internal === null) {
      throw new CommandRoutingError("provider.connection_not_found", "The selected provider connection does not exist.");
    }
    const connection = safeConnectionView(internal);
    const capabilityRecord = await this.storage.catalog.getProviderCapabilities(connection.connectionId);
    const capabilities = capabilityRecord;
    if (capabilities?.capabilitiesVersion !== defaultValue.capabilitiesVersion) {
      throw new CommandRoutingError(
        "provider.capabilities_unavailable",
        "The selected provider capabilities changed after the session default was chosen.",
      );
    }
    try {
      const selected = this.router.select({
        policy: defaultValue.policy,
        modelId: defaultValue.modelId,
        reasoning: defaultValue.reasoning,
        requiresTools: toolsAvailable,
        transportMode: defaultValue.transportMode,
        credentialBackendAvailable: !requireAdapter || (this.fixtures.adapterAvailable?.(connection) ?? false),
      }, [{ connection, capabilities }]);
      return { connection: selected.connection, capabilities: selected.capabilities };
    } catch (error) {
      if (error instanceof ProviderRoutingError) {
        throw new CommandRoutingError(error.code, error.message);
      }
      throw error;
    }
  }

  private reportMaintenanceFailure(kind: ProviderMaintenanceKind, error: unknown): void {
    try {
      this.onMaintenanceFailure?.(kind, error);
    } catch {
      // Diagnostics cannot change an already committed lifecycle result.
    }
  }

  private async publishCapabilitiesAfterCommit(
    connection: ProviderConnectionSafeView,
  ): Promise<void> {
    try {
      this.fixtures.beforePostCommitMaintenance?.("capabilities");
      await this.publishFixtureCapabilities(connection);
      this.pendingCapabilityRepairs.delete(connection.connectionId);
    } catch (error) {
      this.pendingCapabilityRepairs.add(connection.connectionId);
      this.reportMaintenanceFailure("capabilities", error);
    }
  }

  private async refreshRecoveryAvailabilityAfterCommit(): Promise<void> {
    try {
      this.fixtures.beforePostCommitMaintenance?.("recovery_availability");
      await this.refreshCatalogLossRecoveryAvailability();
      this.recoveryAvailabilityRepairPending = false;
    } catch (error) {
      this.recoveryAvailabilityRepairPending = true;
      this.reportMaintenanceFailure("recovery_availability", error);
    }
  }

  private async repairPostCommitMaintenance(): Promise<void> {
    for (const connectionId of [...this.pendingCapabilityRepairs]) {
      const connection = await this.storage.catalog.getProviderConnection(connectionId);
      if (connection === null) {
        this.pendingCapabilityRepairs.delete(connectionId);
        continue;
      }
      await this.publishCapabilitiesAfterCommit(connection);
    }
    if (this.recoveryAvailabilityRepairPending) {
      await this.refreshRecoveryAvailabilityAfterCommit();
    }
  }

  private async publishFixtureCapabilities(connection: ProviderConnectionSafeView): Promise<void> {
    const snapshot = this.fixtures.capabilitiesForConnection?.(connection) ?? null;
    if (snapshot === null) return;
    await this.storage.catalog.putProviderCapabilities({
      snapshot,
      expectedMetadataRevision: connection.metadataRevision,
      updatedAtMs: this.now(),
    });
  }
}
