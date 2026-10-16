import { gzipSync } from "node:zlib";
import { githubProxyHeaders } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubProviderAdapter } from "../services/github-proxy/github-provider-adapter.js";
import { githubRequestTarget } from "../services/github-proxy/http-target.js";
import { GitHubHttpTransport } from "../services/github-proxy/http-transport.js";
import { body, bytes, githubProxyFixture, proxyAuthorization, proxyRequest } from "./support/github-proxy-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(...args: Parameters<typeof githubProxyFixture>) {
  const f = await githubProxyFixture(...args);
  cleanup.push(f.close);
  return f;
}

describe("native connected-user GitHub adapter", () => {
  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])(
    "forwards %s without API, field, Session or repository planning",
    async (method) => {
      const received: string[] = [];
      const f = await fixture(async (req, res) => {
        received.push((await bytes(req)).toString());
        res.writeHead(204);
        res.end();
      });
      const response = await f.send({
        method,
        path: "/repos/team/new/issues/123/comments",
        body: body(method === "HEAD" ? "" : '{"body":"https://example.com/?token=public"}'),
      });
      expect(response.status).toBe(204);
      expect(await bytes(response.body)).toHaveLength(0);
      expect(f.requests).toEqual([
        {
          host: "api.github.com",
          path: "/repos/team/new/issues/123/comments",
          authorization: "Bearer ghu_fixture_owner",
        },
      ]);
      expect(f.management.getExecutionUserCredential).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(1);
    },
  );
  it("keeps cold multi-target GraphQL aliases, fragments, partial data/errors and real introspection", async () => {
    const payload = { data: { token: { id: "new" }, other: null }, errors: [{ message: "Native permission error" }] };
    const seen: string[] = [];
    const f = await fixture(async (req, res) => {
      seen.push((await bytes(req)).toString());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
    const query =
      '{ token: node(id:"cold") { id } other: repository(owner:"other",name:"repo"){name} __type(name:"NewType"){fields{name}} }';
    const input = JSON.stringify({ query });
    expect(
      JSON.parse(
        (await bytes((await f.send({ method: "POST", path: "/graphql", body: body(input) })).body)).toString(),
      ),
    ).toEqual(payload);
    expect(seen).toEqual([input]);
  });
  it.each([202, 204, 206, 304, 401, 403, 404, 422, 429, 500, 503])(
    "preserves HTTP %i including native diagnostics",
    async (status) => {
      const f = await fixture((_req, res) => {
        res.writeHead(status, {
          "content-type": "application/json",
          "x-github-request-id": "fixture-id",
          "retry-after": "17",
        });
        res.end(JSON.stringify({ message: "native error", errors: [{ field: "base" }] }));
      });
      const r = await f.send();
      expect(r.status).toBe(status);
      expect(r.headers["x-github-request-id"]).toBe("fixture-id");
      expect(r.headers["retry-after"]).toBe("17");
      const value = await bytes(r.body);
      if ([204, 304].includes(status)) expect(value.length).toBe(0);
      else expect(JSON.parse(value.toString()).message).toBe("native error");
    },
  );
  it("preserves encoded query, compare paths and end-to-end headers; strips caller credentials", async () => {
    const f = await fixture((req, res) => {
      expect(req.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(req.headers.range).toBe("bytes=0-9");
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers["x-opentag-internal"]).toBeUndefined();
      res.end("native");
    });
    const r = await f.send({
      path: "/repos/team/code/compare/main...feature?ref=feature%2Fx&path=docs/a...md",
      headers: {
        "x-opentag-provider-origin": "api.github.com",
        authorization: "foreign",
        cookie: "foreign",
        "x-opentag-internal": "secret",
        "x-github-api-version": "2022-11-28",
        range: "bytes=0-9",
      },
    });
    expect((await bytes(r.body)).toString()).toBe("native");
    expect(f.requests[0]?.path).toContain("feature%2Fx");
  });
  it("streams gzip byte-for-byte and raw bodies beyond the old JSON limit", async () => {
    const raw = Buffer.alloc(6 * 1024 * 1024, 97),
      compressed = gzipSync(raw);
    const f = await fixture((req, res) => {
      const value = req.url === "/raw" ? raw : compressed;
      res.setHeader("content-length", value.length);
      if (req.url !== "/raw") res.setHeader("content-encoding", "gzip");
      res.end(value);
    });
    const gzip = await f.send();
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect((await bytes(gzip.body)).equals(compressed)).toBe(true);
    const response = await f.send({ path: "/raw" });
    expect((await bytes(response.body)).equals(raw)).toBe(true);
  });
  it("replaces the account token per request without minting, caching, revoking or replaying", async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(401);
      res.end("rotated");
    });
    await bytes((await f.send({ method: "POST", path: "/graphql", body: body("{}") })).body);
    f.rotate("ghu_next");
    await bytes((await f.send()).body);
    expect(f.requests.map((r) => r.authorization)).toEqual(["Bearer ghu_fixture_owner", "Bearer ghu_next"]);
    expect(f.management.getExecutionUserCredential).toHaveBeenCalledTimes(2);
  });
  it.each(["executionId", "sessionId", "bindingId", "provider", "purpose"])(
    "rejects mismatched %s before upstream",
    async (field) => {
      const f = await fixture((_req, res) => res.end());
      await expect(
        f.adapter.handle(proxyRequest(f.authorization), { ...f.authorization, [field]: "foreign" }),
      ).rejects.toMatchObject({ code: "scope_denied" });
      expect(f.requests).toHaveLength(0);
      expect(f.management.getExecutionUserCredential).not.toHaveBeenCalled();
    },
  );
  it("rechecks authority after credential retrieval and never installs a repository polling hook", async () => {
    const f = await fixture((_req, res) => res.end());
    const setRevalidation = vi.fn();
    await bytes((await f.send({ setRevalidation })).body);
    expect(setRevalidation).not.toHaveBeenCalled();
    f.authorization.recheck = async () => {
      throw Error("cancelled");
    };
    await expect(f.send()).rejects.toThrow("cancelled");
    expect(f.requests).toHaveLength(1);
  });
  it("fails explicitly when the current credential is unavailable", async () => {
    const auth = proxyAuthorization();
    const transport = { request: vi.fn() };
    const adapter = new GitHubProviderAdapter({
      management: { getExecutionUserCredential: async () => null },
      transport,
    });
    await expect(adapter.handle(proxyRequest(auth), auth)).rejects.toMatchObject({
      code: "github_credential_unavailable",
    });
    expect(transport.request).not.toHaveBeenCalled();
  });
});

describe("fixed transport boundary", () => {
  it.each([
    "/app/installations/1/access_tokens",
    "/applications/id/token",
    "/installation/token",
    "/login/oauth/access_token",
    "/%61pp/installations",
    "/repos/../app/installations",
    "/%2561pp/installations",
    "//evil.example/path",
    "https://evil.example",
    "/path\\escape",
    "/path#fragment",
  ])("rejects credentials/ambiguous targets %s", (path) => {
    expect(() => githubRequestTarget("api.github.com", path, "POST")).toThrow();
  });
  it("checks Git protocol paths without restricting refs or repository identities", () => {
    expect(githubRequestTarget("github.com", "/team/anything.git/git-receive-pack", "POST").hostname).toBe(
      "github.com",
    );
    expect(() => githubRequestTarget("github.com", "/login/oauth/access_token", "POST")).toThrow();
    expect(() => githubRequestTarget("evil.example", "/user", "GET")).toThrow();
  });
  it("removes connection-nominated and reserved headers without deleting ordinary API fields", () => {
    expect(
      githubProxyHeaders({
        Connection: "X-Custom",
        "x-custom": "value",
        Authorization: "secret",
        Cookie: "secret",
        "Set-Cookie": "secret",
        "x-opentag-provider-origin": "evil",
        "x-github-api-version": "version",
        "content-encoding": "gzip",
      }),
    ).toEqual({ "x-github-api-version": "version", "content-encoding": "gzip" });
  });
  it("follows trusted downloads internally without account credentials on any later hop", async () => {
    const f = await fixture((req, res) => {
      if (req.headers.host === "api.github.com") {
        res.writeHead(302, { location: "https://productionresultssa13.blob.core.windows.net/file?sig=fixture" });
        res.end();
      } else {
        expect(req.headers.authorization).toBeUndefined();
        expect(req.headers.cookie).toBeUndefined();
        res.end("artifact");
      }
    });
    expect((await bytes((await f.send()).body)).toString()).toBe("artifact");
    expect(f.requests).toHaveLength(2);
  });
  it.each([
    "http://api.github.com/file",
    "https://127.0.0.1/file",
    "https://evil.blob.core.windows.net/file",
    "https://api.github.com:444/file",
    "https://user:pass@api.github.com/file",
  ])("rejects redirect %s without contacting it", async (location) => {
    const f = await fixture((_req, res) => {
      res.writeHead(302, { location });
      res.end();
    });
    await expect(f.send()).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });
  it("does not replay redirected writes", async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(307, { location: "https://api.github.com/repos/renamed/issues" });
      res.end();
    });
    const r = await f.send({ method: "POST", path: "/repos/team/code/issues", body: body("{}") });
    expect(r.status).toBe(307);
    await bytes(r.body);
    expect(f.requests).toHaveLength(1);
  });
  it.for([["127.0.0.1"], ["140.82.112.3", "169.254.169.254"]])("pins only public DNS answers %j", async (addresses) => {
    const connect = vi.fn();
    const transport = new GitHubHttpTransport({ connect, resolveAddresses: async () => addresses });
    await expect(
      transport.request({
        url: new URL("https://api.github.com/user"),
        method: "GET",
        headers: {},
        body: body(),
        token: "secret",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "github_destination_blocked" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("reports a truncated response without replaying the request", async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setImmediate(() => res.destroy());
    });
    const r = await f.send({ method: "POST", path: "/graphql", body: body("{}") });
    await expect(bytes(r.body)).rejects.toMatchObject({ code: "github_response_truncated" });
    expect(f.requests).toHaveLength(1);
  });
});

describe("native transport failure phases and cleanup", () => {
  it("reports credential retrieval failure without exposing material or contacting upstream", async () => {
    const request = vi.fn();
    const adapter = new GitHubProviderAdapter({
      management: {
        getExecutionUserCredential: async () => {
          throw Error("ghu_private_fixture");
        },
      },
      transport: { request },
    });
    const auth = proxyAuthorization();
    await expect(adapter.handle(proxyRequest(auth), auth)).rejects.toMatchObject({
      code: "github_credential_failed",
      message: "github_credential_failed",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ["ERR_TLS_CERT_ALTNAME_INVALID", "github_tls_failed"],
    ["ECONNREFUSED", "github_connect_failed"],
  ])("classifies %s without raw exception text", async (code, expected) => {
    const transport = new GitHubHttpTransport({
      resolveAddresses: async () => ["140.82.112.3"],
      connect: () => {
        throw Object.assign(Error("ghu_private_fixture"), { code });
      },
    });
    await expect(
      transport.request({
        url: new URL("https://api.github.com/user"),
        method: "GET",
        headers: {},
        body: body(),
        token: "ghu_private_fixture",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: expected, message: expected });
  });
  it("bounds stalled DNS and supports cancellation before connecting", async () => {
    const connect = vi.fn();
    const transport = new GitHubHttpTransport({
      idleTimeoutMs: 30,
      resolveAddresses: () => new Promise(() => {}),
      connect,
    });
    const request = {
      url: new URL("https://api.github.com/user"),
      method: "GET",
      headers: {},
      body: body(),
      token: "ghu_private_fixture",
      signal: new AbortController().signal,
    };
    await expect(transport.request(request)).rejects.toMatchObject({
      code: "github_timeout",
      message: "github_timeout",
    });
    const controller = new AbortController();
    const result = transport.request({ ...request, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toBeDefined();
    expect(connect).not.toHaveBeenCalled();
  });
  it("does not retry a write whose connection fails after the body arrived", async () => {
    let writes = 0;
    const f = await fixture(async (req, res) => {
      await bytes(req);
      writes++;
      res.destroy();
    });
    await expect(f.send({ method: "POST", body: body("write") })).rejects.toMatchObject({
      code: "github_connect_failed",
      message: "github_connect_failed",
    });
    expect(writes).toBe(1);
  });
  it("uses an idle response deadline, excluding time spent waiting for the consumer", async () => {
    const f = await fixture((_req, res) => {
      res.write("first");
      setTimeout(() => res.end("last"), 40);
    }, 100);
    const response = await f.send();
    const iterator = response.body[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(Buffer.from((await iterator.next()).value).toString()).toBe("last");
    expect((await iterator.next()).done).toBe(true);
  });
  it("closes the upstream socket on consumer break", async () => {
    let closed = false;
    const f = await fixture((_req, res) => {
      res.on("close", () => {
        closed = true;
      });
      res.write("first");
    });
    for await (const _chunk of (await f.send()).body) break;
    await vi.waitFor(() => expect(closed).toBe(true));
  });
  it("stops an idle upstream body with an explicit timeout", async () => {
    const f = await fixture((_req, res) => {
      res.write("prefix");
    }, 30);
    await expect(bytes((await f.send()).body)).rejects.toMatchObject({ code: "github_timeout" });
  });
});
