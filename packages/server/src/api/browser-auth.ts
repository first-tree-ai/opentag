import { isIP } from "node:net";
import { AuthProvidersResponseSchema, HTTP_PATHS } from "@opentag/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";
import { callBetterAuth, copyBetterAuthCookies } from "../auth/fastify-handler.js";
import {
  BROWSER_COOKIE_NAMES,
  clearBrowserSessionCookies,
  clearOAuthContextCookie,
  parseCookies,
  requireBrowserMutationSecurity,
  requireRefreshCookie,
  setBrowserSessionCookies,
  setOAuthContextCookie,
} from "../services/auth/browser-cookies.js";
import { AuthServiceError } from "../services/auth/errors.js";
import type { DevBrowserAuthService, GoogleBrowserAuthService, UserAuthService } from "../services/auth/index.js";
import { validateOAuthNext } from "../services/auth/index.js";
import { parseRequest } from "./request-validation.js";

const StartQuerySchema = z.object({ next: z.string().max(1024).optional() }).strict();
const CallbackQuerySchema = z
  .object({
    code: z.string().min(1).max(4096).optional(),
    error: z.string().min(1).max(256).optional(),
    error_description: z.string().max(1024).optional(),
    state: z.string().min(1).max(4096),
  })
  .superRefine((value, context) => {
    if ((value.code === undefined) === (value.error === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of code or error is required",
        path: ["code"],
      });
    }
  });

export interface BrowserAuthRoutesOptions {
  /** Present once Better Auth owns the browser session; the legacy paths stay for credentials it did not issue. */
  betterAuth?: { instance: OpenTagBetterAuth; publicUrl: string };
  dev?: DevBrowserAuthService;
  google?: GoogleBrowserAuthService;
  publicOrigin: string;
  refreshTokenTtlSeconds: number;
  secureCookies: boolean;
}

function isLoopbackAddress(value: string): boolean {
  const address =
    value
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%", 1)[0] ?? value;
  if (address === "localhost") return true;
  if (address === "::1") return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  const ipv4 = mapped ?? address;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

class RouteRateLimiter {
  readonly #entries = new Map<string, { count: number; resetAt: number }>();
  constructor(
    readonly limit = 20,
    readonly windowMs = 5 * 60 * 1000,
  ) {}

  check(key: string): void {
    const now = Date.now();
    const current = this.#entries.get(key);
    if (!current || current.resetAt <= now) {
      this.#entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    current.count += 1;
    if (current.count > this.limit) {
      throw new AuthServiceError("RATE_LIMITED", "rate_limit", "Too many browser sign-in attempts", 429);
    }
  }
}

export function registerBrowserAuthRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: BrowserAuthRoutesOptions,
): void {
  const limiter = new RouteRateLimiter();

  app.get(HTTP_PATHS.authProviders, async (request, reply) => {
    const devAvailable = Boolean(options.dev) && isLoopbackAddress(request.ip) && isLoopbackAddress(request.hostname);
    return reply.code(200).send(
      AuthProvidersResponseSchema.parse({
        providers: [
          {
            id: "google",
            enabled: Boolean(options.google),
            startUrl: options.google ? HTTP_PATHS.authGoogleStart : null,
          },
          {
            id: "dev",
            enabled: devAvailable,
            startUrl: devAvailable ? HTTP_PATHS.authDevCallback : null,
          },
        ],
      }),
    );
  });

  app.get(HTTP_PATHS.authDevCallback, async (request, reply) => {
    limiter.check(`${request.ip}:dev`);
    if (!options.dev || !isLoopbackAddress(request.ip) || !isLoopbackAddress(request.hostname)) {
      throw new AuthServiceError(
        "AUTH_PROVIDER_DISABLED",
        "deterministic",
        "Development sign-in is not available",
        404,
      );
    }
    const { next } = parseRequest(StartQuerySchema, request.query);
    const destination = validateOAuthNext(next);
    const tokens = await options.dev.signIn();
    setBrowserSessionCookies(reply, tokens, {
      refreshTtlSeconds: options.refreshTokenTtlSeconds,
      secure: options.secureCookies,
    });
    return reply.redirect(destination, 302);
  });

  app.get(HTTP_PATHS.authGoogleStart, async (request, reply) => {
    limiter.check(`${request.ip}:start`);
    const { next } = parseRequest(StartQuerySchema, request.query);
    const destination = validateOAuthNext(next);

    if (options.betterAuth) {
      /*
       * Better Auth expects the client to POST for a URL and navigate itself. The login page is a plain link, so this
       * route does the POST server-side and redirects — which also keeps the provider's state and PKCE cookies on the
       * response, and keeps `validateOAuthNext` as the single gate on where sign-in may land.
       */
      const response = await callBetterAuth(options.betterAuth.instance, options.betterAuth.publicUrl, request, {
        method: "POST",
        path: "/sign-in/social",
        body: { callbackURL: destination, provider: "google" },
      });
      const payload = (await response.json().catch(() => undefined)) as { url?: string } | undefined;
      if (!response.ok || !payload?.url) {
        throw new AuthServiceError("AUTH_PROVIDER_DISABLED", "deterministic", "Google sign-in is not configured", 404);
      }
      copyBetterAuthCookies(reply, response);
      return reply.redirect(payload.url, 302);
    }

    if (!options.google) {
      throw new AuthServiceError("AUTH_PROVIDER_DISABLED", "deterministic", "Google sign-in is not configured", 404);
    }
    const result = await options.google.start(next);
    setOAuthContextCookie(reply, result.context, options.secureCookies);
    return reply.redirect(result.authorizationUrl, 302);
  });

  app.get(HTTP_PATHS.authGoogleCallback, async (request, reply) => {
    limiter.check(`${request.ip}:callback`);
    if (!options.google) {
      throw new AuthServiceError("AUTH_PROVIDER_DISABLED", "deterministic", "Google sign-in is not configured", 404);
    }
    const callback = parseRequest(CallbackQuerySchema, request.query);
    const context = parseCookies(request.headers.cookie)[BROWSER_COOKIE_NAMES.oauthContext];
    if (!context) {
      throw new AuthServiceError(
        "AUTH_OAUTH_FAILED",
        "credential",
        "The browser sign-in flow is invalid or expired",
        401,
      );
    }
    const result = await options.google.callback(
      {
        ...(callback.code !== undefined ? { code: callback.code } : {}),
        ...(callback.error !== undefined ? { error: callback.error } : {}),
        state: callback.state,
      },
      context,
      {
        onVerified: () => clearOAuthContextCookie(reply, options.secureCookies),
      },
    );
    setBrowserSessionCookies(reply, result.tokens, {
      refreshTtlSeconds: options.refreshTokenTtlSeconds,
      secure: options.secureCookies,
    });
    return reply.redirect(result.next, 302);
  });

  app.post(HTTP_PATHS.authBrowserRefresh, async (request, reply) => {
    requireBrowserMutationSecurity(request, options.publicOrigin);
    const tokens = await authService.refresh(requireRefreshCookie(request));
    setBrowserSessionCookies(reply, tokens, {
      refreshTtlSeconds: options.refreshTokenTtlSeconds,
      secure: options.secureCookies,
    });
    return reply.code(204).send();
  });

  app.post(HTTP_PATHS.authBrowserLogout, async (request, reply) => {
    requireBrowserMutationSecurity(request, options.publicOrigin);
    if (options.betterAuth) {
      const instance = options.betterAuth.instance;
      const session = await instance.api.getSession({ headers: fromNodeHeaders(request.headers) });
      const response = await callBetterAuth(instance, options.betterAuth.publicUrl, request, {
        method: "POST",
        path: "/sign-out",
        body: {},
      });
      /*
       * Better Auth's sign-out swallows a failed session delete and still reports success, so taking its word would
       * let this route promise revocation while quietly degrading to a cookie-only logout. Reading the row back is
       * what makes the promise checkable.
       *
       * Nothing is written to the reply until that read succeeds. Better Auth clears the cookie even when its delete
       * failed, and Fastify's error handler keeps headers already placed on the reply — propagating them before the
       * check would destroy the browser's only copy of a token whose session is still live, leaving nothing to retry
       * the revocation with and a stolen copy usable until expiry.
       */
      if (session) {
        const survivor = await (await instance.$context).internalAdapter.findSession(session.session.token);
        if (survivor) {
          throw new AuthServiceError("INTERNAL_ERROR", "transient", "Sign-out could not revoke the session", 500);
        }
      }
      copyBetterAuthCookies(reply, response);
    }
    // Cleared unconditionally: a browser mid-rollout can hold either credential, and signing out must end both.
    clearBrowserSessionCookies(reply, options.secureCookies);
    return reply.code(204).send();
  });
}
