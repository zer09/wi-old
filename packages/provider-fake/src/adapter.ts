import type {
  ProviderAdapter,
  ProviderContext,
  ProviderEvent,
  ProviderRequest,
  IssuedProviderCredential,
} from "@wi/provider-contract";

import { createFakeProviderScript } from "./scenarios.js";
import {
  FAKE_PROVIDER_SCENARIOS,
  FakeProviderController,
  type FakeProviderConfiguration,
  type FakeProviderScenario,
} from "./script.js";

function isScenario(value: unknown): value is FakeProviderScenario {
  return typeof value === "string" &&
    (FAKE_PROVIDER_SCENARIOS as readonly string[]).includes(value);
}

export function parseFakeProviderConfiguration(value: unknown): FakeProviderConfiguration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Fake provider configuration must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!isScenario(record.scenario)) {
    throw new TypeError("Fake provider scenario must be selected explicitly");
  }
  const allowed = new Set(["scenario", "roundTripTool"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new TypeError("Fake provider configuration contains an unknown field");
  }
  if (
    record.roundTripTool !== undefined &&
    record.roundTripTool !== "echo" &&
    record.roundTripTool !== "delay" &&
    record.roundTripTool !== "unknown" &&
    record.roundTripTool !== "invalid_echo"
  ) {
    throw new TypeError("Fake provider roundTripTool is invalid");
  }
  return {
    scenario: record.scenario,
    ...(record.roundTripTool === undefined ? {} : { roundTripTool: record.roundTripTool }),
  };
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id: string;
  readonly requests: ProviderRequest[] = [];
  readonly controller: FakeProviderController;
  private readonly onCredential: ((credential: IssuedProviderCredential | undefined) => void) | undefined;

  constructor(options: {
    readonly controller?: FakeProviderController;
    readonly id?: string;
    readonly onCredential?: (credential: IssuedProviderCredential | undefined) => void;
  } = {}) {
    this.id = options.id ?? "fake";
    this.controller = options.controller ?? new FakeProviderController();
    this.onCredential = options.onCredential;
  }

  async *stream(
    request: ProviderRequest,
    context: ProviderContext,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    signal.throwIfAborted();
    this.onCredential?.(context.credential);
    const configuration = parseFakeProviderConfiguration(request.providerConfig);
    const script = createFakeProviderScript(configuration);
    const scriptStep = script.steps[request.stepIndex] ?? script.steps.at(-1);
    if (scriptStep === undefined) {
      throw new Error(`Fake provider script ${script.scenario} has no steps`);
    }
    this.requests.push(request);
    yield* scriptStep.stream(request, context, this.controller, signal);
  }
}
