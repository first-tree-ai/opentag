import { describe, expect, it } from "vitest";
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
        repository_selection: "selected",
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
    expect(page.repositories[0]).toEqual({
      repositoryId: "987654321",
      fullName: "octocat/hello-world",
      private: true,
      defaultBranch: "main",
      permissions: { admin: false, pull: true, push: true },
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
