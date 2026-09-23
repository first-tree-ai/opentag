import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opentag-web-app-static-"));
  await mkdir(join(root, "assets"));
  await cp(
    fileURLToPath(new URL("../../../../apps/web/public/bot-avatars", import.meta.url)),
    join(root, "bot-avatars"),
    { recursive: true },
  );
  await writeFile(join(root, "index.html"), "<!doctype html><title>OpenTag</title>");
  await writeFile(join(root, "assets", "app.js"), "globalThis.OPENTAG_APP = true;");
});

afterAll(async () => rm(root, { recursive: true, force: true }));

describe("Web App static serving", () => {
  it("serves all six registration avatars publicly as square, cross-origin-readable PNG files", async () => {
    const app = createApp({ webAppRoot: root });
    try {
      for (const name of ["developer", "engineer", "architect", "artist", "businessman", "sales"]) {
        const response = await app.inject({
          method: "GET",
          url: `/bot-avatars/v1/${name}.png`,
          headers: { origin: "https://open.feishu.cn" },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("image/png");
        expect(response.headers["cache-control"]).toContain("immutable");
        // Feishu loads each preset with `crossOrigin="anonymous"` and crops it on a canvas before
        // creating the App, so a response without this allowance is discarded in favour of Feishu's
        // own default avatar.
        expect(response.headers["access-control-allow-origin"]).toBe("*");
        expect(response.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(response.rawPayload.readUInt32BE(16)).toBe(512);
        expect(response.rawPayload.readUInt32BE(20)).toBe(512);
      }
    } finally {
      await app.close();
    }
  });

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
      expect(policy).toContain("img-src 'self' data: https:");
      // The analytics tag is a host allowance and nothing more: inline script stays refused, so the
      // published gtag.js snippet cannot run and the Web App queues from its own bundle instead.
      expect(policy).toContain("script-src 'self' https://www.googletagmanager.com");
      expect(policy).not.toContain("'unsafe-inline' https://www.googletagmanager.com");
      expect(policy).toContain("https://*.google-analytics.com");
      expect(spa.headers["cache-control"]).toBe("no-store");

      const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toContain("immutable");
      // The CORS allowance is scoped to the registration presets, not to every static response.
      expect(asset.headers["access-control-allow-origin"]).toBeUndefined();
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
