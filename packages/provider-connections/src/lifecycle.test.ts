import { describe, expect, it } from "vitest";

import {
  acquireLifecycleOwner,
  advanceLifecycleOwner,
  updateConnectionMetadata,
  type LifecycleState,
} from "./lifecycle.js";

function ready(): LifecycleState {
  return {
    status: "ready",
    lifecycleRevision: 1,
    metadataRevision: 1,
    credentialGeneration: 1,
    owner: null,
    deleted: false,
  };
}

describe("provider connection lifecycle ownership", () => {
  it("reserves one revision and generation once, then resumes an identical command", () => {
    const acquired = acquireLifecycleOwner(ready(), "cmd_replace", "a".repeat(64), "replace");
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome !== "acquired") return;
    expect(acquired.state).toMatchObject({ lifecycleRevision: 2, credentialGeneration: 2 });
    const resumed = acquireLifecycleOwner(
      acquired.state,
      "cmd_replace",
      "a".repeat(64),
      "replace",
    );
    expect(resumed.outcome).toBe("resume");
    expect(resumed.state).toEqual(acquired.state);
  });

  it.each(["disable", "logout"] as const)(
    "returns stable operation_in_progress when replace owns and %s arrives",
    (kind) => {
      const owner = acquireLifecycleOwner(ready(), "cmd_replace", "a".repeat(64), "replace");
      if (owner.outcome !== "acquired") throw new Error("owner missing");
      const conflict = acquireLifecycleOwner(owner.state, `cmd_${kind}`, "b".repeat(64), kind);
      expect(conflict).toMatchObject({ outcome: "operation_in_progress", owningKind: "replace" });
      expect(conflict.state).toEqual(owner.state);
    },
  );

  it.each([
    ["delete", "reauthenticate"],
    ["refresh", "logout"],
    ["replace", "replace"],
  ] as const)(
    "keeps exclusive ownership for %s plus a distinct %s command",
    (owningKind, conflictingKind) => {
      const owner = acquireLifecycleOwner(
        ready(),
        `cmd_owner_${owningKind}`,
        "c".repeat(64),
        owningKind,
      );
      if (owner.outcome !== "acquired") throw new Error("owner missing");
      const conflict = acquireLifecycleOwner(
        owner.state,
        `cmd_conflict_${conflictingKind}`,
        "d".repeat(64),
        conflictingKind,
      );
      expect(conflict).toMatchObject({
        outcome: "operation_in_progress",
        owningKind,
      });
      expect(conflict.state).toEqual(owner.state);
    },
  );

  it("restores an unavailable environment through enable without changing generation", () => {
    const unavailable: LifecycleState = {
      ...ready(),
      status: "unavailable",
    };
    const owner = acquireLifecycleOwner(
      unavailable,
      "cmd_enable",
      "a".repeat(64),
      "enable",
    );
    expect(owner).toMatchObject({
      outcome: "acquired",
      state: { lifecycleRevision: 2, credentialGeneration: 1 },
    });
    if (owner.outcome !== "acquired") return;
    expect(advanceLifecycleOwner(owner.state, "succeeded")).toMatchObject({
      status: "ready",
      lifecycleRevision: 2,
      credentialGeneration: 1,
      owner: null,
      deleted: false,
    });
  });

  it("rejects changed-content reuse without mutation", () => {
    const owner = acquireLifecycleOwner(ready(), "cmd_replace", "a".repeat(64), "replace");
    if (owner.outcome !== "acquired") throw new Error("owner missing");
    expect(
      acquireLifecycleOwner(owner.state, "cmd_replace", "b".repeat(64), "replace"),
    ).toEqual({ outcome: "command_conflict", state: owner.state });
  });

  it("keeps metadata revision disjoint during ownership", () => {
    const owner = acquireLifecycleOwner(ready(), "cmd_replace", "a".repeat(64), "replace");
    if (owner.outcome !== "acquired") throw new Error("owner missing");
    const updated = updateConnectionMetadata(owner.state);
    expect(updated.metadataRevision).toBe(2);
    expect(updated.owner).toEqual(owner.owner);
    expect(updated.lifecycleRevision).toBe(owner.state.lifecycleRevision);
    expect(updated.credentialGeneration).toBe(owner.state.credentialGeneration);
  });

  it("terminalizes without incrementing again and fails closed after effect", () => {
    const owner = acquireLifecycleOwner(ready(), "cmd_replace", "a".repeat(64), "replace");
    if (owner.outcome !== "acquired") throw new Error("owner missing");
    const observed = advanceLifecycleOwner(owner.state, "file_observed");
    const terminal = advanceLifecycleOwner(observed, "failed_after_effect");
    expect(terminal).toMatchObject({
      status: "unavailable",
      lifecycleRevision: 2,
      credentialGeneration: 2,
      owner: null,
    });
  });
});
