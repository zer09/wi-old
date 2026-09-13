import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@wi/protocol";

import {
  BrowserCommandJournal,
  BrowserCommandJournalError,
  COMMAND_JOURNAL_STORAGE_KEY,
  inputDraftKey,
  messageDraftKey,
  sessionTitleDraftKey,
  type CommandJournalBounds,
} from "./command-journal.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const commands: readonly CommandMessage[] = [
  {
    v: 1,
    kind: "command",
    commandId: "cmd_journalCreate",
    method: "session.create",
    params: { title: "Journal create" },
  },
  {
    v: 1,
    kind: "command",
    commandId: "cmd_journalMessage",
    sessionId: "ses_journal",
    method: "message.submit",
    params: { text: "Journal message" },
  },
  {
    v: 1,
    kind: "command",
    commandId: "cmd_journalCancel",
    sessionId: "ses_journal",
    method: "run.cancel",
    params: { runId: "run_journal" },
  },
  {
    v: 1,
    kind: "command",
    commandId: "cmd_journalApproval",
    sessionId: "ses_journal",
    method: "approval.resolve",
    params: { approvalId: "approval_journal", resolution: "approved" },
  },
  {
    v: 1,
    kind: "command",
    commandId: "cmd_journalInput",
    sessionId: "ses_journal",
    method: "input.respond",
    params: { inputId: "input_journal", value: { answer: "yes" } },
  },
];

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

describe("BrowserCommandJournal", () => {
  it("restores every command method with canonical content, identity, and sent phase", () => {
    const storage = new MemoryStorage();
    const journal = new BrowserCommandJournal(storage, "owner-a");
    for (const command of commands) journal.addCommand(command);
    journal.markCommandSent("cmd_journalMessage");

    const restored = new BrowserCommandJournal(storage, "owner-a").commands();
    expect(restored.map((entry) => entry.command)).toEqual(commands);
    expect(
      restored.find((entry) => entry.command.commandId === "cmd_journalMessage")?.persistedPhase,
    ).toBe("sent");
    expect(
      restored.find((entry) => entry.command.commandId === "cmd_journalCreate")?.persistedPhase,
    ).toBe("queued");
    expect(storage.getItem(COMMAND_JOURNAL_STORAGE_KEY)).not.toContain("wi_browser_session");
    expect(storage.getItem(COMMAND_JOURNAL_STORAGE_KEY)).not.toContain("authorization");
  });

  it("clears only matching commands and removes the storage key when empty", () => {
    const storage = new MemoryStorage();
    const journal = new BrowserCommandJournal(storage, "owner-a");
    journal.addCommand(commands[0] as CommandMessage);
    journal.addCommand(commands[1] as CommandMessage);
    journal.removeCommand("cmd_journalCreate");
    expect(journal.commands().map((entry) => entry.command.commandId)).toEqual([
      "cmd_journalMessage",
    ]);
    journal.removeCommand("cmd_missing");
    expect(journal.commands()).toHaveLength(1);
    journal.removeCommand("cmd_journalMessage");
    expect(storage.getItem(COMMAND_JOURNAL_STORAGE_KEY)).toBeNull();
  });

  it("keeps a newer draft when an older command settles", () => {
    const storage = new MemoryStorage();
    const journal = new BrowserCommandJournal(storage, "owner-a");
    const key = messageDraftKey("ses_journal");
    journal.setDraft(key, "submitted draft");
    journal.addCommand(commands[1] as CommandMessage, { key, value: "submitted draft" });
    journal.setDraft(key, "newer edited draft");

    expect(journal.clearDraftIfUnchanged({ key, value: "submitted draft" })).toBe(false);
    journal.removeCommand("cmd_journalMessage");
    expect(journal.drafts()[key]).toBe("newer edited draft");
  });

  it("round-trips title, message, and pending-input drafts", () => {
    const storage = new MemoryStorage();
    const journal = new BrowserCommandJournal(storage, "owner-a");
    journal.setDraft(sessionTitleDraftKey(), "Title draft");
    journal.setDraft(messageDraftKey("ses_journal"), "Message draft");
    journal.setDraft(inputDraftKey("input_journal"), '"Input draft"');

    expect(new BrowserCommandJournal(storage, "owner-a").drafts()).toEqual({
      "session-title": "Title draft",
      "message:ses_journal": "Message draft",
      "input:input_journal": '"Input draft"',
    });
  });

  it("accepts the exact item-count limit and rejects one item over", () => {
    const storage = new MemoryStorage();
    const bounds: CommandJournalBounds = {
      maximumItems: 2,
      maximumItemBytes: 1_000,
      maximumAggregateBytes: 2_000,
    };
    const journal = new BrowserCommandJournal(storage, "owner-a", bounds);
    journal.setDraft(sessionTitleDraftKey(), "one");
    journal.setDraft(messageDraftKey("ses_journal"), "two");
    expect(() => journal.setDraft(inputDraftKey("input_journal"), "three")).toThrow(
      /full \(2 items\)/u,
    );
  });

  it("accepts exact per-item and aggregate byte limits and rejects one byte over", () => {
    const probeStorage = new MemoryStorage();
    const probe = new BrowserCommandJournal(probeStorage, "owner-a");
    probe.setDraft(sessionTitleDraftKey(), "x");
    const serialized = probeStorage.getItem(COMMAND_JOURNAL_STORAGE_KEY);
    if (serialized === null) throw new Error("Probe journal was not stored");
    const parsed = JSON.parse(serialized) as { readonly items: readonly unknown[] };
    const itemBytes = byteLength(JSON.stringify(parsed.items[0]));
    const aggregateBytes = byteLength(serialized);

    const itemStorage = new MemoryStorage();
    const itemBounded = new BrowserCommandJournal(itemStorage, "owner-a", {
      maximumItems: 2,
      maximumItemBytes: itemBytes,
      maximumAggregateBytes: aggregateBytes + 100,
    });
    itemBounded.setDraft(sessionTitleDraftKey(), "x");
    expect(() => itemBounded.setDraft(sessionTitleDraftKey(), "xx")).toThrow(/item exceeds/u);

    const aggregateStorage = new MemoryStorage();
    const aggregateBounded = new BrowserCommandJournal(aggregateStorage, "owner-a", {
      maximumItems: 2,
      maximumItemBytes: aggregateBytes,
      maximumAggregateBytes: aggregateBytes,
    });
    aggregateBounded.setDraft(sessionTitleDraftKey(), "x");
    expect(() => aggregateBounded.setDraft(sessionTitleDraftKey(), "xx")).toThrow(
      /journal exceeds/u,
    );
  });

  it("fails closed for corrupt, old-version, oversized, and cloned-tab data", () => {
    const deeplyNestedCommand = JSON.stringify({
      v: 1,
      ownerId: "owner-a",
      items: [
        {
          type: "command",
          commandJson: `${"[".repeat(65)}0${"]".repeat(65)}`,
          phase: "queued",
        },
      ],
    });
    for (const serialized of [
      "not-json",
      JSON.stringify({ v: 0, ownerId: "owner-a", items: [] }),
      "x".repeat(2_001),
      JSON.stringify({ v: 1, ownerId: "owner-other-tab", items: [] }),
      deeplyNestedCommand,
    ]) {
      const storage = new MemoryStorage();
      storage.setItem(COMMAND_JOURNAL_STORAGE_KEY, serialized);
      const journal = new BrowserCommandJournal(storage, "owner-a", {
        maximumItems: 4,
        maximumItemBytes: 1_000,
        maximumAggregateBytes: 2_000,
      });
      expect(journal.commands()).toEqual([]);
      expect(journal.drafts()).toEqual({});
      expect(storage.getItem(COMMAND_JOURNAL_STORAGE_KEY)).toBeNull();
    }
  });

  it("rejects invalid runtime draft keys and references before persistence", () => {
    const storage = new MemoryStorage();
    const journal = new BrowserCommandJournal(storage, "owner-a");
    expect(() => journal.setDraft("message:not-an-id" as never, "draft")).toThrow(
      /draft journal entry is invalid/u,
    );
    expect(() =>
      journal.addCommand(commands[0] as CommandMessage, {
        key: "input:not-an-id" as never,
        value: "draft",
      }),
    ).toThrow(/draft reference is invalid/u);
    expect(storage.getItem(COMMAND_JOURNAL_STORAGE_KEY)).toBeNull();
  });

  it("uses canonical nested command equality for unresolved command reuse", () => {
    const storage = new MemoryStorage();
    const journal = new BrowserCommandJournal(storage, "owner-a");
    const first = {
      v: 1,
      kind: "command",
      commandId: "cmd_journalCanonicalInput",
      sessionId: "ses_journal",
      method: "input.respond",
      params: { inputId: "input_journal", value: { outer: { a: 1, b: 2 } } },
    } as const;
    const reordered = {
      ...first,
      params: { inputId: "input_journal", value: { outer: { b: 2, a: 1 } } },
    } as const;
    journal.addCommand(first);
    expect(() => journal.addCommand(reordered)).not.toThrow();
    expect(() => journal.addCommand({
      ...reordered,
      params: { inputId: "input_journal", value: { outer: { b: 3, a: 1 } } },
    })).toThrow(/cannot be reused with different content/u);
  });

  it("leaves the prior state intact when a new journal mutation is rejected", () => {
    const storage = new MemoryStorage();
    const journal = new BrowserCommandJournal(storage, "owner-a", {
      maximumItems: 1,
      maximumItemBytes: 200,
      maximumAggregateBytes: 300,
    });
    journal.setDraft(sessionTitleDraftKey(), "kept");
    expect(() => journal.addCommand(commands[0] as CommandMessage)).toThrow(
      BrowserCommandJournalError,
    );
    expect(journal.drafts()[sessionTitleDraftKey()]).toBe("kept");
  });
});
