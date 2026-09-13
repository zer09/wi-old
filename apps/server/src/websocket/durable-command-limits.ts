import {
  canonicalJsonBytes,
  type BrowserCommandLimits,
  type CommandMessage,
} from "@wi/protocol";
import {
  SESSION_EVENT_PAGE_BOUNDS,
  WORKER_RPC_PAYLOAD_BOUNDS,
} from "@wi/storage";
import { MINIMUM_WI_V1_CLIENT_FRAME_DEPTH } from "./frame-decoder.js";

/**
 * Leaves room for the largest bounded event identity/timestamp envelope and worker-RPC fields.
 * Variable command content is measured as complete canonical JSON, including escaping.
 */
export const DURABLE_EVENT_ENVELOPE_RESERVE_BYTES = 4 * 1_024;

// message.submit and input.respond each place their variable value in at most two RPC fields.
const MAXIMUM_STORAGE_RPC_PAYLOAD_COPIES = 2;
const COMMAND_ENVELOPE_JSON_DEPTH = 2;
const WORKER_JSON_DEPTH_RESERVE = 8;
const WORKER_NODE_RESERVE = 128;
const STORAGE_RPC_DURABLE_PAYLOAD_CAPACITY = Math.floor(
  WORKER_RPC_PAYLOAD_BOUNDS.maximumUnits / MAXIMUM_STORAGE_RPC_PAYLOAD_COPIES,
);

export interface DurableCommandCapacities {
  readonly outboundSingleMessageBytes: number;
  readonly replayLiveSingleEventBytes: number;
  readonly replayPageSingleEventBytes: number;
}

export interface BrowserCommandCapacities extends DurableCommandCapacities {
  readonly frameMaximumBytes: number;
  readonly frameMaximumDepth: number;
}

export function maximumDurableCommandPayloadBytes(
  capacities: DurableCommandCapacities,
): number {
  const durableEventCapacity = Math.min(
    capacities.outboundSingleMessageBytes,
    capacities.replayLiveSingleEventBytes,
    capacities.replayPageSingleEventBytes,
    SESSION_EVENT_PAGE_BOUNDS.maximumSingleEventBytes,
    STORAGE_RPC_DURABLE_PAYLOAD_CAPACITY,
  );
  if (durableEventCapacity <= DURABLE_EVENT_ENVELOPE_RESERVE_BYTES) {
    throw new RangeError(
      "WebSocket durable event capacity must exceed the server-owned event envelope reserve",
    );
  }
  return durableEventCapacity - DURABLE_EVENT_ENVELOPE_RESERVE_BYTES;
}

export function browserCommandLimits(
  capacities: BrowserCommandCapacities,
): BrowserCommandLimits {
  if (capacities.frameMaximumDepth < MINIMUM_WI_V1_CLIENT_FRAME_DEPTH) {
    throw new RangeError(
      `WebSocket frame depth limit must be at least ${MINIMUM_WI_V1_CLIENT_FRAME_DEPTH}`,
    );
  }
  const maximumDurablePayloadBytes = maximumDurableCommandPayloadBytes(capacities);
  const maximumRawInput = Math.min(
    capacities.frameMaximumBytes,
    maximumDurablePayloadBytes,
  );
  return {
    v: 1,
    maximumFrameBytes: capacities.frameMaximumBytes,
    maximumDurablePayloadBytes,
    maximumRawInputCodeUnits: maximumRawInput,
    maximumRawInputUtf8Bytes: maximumRawInput,
    maximumJsonDepth: Math.max(
      0,
      Math.min(
        capacities.frameMaximumDepth - COMMAND_ENVELOPE_JSON_DEPTH,
        WORKER_RPC_PAYLOAD_BOUNDS.maximumDepth - WORKER_JSON_DEPTH_RESERVE,
      ),
    ),
    maximumJsonNodes: Math.floor(
      (WORKER_RPC_PAYLOAD_BOUNDS.maximumNodes - WORKER_NODE_RESERVE) /
        MAXIMUM_STORAGE_RPC_PAYLOAD_COPIES,
    ),
  };
}

export function durableCommandPayloadBytes(command: CommandMessage): number {
  switch (command.method) {
    case "session.create":
      return canonicalJsonBytes(command.params.title ?? "").byteLength;
    case "message.submit":
      return canonicalJsonBytes(command.params.text).byteLength;
    case "input.respond":
      return canonicalJsonBytes(command.params.value).byteLength;
    case "run.cancel":
    case "approval.resolve":
      return 0;
    case "providerConnection.file.create":
    case "providerConnection.environment.create":
    case "providerConnection.environment.revalidate":
    case "providerConnection.file.replace":
    case "providerConnection.rename":
    case "providerConnection.disable":
    case "providerConnection.logout":
    case "providerConnection.delete":
    case "providerConnection.recover":
    case "session.providerDefault.set":
      return canonicalJsonBytes(command.params).byteLength;
  }
}
