import {
  CommandMessageSchema,
  InputIdSchema,
  SessionIdSchema,
  canonicalJson,
  type CommandMessage,
} from "@wi/protocol";

export const COMMAND_JOURNAL_STORAGE_KEY = "wi:v1:tab-command-journal";
export const DEFAULT_COMMAND_JOURNAL_BOUNDS = {
  maximumItems: 64,
  maximumItemBytes: 256 * 1_024,
  maximumAggregateBytes: 1_024 * 1_024,
} as const;

const TAB_NAME_PREFIX = "wi:v1:tab:";
const MAXIMUM_JOURNAL_COMMAND_DEPTH = 64;
const MAXIMUM_JOURNAL_COMMAND_NODES = 20_000;

export interface CommandJournalBounds {
  readonly maximumItems: number;
  readonly maximumItemBytes: number;
  readonly maximumAggregateBytes: number;
}

export interface CommandJournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type JournalDraftKey =
  | "session-title"
  | `message:${string}`
  | `input:${string}`;

export interface JournalDraftReference {
  readonly key: JournalDraftKey;
  readonly value: string;
}

export interface JournalCommand {
  readonly command: CommandMessage;
  readonly persistedPhase: "queued" | "sent";
  readonly draft?: JournalDraftReference;
}

interface StoredCommandItem {
  readonly type: "command";
  readonly commandJson: string;
  readonly phase: "queued" | "sent";
  readonly draft?: JournalDraftReference;
}

interface StoredDraftItem {
  readonly type: "draft";
  readonly key: JournalDraftKey;
  readonly value: string;
}

type StoredItem = StoredCommandItem | StoredDraftItem;

export class BrowserCommandJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserCommandJournalError";
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function parseDraftKey(value: unknown): JournalDraftKey | null {
  if (value === "session-title") return value;
  if (typeof value !== "string") return null;
  if (value.startsWith("message:")) {
    const sessionId = value.slice("message:".length);
    return SessionIdSchema.safeParse(sessionId).success ? `message:${sessionId}` : null;
  }
  if (value.startsWith("input:")) {
    const inputId = value.slice("input:".length);
    return InputIdSchema.safeParse(inputId).success ? `input:${inputId}` : null;
  }
  return null;
}

function parseDraftReference(value: unknown): JournalDraftReference | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!strictKeys(record, ["key", "value"])) return null;
  const key = parseDraftKey(record.key);
  return key === null || typeof record.value !== "string" ? null : { key, value: record.value };
}

function assertBoundedCommandJson(text: string): void {
  let depth = 0;
  let nodes = 0;
  let inString = false;
  let escaped = false;
  let token = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        inString = false;
        nodes += 1;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      token = false;
    } else if (character === "{" || character === "[") {
      depth += 1;
      nodes += 1;
      token = false;
      if (depth > MAXIMUM_JOURNAL_COMMAND_DEPTH) throw new Error("command is too deep");
    } else if (character === "}" || character === "]") {
      depth -= 1;
      token = false;
    } else if (character === ":" || character === "," || /\s/u.test(character)) {
      token = false;
    } else if (!token) {
      nodes += 1;
      token = true;
    }
    if (nodes > MAXIMUM_JOURNAL_COMMAND_NODES) throw new Error("command has too many nodes");
  }
}

function itemKey(item: StoredItem): string {
  if (item.type === "draft") return `draft:${item.key}`;
  const parsed = CommandMessageSchema.parse(JSON.parse(item.commandJson) as unknown);
  return `command:${parsed.commandId}`;
}

function parseStoredItem(value: unknown): StoredItem | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "draft") {
    if (!strictKeys(record, ["type", "key", "value"])) return null;
    const key = parseDraftKey(record.key);
    return key === null || typeof record.value !== "string"
      ? null
      : { type: "draft", key, value: record.value };
  }
  if (record.type !== "command") return null;
  const hasDraft = record.draft !== undefined;
  if (!strictKeys(record, hasDraft ? ["type", "commandJson", "phase", "draft"] : ["type", "commandJson", "phase"])) {
    return null;
  }
  if (
    typeof record.commandJson !== "string" ||
    (record.phase !== "queued" && record.phase !== "sent")
  ) {
    return null;
  }
  try {
    assertBoundedCommandJson(record.commandJson);
    const command = CommandMessageSchema.parse(JSON.parse(record.commandJson) as unknown);
    if (canonicalJson(command) !== record.commandJson) return null;
  } catch {
    return null;
  }
  const draft = hasDraft ? parseDraftReference(record.draft) : undefined;
  if (hasDraft && draft === null) return null;
  return {
    type: "command",
    commandJson: record.commandJson,
    phase: record.phase,
    ...(draft === undefined || draft === null ? {} : { draft }),
  };
}

function validateBounds(bounds: CommandJournalBounds): void {
  for (const [description, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Command journal ${description} must be a positive safe integer`);
    }
  }
  if (bounds.maximumItemBytes > bounds.maximumAggregateBytes) {
    throw new RangeError("Command journal item bytes must fit within aggregate bytes");
  }
}

export function sessionTitleDraftKey(): JournalDraftKey {
  return "session-title";
}

export function messageDraftKey(sessionId: string): JournalDraftKey {
  return `message:${SessionIdSchema.parse(sessionId)}`;
}

export function inputDraftKey(inputId: string): JournalDraftKey {
  return `input:${InputIdSchema.parse(inputId)}`;
}

export function browserJournalOwnerId(): string {
  const existing = globalThis.window.name;
  if (existing.startsWith(TAB_NAME_PREFIX)) {
    const candidate = existing.slice(TAB_NAME_PREFIX.length);
    if (/^[a-zA-Z0-9_-]{1,128}$/u.test(candidate)) return candidate;
  }
  const ownerId = globalThis.crypto.randomUUID().replaceAll("-", "");
  globalThis.window.name = `${TAB_NAME_PREFIX}${ownerId}`;
  return ownerId;
}

export class BrowserCommandJournal {
  private items = new Map<string, StoredItem>();

  constructor(
    private readonly storage: CommandJournalStorage,
    private readonly ownerId: string,
    private readonly bounds: CommandJournalBounds = DEFAULT_COMMAND_JOURNAL_BOUNDS,
  ) {
    validateBounds(bounds);
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(ownerId)) {
      throw new RangeError("Command journal owner ID is invalid");
    }
    this.load();
  }

  commands(): readonly JournalCommand[] {
    const commands: JournalCommand[] = [];
    for (const item of this.items.values()) {
      if (item.type !== "command") continue;
      commands.push({
        command: CommandMessageSchema.parse(JSON.parse(item.commandJson) as unknown),
        persistedPhase: item.phase,
        ...(item.draft === undefined ? {} : { draft: item.draft }),
      });
    }
    return commands;
  }

  drafts(): Readonly<Record<JournalDraftKey, string>> {
    const drafts: Partial<Record<JournalDraftKey, string>> = {};
    for (const item of this.items.values()) {
      if (item.type === "draft") drafts[item.key] = item.value;
    }
    return drafts as Readonly<Record<JournalDraftKey, string>>;
  }

  setDraft(key: JournalDraftKey, value: string): void {
    if (parseDraftKey(key) === null || typeof value !== "string") {
      throw new BrowserCommandJournalError("The draft journal entry is invalid.");
    }
    const candidate = new Map(this.items);
    const storageKey = `draft:${key}`;
    if (value === "") candidate.delete(storageKey);
    else candidate.set(storageKey, { type: "draft", key, value });
    this.commit(candidate);
  }

  clearDraftIfUnchanged(reference: JournalDraftReference): boolean {
    const storageKey = `draft:${reference.key}`;
    const current = this.items.get(storageKey);
    if (current?.type !== "draft" || current.value !== reference.value) return false;
    const candidate = new Map(this.items);
    candidate.delete(storageKey);
    this.commit(candidate);
    return true;
  }

  addCommand(commandValue: CommandMessage, draft?: JournalDraftReference): void {
    const command = CommandMessageSchema.parse(commandValue);
    const parsedDraft = draft === undefined ? undefined : parseDraftReference(draft);
    if (draft !== undefined && parsedDraft === null) {
      throw new BrowserCommandJournalError("The command draft reference is invalid.");
    }
    const commandJson = canonicalJson(command);
    const storageKey = `command:${command.commandId}`;
    const existing = this.items.get(storageKey);
    if (existing !== undefined) {
      if (
        existing.type !== "command" ||
        existing.commandJson !== commandJson ||
        canonicalJson(existing.draft ?? null) !== canonicalJson(parsedDraft ?? null)
      ) {
        throw new BrowserCommandJournalError(
          "An unresolved command ID cannot be reused with different content.",
        );
      }
      return;
    }
    const candidate = new Map(this.items);
    candidate.set(storageKey, {
      type: "command",
      commandJson,
      phase: "queued",
      ...(parsedDraft === undefined || parsedDraft === null ? {} : { draft: parsedDraft }),
    });
    this.commit(candidate);
  }

  markCommandSent(commandId: string): void {
    const storageKey = `command:${commandId}`;
    const current = this.items.get(storageKey);
    if (current?.type !== "command" || current.phase === "sent") return;
    const candidate = new Map(this.items);
    candidate.set(storageKey, { ...current, phase: "sent" });
    this.commit(candidate);
  }

  removeCommand(commandId: string): void {
    const storageKey = `command:${commandId}`;
    if (!this.items.has(storageKey)) return;
    const candidate = new Map(this.items);
    candidate.delete(storageKey);
    this.commit(candidate);
  }

  private load(): void {
    let serialized: string | null;
    try {
      serialized = this.storage.getItem(COMMAND_JOURNAL_STORAGE_KEY);
    } catch {
      return;
    }
    if (serialized === null) return;
    try {
      if (
        serialized.length > this.bounds.maximumAggregateBytes ||
        byteLength(serialized) > this.bounds.maximumAggregateBytes
      ) {
        throw new Error("journal exceeds aggregate bytes");
      }
      const parsed = JSON.parse(serialized) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("journal is not an object");
      }
      const record = parsed as Record<string, unknown>;
      if (!strictKeys(record, ["v", "ownerId", "items"]) || record.v !== 1) {
        throw new Error("journal version is invalid");
      }
      if (record.ownerId !== this.ownerId) {
        this.removeStoredJournal();
        return;
      }
      if (!Array.isArray(record.items) || record.items.length > this.bounds.maximumItems) {
        throw new Error("journal item count is invalid");
      }
      const items = new Map<string, StoredItem>();
      for (const value of record.items) {
        const item = parseStoredItem(value);
        if (item === null || byteLength(JSON.stringify(item)) > this.bounds.maximumItemBytes) {
          throw new Error("journal item is invalid");
        }
        const key = itemKey(item);
        if (items.has(key)) throw new Error("journal item is duplicated");
        items.set(key, item);
      }
      this.items = items;
    } catch {
      this.items.clear();
      this.removeStoredJournal();
    }
  }

  private removeStoredJournal(): void {
    try {
      this.storage.removeItem(COMMAND_JOURNAL_STORAGE_KEY);
    } catch {
      // Invalid temporary state must not prevent the browser from starting.
    }
  }

  private commit(candidate: Map<string, StoredItem>): void {
    if (candidate.size > this.bounds.maximumItems) {
      throw new BrowserCommandJournalError(
        `The unresolved-command journal is full (${this.bounds.maximumItems} items).`,
      );
    }
    const items = [...candidate.values()];
    for (const item of items) {
      if (byteLength(JSON.stringify(item)) > this.bounds.maximumItemBytes) {
        throw new BrowserCommandJournalError(
          `One unresolved-command journal item exceeds ${this.bounds.maximumItemBytes} bytes.`,
        );
      }
    }
    if (items.length === 0) {
      this.storage.removeItem(COMMAND_JOURNAL_STORAGE_KEY);
      this.items = candidate;
      return;
    }
    const serialized = JSON.stringify({ v: 1, ownerId: this.ownerId, items });
    if (byteLength(serialized) > this.bounds.maximumAggregateBytes) {
      throw new BrowserCommandJournalError(
        `The unresolved-command journal exceeds ${this.bounds.maximumAggregateBytes} bytes.`,
      );
    }
    try {
      this.storage.setItem(COMMAND_JOURNAL_STORAGE_KEY, serialized);
    } catch {
      throw new BrowserCommandJournalError(
        "The unresolved command could not be saved in this browser tab.",
      );
    }
    this.items = candidate;
  }
}

export function createBrowserCommandJournal(): BrowserCommandJournal {
  return new BrowserCommandJournal(globalThis.sessionStorage, browserJournalOwnerId());
}
