import { verify as cryptoVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubInstallationTokenClient,
  GitHubInstallationTokenError,
  type GitHubInstallationTokenPermissions,
} from "../services/github/installation-token-client.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const PRIVATE_KEY_PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PRIVATE_KEY_PKCS1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const NOW = new Date("2026-09-16T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const APP_ID = "123456";
const INSTALLATION_ID = "789";
const REPOSITORY_ID = "456";
const TOKEN = "ghs_unit_test_token";
// Keep in sync with REQUEST_TIMEOUT_MS in the client under test.
const REQUEST_TIMEOUT_MS = 10_000;

type FetchCall = { url: string; init: RequestInit };

function stubFetch(handler: (call: FetchCall, index: number) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fetchStub = (async (url: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchStub };
}

function jsonResponse(payload: unknown, status = 201, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mintPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: TOKEN,
    expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
    permissions: { contents: "read", metadata: "read" },
    repositories: [{ id: 456, node_id: "R_node", name: "repo", full_name: "acme/repo" }],
    repository_selection: "selected",
    ...overrides,
  };
}

function makeClient(fetchStub: typeof fetch, privateKeyPem = PRIVATE_KEY_PKCS8): GitHubInstallationTokenClient {
  return new GitHubInstallationTokenClient({
    appId: APP_ID,
    privateKey: privateKeyPem,
    fetch: fetchStub,
    now: () => new Date(NOW.getTime()),
  });
}

function baseMintInput(permissions: GitHubInstallationTokenPermissions = { contents: "read" }) {
  return { installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, permissions };
}

function successClient(extraPermissions?: GitHubInstallationTokenPermissions) {
  const permissions = extraPermissions ?? { contents: "read" };
  const granted: Record<string, string> = { metadata: "read" };
  for (const [key, value] of Object.entries(permissions)) granted[key] = value;
  const { calls, fetchStub } = stubFetch(() => jsonResponse(mintPayload({ permissions: granted })));
  return { calls, client: makeClient(fetchStub) };
}

function bearerJwt(call: FetchCall): { header: unknown; payload: Record<string, unknown>; verifies: boolean } {
  const headers = call.init.headers as Record<string, string>;
  const authorization = headers.authorization ?? "";
  expect(authorization.startsWith("Bearer ")).toBe(true);
  const parts = authorization.slice("Bearer ".length).split(".");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (parts.length !== 3 || !encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("The authorization header does not carry a JWT");
  }
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as unknown;
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  const verifies = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    publicKey,
    Buffer.from(encodedSignature, "base64url"),
  );
  return { header, payload, verifies };
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the action to throw");
}

describe("GitHubInstallationTokenClient", () => {
  it("mints a token scoped to exactly one repository with read permissions", async () => {
    const { calls, client } = successClient();

    const result = await client.mint(baseMintInput());

    expect(result.token).toBe(TOKEN);
    expect(result.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) throw new Error("Expected exactly one fetch call");
    expect(call.url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.accept).toBe("application/vnd.github+json");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(headers["user-agent"]).toBeTruthy();
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(call.init.body)) as {
      repository_ids: number[];
      permissions: Record<string, string>;
    };
    expect(body).toEqual({ repository_ids: [456], permissions: { contents: "read" } });
    expect(Object.keys(body.permissions)).toEqual(["contents"]);

    const jwt = bearerJwt(call);
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwt.payload).toEqual({ iat: NOW_SECONDS - 60, exp: NOW_SECONDS + 540, iss: APP_ID });
    expect(jwt.verifies).toBe(true);
  });

  it("sends the exact requested write permission set and accepts a matching grant", async () => {
    const { calls, client } = successClient({ contents: "write", pull_requests: "read" });

    const result = await client.mint(baseMintInput({ contents: "write", pull_requests: "read" }));

    expect(result.token).toBe(TOKEN);
    const [call] = calls;
    if (!call) throw new Error("Expected exactly one fetch call");
    const body = JSON.parse(String(call.init.body)) as { permissions: Record<string, string> };
    expect(body.permissions).toEqual({ contents: "write", pull_requests: "read" });
    expect(Object.keys(body.permissions)).toEqual(["contents", "pull_requests"]);
  });

  it("accepts a grant narrower than requested and implicit metadata read", async () => {
    const { client } = successClient();
    const { fetchStub } = stubFetch(() =>
      jsonResponse(mintPayload({ permissions: { contents: "read", metadata: "read" } })),
    );
    const narrowed = makeClient(fetchStub);

    await expect(client.mint(baseMintInput({ contents: "write" }))).resolves.toMatchObject({ token: TOKEN });
    await expect(narrowed.mint(baseMintInput({ contents: "write" }))).resolves.toMatchObject({ token: TOKEN });
  });

  it("supports legacy PKCS1 PEM keys", async () => {
    const { calls, fetchStub } = stubFetch(() => jsonResponse(mintPayload()));
    const client = makeClient(fetchStub, PRIVATE_KEY_PKCS1);

    await expect(client.mint(baseMintInput())).resolves.toMatchObject({ token: TOKEN });
    const [call] = calls;
    if (!call) throw new Error("Expected exactly one fetch call");
    expect(bearerJwt(call).verifies).toBe(true);
  });

  it("rejects invalid identifiers before any request", async () => {
    const { calls, client } = successClient();
    const invalidRepositoryIds = ["", "abc", "1.5", "-1", "0", "007", "12a", " 123", "123 ", "9007199254740992"];
    for (const repositoryId of invalidRepositoryIds) {
      await expect(client.mint({ ...baseMintInput(), repositoryId })).rejects.toMatchObject({
        code: "GITHUB_REQUEST_INVALID",
      });
    }
    const invalidInstallationIds = ["", "abc", "0", "1_000", "7.5"];
    for (const installationId of invalidInstallationIds) {
      await expect(client.mint({ ...baseMintInput(), installationId })).rejects.toMatchObject({
        code: "GITHUB_REQUEST_INVALID",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid permission requests before any request", async () => {
    const { calls, client } = successClient();
    const invalidPermissions = [
      {},
      { contents: "admin" },
      { contents: "read", issues: "read" },
      { contents: "read", pull_requests: "none" },
      null,
      "read",
    ];
    for (const permissions of invalidPermissions) {
      const input = { ...baseMintInput(), permissions } as unknown as Parameters<
        GitHubInstallationTokenClient["mint"]
      >[0];
      await expect(client.mint(input)).rejects.toMatchObject({ code: "GITHUB_REQUEST_INVALID" });
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed configuration with generic errors", () => {
    const malformedPem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    const rsa1024 = generateKeyPairSync("rsa", { modulusLength: 1_024 });
    const ecP256 = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const cases: { options: { appId: string; privateKey: string }; leaked: string }[] = [
      { options: { appId: "12x4", privateKey: PRIVATE_KEY_PKCS8 }, leaked: "12x4" },
      { options: { appId: "", privateKey: PRIVATE_KEY_PKCS8 }, leaked: PRIVATE_KEY_PKCS8.slice(0, 40) },
      { options: { appId: APP_ID, privateKey: malformedPem }, leaked: "AAAA" },
      {
        options: { appId: APP_ID, privateKey: rsa1024.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
        leaked: "BEGIN",
      },
      {
        options: { appId: APP_ID, privateKey: ecP256.privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
        leaked: "BEGIN",
      },
    ];
    for (const { options, leaked } of cases) {
      const error = captureError(() => new GitHubInstallationTokenClient(options));
      expect(error).toBeInstanceOf(GitHubInstallationTokenError);
      expect((error as GitHubInstallationTokenError).code).toBe("GITHUB_APP_CONFIG_INVALID");
      expect((error as Error).message).not.toContain(leaked);
    }
  });

  it("refuses redirects and never follows them", async () => {
    const { calls, fetchStub } = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/hook" } }),
    );
    const client = makeClient(fetchStub);

    await expect(client.mint(baseMintInput())).rejects.toMatchObject({ code: "GITHUB_API_REDIRECT_REJECTED" });
    const [call] = calls;
    if (!call) throw new Error("Expected exactly one fetch call");
    expect(call.init.redirect).toBe("error");
    expect(call.url.startsWith("https://api.github.com/")).toBe(true);
  });

  it("does not retry on network errors and hides the upstream failure", async () => {
    const { calls, fetchStub } = stubFetch(() => {
      throw new TypeError(`connect ECONNREFUSED https://api.github.com/app/installations/${INSTALLATION_ID}`);
    });
    const client = makeClient(fetchStub);

    const error = await client.mint(baseMintInput()).then(
      () => {
        throw new Error("Expected mint to reject");
      },
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "GITHUB_API_NETWORK_ERROR" });
    expect((error as Error).message).not.toContain("ECONNREFUSED");
    expect((error as Error).message).not.toContain(INSTALLATION_ID);
    expect(calls).toHaveLength(1);
  });

  it("does not retry on server errors and never exposes the upstream body", async () => {
    const { calls, fetchStub } = stubFetch(() => new Response("raw upstream detail", { status: 500 }));
    const client = makeClient(fetchStub);

    const error = await client.mint(baseMintInput()).then(
      () => {
        throw new Error("Expected mint to reject");
      },
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "GITHUB_API_HTTP_ERROR", status: 500 });
    expect((error as Error).message).not.toContain("raw upstream detail");
    expect(calls).toHaveLength(1);
  });

  it("classifies authentication and rate-limit failures with bounded hints", async () => {
    const scenarios: { response: Response; expected: Record<string, unknown> }[] = [
      {
        response: new Response(null, { status: 401 }),
        expected: { code: "GITHUB_APP_AUTH_FAILED", status: 401 },
      },
      {
        response: new Response(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW_SECONDS + 120) },
        }),
        expected: { code: "GITHUB_API_RATE_LIMITED", status: 403, retryAfterSeconds: 120 },
      },
      {
        response: new Response(null, { status: 429, headers: { "retry-after": "30" } }),
        expected: { code: "GITHUB_API_RATE_LIMITED", status: 429, retryAfterSeconds: 30 },
      },
      {
        response: new Response(null, { status: 403 }),
        expected: { code: "GITHUB_API_HTTP_ERROR", status: 403 },
      },
    ];
    for (const { response, expected } of scenarios) {
      const { fetchStub } = stubFetch(() => response);
      const client = makeClient(fetchStub);
      await expect(client.mint(baseMintInput())).rejects.toMatchObject(expected);
    }
  });

  it("rejects a pre-aborted caller signal before any request", async () => {
    const { calls, client } = successClient();
    const controller = new AbortController();
    controller.abort();

    await expect(client.mint({ ...baseMintInput(), signal: controller.signal })).rejects.toMatchObject({
      code: "GITHUB_API_ABORTED",
    });
    expect(calls).toHaveLength(0);
  });

  it("cancels an in-flight request when the caller aborts", async () => {
    const { fetchStub } = stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
        }),
    );
    const client = makeClient(fetchStub);
    const controller = new AbortController();

    const pending = client.mint({ ...baseMintInput(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "GITHUB_API_ABORTED" });
  });

  it("times out a stalled request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { fetchStub } = stubFetch(() => new Promise<Response>(() => undefined));
      const client = makeClient(fetchStub);

      const pending = client.mint(baseMintInput());
      const assertion = expect(pending).rejects.toMatchObject({ code: "GITHUB_API_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stalled response body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { fetchStub } = stubFetch(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                // Never enqueues and never closes: the body stalls.
              },
            }),
            { status: 201 },
          ),
      );
      const client = makeClient(fetchStub);

      const pending = client.mint(baseMintInput());
      const assertion = expect(pending).rejects.toMatchObject({ code: "GITHUB_API_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts off responses beyond the byte limit", async () => {
    const { calls, fetchStub } = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < 4; index += 1) controller.enqueue(new Uint8Array(32 * 1_024));
              controller.close();
            },
          }),
          { status: 201 },
        ),
    );
    const client = makeClient(fetchStub);

    await expect(client.mint(baseMintInput())).rejects.toMatchObject({ code: "GITHUB_API_RESPONSE_TOO_LARGE" });
    expect(calls).toHaveLength(1);
  });

  it("rejects malformed success payloads", async () => {
    const malformed: { payload: unknown; cleanupCalls: number }[] = [
      { payload: "this is not json", cleanupCalls: 0 },
      { payload: mintPayload({ token: undefined }), cleanupCalls: 0 },
      { payload: mintPayload({ token: 42 }), cleanupCalls: 0 },
      { payload: mintPayload({ expires_at: "not-a-date" }), cleanupCalls: 1 },
      { payload: mintPayload({ expires_at: undefined }), cleanupCalls: 1 },
      { payload: mintPayload({ repositories: [{ id: 9_007_199_254_740_992 }] }), cleanupCalls: 1 },
    ];
    for (const { payload, cleanupCalls } of malformed) {
      const { calls, fetchStub } = stubFetch((_call, index) =>
        index === 0
          ? typeof payload === "string"
            ? new Response(payload, { status: 201 })
            : jsonResponse(payload)
          : new Response(null, { status: 204 }),
      );
      const client = makeClient(fetchStub);
      await expect(client.mint(baseMintInput())).rejects.toMatchObject({ code: "GITHUB_API_RESPONSE_INVALID" });
      expect(calls).toHaveLength(1 + cleanupCalls);
    }
  });

  it("rejects a token scoped to wider or different repositories and revokes it", async () => {
    const widened: unknown[] = [[{ id: 456 }, { id: 999 }], [{ id: 999 }], undefined];
    for (const repositories of widened) {
      const { calls, fetchStub } = stubFetch((_call, index) =>
        index === 0 ? jsonResponse(mintPayload({ repositories })) : new Response(null, { status: 204 }),
      );
      const client = makeClient(fetchStub);

      const error = await client.mint(baseMintInput()).then(
        () => {
          throw new Error("Expected mint to reject");
        },
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "GITHUB_TOKEN_VALIDATION_FAILED" });
      expect((error as Error).message).not.toContain(TOKEN);
      expect(calls).toHaveLength(2);
      const revokeCall = calls[1];
      if (!revokeCall) throw new Error("Expected a best-effort revoke call");
      expect(revokeCall.url).toBe("https://api.github.com/installation/token");
      expect(revokeCall.init.method).toBe("DELETE");
      expect((revokeCall.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    }

    // A structurally malformed repository scope is still revoked best-effort.
    const { calls, fetchStub } = stubFetch((_call, index) =>
      index === 0 ? jsonResponse(mintPayload({ repositories: "all" })) : new Response(null, { status: 204 }),
    );
    const client = makeClient(fetchStub);
    await expect(client.mint(baseMintInput())).rejects.toMatchObject({ code: "GITHUB_API_RESPONSE_INVALID" });
    expect(calls).toHaveLength(2);
  });

  it("keeps the original validation failure when the cleanup revoke fails", async () => {
    const { calls, fetchStub } = stubFetch((_call, index) =>
      index === 0 ? jsonResponse(mintPayload({ repositories: [{ id: 999 }] })) : new Response(null, { status: 500 }),
    );
    const client = makeClient(fetchStub);

    await expect(client.mint(baseMintInput())).rejects.toMatchObject({ code: "GITHUB_TOKEN_VALIDATION_FAILED" });
    expect(calls).toHaveLength(2);
  });

  it("rejects permissions broader than requested and revokes the token", async () => {
    const broader: Record<string, unknown>[] = [
      { contents: "write", metadata: "read" },
      { contents: "read", metadata: "read", issues: "read" },
      { contents: "read", metadata: "write" },
      { contents: "read", metadata: "read", administration: "write" },
    ];
    for (const permissions of broader) {
      const { calls, fetchStub } = stubFetch((_call, index) =>
        index === 0 ? jsonResponse(mintPayload({ permissions })) : new Response(null, { status: 204 }),
      );
      const client = makeClient(fetchStub);

      await expect(client.mint(baseMintInput())).rejects.toMatchObject({ code: "GITHUB_TOKEN_VALIDATION_FAILED" });
      expect(calls).toHaveLength(2);
    }
  });

  it("rejects a grant missing a requested permission", async () => {
    const { calls, fetchStub } = stubFetch((_call, index) =>
      index === 0
        ? jsonResponse(mintPayload({ permissions: { contents: "write", metadata: "read" } }))
        : new Response(null, { status: 204 }),
    );
    const client = makeClient(fetchStub);

    await expect(client.mint(baseMintInput({ contents: "write", pull_requests: "read" }))).rejects.toMatchObject({
      code: "GITHUB_TOKEN_VALIDATION_FAILED",
    });
    expect(calls).toHaveLength(2);
  });

  it.each([
    { contents: "constructor", metadata: "read" },
    { contents: "read", constructor: "write" },
    JSON.parse('{"contents":"read","__proto__":"write"}') as Record<string, unknown>,
  ])("does not treat inherited JavaScript properties as permission grants", async (permissions) => {
    const { calls, fetchStub } = stubFetch((_call, index) =>
      index === 0 ? jsonResponse(mintPayload({ permissions })) : new Response(null, { status: 204 }),
    );
    await expect(makeClient(fetchStub).mint(baseMintInput())).rejects.toMatchObject({
      code: "GITHUB_TOKEN_VALIDATION_FAILED",
    });
    expect(calls).toHaveLength(2);
  });

  it("does not report revocation complete on an unexpected success response", async () => {
    const { fetchStub } = stubFetch(() => new Response(null, { status: 202 }));
    await expect(makeClient(fetchStub).revoke(TOKEN)).rejects.toMatchObject({
      code: "GITHUB_API_RESPONSE_INVALID",
    });
  });

  it("rejects tokens containing header control characters", async () => {
    const { fetchStub } = stubFetch(() => jsonResponse(mintPayload({ token: "bad\r\nheader" })));
    await expect(makeClient(fetchStub).mint(baseMintInput())).rejects.toMatchObject({
      code: "GITHUB_API_RESPONSE_INVALID",
    });
  });

  it("rejects unusable token expiries and revokes the token", async () => {
    const unusableExpiries = [
      new Date(NOW.getTime() + 4 * 60_000).toISOString(),
      new Date(NOW.getTime() - 60_000).toISOString(),
      new Date(NOW.getTime() + 48 * 3_600_000).toISOString(),
    ];
    for (const expiresAt of unusableExpiries) {
      const { calls, fetchStub } = stubFetch((_call, index) =>
        index === 0 ? jsonResponse(mintPayload({ expires_at: expiresAt })) : new Response(null, { status: 204 }),
      );
      const client = makeClient(fetchStub);

      await expect(client.mint(baseMintInput())).rejects.toMatchObject({ code: "GITHUB_TOKEN_VALIDATION_FAILED" });
      expect(calls).toHaveLength(2);
    }

    // Exactly at the renewal safety window boundary the token is still usable.
    const { fetchStub } = stubFetch(() =>
      jsonResponse(mintPayload({ expires_at: new Date(NOW.getTime() + 5 * 60_000).toISOString() })),
    );
    const boundaryClient = makeClient(fetchStub);
    await expect(boundaryClient.mint(baseMintInput())).resolves.toMatchObject({ token: TOKEN });
  });

  it("revokes a token with the token itself as the credential", async () => {
    const { calls, fetchStub } = stubFetch(() => new Response(null, { status: 204 }));
    const client = makeClient(fetchStub);

    await expect(client.revoke(TOKEN)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) throw new Error("Expected exactly one fetch call");
    expect(call.url).toBe("https://api.github.com/installation/token");
    expect(call.init.method).toBe("DELETE");
    expect(call.init.redirect).toBe("error");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("rejects invalid revoke input before any request", async () => {
    const { calls, client } = successClient();

    await expect(client.revoke("")).rejects.toMatchObject({ code: "GITHUB_REQUEST_INVALID" });
    expect(calls).toHaveLength(0);
  });

  it("reports revoke failures with the controlled error", async () => {
    const { fetchStub } = stubFetch(() => new Response("upstream detail", { status: 404 }));
    const client = makeClient(fetchStub);

    const error = await client.revoke(TOKEN).then(
      () => {
        throw new Error("Expected revoke to reject");
      },
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "GITHUB_API_HTTP_ERROR", status: 404 });
    expect((error as Error).message).not.toContain("upstream detail");
  });
});
