import type { ConnectionLifecycleStatus } from "@wi/protocol";

export const LIFECYCLE_OPERATION_KINDS = [
  "create",
  "replace",
  "disable",
  "logout",
  "delete",
  "reauthenticate",
  "refresh",
  "enable",
  "credential_recovery",
] as const;
export type LifecycleOperationKind = (typeof LIFECYCLE_OPERATION_KINDS)[number];
export type LifecycleOperationPhase =
  | "validating"
  | "prepared"
  | "file_observed"
  | "succeeded"
  | "failed"
  | "failed_after_effect";

export interface LifecycleOwner {
  readonly commandId: string;
  readonly contentHash: string;
  readonly kind: LifecycleOperationKind;
  readonly phase: LifecycleOperationPhase;
  readonly targetLifecycleRevision: number;
  readonly targetGeneration: number;
}

export interface LifecycleState {
  readonly status: ConnectionLifecycleStatus;
  readonly lifecycleRevision: number;
  readonly metadataRevision: number;
  readonly credentialGeneration: number;
  readonly owner: LifecycleOwner | null;
  readonly deleted: boolean;
}

export type LifecycleAcquireResult =
  | { readonly outcome: "acquired"; readonly state: LifecycleState; readonly owner: LifecycleOwner }
  | { readonly outcome: "resume"; readonly state: LifecycleState; readonly owner: LifecycleOwner }
  | { readonly outcome: "command_conflict"; readonly state: LifecycleState }
  | {
      readonly outcome: "operation_in_progress";
      readonly state: LifecycleState;
      readonly owningKind: LifecycleOperationKind;
    };

function incrementsRevision(kind: LifecycleOperationKind): boolean {
  return kind !== "create" && kind !== "refresh" && kind !== "credential_recovery";
}

function incrementsGeneration(kind: LifecycleOperationKind): boolean {
  return kind === "replace" || kind === "reauthenticate";
}

export function acquireLifecycleOwner(
  state: LifecycleState,
  commandId: string,
  contentHash: string,
  kind: LifecycleOperationKind,
): LifecycleAcquireResult {
  if (state.owner !== null) {
    if (state.owner.commandId !== commandId) {
      return {
        outcome: "operation_in_progress",
        state,
        owningKind: state.owner.kind,
      };
    }
    return state.owner.contentHash === contentHash && state.owner.kind === kind
      ? { outcome: "resume", state, owner: state.owner }
      : { outcome: "command_conflict", state };
  }
  const targetLifecycleRevision = state.lifecycleRevision + (incrementsRevision(kind) ? 1 : 0);
  const targetGeneration = state.credentialGeneration + (incrementsGeneration(kind) ? 1 : 0);
  const owner: LifecycleOwner = {
    commandId,
    contentHash,
    kind,
    phase: kind === "credential_recovery" ? "validating" : "prepared",
    targetLifecycleRevision,
    targetGeneration,
  };
  return {
    outcome: "acquired",
    owner,
    state: {
      ...state,
      lifecycleRevision: targetLifecycleRevision,
      credentialGeneration: targetGeneration,
      owner,
    },
  };
}

export function advanceLifecycleOwner(
  state: LifecycleState,
  phase: LifecycleOperationPhase,
): LifecycleState {
  if (state.owner === null) throw new Error("Lifecycle operation has no owner");
  const allowed: Readonly<Record<LifecycleOperationPhase, readonly LifecycleOperationPhase[]>> = {
    validating: ["prepared", "failed"],
    prepared: ["file_observed", "succeeded", "failed", "failed_after_effect"],
    file_observed: ["succeeded", "failed_after_effect"],
    succeeded: [],
    failed: [],
    failed_after_effect: [],
  };
  if (!allowed[state.owner.phase].includes(phase)) {
    throw new Error(`Invalid lifecycle transition ${state.owner.phase} -> ${phase}`);
  }
  const terminal = phase === "succeeded" || phase === "failed" || phase === "failed_after_effect";
  let status = state.status;
  let deleted = state.deleted;
  if (phase === "failed_after_effect") status = "unavailable";
  if (phase === "succeeded") {
    switch (state.owner.kind) {
      case "disable": status = "disabled"; break;
      case "logout": status = "reauth_required"; break;
      case "delete": status = "unavailable"; deleted = true; break;
      case "create":
      case "replace":
      case "reauthenticate":
      case "credential_recovery":
      case "enable": status = "ready"; break;
      case "refresh": break;
    }
  }
  return {
    ...state,
    status,
    deleted,
    owner: terminal ? null : { ...state.owner, phase },
  };
}

export function updateConnectionMetadata(state: LifecycleState): LifecycleState {
  return { ...state, metadataRevision: state.metadataRevision + 1 };
}
