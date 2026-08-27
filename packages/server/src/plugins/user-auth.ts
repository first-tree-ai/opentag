import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";
import {
  BROWSER_COOKIE_NAMES,
  parseCookies,
  requireBrowserMutationSecurity,
} from "../services/auth/browser-cookies.js";
import { invalidCredential } from "../services/auth/errors.js";
import type { AuthenticatedUser, UserAuthService } from "../services/auth/index.js";

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthenticatedUser;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface UserAuthPreHandlerOptions {
  /** Present once Better Auth issues sessions; credentials it did not issue still resolve through the legacy path. */
  betterAuth?: OpenTagBetterAuth;
  publicOrigin?: string;
}

/**
 * Resolves who a request is, across every credential this server accepts, or `undefined` when it carries none.
 *
 * Routes that authenticate outside the preHandler need the same answer it would give — otherwise a browser holding
 * one kind of credential works everywhere except there.
 */
export async function resolveAuthenticatedUserId(
  request: FastifyRequest,
  authService: UserAuthService,
  options: UserAuthPreHandlerOptions = {},
): Promise<string | undefined> {
  if (options.betterAuth) {
    const session = await options.betterAuth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    // Resolved live rather than trusted from the session, so an Account suspended after issuance is rejected here
    // instead of at whatever authority check happens to come after the caller's side effects.
    if (session) return (await authService.getActiveUserById(session.user.id)).user.id;
  }
  const authorization = request.headers.authorization;
  const legacyToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : parseCookies(request.headers.cookie)[BROWSER_COOKIE_NAMES.access];
  if (!legacyToken) return undefined;
  const authenticated = await authService.getAuthenticatedUser(legacyToken);
  return authenticated.me.user.id;
}

export function createUserAuthPreHandler(authService: UserAuthService, options: UserAuthPreHandlerOptions = {}) {
  return async function userAuthPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;

    /*
     * A bearer credential carries its own proof and is used by the CLI, which has no origin to present. Cookie
     * requests are browser requests, so a mutation has to additionally prove it came from this origin — but only once
     * a credential has actually been presented, so a request with none still reads as unauthenticated rather than
     * forbidden.
     */
    const requireBrowserOrigin = () => {
      if (!options.publicOrigin) throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");
      if (!SAFE_METHODS.has(request.method)) requireBrowserMutationSecurity(request, options.publicOrigin);
    };

    /*
     * Better Auth reads both its session cookie and the bearer header, so one call covers every credential it issued.
     * What comes back is only an identity: suspension and Workspace grants are still resolved live from the database
     * on every request, exactly as the legacy path does, so revoking either takes effect immediately.
     */
    if (options.betterAuth) {
      const session = await options.betterAuth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (session) {
        if (!bearer) requireBrowserOrigin();
        request.authContext = {
          me: await authService.getActiveUserById(session.user.id),
          tokenExpiresAt: session.session.expiresAt,
        };
        return;
      }
    }

    // Credentials issued before the cutover, still valid until they expire.
    if (bearer) {
      request.authContext = await authService.getAuthenticatedUser(bearer);
      return;
    }
    const accessCookie = parseCookies(request.headers.cookie)[BROWSER_COOKIE_NAMES.access];
    if (!accessCookie) throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");
    requireBrowserOrigin();
    request.authContext = await authService.getAuthenticatedUser(accessCookie);
  };
}
