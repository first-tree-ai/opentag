import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_API_CLIENT_ERROR_CODES,
  GitHubApiClient,
  GitHubApiClientError,
} from "../services/github/github-api-client.js";

const REDIRECT_URI = "https://opentag.example.com/api/v2/integrations/github/oauth/callback";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-oauth-scopes": "repo", ...headers },
  });
}

function tokenPayload(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "ghu_access-token",
    token_type: "bearer",
    expires_in: 28_800,
    refresh_token: "ghr_refresh-token",
    refresh_token_expires_in: 15_897_600,
    scope: "repo offline_access",
    ...overrides,
  };
}

function clientWithFetch(fetchImpl: typeof fetch, now = new Date("2026-09-16T00:00:00.000Z")) {
  const client = new GitHubApiClient({
    clientId: "Ov23testclient",
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
      client_id: "Ov23testclient",
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
      client_id: "Ov23testclient",
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
      jsonResponse(200, { access_token: "ghu_noexpiry", token_type: "bearer", scope: "repo offline_access" }),
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

  it.each(["", "public_repo", "read:user, public_repo", "repo:status"])(
    "rejects insufficient granted scopes: %s",
    async (scope) => {
      const client = clientWithFetch(async () =>
        jsonResponse(
          200,
          { id: 42, login: "octocat", type: "User" },
          {
            "x-oauth-scopes": scope,
            "x-accepted-oauth-scopes": "repo",
          },
        ),
      );
      await expect(client.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
        code: GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID,
      });
    },
  );

  it.each([null, "repo read:user", `repo,${"x".repeat(101)}`, "repo,".repeat(101), "x".repeat(10_101)])(
    "treats a missing or malformed scope header as an unconfirmed recheck",
    async (scope) => {
      const headers = new Headers({ "x-accepted-oauth-scopes": "repo" });
      if (scope !== null) headers.set("x-oauth-scopes", scope);
      const client = clientWithFetch(
        async () => new Response(JSON.stringify({ id: 42, login: "octocat", type: "User" }), { headers }),
      );
      await expect(client.getAuthenticatedUser({ accessToken: "ghu_token" })).rejects.toMatchObject({
        code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID,
      });
    },
  );

  it("accepts the repo scope alongside other granted scopes", async () => {
    const client = clientWithFetch(async () =>
      jsonResponse(
        200,
        { id: 42, login: "octocat", type: "User" },
        { "x-oauth-scopes": "read:user, repo, user:email" },
      ),
    );
    await expect(client.getAuthenticatedUser({ accessToken: "ghu_token" })).resolves.toEqual({
      id: "42",
      login: "octocat",
    });
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

  it("bounds oversized responses", async () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const client = clientWithFetch(async () => new Response(`{"access_token":"${huge}"}`, { status: 200 }));
    await expect(clientReady(client)).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
  });
});

describe("GitHubApiClient construction", () => {
  const base = { clientId: "Ov23testclient", clientSecret: "client-secret", redirectUri: REDIRECT_URI };

  it.each([
    ["an empty client id", { clientId: "" }],
    ["an over-long client id", { clientId: "c".repeat(256) }],
    ["a non-string client id", { clientId: 7 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => new GitHubApiClient({ ...base, ...overrides } as never)).toThrow(
      /The GitHub OAuth App client ID is invalid/,
    );
  });

  it.each([
    ["an empty client secret", { clientSecret: "" }],
    ["an over-long client secret", { clientSecret: "s".repeat(256) }],
    ["a non-string client secret", { clientSecret: null }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => new GitHubApiClient({ ...base, ...overrides } as never)).toThrow(
      /The GitHub OAuth App client secret is invalid/,
    );
  });

  it.each([
    ["a plain http callback", "http://opentag.example.com/callback"],
    ["a non-http callback scheme", "ftp://opentag.example.com/callback"],
    ["a non-http loopback callback", "ftp://localhost/callback"],
    ["a non-loopback IPv6 callback", "http://[2001:db8::1]/callback"],
  ])("rejects %s", (_label, redirectUri) => {
    expect(() => new GitHubApiClient({ ...base, redirectUri })).toThrow(/OAuth callback URL is invalid/);
  });

  it.each([
    ["a 127.0.0.1 loopback callback", "http://127.0.0.1:8000/callback"],
    ["a localhost callback", "http://localhost:8000/callback"],
    ["an IPv6 loopback callback", "http://[::1]:8000/callback"],
    ["another IPv4 loopback callback", "http://127.0.0.2:8000/callback"],
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
    await expect(client.listUserRepositories({ accessToken: "ghu_token", page })).rejects.toMatchObject({
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

describe("GitHub user identity validation", () => {
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
      clientId: "Ov23testclient",
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

describe("GitHubApiClient exact target lookup", () => {
  it("uses only the fixed repository endpoint with the current user token", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(200, {
        id: 123,
        full_name: "owner/requested",
        private: true,
        default_branch: "main",
        permissions: { pull: true, push: false, admin: false },
      }),
    );
    const client = clientWithFetch(fetcher);
    expect(await client.getRepository({ accessToken: "ghu_current", fullName: "owner/requested" })).toMatchObject({
      repositoryId: "123",
      fullName: "owner/requested",
      permissions: { pull: true, push: false },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/requested",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer ghu_current" }),
      }),
    );
  });
  it.each(["../foreign", "owner/repo?token=x", "owner/repo/extra", "owner/%2fother"])(
    "rejects an unsafe target %s before network",
    async (fullName) => {
      const fetcher = vi.fn();
      await expect(clientWithFetch(fetcher).getRepository({ accessToken: "ghu_current", fullName })).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("OAuth client and repository scope verification", () => {
  const payload = () => ({
    app: { client_id: "Ov23testclient" },
    scopes: ["repo", "offline_access"],
    user: { id: 42, login: "octocat", type: "User" },
  });
  it("checks the exact OAuth client with Basic authentication and returns only user identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(200, payload()));
    expect(await clientWithFetch(fetcher).validateOAuthToken({ accessToken: "gho_parent" })).toEqual({
      id: "42",
      login: "octocat",
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    if (!init) throw new Error("OAuth verification request is missing");
    expect(url).toBe("https://api.github.com/applications/Ov23testclient/token");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("Ov23testclient:client-secret").toString("base64")}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({ access_token: "gho_parent" });
  });
  it.each([
    { app: { client_id: "other" } },
    { scopes: ["public_repo"] },
    { scopes: "repo" },
    { scopes: Array(101).fill("repo") },
    { user: { id: 42, login: "bot", type: "Bot" } },
    { user: { id: 0, login: "octocat", type: "User" } },
  ])("rejects a mismatched or insufficient token proof %j", async (override) => {
    await expect(
      clientWithFetch(async () => jsonResponse(200, { ...payload(), ...override })).validateOAuthToken({
        accessToken: "gho_parent",
      }),
    ).rejects.toBeInstanceOf(GitHubApiClientError);
  });
  it("treats a missing OAuth token as invalid without exposing the upstream response", async () => {
    await expect(
      clientWithFetch(async () => jsonResponse(404, { message: "secret-upstream" })).validateOAuthToken({
        accessToken: "gho_parent",
      }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID });
  });
  it.each(["", "public_repo", undefined])("rejects token exchange without repo scope (%s)", async (scope) => {
    await expect(
      clientWithFetch(async () => jsonResponse(200, tokenPayload({ scope }))).exchangeCodeForUserToken({
        code: "code",
        codeVerifier: "v".repeat(64),
      }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID });
  });
  it("reads a bounded repository array from the fixed user endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, [
        {
          id: 123,
          full_name: "owner/repo",
          private: true,
          default_branch: "main",
          permissions: { admin: false, pull: true, push: false },
        },
      ]),
    );
    expect(await clientWithFetch(fetcher).listUserRepositories({ accessToken: "gho_parent", page: 2 })).toEqual([
      {
        repositoryId: "123",
        fullName: "owner/repo",
        private: true,
        defaultBranch: "main",
        permissions: { admin: false, pull: true, push: false },
      },
    ]);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/user/repos?per_page=100&page=2&sort=full_name&direction=asc",
    );
  });
  it.each([
    {},
    null,
    Array(101).fill({}),
    [{ id: 1, full_name: "owner/repo", private: true, permissions: { pull: true } }],
  ])("rejects malformed or unbounded repository pages", async (payload) => {
    await expect(
      clientWithFetch(async () => jsonResponse(200, payload)).listUserRepositories({
        accessToken: "gho_parent",
        page: 1,
      }),
    ).rejects.toMatchObject({ code: GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID });
  });
});
