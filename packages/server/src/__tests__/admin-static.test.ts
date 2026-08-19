import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opentag-admin-static-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>OpenTag Admin</title>");
  await writeFile(join(root, "assets", "app.js"), "globalThis.OPENTAG_ADMIN = true;");
});

afterAll(async () => rm(root, { recursive: true, force: true }));

describe("Admin Web static serving", () => {
  it("serves SPA routes with security headers without swallowing API or health paths", async () => {
    const app = createApp({ adminWebRoot: root });
    try {
      const spa = await app.inject({ method: "GET", url: "/admin/teams/example/members" });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain("OpenTag Admin");
      expect(spa.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(spa.headers["cache-control"]).toBe("no-store");

      const asset = await app.inject({ method: "GET", url: "/admin/assets/app.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toContain("immutable");
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
      const api = await app.inject({ method: "GET", url: "/api/v1/not-a-route" });
      expect(api.statusCode).toBe(404);
      expect(api.body).not.toContain("OpenTag Admin");
    } finally {
      await app.close();
    }
  });
});
