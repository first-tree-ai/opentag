import { describe, expect, it } from "vitest";
import {
  BeginGitHubAuthorizationRequestSchema,
  CreateGitHubConnectionRequestSchema,
  GitBranchRefSchema,
  GitHubConnectionStatusSchema,
  GitHubDecimalIdSchema,
  GitHubOAuthContextSchema,
  GitHubVersionStringSchema,
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

describe("GitHubVersionStringSchema", () => {
  it("accepts zero and positive versions inside the bigint range", () => {
    expect(GitHubVersionStringSchema.parse("0")).toBe("0");
    expect(GitHubVersionStringSchema.parse("9223372036854775807")).toBe("9223372036854775807");
  });

  it.each(["-1", "00", " 1", "1 ", "9223372036854775808", 5, null])("rejects %j", (value) => {
    expect(GitHubVersionStringSchema.safeParse(value).success).toBe(false);
  });
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

describe("GitHubConnectionStatusSchema", () => {
  it("accepts a nonsecret active status DTO and rejects secret-bearing shapes", () => {
    const dto = {
      id: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000bb",
      accountId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000cc",
      githubHost: "github.com",
      oauthClientId: "987654",
      githubUserId: "42",
      githubLogin: "octocat",
      status: "active",
      authorizationVersion: "7",
      credentialGeneration: "3",
      accessExpiresAt: "2026-09-16T08:00:00.000Z",
      refreshExpiresAt: "2027-03-16T00:00:00.000Z",
      recheckRequired: false,
      nextRecheckAt: "2026-09-16T00:30:00.000Z",
      lastVerifiedAt: "2026-09-16T00:00:00.000Z",
      lastErrorCode: null,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    };
    expect(GitHubConnectionStatusSchema.parse(dto).authorizationVersion).toBe("7");
    expect(GitHubConnectionStatusSchema.safeParse({ ...dto, credentialCiphertext: "x" }).success).toBe(false);
    expect(GitHubConnectionStatusSchema.safeParse({ ...dto, credentialKeyId: "k" }).success).toBe(false);
    expect(GitHubConnectionStatusSchema.safeParse({ ...dto, oauthStateHash: "h" }).success).toBe(false);
    expect(
      GitHubConnectionStatusSchema.safeParse({ ...dto, authorizationVersion: "9223372036854775808" }).success,
    ).toBe(false);
  });
});

describe("management request DTOs", () => {
  it("defaults the host and return surface on create and rejects unknown fields", () => {
    expect(CreateGitHubConnectionRequestSchema.parse({ oauthClientId: "1234" })).toEqual({
      githubHost: "github.com",
      oauthClientId: "1234",
      returnSurface: "account-integrations",
      agentId: null,
    });
    expect(CreateGitHubConnectionRequestSchema.safeParse({ oauthClientId: "1234", clientSecret: "x" }).success).toBe(
      false,
    );
    expect(
      CreateGitHubConnectionRequestSchema.safeParse({
        oauthClientId: "1234",
        returnSurface: "agent-integrations",
        agentId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000dd",
      }).success,
    ).toBe(true);
    expect(
      CreateGitHubConnectionRequestSchema.safeParse({ oauthClientId: "1234", returnSurface: "agent-integrations" })
        .success,
    ).toBe(false);
  });

  it("restricts begin-authorization intents to reauthorize and replace", () => {
    expect(BeginGitHubAuthorizationRequestSchema.parse({ intent: "replace" }).returnSurface).toBe(
      "account-integrations",
    );
    expect(BeginGitHubAuthorizationRequestSchema.safeParse({ intent: "create" }).success).toBe(false);
  });
});
