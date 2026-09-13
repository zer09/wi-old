import type {
  ExplicitProviderSelectionPolicy,
  ProviderCapabilitiesSnapshot,
  ProviderConnectionSafeView,
  ProviderReasoningConfiguration,
  TransportMode,
} from "@wi/protocol";

export interface ProviderRoutingRequest {
  readonly policy: ExplicitProviderSelectionPolicy | null;
  readonly modelId: string;
  readonly reasoning: ProviderReasoningConfiguration;
  readonly transportMode: TransportMode;
  readonly requiresTools: boolean;
  readonly credentialBackendAvailable: boolean;
}

export interface ProviderRoutingCandidate {
  readonly connection: ProviderConnectionSafeView;
  readonly capabilities: ProviderCapabilitiesSnapshot | null;
}

export interface ProviderRoutingDecision {
  readonly kind: "explicit";
  readonly connection: ProviderConnectionSafeView;
  readonly capabilities: ProviderCapabilitiesSnapshot;
  readonly modelId: string;
  readonly reasoning: ProviderReasoningConfiguration;
  readonly transportMode: TransportMode;
}

export class ProviderRoutingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProviderRoutingError";
  }
}

export class ExplicitProviderRouter {
  select(
    request: ProviderRoutingRequest,
    candidates: readonly ProviderRoutingCandidate[],
  ): ProviderRoutingDecision {
    if (request.policy === null || request.policy.kind !== "explicit") {
      throw new ProviderRoutingError("provider.selection_required", "An explicit provider connection is required");
    }
    const candidate = candidates.find(
      (entry) => entry.connection.connectionId === request.policy?.connectionId,
    );
    if (candidate === undefined || candidate.connection.deleted) {
      throw new ProviderRoutingError("provider.connection_not_found", "The selected provider connection was not found");
    }
    const connection = candidate.connection;
    const expectedAuth = connection.providerId === "openai_platform" ? "api_key" : "chatgpt_oauth";
    if (connection.authMode !== expectedAuth) {
      throw new ProviderRoutingError("provider.auth_mode_invalid", "The selected provider authentication mode is invalid");
    }
    if (connection.lifecycleStatus !== "ready" || connection.lifecycleOwnerKind !== null) {
      throw new ProviderRoutingError("provider.connection_unavailable", "The selected provider connection is unavailable");
    }
    if (!request.credentialBackendAvailable) {
      throw new ProviderRoutingError("provider.credential_unavailable", "The selected credential backend is unavailable");
    }
    const capabilities = candidate.capabilities;
    if (
      capabilities === null ||
      capabilities.status !== "current" ||
      capabilities.connectionId !== connection.connectionId ||
      capabilities.providerId !== connection.providerId ||
      capabilities.authMode !== connection.authMode ||
      capabilities.capabilitiesVersion !== connection.capabilitiesVersion
    ) {
      throw new ProviderRoutingError("provider.capabilities_unavailable", "Current connection capabilities are unavailable");
    }
    const model = capabilities.models.find((entry) => entry.modelId === request.modelId);
    if (model === undefined) {
      throw new ProviderRoutingError("provider.model_unavailable", "The requested model is unavailable for this connection");
    }
    if (!model.reasoningEfforts.includes(request.reasoning.effort)) {
      throw new ProviderRoutingError("provider.reasoning_incompatible", "The requested reasoning controls are incompatible");
    }
    if (request.reasoning.summary !== "none" && !model.reasoningSummary) {
      throw new ProviderRoutingError("provider.reasoning_incompatible", "Reasoning summaries are unavailable");
    }
    if (request.requiresTools && !model.tools) {
      throw new ProviderRoutingError("provider.tools_incompatible", "Tool calling is unavailable for this model");
    }
    if (!model.transports.includes(request.transportMode)) {
      throw new ProviderRoutingError("provider.transport_incompatible", "The requested transport is unavailable");
    }
    return {
      kind: "explicit",
      connection,
      capabilities,
      modelId: request.modelId,
      reasoning: request.reasoning,
      transportMode: request.transportMode,
    };
  }
}
