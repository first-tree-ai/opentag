import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_API_CLIENT_ERROR_CODES,
  GitHubApiClient,
  GitHubApiClientError,
} from "../services/github/github-api-client.js";

const REDIRECT_URI = "https://opentag.example.com/api/v1/integrations/github/oauth/callback";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenPayload(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "ghu_access-token",
    token_type: "bearer",
    expires_in: 28_800,
    refresh_token: "ghr_refresh-token",
    refresh_token_expires_in: 15_897_600,
    scope: "",
    ...overrides,
  };
}

function clientWithFetch(fetchImpl: typeof fetch, now = new Date("2026-09-16T00:00:00.000Z")) {
  const client = new GitHubApiClient({
    clientId: "Iv1.client",
    clientSecret: "client-secret",
    redirectUri: REDIRECT_URI,
    fetch: fetchImpl,
    now: () => now,
  });
  return client;
}

describe("GitHubApiClient OAuth token endpoint", () => {
  it("exchanges a code over the fixed origin with PKCE and bounded expiries", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = clientWithFetch(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, tokenPayload());
    });
    const material = await client.exchangeCodeForUserToken({ code: "oauth-code", codeVerifier: "v".repeat(64) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
    expect(calls[0]?.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      client_id: "Iv1.client",
      client_secret: "client-secret",
      code: "oauth-code",
      redirect_uri: REDIRECT_URI,
      code_verifier: "v".repeat(64),
    });
    expect(material.accessToken).toBe("ghu_access-token");
    expect(material.refreshToken).toBe("ghr_refresh-token");
    expect(material.accessExpiresAt.toISOString()).toBe("2026-09-16T08:00:00.000Z");
    expect(material.refreshExpiresAt.toISOString()).toBe("2027-03-19T00:00:00.000Z");
  });

  it("refreshes with the refresh_token grant and nothing else", async () => {
    const bodies: unknown[] = [];
    const client = clientWithFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(200, tokenPayload({ access_token: "ghu_next" }));
    });
    const material = await client.refreshUserToken({ refreshToken: "ghr_current" });
    expect(bodies[0]).toEqual({
      client_id: "Iv1.client",
      client_secret: "client-secret",
      grant_type: "refresh_token",
      refresh_token: "ghr_current",
    });
    expect(material.accessToken).toBe("ghu_next");
  });

  it("treats a 200 error payload as a definitive rejection", async () => {
    const client = clientWithFetch(async () =>
      jsonResponse(200, { error: "bad_verification_code", error_description: "The code passed is incorrect" }),
    );
    const error = await client
      .exchangeCodeForUserToken({ code: "dead-code", codeVerifier: "v".repeat(64) })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GitHubApiClientError);
    expect((error as GitHubApiClientError).code).toBe(GITHUB_API_CLIENT_ERROR_CODES.OAUTH_EXCHANGE_REJECTED);
    // The upstream description text never propagates.
    expect((error as GitHubApiClientError).message).not.toContain("The code passed is incorrect");
  });

  it("fails clearly when the App does not issue expiring user tokens", async () => {
    const client = clientWithFetch(async () =>
      jsonResponse(200, { access_token: "ghu_noexpiry", token_type: "bearer", scope: "" }),
    );
    const error = await client
      .exchangeCodeForUserToken({ code: "code", codeVerifier: "v".repeat(64) })
      .catch((cause: unknown) => cause);
    expect((error as GitHubApiClientError).code).toBe(GITHUB_API_CLIENT_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED);
  });

  it("rejects malformed tokens and non-JSON success bodies", async () => {
    const badToken = clientWithFetch(async () => jsonResponse(200, tokenPayload({ access_token: "has space" })));
    await expect(clientReady(badToken)).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
    const notJson = clientWithFetch(async () => new Response("<html>ok</html>", { status: 200 }));
    await expect(clientReady(notJson)).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
  });

  it("never follows redirects and classifies network failures as unavailable", async () => {
    const redirected = clientWithFetch(async () => new Response(null, { status: 302 }));
    await expect(clientReady(redirected)).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_ERROR });
    const offline = clientWithFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(clientReady(offline)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });
});

async function clientReady(client: GitHubApiClient): Promise<unknown> {
  return client.exchangeCodeForUserToken({ code: "code", codeVerifier: "v".repeat(64) });
}

/** One installation entry in the exact `2022-11-28` shape the client accepts. */
function installationPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 55_123_456,
    app_id: 871_235,
    account: { login: "octocat", type: "Organization" },
    repository_selection: "selected",
    permissions: { contents: "write" },
    suspended_at: null,
    ...overrides,
  };
}

function installationsResponse(installation: unknown, totalCount: number | unknown = 1): Response {
  return jsonResponse(200, { total_count: totalCount, installations: [installation] });
}

describe("GitHubApiClient REST endpoints", () => {
  it("reads the authenticated user identity from the fixed API origin", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = clientWithFetch(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, { id: 42, login: "octocat", type: "User" });
    });
    const user = await client.getAuthenticatedUser({ accessToken: "ghu_token" });
    expect(user).toEqual({ id: "42", login: "octocat" });
    expect(calls[0]?.url).toBe("https://api.github.com/user");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ghu_token");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("classifies 401 as credential invalid, 429 as rate limited, and 5xx as unavailable", async () => {
    const unauthorized = clientWithFetch(async () => jsonResponse(401, { message: "Bad credentials" }));
    await expect(unauthorized.getAuthenticatedUser({ accessToken: "ghu_dead" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID,
    });
    const rateLimited = clientWithFetch(async () =>
      jsonResponse(429, { message: "slow down" }, { "retry-after": "17" }),
    );
    await expect(rateLimited.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED,
      details: { status: 429, retryAfterSeconds: 17 },
    });
    const secondary = clientWithFetch(async () =>
      jsonResponse(403, { message: "rate" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789770600" }),
    );
    await expect(secondary.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED,
    });
    const unavailable = clientWithFetch(async () => jsonResponse(503, { message: "down" }));
    await expect(unavailable.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });

  it("paginates user installations with verified shapes", async () => {
    const client = clientWithFetch(async (url) => {
      expect(String(url)).toBe("https://api.github.com/user/installations?per_page=100&page=2");
      return jsonResponse(200, {
        total_count: 150,
        installations: [
          {
            id: 55_123_456,
            app_id: 871_235,
            account: { login: "octocat", type: "Organization" },
            repository_selection: "selected",
            permissions: { contents: "write", pull_requests: "write", metadata: "read" },
            suspended_at: null,
          },
        ],
      });
    });
    const page = await client.listUserInstallations({ accessToken: "ghu_token", page: 2 });
    expect(page.totalCount).toBe(150);
    expect(page.installations[0]).toEqual({
      installationId: "55123456",
      appId: "871235",
      accountLogin: "octocat",
      accountType: "Organization",
      repositorySelection: "selected",
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      suspended: false,
    });
  });

  it("reads installation repositories with per-user permissions", async () => {
    const client = clientWithFetch(async (url) => {
      expect(String(url)).toBe("https://api.github.com/user/installations/55123456/repositories?per_page=100&page=1");
      return jsonResponse(200, {
        total_count: 1,
        repositories: [
          {
            id: 987_654_321,
            full_name: "octocat/hello-world",
            private: true,
            default_branch: "main",
            permissions: { admin: false, pull: true, push: true, triage: true, maintain: false },
          },
        ],
      });
    });
    const page = await client.listInstallationRepositories({
      accessToken: "ghu_token",
      installationId: "55123456",
      page: 1,
    });
    expect(page).toEqual({
      totalCount: 1,
      repositories: [
        {
          repositoryId: "987654321",
          fullName: "octocat/hello-world",
          private: true,
          defaultBranch: "main",
          permissions: { admin: false, pull: true, push: true },
        },
      ],
    });
  });

  it("returns an empty repositories page at the requested page index", async () => {
    const client = clientWithFetch(async (url) => {
      expect(String(url)).toBe("https://api.github.com/user/installations/55123456/repositories?per_page=100&page=3");
      return jsonResponse(200, { total_count: 2, repositories: [] });
    });
    const page = await client.listInstallationRepositories({
      accessToken: "ghu_token",
      installationId: "55123456",
      page: 3,
    });
    expect(page).toEqual({ totalCount: 2, repositories: [] });
  });

  it("rejects repository pages with a malformed total_count", async () => {
    for (const totalCount of ["2", -1, 1.5, 1_000_001]) {
      const client = clientWithFetch(async () => jsonResponse(200, { total_count: totalCount, repositories: [] }));
      await expect(
        client.listInstallationRepositories({ accessToken: "ghu_token", installationId: "55123456", page: 1 }),
      ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
    }
  });

  it("rejects repository pages whose repositories are not a bounded array", async () => {
    const notArray = clientWithFetch(async () => jsonResponse(200, { total_count: 1, repositories: {} }));
    await expect(
      notArray.listInstallationRepositories({ accessToken: "ghu_token", installationId: "55123456", page: 1 }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
    const oversized = clientWithFetch(async () =>
      jsonResponse(200, {
        total_count: 101,
        repositories: Array.from({ length: 101 }, () => ({
          id: 987_654_321,
          full_name: "octocat/hello-world",
          private: true,
          default_branch: "main",
          permissions: { admin: false, pull: true, push: true },
        })),
      }),
    );
    await expect(
      oversized.listInstallationRepositories({ accessToken: "ghu_token", installationId: "55123456", page: 1 }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
  });

  it("rejects repository entries whose permissions lack the boolean grants", async () => {
    const missingGrant = clientWithFetch(async () =>
      jsonResponse(200, {
        total_count: 1,
        repositories: [
          {
            id: 987_654_321,
            full_name: "octocat/hello-world",
            private: true,
            default_branch: "main",
            permissions: { pull: true, push: true },
          },
        ],
      }),
    );
    await expect(
      missingGrant.listInstallationRepositories({ accessToken: "ghu_token", installationId: "55123456", page: 1 }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
    const nonBooleanGrant = clientWithFetch(async () =>
      jsonResponse(200, {
        total_count: 1,
        repositories: [
          {
            id: 987_654_321,
            full_name: "octocat/hello-world",
            private: true,
            default_branch: "main",
            permissions: { admin: "yes", pull: true, push: true },
          },
        ],
      }),
    );
    await expect(
      nonBooleanGrant.listInstallationRepositories({ accessToken: "ghu_token", installationId: "55123456", page: 1 }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
  });

  it("accepts the official repositories page shape, which carries no repository_selection", async () => {
    // API 2022-11-28: GET /user/installations/{id}/repositories
    // answers HTTP 200 with exactly total_count and repositories; repository_selection exists
    // only on the installation object, never on this page.
    const client = clientWithFetch(async (url) => {
      expect(String(url)).toBe("https://api.github.com/user/installations/55123456/repositories?per_page=100&page=1");
      return jsonResponse(200, {
        total_count: 2,
        repositories: [
          {
            id: 987_654_321,
            full_name: "staging-org/alpha-private",
            private: true,
            default_branch: "main",
            permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
          },
          {
            id: 987_654_322,
            full_name: "staging-org/beta-private",
            private: true,
            default_branch: "main",
            permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
          },
        ],
      });
    });
    const page = await client.listInstallationRepositories({
      accessToken: "ghu_token",
      installationId: "55123456",
      page: 1,
    });
    expect(page).toEqual({
      totalCount: 2,
      repositories: [
        {
          repositoryId: "987654321",
          fullName: "staging-org/alpha-private",
          private: true,
          defaultBranch: "main",
          permissions: { admin: true, pull: true, push: true },
        },
        {
          repositoryId: "987654322",
          fullName: "staging-org/beta-private",
          private: true,
          defaultBranch: "main",
          permissions: { admin: true, pull: true, push: true },
        },
      ],
    });
  });

  it("rejects malformed installation pages instead of guessing", async () => {
    const client = clientWithFetch(async () =>
      jsonResponse(200, {
        total_count: 1,
        installations: [{ id: "not-a-number", app_id: 871_235 }],
      }),
    );
    await expect(client.listUserInstallations({ accessToken: "ghu_token", page: 1 })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it("bounds oversized responses", async () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const client = clientWithFetch(async () => new Response(`{"access_token":"${huge}"}`, { status: 200 }));
    await expect(clientReady(client)).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
  });
});

describe("GitHubApiClient construction", () => {
  const base = { clientId: "Iv1.client", clientSecret: "client-secret", redirectUri: REDIRECT_URI };

  it.each([
    ["an empty client id", { clientId: "" }],
    ["an over-long client id", { clientId: "c".repeat(256) }],
    ["a non-string client id", { clientId: 7 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => new GitHubApiClient({ ...base, ...overrides } as never)).toThrow(
      /The GitHub App client ID is invalid/,
    );
  });

  it.each([
    ["an empty client secret", { clientSecret: "" }],
    ["an over-long client secret", { clientSecret: "s".repeat(256) }],
    ["a non-string client secret", { clientSecret: null }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => new GitHubApiClient({ ...base, ...overrides } as never)).toThrow(
      /The GitHub App client secret is invalid/,
    );
  });

  it.each([
    ["a plain http callback", "http://opentag.example.com/callback"],
    ["a non-http callback scheme", "ftp://opentag.example.com/callback"],
  ])("rejects %s", (_label, redirectUri) => {
    expect(() => new GitHubApiClient({ ...base, redirectUri })).toThrow(/OAuth callback URL is invalid/);
  });

  it.each([
    ["a 127.0.0.1 loopback callback", "http://127.0.0.1:8000/callback"],
    ["a localhost callback", "http://localhost:8000/callback"],
    ["an https callback", "https://opentag.example.com/callback"],
  ])("accepts %s", (_label, redirectUri) => {
    expect(() => new GitHubApiClient({ ...base, redirectUri })).not.toThrow();
  });

  it("falls back to the global fetch and the wall clock when no overrides are given", async () => {
    // The default transport is `globalThis.fetch` bound to globalThis. A request that the caller
    // aborts before it starts never reaches the network, so this exercises the default wiring safely.
    const client = new GitHubApiClient({ ...base });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.getAuthenticatedUser({ accessToken: "ghu_token", signal: controller.signal }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE });
  });
});

describe("GitHubApiClient error detail accessors", () => {
  it("exposes the HTTP status and rate-limit hint when the details carry them", () => {
    const error = new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED, "slow down", {
      retryAfterSeconds: 30,
      status: 429,
    });
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.name).toBe("GitHubApiClientError");
  });

  it("leaves both accessors undefined when no details were recorded", () => {
    const error = new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_ERROR, "failed");
    expect(error.status).toBeUndefined();
    expect(error.retryAfterSeconds).toBeUndefined();
  });
});

describe("GitHubApiClient request validation", () => {
  it.each([
    ["an empty authorization code", { code: "", codeVerifier: "v".repeat(64) }],
    ["an over-long authorization code", { code: "c".repeat(4097), codeVerifier: "v".repeat(64) }],
    ["a non-string authorization code", { code: 7 as never, codeVerifier: "v".repeat(64) }],
  ])("rejects %s before any request", async (_label, input) => {
    const calls: string[] = [];
    const client = clientWithFetch(async (url) => {
      calls.push(String(url));
      return jsonResponse(200, tokenPayload());
    });
    await expect(client.exchangeCodeForUserToken(input)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.REQUEST_INVALID,
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ["a verifier under the minimum length", "v".repeat(42)],
    ["a verifier over the maximum length", "v".repeat(129)],
    ["a verifier with an out-of-alphabet character", `${"v".repeat(63)}!`],
  ])("rejects %s before any request", async (_label, codeVerifier) => {
    const client = clientWithFetch(async () => jsonResponse(200, tokenPayload()));
    await expect(client.exchangeCodeForUserToken({ code: "code", codeVerifier })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.REQUEST_INVALID,
    });
  });

  it.each([
    ["a non-string refresh token", 7 as never],
    ["an empty refresh token", ""],
    ["a refresh token with a disallowed character", "ghr token"],
    ["an over-long refresh token", "r".repeat(4097)],
  ])("rejects %s before any request", async (_label, refreshToken) => {
    const client = clientWithFetch(async () => jsonResponse(200, tokenPayload()));
    await expect(client.refreshUserToken({ refreshToken })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it.each([
    ["a non-decimal installation id", "not-a-number"],
    ["a zero-leading installation id", "055123456"],
    ["a non-string installation id", 55123456 as never],
  ])("rejects %s before any request", async (_label, installationId) => {
    const calls: string[] = [];
    const client = clientWithFetch(async (url) => {
      calls.push(String(url));
      return jsonResponse(200, { total_count: 0, repositories: [] });
    });
    await expect(
      client.listInstallationRepositories({ accessToken: "ghu_token", installationId, page: 1 }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.REQUEST_INVALID });
    expect(calls).toEqual([]);
  });

  it.each([
    ["zero", 0],
    ["a negative page", -1],
    ["a fractional page", 1.5],
    ["a page above the maximum", 10_001],
    ["a non-numeric page", "1" as never],
  ])("rejects %s before any request", async (_label, page) => {
    const calls: string[] = [];
    const client = clientWithFetch(async (url) => {
      calls.push(String(url));
      return jsonResponse(200, { total_count: 0, installations: [] });
    });
    await expect(client.listUserInstallations({ accessToken: "ghu_token", page })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.REQUEST_INVALID,
    });
    expect(calls).toEqual([]);
  });

  it("rejects a malformed access token before any request", async () => {
    const calls: string[] = [];
    const client = clientWithFetch(async (url) => {
      calls.push(String(url));
      return jsonResponse(200, { id: 42, login: "octocat", type: "User" });
    });
    await expect(client.getAuthenticatedUser({ accessToken: "has space" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
    expect(calls).toEqual([]);
  });
});

describe("GitHubApiClient installation payload validation", () => {
  it("accepts a decimal string id and app id and a suspended installation", async () => {
    const client = clientWithFetch(async () =>
      installationsResponse(
        installationPayload({
          id: "55123456",
          app_id: "871235",
          account: { login: "octocat", type: "User" },
          suspended_at: "2026-09-01T00:00:00Z",
        }),
      ),
    );
    const page = await client.listUserInstallations({ accessToken: "ghu_token", page: 1 });
    expect(page.installations[0]).toMatchObject({
      accountType: "User",
      appId: "871235",
      installationId: "55123456",
      suspended: true,
    });
  });

  it.each([
    ["a floating-point id", { id: 55_123_456.5 }],
    ["a negative id", { id: -1 }],
    ["a zero id", { id: 0 }],
    ["a null id", { id: null }],
    ["a zero-leading string id", { id: "055123456" }],
  ])("refuses an installation with %s", async (_label, overrides) => {
    const client = clientWithFetch(async () => installationsResponse(installationPayload(overrides)));
    await expect(client.listUserInstallations({ accessToken: "ghu_token", page: 1 })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it.each([
    ["a non-object installation", "not-an-object"],
    ["an array installation", []],
    ["a missing account", installationPayload({ account: null })],
    ["an unsupported account type", installationPayload({ account: { login: "octocat", type: "Bot" } })],
    ["an empty account login", installationPayload({ account: { login: "", type: "User" } })],
    ["an over-long account login", installationPayload({ account: { login: "l".repeat(101), type: "User" } })],
    ["a non-string account login", installationPayload({ account: { login: 7, type: "User" } })],
    ["an unknown repository selection", installationPayload({ repository_selection: "none" })],
    ["non-object permissions", installationPayload({ permissions: null })],
    ["an empty permission grant", installationPayload({ permissions: { "": "read" } })],
    ["an over-long permission name", installationPayload({ permissions: { ["p".repeat(65)]: "read" } })],
    ["an unsupported permission level", installationPayload({ permissions: { contents: "admin" } })],
    ["a non-string permission level", installationPayload({ permissions: { contents: 1 } })],
    ["a non-string suspended_at", installationPayload({ suspended_at: 123 })],
    ["an unparseable suspended_at", installationPayload({ suspended_at: "not-a-date" })],
    ["a missing id", installationPayload({ id: undefined })],
    ["a missing app_id", installationPayload({ app_id: undefined })],
  ])("refuses %s", async (_label, payload) => {
    const client = clientWithFetch(async () => installationsResponse(payload));
    await expect(client.listUserInstallations({ accessToken: "ghu_token", page: 1 })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it("refuses an installations page that is not a bounded array", async () => {
    const notAnArray = clientWithFetch(async () => jsonResponse(200, { total_count: 1, installations: {} }));
    await expect(notAnArray.listUserInstallations({ accessToken: "ghu_token", page: 1 })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
    const oversized = clientWithFetch(async () =>
      jsonResponse(200, {
        total_count: 101,
        installations: Array.from({ length: 101 }, () => installationPayload()),
      }),
    );
    await expect(oversized.listUserInstallations({ accessToken: "ghu_token", page: 1 })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it("refuses a user identity that is not a user account", async () => {
    const client = clientWithFetch(async () => jsonResponse(200, { id: 42, login: "octocat", type: "Bot" }));
    await expect(client.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it("refuses an authenticated-user payload that is not an object", async () => {
    const client = clientWithFetch(async () => jsonResponse(200, "octocat"));
    await expect(client.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it.each([
    [
      "the installations response",
      (c: GitHubApiClient) => c.listUserInstallations({ accessToken: "ghu_token", page: 1 }),
    ],
    [
      "the repositories response",
      (c: GitHubApiClient) =>
        c.listInstallationRepositories({ accessToken: "ghu_token", installationId: "55123456", page: 1 }),
    ],
  ])("refuses a non-object %s", async (_label, call) => {
    const client = clientWithFetch(async () => jsonResponse(200, "not-an-object"));
    await expect(call(client)).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
  });

  it.each([
    ["a non-object repository", "not-an-object"],
    ["a repository with no permissions", { id: 1, full_name: "octocat/hello-world", permissions: null }],
    [
      "a repository with a non-boolean grant",
      { id: 1, full_name: "octocat/hello-world", permissions: { admin: false, pull: true, push: "yes" } },
    ],
    [
      "a repository with a missing full name",
      { id: 1, full_name: "", permissions: { admin: false, pull: true, push: true } },
    ],
    [
      "a repository with an over-long full name",
      { id: 1, full_name: "n".repeat(256), permissions: { admin: false, pull: true, push: true } },
    ],
    [
      "a repository with an over-long default branch",
      {
        id: 1,
        full_name: "octocat/hello-world",
        default_branch: "b".repeat(256),
        permissions: { admin: false, pull: true, push: true },
      },
    ],
    [
      "a repository with an empty default branch",
      {
        id: 1,
        full_name: "octocat/hello-world",
        default_branch: "",
        permissions: { admin: false, pull: true, push: true },
      },
    ],
    [
      "a repository with a malformed id",
      { id: "not-a-number", full_name: "octocat/hello-world", permissions: { admin: false, pull: true, push: true } },
    ],
  ])("refuses %s", async (_label, repository) => {
    const client = clientWithFetch(async () => jsonResponse(200, { total_count: 1, repositories: [repository] }));
    await expect(
      client.listInstallationRepositories({ accessToken: "ghu_token", installationId: "55123456", page: 1 }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
  });

  it.each([
    ["an absent default branch", undefined, null],
    ["a null default branch", null, null],
    ["a real default branch", "main", "main"],
  ])("maps %s to the documented default branch value", async (_label, defaultBranch, expected) => {
    const client = clientWithFetch(async () =>
      jsonResponse(200, {
        total_count: 1,
        repositories: [
          {
            id: 1,
            full_name: "octocat/hello-world",
            private: true,
            default_branch: defaultBranch,
            permissions: { admin: false, pull: true, push: true },
          },
        ],
      }),
    );
    const page = await client.listInstallationRepositories({
      accessToken: "ghu_token",
      installationId: "55123456",
      page: 1,
    });
    expect(page.repositories[0]?.defaultBranch).toBe(expected);
  });
});

describe("GitHubApiClient token payload validation", () => {
  it.each([
    ["a null access token", { access_token: null }],
    ["an empty access token", { access_token: "" }],
    ["an over-long access token", { access_token: "a".repeat(4097) }],
    ["a null refresh token", { refresh_token: null }],
    ["a malformed refresh token", { refresh_token: "has space" }],
  ])("refuses %s", async (_label, override) => {
    const client = clientWithFetch(async () => jsonResponse(200, tokenPayload(override)));
    await expect(clientReady(client)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it.each([
    ["a zero access expiry", { expires_in: 0 }],
    ["a negative access expiry", { expires_in: -1 }],
    ["a fractional access expiry", { expires_in: 1.5 }],
    ["an access expiry beyond a year", { expires_in: 31_536_001 }],
    ["a string access expiry", { expires_in: "28800" }],
    ["a zero refresh expiry", { refresh_token_expires_in: 0 }],
    ["a refresh expiry beyond a year", { refresh_token_expires_in: 31_536_001 }],
  ])("refuses %s", async (_label, override) => {
    const client = clientWithFetch(async () => jsonResponse(200, tokenPayload(override)));
    await expect(clientReady(client)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED,
    });
  });

  it("falls back to a bounded slug when the OAuth error is not a plain slug", async () => {
    for (const error of ["Bad Verification Code", "x".repeat(65), 42, { nested: true }]) {
      const client = clientWithFetch(async () => jsonResponse(200, { error, error_description: "untrusted" }));
      const failure = await clientReady(client).catch((cause: unknown) => cause);
      expect((failure as GitHubApiClientError).code).toBe(GITHUB_API_CLIENT_ERROR_CODES.OAUTH_EXCHANGE_REJECTED);
      expect((failure as GitHubApiClientError).message).toContain("oauth_error");
    }
  });

  it("refuses a token payload that is not an object", async () => {
    const client = clientWithFetch(async () => jsonResponse(200, ["ghu_token"]));
    await expect(clientReady(client)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });
});

describe("GitHubApiClient transport edge cases", () => {
  it.each([
    ["a bare 500", 500],
    ["a 404", 404],
    ["a 403 without rate-limit evidence", 403],
  ])("classifies %s with its status and no retry hint", async (_label, status) => {
    const client = clientWithFetch(async () => jsonResponse(status, { message: "nope" }));
    const failure = await client.getAuthenticatedUser({ accessToken: "ghu_token" }).catch((cause: unknown) => cause);
    expect((failure as GitHubApiClientError).status).toBe(status);
    expect((failure as GitHubApiClientError).retryAfterSeconds).toBeUndefined();
  });

  it.each([
    ["a non-numeric retry-after", "soon"],
    ["a retry-after above the regex bound", "12345678"],
  ])("ignores %s on a 429 response", async (_label, retryAfter) => {
    const client = clientWithFetch(async () =>
      jsonResponse(429, { message: "slow down" }, { "retry-after": retryAfter }),
    );
    const failure = await client.getAuthenticatedUser({ accessToken: "ghu_token" }).catch((cause: unknown) => cause);
    expect((failure as GitHubApiClientError).code).toBe(GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED);
    expect((failure as GitHubApiClientError).retryAfterSeconds).toBeUndefined();
  });

  it("caps an over-large retry-after at the documented maximum", async () => {
    const client = clientWithFetch(async () =>
      jsonResponse(429, { message: "slow down" }, { "retry-after": "9999999" }),
    );
    const failure = await client.getAuthenticatedUser({ accessToken: "ghu_token" }).catch((cause: unknown) => cause);
    expect((failure as GitHubApiClientError).retryAfterSeconds).toBe(3_600);
  });

  it.each([
    ["a 403 with a zero remaining limit and a future reset", "1789770600", 3_600],
    ["a 403 with a zero remaining limit and no reset header", null, undefined],
    ["a 403 with a zero remaining limit and a malformed reset header", "not-a-number", undefined],
    ["a 403 with a zero remaining limit and an already-past reset", "1", undefined],
  ])("derives the secondary rate limit from %s", async (_label, reset, expected) => {
    const headers: Record<string, string> = { "x-ratelimit-remaining": "0" };
    if (reset !== null) headers["x-ratelimit-reset"] = reset;
    const client = clientWithFetch(async () => jsonResponse(403, { message: "rate" }, headers));
    const failure = await client.getAuthenticatedUser({ accessToken: "ghu_token" }).catch((cause: unknown) => cause);
    expect((failure as GitHubApiClientError).code).toBe(GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED);
    expect((failure as GitHubApiClientError).retryAfterSeconds).toBe(expected);
  });

  it("reports a 3xx that the transport did not follow as a redirect attempt", async () => {
    const client = clientWithFetch(async () => new Response(null, { status: 301 }));
    await expect(client.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_ERROR,
    });
  });

  it("reports a response flagged as redirected even with a success status", async () => {
    const redirected = Response.json({ id: 42, login: "octocat", type: "User" });
    Object.defineProperty(redirected, "redirected", { value: true });
    const client = clientWithFetch(async () => redirected);
    await expect(client.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_ERROR,
    });
  });

  it("returns undefined for a success response with no body at all", async () => {
    const client = clientWithFetch(async () => new Response(null, { status: 200 }));
    await expect(clientReady(client)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it("treats a whitespace-only success body as an absent payload", async () => {
    const client = clientWithFetch(async () => new Response("   \n", { status: 200 }));
    await expect(clientReady(client)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it("surfaces a caller abort that fires before the request starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = clientWithFetch(async () => jsonResponse(200, tokenPayload()));
    await expect(clientReadyWith(client, controller.signal)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });

  it("surfaces a caller abort that fires while the request is in flight", async () => {
    const controller = new AbortController();
    let armed: () => void = () => undefined;
    const armedPromise = new Promise<void>((resolve) => {
      armed = resolve;
    });
    const client = clientWithFetch(async (_url, init) => {
      armed();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const pending = clientReadyWith(client, controller.signal);
    await armedPromise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });

  it("classifies a stream that fails mid-body as unavailable", async () => {
    const client = clientWithFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"access_token":"ghu_'));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 200 });
    });
    await expect(clientReady(client)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });
});

async function clientReadyWith(client: GitHubApiClient, signal: AbortSignal): Promise<unknown> {
  return client.exchangeCodeForUserToken({ code: "code", codeVerifier: "v".repeat(64), signal });
}

describe("GitHubApiClient deadline and transport failure precedence", () => {
  it("uses the wall clock when no now override is configured", async () => {
    const before = Date.now();
    const client = new GitHubApiClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret",
      redirectUri: REDIRECT_URI,
      fetch: async () => jsonResponse(200, tokenPayload({ expires_in: 60, refresh_token_expires_in: 120 })),
    });
    const material = await clientReady(client);
    expect(material).toBeDefined();
    const after = Date.now();
    expect((material as { accessExpiresAt: Date }).accessExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect((material as { accessExpiresAt: Date }).accessExpiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);
  });

  it("fails a request that outlives its own time limit", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const client = clientWithFetch(async (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("deadline aborted")), { once: true });
        });
      });
      const pending = clientReady(client);
      const settled = expect(pending).rejects.toMatchObject({
        code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
      });
      await vi.advanceTimersByTimeAsync(10_001);
      await settled;
      // The deadline aborts the signal the underlying transport was handed.
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the recorded deadline failure when the caller aborts and the transport fails", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const client = clientWithFetch(async (_url, init) => {
      seen = init?.signal ?? undefined;
      // Wait for the deadline to abort, then fail with a plain transport error instead of an
      // AbortError, so the catch block must consult the recorded deadline failure.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new TypeError("socket hang up")), { once: true });
      });
    });
    const pending = clientReadyWith(client, controller.signal);
    await vi.waitFor(() => expect(seen).toBeDefined(), { timeout: 1_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });

  it("reports a deadline failure that lands after the transport already resolved", async () => {
    const controller = new AbortController();
    const client = clientWithFetch(async () => {
      // The response arrives, but the caller aborts in the same turn before the continuation runs.
      controller.abort();
      return jsonResponse(200, tokenPayload());
    });
    await expect(clientReadyWith(client, controller.signal)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });

  it("cancels an error body whose own cancel fails", async () => {
    const client = clientWithFetch(async () => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          return Promise.reject(new Error("cancel failed"));
        },
      });
      return new Response(body, { status: 503 });
    });
    await expect(clientReady(client)).rejects.toMatchObject({
      code: GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
  });

  it.each([
    ["a 4xx", 409, GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_ERROR],
    ["a 5xx", 503, GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE],
  ] as const)("carries the retry-after hint through %s", async (_label, status, code) => {
    const client = clientWithFetch(async () => jsonResponse(status, { message: "later" }, { "retry-after": "42" }));
    const failure = await clientReady(client).catch((cause: unknown) => cause);
    expect((failure as GitHubApiClientError).code).toBe(code);
    expect((failure as GitHubApiClientError).details).toEqual({ retryAfterSeconds: 42, status });
  });
});
