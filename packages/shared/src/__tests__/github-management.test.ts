import { describe, expect, it } from "vitest";
import { ErrorCodeSchema } from "../errors.js";
import { GITHUB_CONNECTION_ERROR_CODES } from "../github-integration.js";
import {
  GITHUB_MANAGEMENT_ERROR_CODES,
  GITHUB_OAUTH_ERROR_PARAM,
  GITHUB_OAUTH_OUTCOME_PARAM,
  GITHUB_OAUTH_OUTCOME_SUCCESS,
  GitHubIntegrationAvailabilitySchema,
  GitHubIntegrationOverviewSchema,
  GitHubOAuthOutcomeSearchSchema,
  GitHubRepositoryDiscoveryPageSchema,
  GitHubRepositoryDiscoveryQuerySchema,
  StartGitHubAuthorizationRequestSchema,
  StartGitHubAuthorizationResponseSchema,
} from "../github-management.js";

const AGENT_ID = "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000dd";

const installation = {
  installationId: "55123456",
  accountLogin: "octocat",
  accountType: "Organization",
  repositorySelection: "selected",
  suspended: false,
} as const;

const repository = {
  installationId: "55123456",
  repositoryId: "987654321",
  fullName: "octocat/hello-world",
  private: true,
  defaultBranch: "main",
  permissions: { pull: true, push: true },
} as const;

const connectionStatus = {
  id: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000bb",
  accountId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f0000cc",
  githubHost: "github.com",
  appId: "871235",
  githubUserId: "42",
  githubLogin: "octocat",
  status: "active",
  bindingsSchemaVersion: 1,
  bindings: [],
  authorizationVersion: "2",
  credentialGeneration: "1",
  accessExpiresAt: "2026-09-16T08:00:00.000Z",
  refreshExpiresAt: "2027-03-16T00:00:00.000Z",
  recheckRequired: false,
  nextRecheckAt: "2026-09-16T00:30:00.000Z",
  lastVerifiedAt: "2026-09-16T00:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
} as const;

describe("GitHubIntegrationAvailabilitySchema", () => {
  it("describes configured and unconfigured deployments without secrets", () => {
    expect(
      GitHubIntegrationAvailabilitySchema.parse({ available: true, githubHost: "github.com", appId: "871235" }),
    ).toEqual({ available: true, githubHost: "github.com", appId: "871235" });
    expect(
      GitHubIntegrationAvailabilitySchema.parse({ available: false, githubHost: "github.com", appId: null }),
    ).toEqual({ available: false, githubHost: "github.com", appId: null });
    expect(
      GitHubIntegrationAvailabilitySchema.safeParse({ available: true, githubHost: "ghe.example.com", appId: "1" })
        .success,
    ).toBe(false);
    expect(
      GitHubIntegrationAvailabilitySchema.safeParse({ available: true, githubHost: "github.com", appId: "871235" })
        .success,
    ).toBe(true);
    expect(
      GitHubIntegrationAvailabilitySchema.safeParse({
        available: true,
        githubHost: "github.com",
        appId: "871235",
        clientSecret: "x",
      }).success,
    ).toBe(false);
  });
});

describe("GitHubIntegrationOverviewSchema", () => {
  it("carries availability with or without a current connection", () => {
    const unavailable = GitHubIntegrationOverviewSchema.parse({
      availability: { available: false, githubHost: "github.com", appId: null },
      connection: null,
    });
    expect(unavailable.connection).toBeNull();
    const overview = GitHubIntegrationOverviewSchema.parse({
      availability: { available: true, githubHost: "github.com", appId: "871235" },
      connection: connectionStatus,
    });
    expect(overview.connection?.githubLogin).toBe("octocat");
  });
});

describe("StartGitHubAuthorizationRequestSchema", () => {
  it("defaults the return surface and rejects an App override", () => {
    expect(StartGitHubAuthorizationRequestSchema.parse({ intent: "create" })).toEqual({
      intent: "create",
      returnSurface: "account-integrations",
      agentId: null,
    });
    expect(
      StartGitHubAuthorizationRequestSchema.safeParse({ intent: "create", appId: "1", clientId: "x" }).success,
    ).toBe(false);
  });

  it("requires the return Agent exactly on the Agent surface", () => {
    expect(
      StartGitHubAuthorizationRequestSchema.parse({
        intent: "replace",
        returnSurface: "agent-integrations",
        agentId: AGENT_ID,
      }).agentId,
    ).toBe(AGENT_ID);
    expect(
      StartGitHubAuthorizationRequestSchema.safeParse({ intent: "create", returnSurface: "agent-integrations" })
        .success,
    ).toBe(false);
    expect(StartGitHubAuthorizationRequestSchema.safeParse({ intent: "create", agentId: AGENT_ID }).success).toBe(
      false,
    );
  });
});

describe("StartGitHubAuthorizationResponseSchema", () => {
  it("carries the authorize URL and expiry, never the state or verifier", () => {
    const response = StartGitHubAuthorizationResponseSchema.parse({
      connectionId: AGENT_ID,
      authorizationUrl: "https://github.com/login/oauth/authorize?client_id=Iv1.example&state=abc",
      expiresAt: "2026-09-16T00:10:00.000Z",
    });
    expect(response.authorizationUrl.startsWith("https://github.com/")).toBe(true);
    expect(
      StartGitHubAuthorizationResponseSchema.safeParse({
        connectionId: AGENT_ID,
        authorizationUrl: "https://evil.example.com/authorize",
        expiresAt: "2026-09-16T00:10:00.000Z",
      }).success,
    ).toBe(true); // shape only; the server constructs the URL, the client never does
    expect(
      StartGitHubAuthorizationResponseSchema.safeParse({
        connectionId: AGENT_ID,
        authorizationUrl: "https://github.com/login/oauth/authorize",
        expiresAt: "2026-09-16T00:10:00.000Z",
        state: "raw-state",
      }).success,
    ).toBe(false);
  });
});

describe("GitHubRepositoryDiscoveryPageSchema", () => {
  it("accepts a bounded discovery page and rejects secret-bearing shapes", () => {
    const page = GitHubRepositoryDiscoveryPageSchema.parse({
      installations: [installation],
      repositories: [repository],
      nextCursor: "eyJ2IjoxfQ",
    });
    expect(page.repositories[0]?.permissions).toEqual({ pull: true, push: true });
    expect(
      GitHubRepositoryDiscoveryPageSchema.safeParse({
        installations: [installation],
        repositories: [{ ...repository, token: "x-access-token" }],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      GitHubRepositoryDiscoveryPageSchema.safeParse({
        installations: [{ ...installation, appSecret: "x" }],
        repositories: [],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("accepts an empty terminal page", () => {
    expect(
      GitHubRepositoryDiscoveryPageSchema.parse({ installations: [], repositories: [], nextCursor: null }).nextCursor,
    ).toBeNull();
  });
});

describe("GitHubRepositoryDiscoveryQuerySchema", () => {
  it("accepts an opaque cursor and nothing else", () => {
    expect(GitHubRepositoryDiscoveryQuerySchema.parse({})).toEqual({});
    expect(GitHubRepositoryDiscoveryQuerySchema.parse({ cursor: "abc" })).toEqual({ cursor: "abc" });
    expect(GitHubRepositoryDiscoveryQuerySchema.safeParse({ cursor: "abc", installationId: "1" }).success).toBe(false);
  });
});

describe("GitHubOAuthOutcomeSearchSchema", () => {
  it("bounds the callback outcome to the fixed local surface contract", () => {
    expect(
      GitHubOAuthOutcomeSearchSchema.parse({ [GITHUB_OAUTH_OUTCOME_PARAM]: GITHUB_OAUTH_OUTCOME_SUCCESS }),
    ).toEqual({ github_oauth: "success" });
    expect(
      GitHubOAuthOutcomeSearchSchema.parse({
        [GITHUB_OAUTH_OUTCOME_PARAM]: "error",
        [GITHUB_OAUTH_ERROR_PARAM]: "GITHUB_OAUTH_DENIED",
      }),
    ).toEqual({ github_oauth: "error", github_oauth_error: "GITHUB_OAUTH_DENIED" });
    expect(
      GitHubOAuthOutcomeSearchSchema.safeParse({ [GITHUB_OAUTH_OUTCOME_PARAM]: "success", code: "x" }).success,
    ).toBe(false);
  });
});

describe("GITHUB_MANAGEMENT_ERROR_CODES", () => {
  it("exposes only bounded public codes", () => {
    for (const code of Object.values(GITHUB_MANAGEMENT_ERROR_CODES)) {
      expect(code).toMatch(/^GITHUB_[A-Z_]+$/);
    }
  });

  it("keeps every GitHub failure inside the Account error envelope's vocabulary", () => {
    // The HTTP envelope parses its `code` through ErrorCodeSchema; a code outside it would turn a
    // controlled management failure into an internal error on the way out.
    const envelopeCodes = new Set(ErrorCodeSchema.options);
    for (const code of Object.values(GITHUB_CONNECTION_ERROR_CODES)) {
      expect(envelopeCodes.has(code)).toBe(true);
    }
    for (const code of Object.values(GITHUB_MANAGEMENT_ERROR_CODES)) {
      if (code === GITHUB_MANAGEMENT_ERROR_CODES.OAUTH_AUTHENTICATION_REQUIRED) continue;
      expect(envelopeCodes.has(code)).toBe(true);
    }
  });
});
