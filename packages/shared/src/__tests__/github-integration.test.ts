import { describe, expect, it } from "vitest";
import {
  GitBranchRefSchema,
  GitHubDecimalIdSchema,
  GitHubOAuthContextSchema,
  isValidGitRefName,
} from "../github-integration.js";

describe("GitHubDecimalIdSchema", () => {
  it("accepts positive decimal strings inside the PostgreSQL bigint range", () => {
    expect(GitHubDecimalIdSchema.parse("1")).toBe("1");
    expect(GitHubDecimalIdSchema.parse("9223372036854775807")).toBe("9223372036854775807");
  });

  it.each(["0", "-1", "01", "1.5", "abc", "", "1e3", "9223372036854775808", "12345678901234567890123456790"])(
    "rejects %j",
    (value) => {
      expect(GitHubDecimalIdSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("isValidGitRefName", () => {
  it.each(["refs/heads/master", "refs/heads/feature/tree-sync", "refs/tags/v1.2.3", "a"])("accepts %j", (ref) => {
    expect(isValidGitRefName(ref)).toBe(true);
  });

  it.each([
    "",
    "refs//heads",
    "refs/heads/",
    "/refs/heads/master",
    "refs/heads/master/",
    "refs/heads/mas..ter",
    "refs/heads/master.lock",
    "refs/heads/.hidden",
    "refs/.heads/master",
    "refs/heads/mas ter",
    "refs/heads/mas~ter",
    "refs/heads/mas^ter",
    "refs/heads/mas:ter",
    "refs/heads/mas?ter",
    "refs/heads/mas*ter",
    "refs/heads/mas[ter",
    "refs/heads/mas\\ter",
    "refs/heads/master.",
    "@",
    "refs/heads/@{1}",
    "refs/heads/master",
  ])("rejects %j", (ref) => {
    expect(isValidGitRefName(ref)).toBe(false);
  });
});

describe("GitBranchRefSchema", () => {
  it("requires a fully qualified valid branch ref, not a short name", () => {
    expect(GitBranchRefSchema.parse("refs/heads/master")).toBe("refs/heads/master");
    expect(GitBranchRefSchema.safeParse("master").success).toBe(false);
    expect(GitBranchRefSchema.safeParse("refs/tags/v1").success).toBe(false);
    expect(GitBranchRefSchema.safeParse("refs/heads/").success).toBe(false);
    expect(GitBranchRefSchema.safeParse("refs/heads/bad..name").success).toBe(false);
  });
});

describe("GitHubOAuthContextSchema", () => {
  const base = {
    flowId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000aa",
    intent: "create",
    phase: "awaiting_callback",
    loginSessionHash: "a".repeat(64),
    returnSurface: "account-integrations",
    expiresAt: "2026-09-16T00:10:00.000Z",
    claimedAt: null,
  };

  it("accepts the awaiting and claimed phases with a consistent claim time", () => {
    expect(GitHubOAuthContextSchema.parse(base).phase).toBe("awaiting_callback");
    expect(
      GitHubOAuthContextSchema.parse({ ...base, phase: "claimed", claimedAt: "2026-09-16T00:05:00.000Z" }).phase,
    ).toBe("claimed");
  });

  it("rejects inconsistent claim pairs, unknown fields, and off-whitelist return surfaces", () => {
    expect(GitHubOAuthContextSchema.safeParse({ ...base, phase: "claimed" }).success).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, claimedAt: "2026-09-16T00:05:00.000Z" }).success).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, pkceVerifier: "secret" }).success).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, returnSurface: "evil.example.com" }).success).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, loginSessionHash: "not-hex" }).success).toBe(false);
  });

  it("defaults a missing return Agent to null and fences the Agent deep link by surface", () => {
    expect(GitHubOAuthContextSchema.parse(base).agentId).toBeNull();
    expect(
      GitHubOAuthContextSchema.parse({
        ...base,
        returnSurface: "agent-integrations",
        agentId: "9F0F2F6C-2F5C-4D43-A9FB-9A1C9F0000DD",
      }).agentId,
    ).toBe("9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000dd");
    expect(
      GitHubOAuthContextSchema.safeParse({ ...base, agentId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000dd" }).success,
    ).toBe(false);
    expect(GitHubOAuthContextSchema.safeParse({ ...base, returnSurface: "agent-integrations" }).success).toBe(false);
  });
});
