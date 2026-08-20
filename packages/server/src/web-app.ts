import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export const defaultWebAppRoot = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

export function registerWebApp(app: FastifyInstance, root: string): void {
  if (!existsSync(root)) throw new Error(`Web App build was not found at ${root}`);
  const indexHtml = readFileSync(join(root, "index.html"), "utf8");

  app.addHook("onSend", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "/";
    if (path.startsWith("/api/") || path === "/healthz" || path === "/readyz") return;
    reply.header(
      "content-security-policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    reply.header("cache-control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store");
  });

  app.register(fastifyStatic, { root, prefix: "/", wildcard: false });
  app.get("/*", async (request, reply) => {
    const wildcard = (request.params as { "*"?: string })["*"] ?? "";
    if (
      wildcard === "admin" ||
      wildcard.startsWith("admin/") ||
      wildcard === "invite" ||
      wildcard.startsWith("invite/") ||
      wildcard === "api" ||
      wildcard.startsWith("api/") ||
      wildcard.split("/").at(-1)?.includes(".")
    ) {
      return reply.callNotFound();
    }
    return reply.type("text/html; charset=utf-8").send(indexHtml);
  });
}
