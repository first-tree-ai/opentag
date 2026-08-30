import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";
import {
  appendSetCookies,
  BROWSER_COOKIE_NAMES,
  parseCookies,
  requireBrowserMutationSecurity,
  setBrowserCsrfCookie,
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
  /** Better Auth owns every Account session; without it nothing authenticates. */
  betterAuth?: OpenTagBetterAuth;
  publicOrigin?: string;
  secureCookies?: boolean;
  /** Present with `betterAuth`; the double-submit token is renewed on this schedule so it outlasts a rolling session. */
  sessionTtlSeconds?: number;
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
  const bearer = bearerToken(request);
  if (bearer) return (await authService.getAuthenticatedUser(bearer)).me.user.id;
  if (options.betterAuth) {
    const session = await options.betterAuth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    // Resolved live rather than trusted from the session, so an Account suspended after issuance is rejected here
    // instead of at whatever authority check happens to come after the caller's side effects.
    if (session) return (await authService.getActiveUserById(session.user.id)).user.id;
  }
  return undefined;
}

export function createUserAuthPreHandler(authService: UserAuthService, options: UserAuthPreHandlerOptions = {}) {
  return async function userAuthPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    /*
     * The transport is chosen before anything authenticates, and a presented bearer authenticates as a bearer or not
     * at all. Better Auth reads both the header and the cookie, and on an invalid bearer it succeeds from the cookie —
     * so deciding afterwards, from the header merely being present, would let a caller holding only the HttpOnly
     * session cookie attach a junk `Authorization` header and have the request treated as the CLI's: no origin check,
     * no double-submit token, mutations allowed.
     */
    const bearer = bearerToken(request);
    if (bearer) {
      request.authContext = await authService.getAuthenticatedUser(bearer);
      return;
    }

    /*
     * A cookie request is a browser request, so a mutation additionally proves it came from this origin — checked only
     * once a credential has been presented, so a request with none still reads as unauthenticated rather than
     * forbidden.
     */
    const requireBrowserOrigin = () => {
      if (!options.publicOrigin) throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");
      if (!SAFE_METHODS.has(request.method)) requireBrowserMutationSecurity(request, options.publicOrigin);
    };

    /*
     * Asked for its headers, not just its answer: Better Auth extends a session as it is used and reports the
     * refreshed cookie this way. Taking the result alone would let the row keep moving while the browser's cookie
     * expired on its original schedule — an active user signed out, with the renewed row left behind.
     */
    const resolved = await options.betterAuth?.api.getSession({
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    if (!resolved?.response) throw invalidCredential("AUTH_INVALID_TOKEN", "Authentication is required");

    requireBrowserOrigin();
    const renewed = resolved.headers.getSetCookie();
    if (renewed.length > 0) appendSetCookies(reply, renewed);
    renewBrowserCsrfCookie(request, reply, options);
    /*
     * What the session carries is only an identity: the Account's active state is resolved live from the database on
     * every request, so suspension takes effect immediately.
     */
    request.authContext = {
      me: await authService.getActiveUserById(resolved.response.user.id),
      tokenExpiresAt: resolved.response.session.expiresAt,
    };
  };
}

/**
 * Extends the double-submit token alongside the session it accompanies.
 *
 * Better Auth renews a session as it is used, so a browser that keeps working keeps its session but would watch this
 * cookie expire on the schedule it was first issued on — leaving it authenticated and unable to mutate or sign out.
 * The value is re-sent unchanged, so a tab that already read it stays correct.
 */
function renewBrowserCsrfCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  options: UserAuthPreHandlerOptions,
): void {
  if (options.sessionTtlSeconds === undefined) return;
  const current = parseCookies(request.headers.cookie)[BROWSER_COOKIE_NAMES.csrf];
  if (!current) return;
  setBrowserCsrfCookie(reply, {
    maxAgeSeconds: options.sessionTtlSeconds,
    secure: options.secureCookies ?? true,
    value: current,
  });
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
}
