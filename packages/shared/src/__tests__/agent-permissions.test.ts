import { describe, expect, it } from "vitest";
import { AgentPermissionsSchema, parseAgentPermissionRules } from "../agent-permissions.js";
import { UpdateSelfAgentRequestSchema } from "../agent-self.js";

describe("Agent permission rules", () => {
  it.each(["codex", "claude-code", "pi"] as const)(
    "accepts empty defaults and rejects malformed JSON for %s",
    (provider) => {
      expect(parseAgentPermissionRules(provider, "")).toEqual(provider === "codex" ? [] : {});
      expect(() => parseAgentPermissionRules(provider, "{")).toThrow();
    },
  );
  it("validates native decisions and refuses unknown Claude fields", () => {
    expect(parseAgentPermissionRules("codex", '[{"pattern":["git","push"],"decision":"prompt"}]')).toHaveLength(1);
    expect(parseAgentPermissionRules("claude-code", '{"allow":["Bash(git status)"]}')).toEqual({
      allow: ["Bash(git status)"],
    });
    expect(parseAgentPermissionRules("pi", '{"bash":{"git push":"ask"}}')).toEqual({ bash: { "git push": "ask" } });
    expect(() => parseAgentPermissionRules("codex", '[{"pattern":[],"decision":"allow"}]')).toThrow();
    expect(() => parseAgentPermissionRules("claude-code", '{"defaultMode":"bypassPermissions"}')).toThrow();
    expect(() => parseAgentPermissionRules("pi", '{"bash":"maybe"}')).toThrow();
  });
  it("keeps permission authority outside Agent self-configuration", () => {
    const permissions = { approverExternalId: "U_OWNER", rules: "" };
    expect(AgentPermissionsSchema.parse(permissions)).toEqual(permissions);
    expect(AgentPermissionsSchema.safeParse({ ...permissions, approverExternalId: " " }).success).toBe(false);
    expect(
      UpdateSelfAgentRequestSchema.safeParse({ expectedRevision: 1, runtimeConfig: { permissions } }).success,
    ).toBe(false);
  });
});
