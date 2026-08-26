import { isIP } from "node:net";
import { AuthProvidersResponseSchema, HTTP_PATHS } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
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

function browserAuthDestination(next: string): string {
  return next.startsWith("/invites/") ? "/agents" : next;
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
    if (!options.google) {
      throw new AuthServiceError("AUTH_PROVIDER_DISABLED", "deterministic", "Google sign-in is not configured", 404);
    }
    const { next } = parseRequest(StartQuerySchema, request.query);
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
    return reply.redirect(browserAuthDestination(result.next), 302);
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
    clearBrowserSessionCookies(reply, options.secureCookies);
    return reply.code(204).send();
  });
}
