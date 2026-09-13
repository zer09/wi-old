import { canonicalJson } from "@wi/protocol";
import type {
  ProviderAuthMode,
  ProviderId,
  RunProviderSelectionSnapshot,
  TransportMode,
} from "@wi/protocol";

export interface ProviderAffinityKey {
  readonly connectionId: string;
  readonly credentialGeneration: number;
  readonly providerId: ProviderId;
  readonly authMode: ProviderAuthMode;
  readonly identity: RunProviderSelectionSnapshot["identity"];
  readonly modelId: string;
  readonly promptVersion: string;
  readonly toolSchemaHash: string;
  readonly reasoning: RunProviderSelectionSnapshot["reasoning"];
  readonly providerChainId: string;
  readonly transportMode: TransportMode;
}

export function providerAffinityKey(
  snapshot: RunProviderSelectionSnapshot,
): ProviderAffinityKey {
  return {
    connectionId: snapshot.connectionId,
    credentialGeneration: snapshot.credentialGeneration,
    providerId: snapshot.providerId,
    authMode: snapshot.authMode,
    identity: snapshot.identity,
    modelId: snapshot.modelId,
    promptVersion: snapshot.promptVersion,
    toolSchemaHash: snapshot.toolSchemaHash,
    reasoning: snapshot.reasoning,
    providerChainId: snapshot.providerChainId,
    transportMode: snapshot.transportMode,
  };
}

export function canReuseProviderChain(
  previous: RunProviderSelectionSnapshot,
  next: Omit<RunProviderSelectionSnapshot, "providerChainId">,
): boolean {
  const { providerChainId: ignoredProviderChainId, ...previousWithoutChain } = previous;
  void ignoredProviderChainId;
  return canonicalJson(previousWithoutChain) === canonicalJson(next);
}
