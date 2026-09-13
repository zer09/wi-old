import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECOVERY_INGRESS_MAXIMUM_BYTES,
  DEFAULT_RECOVERY_INGRESS_MAXIMUM_FRAMES,
  RecoveryIngressBudget,
} from "./recovery-ingress.js";

describe("RecoveryIngressBudget", () => {
  it("accepts the exact count boundary and rejects one more frame", () => {
    const budget = new RecoveryIngressBudget({ maximumFrames: 2, maximumBytes: 100 });
    const first = budget.reserve(10);
    const second = budget.reserve(10);
    expect(first.state).toBe("registered");
    expect(second.state).toBe("registered");
    expect(budget.snapshot).toMatchObject({ pendingFrames: 2, pendingBytes: 20 });
    expect(budget.reserve(10)).toEqual({ state: "saturated" });
  });

  it("accepts the exact byte boundary and rejects one byte more", () => {
    const budget = new RecoveryIngressBudget({ maximumFrames: 10, maximumBytes: 100 });
    const exact = budget.reserve(100);
    expect(exact.state).toBe("registered");
    expect(budget.reserve(1)).toEqual({ state: "saturated" });
  });

  it("charges duplicate reservations and releases each exact reservation once", () => {
    const budget = new RecoveryIngressBudget({ maximumFrames: 3, maximumBytes: 100 });
    const duplicateA = budget.reserve(30);
    const duplicateB = budget.reserve(40);
    expect(budget.snapshot).toMatchObject({ pendingFrames: 2, pendingBytes: 70 });
    expect(budget.reserve(31)).toEqual({ state: "saturated" });
    if (duplicateA.state !== "registered" || duplicateB.state !== "registered") {
      throw new Error("test setup did not reserve duplicate frames");
    }
    duplicateA.reservation.release();
    duplicateA.reservation.release();
    expect(budget.snapshot).toMatchObject({ pendingFrames: 1, pendingBytes: 40 });
    duplicateB.reservation.release();
    expect(budget.snapshot).toMatchObject({ pendingFrames: 0, pendingBytes: 0 });
    expect(budget.reserve(100).state).toBe("registered");
  });

  it("validates constructor-only overrides and never permits a production increase", () => {
    expect(() => new RecoveryIngressBudget({ maximumFrames: 65 })).toThrow(RangeError);
    expect(() => new RecoveryIngressBudget({ maximumBytes: DEFAULT_RECOVERY_INGRESS_MAXIMUM_BYTES + 1 }))
      .toThrow(RangeError);
    const defaults = new RecoveryIngressBudget();
    expect(defaults.snapshot).toEqual({
      pendingFrames: 0,
      pendingBytes: 0,
      maximumFrames: DEFAULT_RECOVERY_INGRESS_MAXIMUM_FRAMES,
      maximumBytes: DEFAULT_RECOVERY_INGRESS_MAXIMUM_BYTES,
    });
  });
});
