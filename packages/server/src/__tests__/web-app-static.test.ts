import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opentag-web-app-static-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>OpenTag</title>");
  await writeFile(join(root, "assets", "app.js"), "globalThis.OPENTAG_APP = true;");
});

afterAll(async () => rm(root, { recursive: true, force: true }));

describe("Web App static serving", () => {
  it("serves SPA routes with security headers without swallowing API or health paths", async () => {
    const app = createApp({ webAppRoot: root });
    try {
      expect((await app.inject({ method: "GET", url: "/" })).body).toContain("OpenTag");
      const spa = await app.inject({ method: "GET", url: "/agents/example/runtime" });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain("OpenTag");
      const policy = String(spa.headers["content-security-policy"]);
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).toContain("style-src 'self' 'unsafe-inline'");
      expect(policy).toContain("img-src 'self' data: https://platform.slack-edge.com");
      // The analytics tag is a host allowance and nothing more: inline script stays refused, so the
      // published gtag.js snippet cannot run and the Web App queues from its own bundle instead.
      expect(policy).toContain("script-src 'self' https://www.googletagmanager.com");
      expect(policy).not.toContain("'unsafe-inline' https://www.googletagmanager.com");
      expect(policy).toContain("https://*.google-analytics.com");
      expect(spa.headers["cache-control"]).toBe("no-store");

      const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toContain("immutable");
      expect((await app.inject({ method: "GET", url: `/invites/${"A".repeat(43)}` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/admin" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/invite/legacy-token" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      const api = await app.inject({ method: "GET", url: "/api/v1/not-a-route" });
      expect(api.statusCode).toBe(404);
      expect(api.body).not.toContain("<!doctype html>");
    } finally {
      await app.close();
    }
  });
});
