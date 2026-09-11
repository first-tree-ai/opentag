import { BrowserSessionStatusResponseSchema, HTTP_PATHS } from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";

const WEBSITE_ORIGINS = new Set(["https://opentag.build", "https://www.opentag.build"]);

/** A cookie-only, identity-free read for the official website. Other deployments expose no such surface. */
export function registerWebsiteSessionRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: Pick<UserAuthPreHandlerOptions, "betterAuth" | "publicOrigin">,
): void {
  const { betterAuth, publicOrigin } = options;
  if (publicOrigin !== "https://app.opentag.build" || !betterAuth) return;

  const allowWebsite = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("Cache-Control", "no-store").header("Vary", "Origin");
    const origin = request.headers.origin;
    if (!origin || !WEBSITE_ORIGINS.has(origin)) {
      throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "Website origin is not allowed", 403);
    }
    reply.header("Access-Control-Allow-Origin", origin).header("Access-Control-Allow-Credentials", "true");
  };

  app.options(HTTP_PATHS.authBrowserSessionStatus, { onRequest: allowWebsite }, async (request, reply) => {
    if (
      request.headers["access-control-request-method"] !== "GET" ||
      request.headers["access-control-request-headers"]
    ) {
      throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "Only the website session read is allowed", 403);
    }
    return reply.header("Access-Control-Allow-Methods", "GET").code(204).send();
  });

  app.get(HTTP_PATHS.authBrowserSessionStatus, { onRequest: allowWebsite }, async (request, reply) => {
    // Forward only the browser cookie: a CLI bearer must not turn this into a separate authentication surface.
    const headers = new Headers();
    if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
    const session = await betterAuth.api.getSession({
      headers,
      // Visiting the website must not keep an otherwise idle app session alive or trust a stale cookie cache.
      query: { disableRefresh: true, disableCookieCache: true },
    });
    let authenticated = false;
    if (session) {
      try {
        await authService.getActiveUserById(session.user.id);
        authenticated = true;
      } catch (error) {
        if (
          !(error instanceof AuthServiceError) ||
          !["AUTH_INVALID_TOKEN", "AUTH_USER_SUSPENDED"].includes(error.code)
        ) {
          throw error;
        }
      }
    }
    return reply.send(BrowserSessionStatusResponseSchema.parse({ authenticated }));
  });
}
