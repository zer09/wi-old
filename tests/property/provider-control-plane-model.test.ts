import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CredentialError,
  EnvironmentCredentialLeaseManager,
  MAXIMUM_API_KEY_BYTES,
} from "@wi/credentials";
import { RecoveryReconciliationJournal } from "../../apps/web/src/state/recovery-journal.js";

const propertyOptions = {
  seed: Number(process.env.WI_FC_SEED ?? "737373"),
  numRuns: 100,
} as const;

class MemoryStorage {
  value: string | null = null;
  getItem(): string | null { return this.value; }
  setItem(_key: string, value: string): void { this.value = value; }
  removeItem(): void { this.value = null; }
}

const environmentValues = {
  small: "property-small",
  asciiExact: "a".repeat(MAXIMUM_API_KEY_BYTES),
  asciiOver: "a".repeat(MAXIMUM_API_KEY_BYTES + 1),
  multibyteExact: "😀".repeat(MAXIMUM_API_KEY_BYTES / 4),
  multibyteOver: `${"😀".repeat(MAXIMUM_API_KEY_BYTES / 4)}a`,
} as const;
type EnvironmentValueKind = keyof typeof environmentValues;

function validEnvironmentValue(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes > 0 && bytes <= MAXIMUM_API_KEY_BYTES;
}

function recoveryEntry(index: number) {
  return {
    commandId: `cmd_propertyRecovery${index}`,
    operationKind: "credential_recovery" as const,
    recoveryEpochId: `recepoch_propertyRecovery${index}`,
    expiresAtMs: 1_000 + index,
    displayName: `Recovery ${index}`,
    expectedSafeMetadata: {
      expected: {
        providerId: "openai_platform" as const,
        authMode: "api_key" as const,
        originalConnectionId: `pconn_propertyRecovery${index}`,
        generation: 1,
        identity: { status: "unverified" as const },
        updatedAtMs: index,
      },
      displayName: `Recovery ${index}`,
    },
  };
}

describe("Milestone 11 provider control-plane models", () => {
  it("matches a reference model across recovery journal add, remove, and reload sequences", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        kind: fc.constantFrom("add", "remove", "reload"),
        index: fc.integer({ min: 0, max: 15 }),
      }), { maxLength: 100 }),
      (actions) => {
        const storage = new MemoryStorage();
        let journal = new RecoveryReconciliationJournal(storage);
        const model = new Map<number, ReturnType<typeof recoveryEntry>>();
        for (const action of actions) {
          if (action.kind === "add") {
            const entry = recoveryEntry(action.index);
            journal.add(entry);
            model.set(action.index, entry);
          } else if (action.kind === "remove") {
            journal.remove(`cmd_propertyRecovery${action.index}`);
            model.delete(action.index);
          } else {
            journal = new RecoveryReconciliationJournal(storage);
          }
          expect(journal.entries()).toEqual([...model.values()]);
        }
      },
    ), propertyOptions);
  });

  it("matches process-epoch, fingerprint, binding, and discard request-lease outcomes", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        kind: fc.constantFrom("accept", "change", "discard", "request"),
        run: fc.integer({ min: 0, max: 7 }),
        valueKind: fc.constantFrom<EnvironmentValueKind>(
          "small",
          "asciiExact",
          "asciiOver",
          "multibyteExact",
          "multibyteOver",
        ),
        wrongBinding: fc.boolean(),
      }), { maxLength: 100 }),
      (actions) => {
        let environmentValue = "initial";
        const manager = new EnvironmentCredentialLeaseManager(
          () => environmentValue,
          { processEpoch: "process_property", hmacKey: new Uint8Array(32).fill(7) },
        );
        const model = new Map<number, string>();
        for (const action of actions) {
          const runId = `run_${action.run}`;
          if (action.kind === "accept") {
            try {
              manager.accept({
                runId,
                connectionId: "pconn_property",
                generation: 1,
                lifecycleRevision: 1,
                variableName: "WI_PROPERTY_KEY",
              });
              expect(validEnvironmentValue(environmentValue)).toBe(true);
              model.set(action.run, environmentValue);
            } catch (error) {
              expect(error).toBeInstanceOf(CredentialError);
              expect(validEnvironmentValue(environmentValue)).toBe(false);
            }
          } else if (action.kind === "change") {
            environmentValue = environmentValues[action.valueKind];
          } else if (action.kind === "discard") {
            manager.discard(runId);
            model.delete(action.run);
          } else {
            const shouldSucceed =
              !action.wrongBinding &&
              validEnvironmentValue(environmentValue) &&
              model.get(action.run) === environmentValue;
            let result: string;
            try {
              result = manager.withCredential(
                runId,
                {
                  connectionId: "pconn_property",
                  generation: action.wrongBinding ? 2 : 1,
                  lifecycleRevision: 1,
                  processEpoch: "process_property",
                },
                (apiKey) => apiKey,
              );
            } catch (error) {
              expect(error).toBeInstanceOf(CredentialError);
              result = "rejected";
            }
            expect(result).toBe(shouldSucceed ? environmentValue : "rejected");
          }
        }
        manager.close();
      },
    ), propertyOptions);
  });
});
