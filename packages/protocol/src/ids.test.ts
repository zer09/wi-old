import { describe, expect, it } from "vitest";

import {
  CommandIdSchema,
  EnvelopeIdSchema,
  ProvisioningRefSchema,
  RecoveryRefSchema,
  createId,
  createIdGenerator,
} from "./ids.js";

describe("ID helpers", () => {
  it("uses the injected source deterministically", () => {
    const values = ["first", "second"];
    const source = () => values.shift() ?? "exhausted";
    const nextCommandId = createIdGenerator("command", source);

    expect(nextCommandId()).toBe("cmd_first");
    expect(nextCommandId()).toBe("cmd_second");
  });

  it("validates generated and decoded IDs", () => {
    expect(createId("command", () => "valid_01")).toBe("cmd_valid_01");
    expect(CommandIdSchema.safeParse("cmd_valid_01").success).toBe(true);
    expect(CommandIdSchema.safeParse("ses_valid_01").success).toBe(false);
    expect(() => createId("command", () => "contains spaces")).toThrow();
  });

  it("keeps credential and recovery reference namespaces distinct", () => {
    expect(EnvelopeIdSchema.safeParse("envl_random01").success).toBe(true);
    expect(ProvisioningRefSchema.safeParse("provref_random01").success).toBe(true);
    expect(RecoveryRefSchema.safeParse("recref_random01").success).toBe(true);
    expect(ProvisioningRefSchema.safeParse("recref_random01").success).toBe(false);
    expect(RecoveryRefSchema.safeParse("/tmp/credential.json").success).toBe(false);
    expect(RecoveryRefSchema.safeParse("credref_internal01").success).toBe(false);
  });
});
