import { describe, expect, it } from "vitest";

import { CredentialError } from "./errors.js";
import { EnvironmentCredentialLeaseManager } from "./environment.js";
import { MAXIMUM_API_KEY_BYTES } from "./models.js";

describe("environment credential leases", () => {
  it("pins a keyed fingerprint and checks first and later request boundaries", () => {
    let value: string | undefined = "synthetic-secret-a";
    const manager = new EnvironmentCredentialLeaseManager(
      () => value,
      { processEpoch: "process_a", hmacKey: new Uint8Array(32).fill(7) },
    );
    const lease = manager.accept({
      runId: "run_a",
      connectionId: "pconn_a",
      generation: 1,
      lifecycleRevision: 1,
      variableName: "OPENAI_API_KEY",
    });
    expect(JSON.stringify(lease)).not.toContain("synthetic-secret-a");
    expect(
      manager.withCredential(
        "run_a",
        {
          connectionId: "pconn_a",
          generation: 1,
          lifecycleRevision: 1,
          processEpoch: "process_a",
        },
        (apiKey) => apiKey.length,
      ),
    ).toBe("synthetic-secret-a".length);
    value = "synthetic-secret-b";
    expect(() =>
      manager.withCredential(
        "run_a",
        {
          connectionId: "pconn_a",
          generation: 1,
          lifecycleRevision: 1,
          processEpoch: "process_a",
        },
        () => undefined,
      ),
    ).toThrowError(CredentialError);
  });

  it("enforces the shared UTF-8 API-key byte limit at acceptance and request time", () => {
    let value = "a".repeat(MAXIMUM_API_KEY_BYTES);
    const manager = new EnvironmentCredentialLeaseManager(
      () => value,
      { processEpoch: "process_limit", hmacKey: new Uint8Array(32).fill(5) },
    );
    const accept = (runId: string) => manager.accept({
      runId,
      connectionId: "pconn_limit",
      generation: 1,
      lifecycleRevision: 1,
      variableName: "LIMIT_KEY",
    });
    expect(accept("run_exact")).toMatchObject({ runId: "run_exact" });
    value = "😀".repeat(MAXIMUM_API_KEY_BYTES / 4);
    expect(accept("run_multibyteExact")).toMatchObject({ runId: "run_multibyteExact" });
    value += "a";
    expect(() => accept("run_multibyteOver")).toThrowError(expect.objectContaining({
      code: "credential.environment_invalid",
    }));
    value = "a".repeat(MAXIMUM_API_KEY_BYTES + 1);
    expect(() => accept("run_asciiOver")).toThrowError(expect.objectContaining({
      code: "credential.environment_invalid",
    }));
    expect(() => manager.withCredential(
      "run_exact",
      {
        connectionId: "pconn_limit",
        generation: 1,
        lifecycleRevision: 1,
        processEpoch: "process_limit",
      },
      () => undefined,
    )).toThrowError(expect.objectContaining({ code: "credential.environment_invalid" }));
    manager.close();
  });

  it("validates a restored environment value without exposing it or creating a lease", () => {
    let value: string | undefined;
    const manager = new EnvironmentCredentialLeaseManager(
      () => value,
      { processEpoch: "process_revalidate", hmacKey: new Uint8Array(32).fill(9) },
    );
    expect(() => manager.validate("REVALIDATE_KEY")).toThrowError(expect.objectContaining({
      code: "credential.environment_missing",
    }));
    value = "restored-private-value";
    expect(() => manager.validate("REVALIDATE_KEY")).not.toThrow();
    expect(manager.get("run_revalidate")).toBeNull();
    value = "a".repeat(MAXIMUM_API_KEY_BYTES + 1);
    expect(() => manager.validate("REVALIDATE_KEY")).toThrowError(expect.objectContaining({
      code: "credential.environment_invalid",
    }));
    manager.close();
  });

  it("discards a fingerprint reservation after failed run acceptance", () => {
    const manager = new EnvironmentCredentialLeaseManager(
      () => "secret",
      { processEpoch: "process_a", hmacKey: new Uint8Array(32).fill(3) },
    );
    manager.accept({
      runId: "run_a",
      connectionId: "pconn_a",
      generation: 1,
      lifecycleRevision: 1,
      variableName: "KEY",
    });
    manager.discard("run_a");
    expect(manager.get("run_a")).toBeNull();
    expect(() => manager.withCredential(
      "run_a",
      {
        connectionId: "pconn_a",
        generation: 1,
        lifecycleRevision: 1,
        processEpoch: "process_a",
      },
      () => undefined,
    )).toThrowError(CredentialError);
  });

  it("fails closed on missing values and process epoch mismatch", () => {
    const manager = new EnvironmentCredentialLeaseManager(
      () => "secret",
      { processEpoch: "process_a", hmacKey: new Uint8Array(32).fill(1) },
    );
    manager.accept({
      runId: "run_a",
      connectionId: "pconn_a",
      generation: 1,
      lifecycleRevision: 1,
      variableName: "KEY",
    });
    expect(() =>
      manager.withCredential(
        "run_a",
        {
          connectionId: "pconn_a",
          generation: 1,
          lifecycleRevision: 1,
          processEpoch: "process_b",
        },
        () => undefined,
      ),
    ).toThrowError(CredentialError);
  });
});
