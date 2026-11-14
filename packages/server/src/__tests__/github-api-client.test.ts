import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_API_CLIENT_ERROR_CODES,
  GitHubApiClient,
  GitHubApiClientError,
} from "../services/github/github-api-client.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-oauth-scopes": "repo", ...headers },
  });
}

function clientWithFetch(fetchImpl: typeof fetch, now = new Date("2026-09-16T00:00:00.000Z")) {
  const client = new GitHubApiClient({
    fetch: fetchImpl,
    now: () => now,
  });
  return client;
}

async function clientReady(client: GitHubApiClient): Promise<unknown> {
  return client.getAuthenticatedUser({ accessToken: "gho_token" });
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
  return client.getAuthenticatedUser({ accessToken: "gho_token", signal });
}

describe("GitHubApiClient deadline and transport failure precedence", () => {
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
        details: { transportCode: "request_timeout" },
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
      details: { transportCode: "request_cancelled" },
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
