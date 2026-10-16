import { afterEach, describe, expect, it } from "vitest";
import { bytes, githubProxyFixture } from "./support/github-proxy-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(...args: Parameters<typeof githubProxyFixture>) {
  const result = await githubProxyFixture(...args);
  cleanup.push(result.close);
  return result;
}

describe("GitHub HTTP interoperability", () => {
  it("retains Basic and the original query through a same-origin Git repository redirect", async () => {
    const f = await fixture((req, res) => {
      expect(req.headers.authorization).toBe(
        `Basic ${Buffer.from("x-access-token:ghu_fixture_owner").toString("base64")}`,
      );
      if (req.url?.startsWith("/team/old.git/")) {
        res.writeHead(301, { location: "/team/new.git/info/refs?service=git-upload-pack" }).end();
      } else res.end("advertisement");
    });
    const response = await f.send({
      path: "/team/old.git/info/refs?service=git-upload-pack",
      headers: { "x-opentag-provider-origin": "github.com" },
    });
    expect((await bytes(response.body)).toString()).toBe("advertisement");
    expect(f.requests.map((request) => request.path)).toEqual([
      "/team/old.git/info/refs?service=git-upload-pack",
      "/team/new.git/info/refs?service=git-upload-pack",
    ]);
  });

  it("answers the real Git Basic challenge while retaining API Bearer authentication", async () => {
    const f = await fixture((req, res) => {
      const expected =
        req.headers.host === "github.com"
          ? `Basic ${Buffer.from("x-access-token:ghu_fixture_owner").toString("base64")}`
          : "Bearer ghu_fixture_owner";
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
        res.end("Authentication required");
        return;
      }
      res.end("authenticated");
    });
    for (const method of ["GET", "POST"]) {
      const response = await f.send({
        method,
        path: method === "GET" ? "/team/code.git/info/refs?service=git-upload-pack" : "/team/code.git/git-receive-pack",
        headers: { "x-opentag-provider-origin": "github.com", authorization: "Bearer caller" },
      });
      expect(response.status).toBe(200);
      expect((await bytes(response.body)).toString()).toBe("authenticated");
    }
    expect((await bytes((await f.send()).body)).toString()).toBe("authenticated");
  });

  it.each([
    "productionresultssa9.blob.core.windows.net",
    "productionresultssa13.blob.core.windows.net",
    "productionresultssa18.blob.core.windows.net",
    "productionresultssa19.blob.core.windows.net",
    "results-receiver.actions.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
  ])("streams GET/HEAD redirects to %s without credentials", async (host) => {
    const f = await fixture((req, res) => {
      if (req.headers.host === "api.github.com") {
        res.writeHead(302, { location: `https://${host}/download?sig=fixture` });
        res.end();
        return;
      }
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers["x-opentag-private"]).toBeUndefined();
      expect(req.headers.range).toBe("bytes=0-4");
      res.writeHead(206, { "content-length": "5", "content-range": "bytes 0-4/10" });
      res.end("bytes");
    });
    for (const method of ["GET", "HEAD"]) {
      const response = await f.send({
        method,
        headers: {
          "x-opentag-provider-origin": "api.github.com",
          cookie: "private",
          "x-opentag-private": "private",
          range: "bytes=0-4",
        },
      });
      expect(response.status).toBe(206);
      expect(response.headers["content-range"]).toBe("bytes 0-4/10");
      expect((await bytes(response.body)).toString()).toBe(method === "HEAD" ? "" : "bytes");
    }
    expect(f.requests).toHaveLength(4);
  });

  it.each([
    "https://productionresultssaevil.blob.core.windows.net/file",
    "https://productionresultssa9.blob.core.windows.net.evil.example/file",
    "https://evil.productionresultssa9.blob.core.windows.net/file",
    "https://unrelated.blob.core.windows.net/file",
    "https://release-assets.githubusercontent.com.evil.example/file",
    "https://productionresultssa9.blob.core.windows.net:444/file",
  ])("rejects lookalike and unrelated download target %s", async (location) => {
    const f = await fixture((_req, res) => res.writeHead(302, { location }).end());
    await expect(f.send()).rejects.toMatchObject({ code: "github_download_target_unsupported" });
    expect(f.requests).toHaveLength(1);
  });

  it("preserves a write's native redirect response when its Location cannot be exposed", async () => {
    const f = await fixture((_req, res) => {
      res.writeHead(307, { location: "https://unsupported.example/path?sig=fixture" });
      res.end("native write result");
    });
    const response = await f.send({ method: "POST" });
    expect(response.status).toBe(307);
    expect(response.headers.location).toBeUndefined();
    expect((await bytes(response.body)).toString()).toBe("native write result");
    expect(f.requests).toHaveLength(1);
  });

  it("never restores authentication after a download redirects back to the API", async () => {
    const f = await fixture((req, res) => {
      if (req.url === "/user")
        res.writeHead(302, { location: "https://productionresultssa9.blob.core.windows.net/file?sig=fixture" }).end();
      else if (req.headers.host !== "api.github.com")
        res.writeHead(302, { location: "https://api.github.com/result" }).end();
      else {
        expect(req.headers.authorization).toBeUndefined();
        res.end("result");
      }
    });
    expect((await bytes((await f.send()).body)).toString()).toBe("result");
    expect(f.requests).toHaveLength(3);
  });
});
