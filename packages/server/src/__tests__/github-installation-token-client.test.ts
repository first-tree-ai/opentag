import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubInstallationTokenClient } from "../services/github/installation-token-client.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const PRIVATE_KEY_PKCS8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const NOW = new Date("2026-09-16T12:00:00.000Z");
const APP_ID = "123456";
const CLIENT_ID = "Iv1.unit-test-client";

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

function makeClient(fetchStub: typeof fetch, privateKeyPem = PRIVATE_KEY_PKCS8): GitHubInstallationTokenClient {
  return new GitHubInstallationTokenClient({
    appId: APP_ID,
    clientId: CLIENT_ID,
    privateKey: privateKeyPem,
    fetch: fetchStub,
    now: () => new Date(NOW.getTime()),
  });
}

describe("JWT-only GitHub App management", () => {
  const app = { id: Number(APP_ID), client_id: CLIENT_ID, slug: "opentag-staging" };
  it("keeps a verified, bounded App JWT for the existing install entry without minting tokens", async () => {
    const { calls, fetchStub } = stubFetch(() => jsonResponse(app, 200));
    expect(await makeClient(fetchStub).installationUrl()).toBe(
      "https://github.com/apps/opentag-staging/installations/new",
    );
    expect(calls[0]?.url).toBe("https://api.github.com/app");
    const authorization = new Headers(calls[0]?.init.headers).get("authorization") ?? "";
    const [header, payload, signature] = authorization.slice(7).split(".") as [string, string, string];
    expect(
      verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe(APP_ID);
    expect(claims.exp - claims.iat).toBe(600);
    expect(claims.iat).toBe(Math.floor(NOW.getTime() / 1_000) - 60);
    expect(calls).toHaveLength(1);
    expect(makeClient(fetchStub)).not.toHaveProperty("mint");
    expect(makeClient(fetchStub)).not.toHaveProperty("revoke");
  });
  it.each([{ id: 99 }, { client_id: "another-app" }, { slug: "../bad" }, { slug: "" }])(
    "rejects mismatched or unsafe install metadata: %j",
    async (changes) => {
      const { fetchStub } = stubFetch(() => jsonResponse({ ...app, ...changes }, 200));
      await expect(makeClient(fetchStub).installationUrl()).rejects.toThrow();
    },
  );
  it("does not send metadata queries after cancellation or follow a redirect", async () => {
    const { fetchStub, calls } = stubFetch(() => jsonResponse({}, 302));
    const signal = AbortSignal.abort();
    await expect(makeClient(fetchStub).installationUrl(signal)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await expect(makeClient(fetchStub).installationUrl()).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
  it("hides network errors and never retries with other credentials", async () => {
    const { fetchStub, calls } = stubFetch(() => {
      throw new Error("upstream-sensitive-body");
    });
    await expect(makeClient(fetchStub).installationUrl()).rejects.not.toThrow("upstream-sensitive-body");
    expect(calls).toHaveLength(1);
  });
  it("rejects malformed or undersized App keys", () => {
    const { fetchStub } = stubFetch(() => jsonResponse(app, 200));
    expect(() => makeClient(fetchStub, "invalid-key")).toThrow();
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => makeClient(fetchStub, small)).toThrow();
  });
});

describe("GitHub App exact repository installation", () => {
  const installation = {
    id: 789,
    app_id: Number(APP_ID),
    account: { login: "owner", type: "Organization" },
    repository_selection: "selected",
    permissions: { contents: "read" },
    suspended_at: null,
  };
  it("uses the App JWT endpoint without issuing or exposing an installation token", async () => {
    const { fetchStub, calls } = stubFetch(() => jsonResponse(installation, 200));
    expect(await makeClient(fetchStub).repositoryInstallation("owner/repo")).toMatchObject({
      installationId: "789",
      appId: APP_ID,
      suspended: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/owner/repo/installation",
      init: { method: "GET", redirect: "error" },
    });
    expect(calls[0]?.init.headers).toEqual(
      expect.objectContaining({ authorization: expect.stringMatching(/^Bearer ey/) }),
    );
  });
  it("rejects another App and does not follow removed/renamed repository redirects", async () => {
    for (const response of [jsonResponse({ ...installation, app_id: 999 }, 200), jsonResponse({}, 301)]) {
      const { fetchStub } = stubFetch(() => response);
      await expect(makeClient(fetchStub).repositoryInstallation("owner/repo")).rejects.toThrow();
    }
  });
});
