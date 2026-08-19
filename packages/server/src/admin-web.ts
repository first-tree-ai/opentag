import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export const defaultAdminWebRoot = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

export function registerAdminWeb(app: FastifyInstance, root: string): void {
  if (!existsSync(root)) throw new Error(`Admin Web build was not found at ${root}`);
  const indexHtml = readFileSync(join(root, "index.html"), "utf8");

  app.addHook("onSend", async (request, reply) => {
    if (!request.url.startsWith("/admin") && !request.url.startsWith("/invite/")) return;
    reply.header(
      "content-security-policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    reply.header(
      "cache-control",
      request.url.startsWith("/admin/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    );
  });

  app.register(fastifyStatic, { root, prefix: "/admin/", wildcard: false });
  app.get("/admin", async (_request, reply) => reply.redirect("/admin/", 308));
  app.get("/admin/*", async (request, reply) => {
    const wildcard = (request.params as { "*"?: string })["*"] ?? "";
    if (wildcard.split("/").at(-1)?.includes(".")) return reply.code(404).send();
    return reply.type("text/html; charset=utf-8").send(indexHtml);
  });
  app.get("/invite/:token", async (_request, reply) => reply.type("text/html; charset=utf-8").send(indexHtml));
}
