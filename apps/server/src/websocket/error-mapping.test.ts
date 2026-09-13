import {
  ReplaySubscriptionError,
  SessionActorError,
  SessionRegistryUnavailableError,
} from "@wi/harness-core";
import { StorageError } from "@wi/storage";
import { describe, expect, it } from "vitest";
import { CommandRoutingError } from "./command-router.js";
import { mapCommandError, mapReplayError } from "./error-mapping.js";

describe("mapCommandError", () => {
  it("preserves validated durable failure diagnostics and safe messages", () => {
    const error = new CommandRoutingError(
      "storage.corrupt",
      "The retained partial session is unavailable.",
      "err_durableFailure",
    );

    expect(mapCommandError(error, () => "err_replacement")).toEqual({
      code: "storage.corrupt",
      message: "The retained partial session is unavailable.",
      recoverable: false,
      diagnosticId: "err_durableFailure",
    });
  });

  it("classifies a faulted session actor as unavailable and non-recoverable", () => {
    const error = new SessionRegistryUnavailableError(
      "ses_unavailable",
      new Error("fault detail"),
    );

    expect(mapCommandError(error, () => "err_sessionUnavailable")).toEqual({
      code: "storage.corrupt",
      message: "The requested session storage is unavailable.",
      recoverable: false,
      diagnosticId: "err_sessionUnavailable",
    });
  });

  it("preserves typed already-resolved interaction results", () => {
    expect(
      mapCommandError(
        new SessionActorError("approval.already_resolved", "untrusted approval detail"),
        () => "err_approvalResolved",
      ),
    ).toEqual({
      code: "approval.already_resolved",
      message: "This approval was already resolved.",
      recoverable: false,
      diagnosticId: "err_approvalResolved",
    });
    expect(
      mapCommandError(
        new SessionActorError("input.already_resolved", "untrusted input detail"),
        () => "err_inputResolved",
      ),
    ).toEqual({
      code: "input.already_resolved",
      message: "This input request was already resolved.",
      recoverable: false,
      diagnosticId: "err_inputResolved",
    });
  });

  it("preserves distinct safe credential recovery conflict results", () => {
    const cases = [
      [
        "credential.recovery_connection_conflict",
        "The original provider connection is already occupied.",
      ],
      [
        "credential.recovery_identity_conflict",
        "The provider identity is already claimed by another connection.",
      ],
      [
        "credential.recovery_already_claimed",
        "The credential recovery evidence was already claimed.",
      ],
    ] as const;
    for (const [code, message] of cases) {
      expect(mapCommandError(
        new StorageError(code, "untrusted recovery detail"),
        () => "err_recoveryConflict",
      )).toEqual({
        code,
        message,
        recoverable: false,
        diagnosticId: "err_recoveryConflict",
      });
    }
  });

  it("rejects invalid embedded metadata and uses safe fallbacks", () => {
    const error = new CommandRoutingError(
      "storage.corrupt",
      "x".repeat(513),
      "not-a-diagnostic-id",
    );

    expect(mapCommandError(error, () => "err_replacement")).toEqual({
      code: "storage.corrupt",
      message: "The requested session storage is unavailable.",
      recoverable: false,
      diagnosticId: "err_replacement",
    });
  });

  it("ignores structurally forged browser metadata on unknown exceptions", () => {
    const secret = "AUDIT_UNTRUSTED_SAFE_MESSAGE_SECRET";
    const error = Object.assign(new Error("untrusted collaborator failure"), {
      code: "storage.corrupt",
      safeMessage: `Unexpected provider detail: ${secret}`,
      diagnosticId: "err_attackerChosenDiagnostic",
    });

    const mapped = mapCommandError(error, () => "err_serverOwned");
    expect(mapped).toEqual({
      code: "storage.worker_failed",
      message: "The storage operation could not be completed safely.",
      recoverable: true,
      diagnosticId: "err_serverOwned",
    });
    expect(JSON.stringify(mapped)).not.toContain(secret);
    expect(JSON.stringify(mapped)).not.toContain("err_attackerChosenDiagnostic");
  });
});

describe("mapReplayError", () => {
  it("marks faulted actors and permanent session storage failures as unavailable", () => {
    for (const error of [
      new SessionRegistryUnavailableError("ses_unavailable", new Error("fault detail")),
      new SessionActorError("session.unavailable", "faulted actor detail"),
      new StorageError("storage.corrupt", "corrupt detail"),
      new StorageError("storage.migration_failed", "migration detail"),
    ]) {
      expect(mapReplayError(error)).toEqual({
        code: "storage.corrupt",
        message: "The requested session storage is unavailable.",
        recoverable: false,
      });
    }
  });

  it("preserves permanent storage failures wrapped by replay queries", () => {
    for (const [storageCode, expectedCode, expectedMessage] of [
      [
        "storage.corrupt",
        "storage.corrupt",
        "The requested session storage is unavailable.",
      ],
      [
        "storage.migration_failed",
        "storage.corrupt",
        "The requested session storage is unavailable.",
      ],
      [
        "storage.session_uninitialized",
        "storage.corrupt",
        "The requested session storage is unavailable.",
      ],
      [
        "storage.session_missing",
        "replay.unknown_session",
        "The requested session does not exist.",
      ],
    ] as const) {
      const error = new ReplaySubscriptionError(
        "replay.query_failed",
        "Replay event page query failed",
        { cause: new StorageError(storageCode, "untrusted storage detail") },
      );

      expect(mapReplayError(error)).toEqual({
        code: expectedCode,
        message: expectedMessage,
        recoverable: false,
      });
    }
  });

  it("marks replay-time session unavailability as corrupt and non-recoverable", () => {
    expect(
      mapReplayError(
        new ReplaySubscriptionError(
          "replay.session_unavailable",
          "catalog became unavailable",
        ),
      ),
    ).toEqual({
      code: "storage.corrupt",
      message: "The requested session storage is unavailable.",
      recoverable: false,
    });
  });

  it("marks conflicting committed history as non-recoverable", () => {
    expect(
      mapReplayError(
        new ReplaySubscriptionError(
          "replay.sequence_conflict",
          "injected conflicting history",
        ),
      ),
    ).toEqual({
      code: "replay.sequence_conflict",
      message: "The session replay detected conflicting committed history.",
      recoverable: false,
    });
  });
});
