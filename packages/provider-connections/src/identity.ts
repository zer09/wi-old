import {
  authoritativeProviderIdentityKey,
  type ProviderAuthMode,
  type ProviderId,
  type ProviderIdentity,
} from "@wi/protocol";

export type AuthoritativeIdentityClaim = Extract<ProviderIdentity, { readonly status: "authoritative" }>;

export interface NormalizedAuthoritativeIdentity {
  readonly providerId: ProviderId;
  readonly authMode: ProviderAuthMode;
  readonly stableKind: "subject" | "account" | "project";
  readonly stableValue: string;
  readonly workspace: "unknown" | "none" | `value:${string}`;
}

export function normalizeAuthoritativeIdentity(
  providerId: ProviderId,
  authMode: ProviderAuthMode,
  identity: AuthoritativeIdentityClaim,
): NormalizedAuthoritativeIdentity {
  const stable = identity.subjectId !== undefined
    ? { stableKind: "subject" as const, stableValue: identity.subjectId }
    : identity.accountId !== undefined
      ? { stableKind: "account" as const, stableValue: identity.accountId }
      : { stableKind: "project" as const, stableValue: identity.projectId as string };
  const workspace = identity.workspace.presence === "value"
    ? `value:${identity.workspace.value}` as const
    : identity.workspace.presence;
  return { providerId, authMode, ...stable, workspace };
}

export function authoritativeIdentityKey(
  providerId: ProviderId,
  authMode: ProviderAuthMode,
  identity: AuthoritativeIdentityClaim,
): string {
  return authoritativeProviderIdentityKey(providerId, authMode, identity);
}
