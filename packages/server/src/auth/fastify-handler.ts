import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import { appendSetCookies } from "../services/auth/browser-cookies.js";
import { BETTER_AUTH_BASE_PATH, type OpenTagBetterAuth } from "./better-auth.js";

/**
 * Mounts Better Auth's catch-all handler.
 *
 * Two details are load-bearing:
 *
 * - The route lives in its own encapsulated Fastify scope with a passthrough body parser. Better Auth signs and parses
 *   the raw payload itself, so re-serializing a JSON-parsed body would change bytes it depends on, and doing this in
 *   the root scope would replace the parser every other route relies on.
 * - `set-cookie` is forwarded through `Headers.getSetCookie()`. Iterating the `Headers` object folds multiple
 *   `set-cookie` values into one comma-joined string, which browsers reject, silently breaking every session cookie.
 *
 * Static sibling routes such as `/api/v1/auth/refresh` keep working: Fastify matches a static segment ahead of the
 * wildcard.
 */
export function registerBetterAuthRoutes(app: FastifyInstance, auth: OpenTagBetterAuth, publicUrl: string): void {
  app.register(async (authApp) => {
    authApp.removeAllContentTypeParsers();
    authApp.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });

    authApp.route({
      method: ["GET", "POST"],
      url: `${BETTER_AUTH_BASE_PATH}/*`,
      handler: async (request, reply) => {
        // Built from the configured public URL rather than the Host header so a spoofed Host cannot move the origin
        // Better Auth validates against.
        const url = new URL(request.url, publicUrl);
        const body = request.body;
        const response = await auth.handler(
          new Request(url, {
            method: request.method,
            headers: fromNodeHeaders(request.headers),
            ...(Buffer.isBuffer(body) && body.length > 0 ? { body } : {}),
          }),
        );

        reply.status(response.status);
        for (const [key, value] of response.headers) {
          if (key.toLowerCase() === "set-cookie") continue;
          reply.header(key, value);
        }
        const setCookies = response.headers.getSetCookie();
        if (setCookies.length > 0) appendSetCookies(reply, setCookies);

        if (!response.body) return reply.send(null);
        return reply.send(Buffer.from(await response.arrayBuffer()));
      },
    });
  });
}
