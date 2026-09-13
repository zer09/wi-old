import {
  CredentialRecoveryCommandStatusSchema,
  CredentialRecoveryScanResultSchema,
  ProviderCapabilitiesSnapshotSchema,
  ProviderConnectionListSchema,
  canonicalJson,
  type CredentialRecoveryCommandStatus,
  type CredentialRecoveryExpectedSafeMetadata,
  type CredentialRecoveryScanResult,
  type ProviderCapabilitiesSnapshot,
  type ProviderConnectionList,
} from "@wi/protocol";

async function readJson(response: Response): Promise<unknown> {
  const value = await response.json() as unknown;
  if (!response.ok) throw new Error("Provider connection request failed.");
  return value;
}

export async function fetchProviderConnections(
  signal?: AbortSignal,
): Promise<ProviderConnectionList> {
  const response = await fetch("/api/provider-connections", {
    credentials: "same-origin",
    cache: "no-store",
    ...(signal === undefined ? {} : { signal }),
  });
  return ProviderConnectionListSchema.parse(await readJson(response));
}

export type CredentialRecoveryScanResponse = CredentialRecoveryScanResult;

export async function fetchCredentialRecoveryScan(
  signal?: AbortSignal,
): Promise<CredentialRecoveryScanResult> {
  const response = await fetch("/api/provider-connections/recovery-scan", {
    credentials: "same-origin",
    cache: "no-store",
    ...(signal === undefined ? {} : { signal }),
  });
  return CredentialRecoveryScanResultSchema.parse(await readJson(response));
}

function encodeRecoveryExpectedMetadata(
  expectedSafeMetadata: CredentialRecoveryExpectedSafeMetadata,
): string {
  const bytes = new TextEncoder().encode(JSON.stringify(expectedSafeMetadata));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

export async function fetchCredentialRecoveryCommandStatus(
  commandId: string,
  recoveryEpochId: string,
  expectedSafeMetadata: CredentialRecoveryExpectedSafeMetadata,
  signal?: AbortSignal,
): Promise<CredentialRecoveryCommandStatus> {
  const response = await fetch(
    `/api/provider-connections/recovery-commands/${encodeURIComponent(commandId)}/${encodeURIComponent(recoveryEpochId)}`,
    {
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "x-wi-recovery-operation-kind": "credential_recovery",
        "x-wi-recovery-expected-metadata": encodeRecoveryExpectedMetadata(
          expectedSafeMetadata,
        ),
      },
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const status = CredentialRecoveryCommandStatusSchema.parse(await readJson(response));
  if (
    status.expectedSafeMetadata !== null &&
    canonicalJson(status.expectedSafeMetadata) !== canonicalJson(expectedSafeMetadata)
  ) {
    throw new Error("Credential recovery status metadata does not match the local reconciliation entry.");
  }
  return status;
}

export async function fetchProviderCapabilities(
  connectionId: string,
  signal?: AbortSignal,
): Promise<ProviderCapabilitiesSnapshot> {
  const response = await fetch(
    `/api/provider-connections/${encodeURIComponent(connectionId)}/capabilities`,
    {
      credentials: "same-origin",
      cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return ProviderCapabilitiesSnapshotSchema.parse(await readJson(response));
}
