import {
  CommandIdSchema,
  CredentialRecoveryExpectedSafeMetadataSchema,
  RecoveryEpochIdSchema,
  type CredentialRecoveryExpectedSafeMetadata,
} from "@wi/protocol";

const STORAGE_KEY = "wi:v1:credential-recovery-reconciliation";
const MAXIMUM_ENTRIES = 32;
const MAXIMUM_BYTES = 32 * 1_024;

export interface RecoveryReconciliationEntry {
  readonly commandId: string;
  readonly operationKind: "credential_recovery";
  readonly recoveryEpochId: string;
  readonly expiresAtMs: number;
  readonly displayName: string;
  readonly expectedSafeMetadata: CredentialRecoveryExpectedSafeMetadata;
}

export interface RecoveryJournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function parseEntry(value: unknown): RecoveryReconciliationEntry | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => ![
      "commandId", "operationKind", "recoveryEpochId", "expiresAtMs", "displayName",
      "expectedSafeMetadata",
    ].includes(key)) ||
    !CommandIdSchema.safeParse(record.commandId).success ||
    record.operationKind !== "credential_recovery" ||
    !RecoveryEpochIdSchema.safeParse(record.recoveryEpochId).success ||
    typeof record.expiresAtMs !== "number" ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    record.expiresAtMs < 0 ||
    typeof record.displayName !== "string" ||
    record.displayName.length > 256 ||
    !CredentialRecoveryExpectedSafeMetadataSchema.safeParse(record.expectedSafeMetadata).success
  ) return null;
  return record as unknown as RecoveryReconciliationEntry;
}

export class RecoveryReconciliationJournal {
  private entriesByCommand = new Map<string, RecoveryReconciliationEntry>();

  constructor(private readonly storage: RecoveryJournalStorage) {
    this.load();
  }

  entries(): readonly RecoveryReconciliationEntry[] {
    return [...this.entriesByCommand.values()];
  }

  add(entryValue: RecoveryReconciliationEntry): void {
    const entry = parseEntry(entryValue);
    if (entry === null) throw new Error("Recovery reconciliation entry is invalid.");
    const existing = this.entriesByCommand.get(entry.commandId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error("Recovery reconciliation command ID conflicts with an existing entry.");
    }
    const next = new Map(this.entriesByCommand);
    next.set(entry.commandId, entry);
    this.commit(next);
  }

  remove(commandId: string): void {
    if (!this.entriesByCommand.has(commandId)) return;
    const next = new Map(this.entriesByCommand);
    next.delete(commandId);
    this.commit(next);
  }

  private load(): void {
    try {
      const serialized = this.storage.getItem(STORAGE_KEY);
      if (serialized === null) return;
      if (new TextEncoder().encode(serialized).byteLength > MAXIMUM_BYTES) throw new Error();
      const value = JSON.parse(serialized) as unknown;
      if (!Array.isArray(value) || value.length > MAXIMUM_ENTRIES) throw new Error();
      for (const candidate of value) {
        const entry = parseEntry(candidate);
        if (entry === null || this.entriesByCommand.has(entry.commandId)) throw new Error();
        this.entriesByCommand.set(entry.commandId, entry);
      }
    } catch {
      this.entriesByCommand.clear();
      try { this.storage.removeItem(STORAGE_KEY); } catch { /* Browser startup remains available. */ }
    }
  }

  private commit(next: Map<string, RecoveryReconciliationEntry>): void {
    if (next.size > MAXIMUM_ENTRIES) throw new Error("Recovery reconciliation journal is full.");
    if (next.size === 0) {
      this.storage.removeItem(STORAGE_KEY);
      this.entriesByCommand = next;
      return;
    }
    const serialized = JSON.stringify([...next.values()]);
    if (new TextEncoder().encode(serialized).byteLength > MAXIMUM_BYTES) {
      throw new Error("Recovery reconciliation journal is too large.");
    }
    this.storage.setItem(STORAGE_KEY, serialized);
    this.entriesByCommand = next;
  }
}

export function createRecoveryReconciliationJournal(): RecoveryReconciliationJournal {
  return new RecoveryReconciliationJournal(globalThis.sessionStorage);
}
