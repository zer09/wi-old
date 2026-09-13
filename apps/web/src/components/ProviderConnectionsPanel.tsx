import { useEffect, useState } from "react";

import {
  createId,
  type CommandMessage,
  type ProviderCapabilitiesSnapshot,
  type ProviderConnectionList,
  type SessionProviderDefault,
} from "@wi/protocol";

import {
  fetchCredentialRecoveryCommandStatus,
  fetchCredentialRecoveryScan,
  fetchProviderCapabilities,
  fetchProviderConnections,
  type CredentialRecoveryScanResponse,
} from "../api/provider-connections.js";
import { startBoundedPoll } from "../state/bounded-poller.js";
import { createRecoveryReconciliationJournal } from "../state/recovery-journal.js";

const PROVIDER_POLL_INTERVAL_MS = 2_000;
const PROVIDER_POLL_TIMEOUT_MS = 5_000;

function idSource(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

export interface ProviderConnectionsPanelProps {
  readonly selectedSessionId: string | null;
  readonly selectedDefault: SessionProviderDefault | null;
  readonly disabled: boolean;
  readonly onCommand: (command: CommandMessage) => string | null;
  readonly onNotice: (message: string, error?: boolean) => void;
}

type SafeConnection = ProviderConnectionList["connections"][number];

function connectionIdentityContext(connection: SafeConnection): string {
  if (connection.identity.status === "unverified") {
    return `connection ${connection.connectionId}`;
  }
  const identity = connection.identity;
  const parts = [
    identity.subjectId === undefined ? null : `subject ${identity.subjectId}`,
    identity.accountId === undefined ? null : `account ${identity.accountId}`,
    identity.projectId === undefined ? null : `project ${identity.projectId}`,
    identity.workspace.presence === "value" ? `workspace ${identity.workspace.value}` : null,
    identity.planType === undefined ? null : `plan ${identity.planType}`,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

function connectionLabel(connection: SafeConnection): string {
  return [
    connection.displayName,
    connection.providerId,
    connection.authMode,
    connection.credentialBackend.kind,
    connectionIdentityContext(connection),
  ].join(" · ");
}

export function ProviderConnectionsPanel(props: ProviderConnectionsPanelProps) {
  const [catalog, setCatalog] = useState<ProviderConnectionList | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [variableName, setVariableName] = useState("");
  const [provisioningRef, setProvisioningRef] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState(
    props.selectedDefault?.policy.connectionId ?? "",
  );
  const [capabilities, setCapabilities] = useState<ProviderCapabilitiesSnapshot | null>(null);
  const [modelId, setModelId] = useState(props.selectedDefault?.modelId ?? "");
  const [managedConnectionId, setManagedConnectionId] = useState("");
  const [renameDisplayName, setRenameDisplayName] = useState("");
  const [replacementProvisioningRef, setReplacementProvisioningRef] = useState("");
  const [recoveryScan, setRecoveryScan] = useState<CredentialRecoveryScanResponse | null>(null);
  const [recoveryJournal] = useState(createRecoveryReconciliationJournal);

  useEffect(() => {
    const poll = startBoundedPoll({
      intervalMs: PROVIDER_POLL_INTERVAL_MS,
      timeoutMs: PROVIDER_POLL_TIMEOUT_MS,
      request: async (signal) => Promise.all(recoveryJournal.entries().map(async (entry) => {
        try {
          const status = await fetchCredentialRecoveryCommandStatus(
            entry.commandId,
            entry.recoveryEpochId,
            entry.expectedSafeMetadata,
            signal,
          );
          return { entry, status };
        } catch {
          return null;
        }
      })),
      onResult: (results) => {
        for (const result of results) {
          if (result === null) continue;
          const { entry, status } = result;
          if (!recoveryJournal.entries().some((current) => current.commandId === entry.commandId)) {
            continue;
          }
          if (status.status === "succeeded") {
            recoveryJournal.remove(entry.commandId);
            setRecoveryScan(null);
            props.onNotice(`${entry.displayName} recovery completed.`);
          } else if (["failed", "failed_after_effect", "conflict", "not_accepted"].includes(status.status)) {
            recoveryJournal.remove(entry.commandId);
            setRecoveryScan(null);
            props.onNotice(`${entry.displayName} recovery was not accepted.`, true);
          }
        }
      },
    });
    return () => poll.stop();
  }, [recoveryJournal]);

  useEffect(() => {
    let revision = -1;
    const poll = startBoundedPoll({
      intervalMs: PROVIDER_POLL_INTERVAL_MS,
      timeoutMs: PROVIDER_POLL_TIMEOUT_MS,
      request: fetchProviderConnections,
      onResult: (next) => {
        if (next.catalogRevision !== revision) {
          revision = next.catalogRevision;
          setCatalog(next);
        }
      },
      onError: () => props.onNotice("Provider connections could not be loaded.", true),
    });
    return () => poll.stop();
  }, []);

  useEffect(() => {
    setSelectedConnectionId(props.selectedDefault?.policy.connectionId ?? "");
    setModelId(props.selectedDefault?.modelId ?? "");
    setCapabilities(null);
  }, [
    props.selectedSessionId,
    props.selectedDefault?.policy.connectionId,
    props.selectedDefault?.modelId,
  ]);

  useEffect(() => {
    if (recoveryScan === null) return;
    const recoveryEpochId = recoveryScan.recoveryEpochId;
    const delayMs = Math.max(0, recoveryScan.expiresAtMs - Date.now());
    const timer = globalThis.setTimeout(() => {
      setRecoveryScan((current) =>
        current?.recoveryEpochId === recoveryEpochId ? null : current
      );
    }, delayMs);
    return () => globalThis.clearTimeout(timer);
  }, [recoveryScan]);

  useEffect(() => {
    if (selectedConnectionId.length === 0) {
      setCapabilities(null);
      setModelId("");
      return;
    }
    const controller = new AbortController();
    setCapabilities(null);
    void fetchProviderCapabilities(selectedConnectionId, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setCapabilities(next);
        setModelId((current) =>
          next.models.some((model) => model.modelId === current)
            ? current
            : next.models[0]?.modelId ?? ""
        );
      },
      () => {
        if (!controller.signal.aborted) {
          setCapabilities(null);
          setModelId("");
        }
      },
    );
    return () => controller.abort();
  }, [selectedConnectionId, catalog?.catalogRevision]);

  const send = (command: CommandMessage): boolean => {
    const error = props.onCommand(command);
    if (error !== null) props.onNotice(error, true);
    return error === null;
  };

  const createEnvironment = (): void => void send({
    v: 1,
    kind: "command",
    commandId: createId("command", idSource),
    method: "providerConnection.environment.create",
    params: {
      providerId: "openai_platform",
      authMode: "api_key",
      displayName,
      variableName,
    },
  });

  const createFile = (): void => void send({
    v: 1,
    kind: "command",
    commandId: createId("command", idSource),
    method: "providerConnection.file.create",
    params: {
      providerId: "openai_platform",
      authMode: "api_key",
      displayName,
      provisioningRef,
    },
  });

  const scanCredentials = (): void => {
    void fetchCredentialRecoveryScan().then(
      setRecoveryScan,
      () => props.onNotice("Credential recovery scan failed safely.", true),
    );
  };

  const recoverCredential = (
    candidate: CredentialRecoveryScanResponse["candidates"][number],
  ): void => {
    if (recoveryScan === null) return;
    const commandId = createId("command", idSource);
    try {
      recoveryJournal.add({
        commandId,
        operationKind: "credential_recovery",
        recoveryEpochId: recoveryScan.recoveryEpochId,
        expiresAtMs: recoveryScan.expiresAtMs,
        displayName: `Recovered ${candidate.providerId}`,
        expectedSafeMetadata: {
          expected: {
            providerId: candidate.providerId,
            authMode: candidate.authMode,
            originalConnectionId: candidate.originalConnectionId,
            generation: candidate.generation,
            identity: candidate.identity,
            updatedAtMs: candidate.updatedAtMs,
          },
          displayName: `Recovered ${candidate.providerId}`,
        },
      });
    } catch {
      props.onNotice("Recovery could not be recorded safely before sending.", true);
      return;
    }
    const sent = send({
      v: 1,
      kind: "command",
      commandId,
      method: "providerConnection.recover",
      params: {
        recoveryRef: candidate.recoveryRef,
        recoveryEpochId: recoveryScan.recoveryEpochId,
        expected: {
          providerId: candidate.providerId,
          authMode: candidate.authMode,
          originalConnectionId: candidate.originalConnectionId,
          generation: candidate.generation,
          identity: candidate.identity,
          updatedAtMs: candidate.updatedAtMs,
        },
        displayName: `Recovered ${candidate.providerId}`,
      },
    });
    setRecoveryScan((current) => {
      if (current?.recoveryEpochId !== recoveryScan.recoveryEpochId) return current;
      const candidates = current.candidates.filter(
        (currentCandidate) => currentCandidate.recoveryRef !== candidate.recoveryRef,
      );
      return candidates.length === 0 ? null : { ...current, candidates };
    });
    if (!sent) recoveryJournal.remove(commandId);
  };

  const managedConnection = catalog?.connections.find(
    (connection) => connection.connectionId === managedConnectionId,
  ) ?? null;

  const renameConnection = (): void => {
    if (managedConnection === null) return;
    send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      method: "providerConnection.rename",
      params: {
        connectionId: managedConnection.connectionId,
        expectedMetadataRevision: managedConnection.metadataRevision,
        displayName: renameDisplayName,
      },
    });
  };

  const replaceFileCredential = (): void => {
    if (managedConnection === null || managedConnection.credentialBackend.kind !== "file") return;
    send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      method: "providerConnection.file.replace",
      params: {
        connectionId: managedConnection.connectionId,
        expectedLifecycleRevision: managedConnection.lifecycleRevision,
        expectedGeneration: managedConnection.credentialGeneration,
        provisioningRef: replacementProvisioningRef,
      },
    });
  };

  const revalidateEnvironment = (
    connection: NonNullable<ProviderConnectionList>["connections"][number],
  ): void => {
    if (connection.credentialBackend.kind !== "environment") return;
    send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      method: "providerConnection.environment.revalidate",
      params: {
        connectionId: connection.connectionId,
        expectedLifecycleRevision: connection.lifecycleRevision,
        expectedGeneration: connection.credentialGeneration,
      },
    });
  };

  const lifecycle = (
    method: "providerConnection.disable" | "providerConnection.logout" | "providerConnection.delete",
    connection: NonNullable<ProviderConnectionList>["connections"][number],
  ): void => void send({
    v: 1,
    kind: "command",
    commandId: createId("command", idSource),
    method,
    params: {
      connectionId: connection.connectionId,
      expectedLifecycleRevision: connection.lifecycleRevision,
      expectedGeneration: connection.credentialGeneration,
    },
  });

  const setDefault = (): void => {
    if (props.selectedSessionId === null || capabilities === null || modelId.length === 0) return;
    send({
      v: 1,
      kind: "command",
      commandId: createId("command", idSource),
      sessionId: props.selectedSessionId,
      method: "session.providerDefault.set",
      params: { default: {
        version: 1,
        policy: { kind: "explicit", connectionId: selectedConnectionId },
        modelId,
        capabilitiesVersion: capabilities.capabilitiesVersion,
        reasoning: { effort: "none", summary: "none" },
        transportMode: capabilities.models.find((model) => model.modelId === modelId)
          ?.transports[0] ?? "responses_http_sse",
      } },
    });
  };

  return (
    <details className="provider-panel">
      <summary>Provider connections</summary>
      <div className="provider-panel__create">
        <p>
          Stage keys locally with <code>pnpm credentials:provision</code> for masked input,
          or <code>node apps/server/dist/credential-cli.js --api-key-fd 3</code> for an open
          descriptor. Paste only the returned <code>provref_…</code> value here.
        </p>
        <input aria-label="Connection display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Display name" />
        <input aria-label="Environment variable name" value={variableName} onChange={(event) => setVariableName(event.target.value)} placeholder="OPENAI_API_KEY" />
        <button type="button" disabled={props.disabled || !displayName || !variableName} onClick={createEnvironment}>Add environment</button>
        <input aria-label="Provisioning reference" value={provisioningRef} onChange={(event) => setProvisioningRef(event.target.value)} placeholder="provref_…" />
        <button type="button" disabled={props.disabled || !displayName || !provisioningRef} onClick={createFile}>Claim staged key</button>
      </div>
      <button type="button" disabled={props.disabled} onClick={scanCredentials}>Scan orphaned credentials</button>
      {recoveryScan === null ? null : (
        <ul className="provider-panel__recovery" aria-label="Recoverable credentials">
          {recoveryScan.candidates.map((candidate) => (
            <li key={candidate.recoveryRef}>
              {candidate.providerId} · {candidate.authMode} · generation {candidate.generation} · original connection {candidate.originalConnectionId}
              <button type="button" disabled={props.disabled} onClick={() => recoverCredential(candidate)}>Recover original connection</button>
            </li>
          ))}
        </ul>
      )}
      <div className="provider-panel__management">
        <label>Manage connection
          <select value={managedConnectionId} onChange={(event) => setManagedConnectionId(event.target.value)}>
            <option value="">Select…</option>
            {(catalog?.connections ?? []).map((connection) => (
              <option key={connection.connectionId} value={connection.connectionId}>{connectionLabel(connection)}</option>
            ))}
          </select>
        </label>
        <input aria-label="Renamed connection display name" value={renameDisplayName} onChange={(event) => setRenameDisplayName(event.target.value)} placeholder="New display name" />
        <button type="button" disabled={props.disabled || managedConnection === null || !renameDisplayName} onClick={renameConnection}>Rename connection</button>
        <input aria-label="Replacement provisioning reference" value={replacementProvisioningRef} onChange={(event) => setReplacementProvisioningRef(event.target.value)} placeholder="provref_…" />
        <button type="button" disabled={props.disabled || managedConnection?.credentialBackend.kind !== "file" || !replacementProvisioningRef} onClick={replaceFileCredential}>Replace file credential</button>
      </div>
      <ul className="provider-panel__list">
        {(catalog?.connections ?? []).map((connection) => (
          <li key={connection.connectionId}>
            <strong>{connection.displayName}</strong> — {connection.lifecycleStatus} · {connection.credentialBackend.kind} · generation {connection.credentialGeneration} · {connection.providerId} · {connection.authMode} · {connectionIdentityContext(connection)}
            <span className="provider-panel__actions">
              <button type="button" disabled={props.disabled || connection.lifecycleOwnerKind !== null} onClick={() => lifecycle("providerConnection.disable", connection)}>Disable</button>
              <button type="button" disabled={props.disabled || connection.credentialBackend.kind !== "environment" || connection.lifecycleStatus !== "unavailable" || connection.deleted || connection.lifecycleOwnerKind !== null} onClick={() => revalidateEnvironment(connection)}>Revalidate environment</button>
              <button type="button" disabled={props.disabled || connection.lifecycleOwnerKind !== null} onClick={() => lifecycle("providerConnection.logout", connection)}>Logout</button>
              <button type="button" disabled={props.disabled || connection.lifecycleOwnerKind !== null} onClick={() => lifecycle("providerConnection.delete", connection)}>Delete</button>
            </span>
          </li>
        ))}
      </ul>
      {props.selectedSessionId === null ? null : (
        <div className="provider-panel__default">
          <label>Session connection
            <select value={selectedConnectionId} onChange={(event) => setSelectedConnectionId(event.target.value)}>
              <option value="">Select…</option>
              {(catalog?.connections ?? []).map((connection) => (
                <option key={connection.connectionId} value={connection.connectionId}>{connectionLabel(connection)}</option>
              ))}
            </select>
          </label>
          <label>Model
            <select aria-label="Provider model" value={modelId} onChange={(event) => setModelId(event.target.value)}>
              {(capabilities?.models ?? []).map((model) => <option key={model.modelId} value={model.modelId}>{model.label}</option>)}
            </select>
          </label>
          <button type="button" disabled={props.disabled || capabilities === null || !modelId} onClick={setDefault}>Use for future runs</button>
        </div>
      )}
    </details>
  );
}
