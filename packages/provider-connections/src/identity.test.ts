import { describe, expect, it } from "vitest";

import { authoritativeIdentityKey, normalizeAuthoritativeIdentity } from "./identity.js";

const base = {
  status: "authoritative" as const,
  subjectId: "subject-a",
  workspace: { presence: "none" as const },
};

describe("authoritative provider identity", () => {
  it("keeps no-workspace, unknown, and explicit workspaces distinct", () => {
    const none = authoritativeIdentityKey("openai_codex", "chatgpt_oauth", base);
    const unknown = authoritativeIdentityKey("openai_codex", "chatgpt_oauth", {
      ...base,
      workspace: { presence: "unknown" },
    });
    const workspace = authoritativeIdentityKey("openai_codex", "chatgpt_oauth", {
      ...base,
      workspace: { presence: "value", value: "workspace-a" },
    });
    expect(new Set([none, unknown, workspace]).size).toBe(3);
  });

  it("does not use alias, email, or plan as stable identity", () => {
    const normalized = normalizeAuthoritativeIdentity("openai_codex", "chatgpt_oauth", {
      ...base,
      planType: "pro",
    });
    expect(normalized).toEqual({
      providerId: "openai_codex",
      authMode: "chatgpt_oauth",
      stableKind: "subject",
      stableValue: "subject-a",
      workspace: "none",
    });
  });
});
