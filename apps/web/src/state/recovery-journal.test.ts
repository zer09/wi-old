import { describe, expect, it } from "vitest";

import { RecoveryReconciliationJournal, type RecoveryJournalStorage } from "./recovery-journal.js";

class MemoryStorage implements RecoveryJournalStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const entry = {
  commandId: "cmd_recoveryJournal",
  operationKind: "credential_recovery" as const,
  recoveryEpochId: "recepoch_recoveryJournal",
  expiresAtMs: 10_000,
  displayName: "Recovered account",
  expectedSafeMetadata: {
    expected: {
      originalConnectionId: "pconn_recoveryJournal",
      providerId: "openai_platform" as const,
      authMode: "api_key" as const,
      generation: 1,
      identity: { status: "unverified" as const },
      updatedAtMs: 1,
    },
    displayName: "Recovered account",
  },
};

describe("RecoveryReconciliationJournal", () => {
  it("persists only bounded nonclaiming recovery metadata", () => {
    const storage = new MemoryStorage();
    const journal = new RecoveryReconciliationJournal(storage);
    journal.add(entry);
    const serialized = [...storage.values.values()][0]!;
    expect(serialized).toContain(entry.commandId);
    expect(serialized).not.toContain("recref_");
    expect(serialized).not.toContain("apiKey");
    expect(new RecoveryReconciliationJournal(storage).entries()).toEqual([entry]);
    journal.remove(entry.commandId);
    expect(storage.values.size).toBe(0);
  });

  it("drops malformed persisted state without blocking startup", () => {
    const storage = new MemoryStorage();
    storage.values.set("wi:v1:credential-recovery-reconciliation", JSON.stringify([
      { ...entry, recoveryRef: "recref_forbidden" },
    ]));
    expect(new RecoveryReconciliationJournal(storage).entries()).toEqual([]);
    expect(storage.values.size).toBe(0);
  });
});
