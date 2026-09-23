import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export const defaultWebAppRoot = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));

/**
 * The Web App's Content Security Policy.
 *
 * `script-src` is stated rather than inherited from `default-src` because the Web App loads
 * Google Analytics' tag from `googletagmanager.com`. It is a host allowance and nothing more: no
 * `'unsafe-inline'`, so the published gtag.js bootstrap snippet still cannot run as written, and the
 * Web App creates the queue in its own bundle instead.
 *
 * The measurement hosts are widened for `connect-src` and `img-src` because the tag reports over
 * `fetch`/`sendBeacon` to a regional collector — `region1.google-analytics.com` and its siblings —
 * and falls back to an image request where that is unavailable. The allowance is unconditional
 * while the tag is loaded conditionally: the Web App measures only non-loopback production
 * documents, so on a development or end-to-end origin these sources are permitted but never used.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://www.googletagmanager.com",
  "connect-src 'self' https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://*.googletagmanager.com",
  // Provider avatars use tenant-specific HTTPS CDNs; other resource directives stay restricted.
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function registerWebApp(app: FastifyInstance, root: string): void {
  if (!existsSync(root)) throw new Error(`Web App build was not found at ${root}`);
  const indexHtml = readFileSync(join(root, "index.html"), "utf8");

  app.addHook("onSend", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "/";
    if (path.startsWith("/api/") || path === "/healthz" || path === "/readyz") return;
    reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    const registrationAvatar = /^\/bot-avatars\/v[0-9]+\//.test(path);
    /*
     * Feishu's app-creation page loads these presets with `crossOrigin="anonymous"`, crops them on a
     * canvas and re-encodes them before creating the App. A preset it cannot read cross-origin is
     * dropped in favour of Feishu's own default avatar, which is what made the picker look untouched.
     * The request carries no credentials, so the wildcard is the entire allowance: no origin echo and
     * no preflight.
     */
    if (registrationAvatar) reply.header("access-control-allow-origin", "*");
    reply.header(
      "cache-control",
      path.startsWith("/assets/") || registrationAvatar ? "public, max-age=31536000, immutable" : "no-store",
    );
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
