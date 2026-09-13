import {
  CanonicalJsonValueSchema,
  ClientMessageSchema,
  canonicalJsonBytes,
  type BrowserCommandLimits,
  type CanonicalJsonValue,
  type CommandMessage,
} from "@wi/protocol";

const COMMAND_ENVELOPE_JSON_DEPTH = 2;
const COMMAND_STRUCTURE_NODE_RESERVE = 64;

export class BrowserCommandLimitError extends Error {
  readonly code = "protocol.message_too_large";
}

export class BrowserCommandTooLargeError extends BrowserCommandLimitError {
  constructor(
    readonly byteLength: number,
    readonly maximumBytes: number,
    description = "command",
  ) {
    super(
      `This ${description} is ${byteLength} UTF-8 bytes; the server limit is ${maximumBytes}. ` +
        "Shorten it and try again.",
    );
    this.name = "BrowserCommandTooLargeError";
  }
}

export class BrowserInputLimitError extends BrowserCommandLimitError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserInputLimitError";
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertRawInputSize(
  value: string,
  limits: BrowserCommandLimits,
  description: string,
): void {
  if (value.length > limits.maximumRawInputCodeUnits) {
    throw new BrowserInputLimitError(
      `${description} exceeds the server limit of ${limits.maximumRawInputCodeUnits} UTF-16 code units.`,
    );
  }
  const byteLength = utf8Bytes(value);
  if (byteLength > limits.maximumRawInputUtf8Bytes) {
    throw new BrowserCommandTooLargeError(
      byteLength,
      limits.maximumRawInputUtf8Bytes,
      description.toLowerCase(),
    );
  }
}

function assertStructuredValue(
  value: unknown,
  maximumDepth: number,
  maximumNodes: number,
  limits?: BrowserCommandLimits,
): void {
  const active = new WeakSet<object>();
  const stack: Array<{ readonly value: unknown; readonly depth: number; readonly leaving?: true }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  let stringCodeUnits = 0;
  let stringUtf8Bytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.leaving === true) {
      active.delete(current.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > maximumNodes) {
      throw new BrowserInputLimitError(`JSON input exceeds the server limit of ${maximumNodes} nodes.`);
    }
    if (typeof current.value === "string") {
      if (limits !== undefined) {
        stringCodeUnits += current.value.length;
        if (stringCodeUnits > limits.maximumRawInputCodeUnits) {
          throw new BrowserInputLimitError(
            `JSON string content exceeds the server limit of ${limits.maximumRawInputCodeUnits} UTF-16 code units.`,
          );
        }
        stringUtf8Bytes += utf8Bytes(current.value);
        if (stringUtf8Bytes > limits.maximumRawInputUtf8Bytes) {
          throw new BrowserCommandTooLargeError(
            stringUtf8Bytes,
            limits.maximumRawInputUtf8Bytes,
            "JSON string content",
          );
        }
      }
      continue;
    }
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value !== "object") {
      throw new BrowserInputLimitError("The response must contain only finite JSON values.");
    }
    if (active.has(current.value)) {
      throw new BrowserInputLimitError("JSON input cannot contain a cycle.");
    }
    const containerDepth = current.depth + 1;
    if (containerDepth > maximumDepth) {
      throw new BrowserInputLimitError(
        `JSON input exceeds the server nesting limit of ${maximumDepth}.`,
      );
    }
    active.add(current.value);
    stack.push({ ...current, leaving: true });

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        if (!(index in current.value)) {
          throw new BrowserInputLimitError("JSON arrays cannot be sparse.");
        }
        stack.push({ value: current.value[index], depth: containerDepth });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BrowserInputLimitError("JSON input must use plain objects.");
    }
    const entries = Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      nodes += 1;
      if (nodes > maximumNodes) {
        throw new BrowserInputLimitError(
          `JSON input exceeds the server limit of ${maximumNodes} nodes.`,
        );
      }
      if (limits !== undefined) {
        stringCodeUnits += entry[0].length;
        stringUtf8Bytes += utf8Bytes(entry[0]);
        if (
          stringCodeUnits > limits.maximumRawInputCodeUnits ||
          stringUtf8Bytes > limits.maximumRawInputUtf8Bytes
        ) {
          throw new BrowserInputLimitError("JSON object keys exceed the server input limit.");
        }
      }
      stack.push({ value: entry[1], depth: containerDepth });
    }
  }
}

export function assertRawJsonPreflight(text: string, limits: BrowserCommandLimits): void {
  assertRawInputSize(text, limits, "JSON response");
  let depth = 0;
  let nodes = 0;
  let inString = false;
  let escaped = false;
  let token = false;

  const addNode = (): void => {
    nodes += 1;
    if (nodes > limits.maximumJsonNodes) {
      throw new BrowserInputLimitError(
        `JSON input exceeds the server limit of ${limits.maximumJsonNodes} nodes.`,
      );
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        inString = false;
        addNode();
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      token = false;
      continue;
    }
    if (character === "{" || character === "[") {
      addNode();
      depth += 1;
      if (depth > limits.maximumJsonDepth) {
        throw new BrowserInputLimitError(
          `JSON input exceeds the server nesting limit of ${limits.maximumJsonDepth}.`,
        );
      }
      token = false;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      token = false;
      continue;
    }
    if (character === ":" || character === "," || /\s/u.test(character)) {
      token = false;
      continue;
    }
    if (!token) {
      addNode();
      token = true;
    }
  }
}

export function parseCanonicalJsonInput(
  text: string,
  limits: BrowserCommandLimits,
  parse: (value: string) => unknown = JSON.parse,
): CanonicalJsonValue {
  assertRawJsonPreflight(text, limits);
  const parsed = parse(text);
  assertStructuredValue(
    parsed,
    limits.maximumJsonDepth,
    limits.maximumJsonNodes,
    limits,
  );
  return CanonicalJsonValueSchema.parse(parsed);
}

function durablePayloadBytes(command: CommandMessage): number {
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

export function serializedCommandBytes(command: CommandMessage): number {
  return utf8Bytes(JSON.stringify(command));
}

export function assertBrowserCommandSize(
  command: CommandMessage,
  limits: BrowserCommandLimits,
): CommandMessage {
  assertStructuredValue(
    command,
    limits.maximumJsonDepth + COMMAND_ENVELOPE_JSON_DEPTH,
    limits.maximumJsonNodes + COMMAND_STRUCTURE_NODE_RESERVE,
  );
  if (command.method === "session.create" && command.params.title !== undefined) {
    assertRawInputSize(command.params.title, limits, "Session title");
  } else if (command.method === "message.submit") {
    assertRawInputSize(command.params.text, limits, "Message");
  } else if (command.method === "input.respond") {
    assertStructuredValue(
      command.params.value,
      limits.maximumJsonDepth,
      limits.maximumJsonNodes,
      limits,
    );
  }

  const parsed = ClientMessageSchema.parse(command);
  if (parsed.kind !== "command") throw new TypeError("Expected a command message");
  const payloadBytes = durablePayloadBytes(parsed);
  if (payloadBytes > limits.maximumDurablePayloadBytes) {
    throw new BrowserCommandTooLargeError(
      payloadBytes,
      limits.maximumDurablePayloadBytes,
      "durable command payload",
    );
  }
  const frameBytes = serializedCommandBytes(parsed);
  if (frameBytes > limits.maximumFrameBytes) {
    throw new BrowserCommandTooLargeError(
      frameBytes,
      limits.maximumFrameBytes,
      "complete command",
    );
  }
  return parsed;
}
