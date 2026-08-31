import { isIP } from "node:net";
import {
  AuthProvidersResponseSchema,
  EmailSignInRequestSchema,
  EmailSignUpRequestSchema,
  ErrorCodeSchema,
  HTTP_PATHS,
} from "@opentag/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";
import { callBetterAuth, copyBetterAuthCookies } from "../auth/fastify-handler.js";
import { DEV_SIGN_IN_PATH } from "../auth/internal-sign-in.js";
import {
  clearBrowserCsrfCookie,
  requireBrowserMutationSecurity,
  requireBrowserOrigin,
  setBrowserCsrfCookie,
} from "../services/auth/browser-cookies.js";
import { AuthServiceError } from "../services/auth/errors.js";
import { validateOAuthNext } from "../services/auth/index.js";
import { parseRequest } from "./request-validation.js";

const StartQuerySchema = z.object({ next: z.string().max(1024).optional() }).strict();

export interface BrowserAuthRoutesOptions {
  /** Better Auth owns every browser session; without it there is no way to sign in. */
  betterAuth?: { instance: OpenTagBetterAuth; publicUrl: string };
  /**
   * Whether the loopback-only development sign-in is configured.
   *
   * Which Account it signs in is fixed inside the Better Auth instance, so this route decides only whether a request
   * may ask for it at all.
   */
  devSignIn?: boolean;
  googleSignIn?: boolean;
  /** Whether an address and password may register an Account and sign one in. */
  passwordSignIn?: boolean;
  publicOrigin: string;
  secureCookies: boolean;
  /** Bounds the double-submit token, so it lasts exactly as long as the session it accompanies. */
  sessionTtlSeconds: number;
  /**
   * Shared attempt budget. Clustered deployments must provide a shared limiter implementation at the gateway. When
   * `OPENTAG_ENV=prod`, the process-local fallback is rejected unless `OPENTAG_BROWSER_AUTH_SINGLE_PROCESS=true` is
   * set as an explicit deployment assertion.
   */
  rateLimiter?: BrowserAuthRateLimiter;
}

export interface BrowserAuthRateLimiter {
  check(key: string): void;
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

/**
 * A per-process attempt budget, and only that.
 *
 * What it is for is making a single server unattractive to hammer, and keeping one caller from spending another's
 * budget within a window. What it is **not** is a deployment-wide guarantee: every replica keeps its own counters and a
 * restart clears them, so an attacker with more than one route to the fleet gets more than one budget. Bounding
 * password guessing across a deployment needs a shared store or a gateway in front, and this class should not be read
 * as standing in for either.
 *
 * Entry count is capped because some keys are attacker-chosen. A key space the caller controls — an email address, for
 * one — is unbounded, so an unbounded map would be a way to spend the server's memory rather than merely its patience.
 * Expired entries are dropped first, and the oldest survivors after that; evicting a live counter can only ever grant
 * attempts, never deny them, so the cap costs enforcement rather than availability.
 */
export class RouteRateLimiter {
  readonly #entries = new Map<string, { count: number; resetAt: number }>();
  constructor(
    readonly limit = 20,
    readonly windowMs = 5 * 60 * 1000,
    readonly maxEntries = 10_000,
  ) {}

  check(key: string): void {
    const now = Date.now();
    const current = this.#entries.get(key);
    if (!current || current.resetAt <= now) {
      // Re-inserted rather than mutated, so the insertion order Map preserves is also the eviction order below.
      this.#entries.delete(key);
      this.#evict(now);
      this.#entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    current.count += 1;
    if (current.count > this.limit) {
      throw new AuthServiceError("RATE_LIMITED", "rate_limit", "Too many browser sign-in attempts", 429);
    }
  }

  /** Exposed for the test that holds the bound; nothing in the routes reads it. */
  get size(): number {
    return this.#entries.size;
  }

  #evict(now: number): void {
    if (this.#entries.size < this.maxEntries) return;
    for (const [key, entry] of this.#entries) {
      if (entry.resetAt <= now) this.#entries.delete(key);
    }
    // Still full of live counters, so age decides: Map iterates in insertion order, and each entry is inserted once.
    while (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.#entries.delete(oldest.value);
    }
  }
}

const processRateLimiter = new RouteRateLimiter();

function assertRateLimiterBoundary(options: BrowserAuthRoutesOptions): void {
  if (options.rateLimiter) return;
  if (process.env.OPENTAG_ENV === "prod" && process.env.OPENTAG_BROWSER_AUTH_SINGLE_PROCESS !== "true") {
    throw new Error(
      "Browser authentication requires a shared rate limiter in production; set OPENTAG_BROWSER_AUTH_SINGLE_PROCESS=true only for a single-process deployment",
    );
  }
}

/**
 * Whether a Better Auth failure was a decision about the request or a failure to answer it at all.
 *
 * The distinction has to survive: a credential path that reports a database outage as "wrong password" tells the
 * person to retype a correct password, tells the browser not to retry, and hides the incident from whoever is meant to
 * notice it. Only a refusal the library actually made may be reported as one.
 */
function transientFailure(response: Response): AuthServiceError | undefined {
  if (response.status === 429) {
    return new AuthServiceError("RATE_LIMITED", "rate_limit", "Too many browser sign-in attempts", 429);
  }
  if (response.status >= 500) {
    /*
     * The library's own message is not forwarded. It is written for a developer reading a stack trace and can name
     * internals; that a sign-in could not be completed is the whole of what a caller needs.
     */
    return new AuthServiceError("SERVICE_UNAVAILABLE", "transient", "Sign-in is temporarily unavailable", 503);
  }
  return undefined;
}

/**
 * An OpenTag decision the library only carried, rather than one of its own.
 *
 * `onSessionCreating` raises `AUTH_USER_SUSPENDED` from inside Better Auth, and that answer should reach the caller
 * intact. Only codes that parse as OpenTag's own survive this: the library's vocabulary — `INVALID_EMAIL_OR_PASSWORD`
 * and the rest — does not, so nothing it decided leaks through here.
 */
function preservedDecision(body: unknown, status: number): AuthServiceError | undefined {
  const envelope = body as { code?: unknown; message?: unknown } | undefined;
  const code = ErrorCodeSchema.safeParse(envelope?.code);
  if (!code.success || typeof envelope?.message !== "string") return undefined;
  return new AuthServiceError(code.data, "deterministic", envelope.message, status);
}

/**
 * Restates a refused registration.
 *
 * Registration cannot hide that an address is taken and still tell the caller what to do about it, so the duplicate is
 * reported as the conflict it is — the one disclosure any self-serve registration without a verification step makes.
 * Everything else is a rejected request rather than a conflict: reporting them all as "already exists" would make
 * every other cause unreadable, and would tell someone registering a free address to go recover an Account that does
 * not exist.
 */
async function signUpFailure(response: Response): Promise<AuthServiceError> {
  const transient = transientFailure(response);
  if (transient) return transient;
  const body = await response.json().catch(() => undefined);
  const preserved = preservedDecision(body, response.status);
  if (preserved) return preserved;
  const code = (body as { code?: unknown } | undefined)?.code;
  const duplicate =
    response.status === 409 || (typeof code === "string" && code.toUpperCase().includes("ALREADY_EXISTS"));
  if (duplicate) {
    return new AuthServiceError(
      "AUTH_EMAIL_CONFLICT",
      "deterministic",
      "An Account already exists for that email address",
      409,
    );
  }
  return new AuthServiceError("VALIDATION_ERROR", "validation", "The registration was refused", 400);
}

/**
 * Restates a refused sign-in.
 *
 * One answer for an unknown address and a wrong password alike, because distinguishing them would turn this endpoint
 * into a way to ask which addresses hold Accounts. That uniformity covers the library's refusals only. A server that
 * could not answer says so, or the transient case is unreachable to both the browser and whoever operates it; and a
 * suspension is reported as itself, because reaching it took a password the caller already had.
 */
async function signInFailure(response: Response): Promise<AuthServiceError> {
  const transient = transientFailure(response);
  if (transient) return transient;
  const preserved = preservedDecision(await response.json().catch(() => undefined), response.status);
  return (
    preserved ??
    new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "The email address or password is incorrect", 401)
  );
}

export function registerBrowserAuthRoutes(app: FastifyInstance, options: BrowserAuthRoutesOptions): void {
  assertRateLimiterBoundary(options);
  const limiter = options.rateLimiter ?? processRateLimiter;

  /** Development sign-in is offered only to a loopback client reaching a loopback host, on a server configured for it. */
  const devSignInAvailable = (request: FastifyRequest): boolean =>
    Boolean(options.devSignIn) && isLoopbackAddress(request.ip) && isLoopbackAddress(request.hostname);

  app.get(HTTP_PATHS.authProviders, async (request, reply) => {
    const devAvailable = devSignInAvailable(request);
    return reply
      .header("Cache-Control", "no-store")
      .code(200)
      .send(
        AuthProvidersResponseSchema.parse({
          providers: [
            {
              id: "google",
              enabled: Boolean(options.googleSignIn),
              startUrl: options.googleSignIn ? HTTP_PATHS.authGoogleStart : null,
            },
            {
              id: "dev",
              enabled: devAvailable,
              startUrl: devAvailable ? HTTP_PATHS.authDevCallback : null,
            },
            // A form rather than a link, so there is no URL to start it from; the caller posts to the two email routes.
            {
              id: "password",
              enabled: Boolean(options.passwordSignIn),
              startUrl: null,
            },
          ],
        }),
      );
  });

  app.get(HTTP_PATHS.authDevCallback, async (request, reply) => {
    limiter.check(`${request.ip}:dev`);
    const betterAuth = options.betterAuth;
    if (!devSignInAvailable(request) || !betterAuth) {
      throw new AuthServiceError(
        "AUTH_PROVIDER_DISABLED",
        "deterministic",
        "Development sign-in is not available",
        404,
      );
    }
    const { next } = parseRequest(StartQuerySchema, request.query);
    const destination = validateOAuthNext(next);
    /*
     * Better Auth mints the session so a development sign-in is the same revocable credential a Google sign-in is:
     * visible to `getSession`, and therefore actually ended by sign-out. Writing a session token into OpenTag's own
     * cookies instead would hide it from both.
     */
    const response = await callBetterAuth(betterAuth.instance, betterAuth.publicUrl, request, {
      method: "POST",
      path: DEV_SIGN_IN_PATH,
      body: {},
    });
    if (!response.ok) {
      // Better Auth's error body is not OpenTag's envelope, so the failure is restated rather than forwarded.
      throw new AuthServiceError(
        "AUTH_DEV_USER_UNAVAILABLE",
        "deterministic",
        "The configured development sign-in user is unavailable or ambiguous",
        503,
      );
    }
    copyBetterAuthCookies(reply, response);
    // The session cookie alone cannot write: every browser mutation also carries OpenTag's double-submit token.
    setBrowserCsrfCookie(reply, {
      maxAgeSeconds: options.sessionTtlSeconds,
      secure: options.secureCookies,
    });
    return reply.header("Cache-Control", "no-store").redirect(destination, 302);
  });

  app.get(HTTP_PATHS.authGoogleStart, async (request, reply) => {
    limiter.check(`${request.ip}:start`);
    const betterAuth = options.betterAuth;
    if (!options.googleSignIn || !betterAuth) {
      throw new AuthServiceError("AUTH_PROVIDER_DISABLED", "deterministic", "Google sign-in is not configured", 404);
    }
    const { next } = parseRequest(StartQuerySchema, request.query);
    const destination = validateOAuthNext(next);
    /*
     * Better Auth expects the client to POST for a URL and navigate itself. The login page is a plain link, so this
     * route does the POST server-side and redirects — which also keeps the provider's state and PKCE cookies on the
     * response, and keeps `validateOAuthNext` as the single gate on where sign-in may land.
     */
    const response = await callBetterAuth(betterAuth.instance, betterAuth.publicUrl, request, {
      method: "POST",
      path: "/sign-in/social",
      body: { callbackURL: destination, provider: "google" },
    });
    const payload = (await response.json().catch(() => undefined)) as { url?: string } | undefined;
    if (!response.ok || !payload?.url) {
      throw new AuthServiceError("AUTH_PROVIDER_DISABLED", "deterministic", "Google sign-in is not configured", 404);
    }
    copyBetterAuthCookies(reply, response);
    return reply.header("Cache-Control", "no-store").redirect(payload.url, 302);
  });

  /**
   * Signs a request in and hands the browser both halves of what it needs to act.
   *
   * Better Auth issues the session cookie; the double-submit token is OpenTag's and is minted here, because every
   * later mutation requires it and a browser that arrived with none would otherwise be able to read and nothing else.
   */
  const establishBrowserSession = (reply: Parameters<typeof setBrowserCsrfCookie>[0], response: Response): void => {
    copyBetterAuthCookies(reply, response);
    setBrowserCsrfCookie(reply, {
      maxAgeSeconds: options.sessionTtlSeconds,
      secure: options.secureCookies,
    });
  };

  const requirePasswordAuth = (): NonNullable<BrowserAuthRoutesOptions["betterAuth"]> => {
    if (!options.passwordSignIn || !options.betterAuth) {
      throw new AuthServiceError(
        "AUTH_PROVIDER_DISABLED",
        "deterministic",
        "Email and password sign-in is not enabled",
        404,
      );
    }
    return options.betterAuth;
  };

  app.post(HTTP_PATHS.authEmailSignUp, async (request, reply) => {
    const betterAuth = requirePasswordAuth();
    requireBrowserOrigin(request, options.publicOrigin);
    limiter.check(`${request.ip}:sign-up`);
    const body = parseRequest(EmailSignUpRequestSchema, request.body);
    const response = await callBetterAuth(betterAuth.instance, betterAuth.publicUrl, request, {
      method: "POST",
      path: "/sign-up/email",
      // `name` is Better Auth's field for what OpenTag stores as `displayName`; the instance maps it to that column.
      body: { email: body.email, name: body.displayName, password: body.password },
    });
    if (!response.ok) {
      throw await signUpFailure(response);
    }
    establishBrowserSession(reply, response);
    return reply.header("Cache-Control", "no-store").code(204).send();
  });

  app.post(HTTP_PATHS.authEmailSignIn, async (request, reply) => {
    const betterAuth = requirePasswordAuth();
    requireBrowserOrigin(request, options.publicOrigin);
    limiter.check(`${request.ip}:sign-in`);
    const body = parseRequest(EmailSignInRequestSchema, request.body);
    /*
     * Also bounded per address, so guessing one Account's password cannot be spread across many source addresses.
     * The cost is that an attacker can spend a victim's budget and lock them out for the window; against unbounded
     * distributed guessing at a single known address, that is the better failure.
     */
    limiter.check(`sign-in:${body.email}`);
    const response = await callBetterAuth(betterAuth.instance, betterAuth.publicUrl, request, {
      method: "POST",
      path: "/sign-in/email",
      body: { email: body.email, password: body.password },
    });
    if (!response.ok) {
      throw await signInFailure(response);
    }
    establishBrowserSession(reply, response);
    return reply.header("Cache-Control", "no-store").code(204).send();
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
    // The double-submit token is OpenTag's, not Better Auth's, so signing out has to retire it here.
    clearBrowserCsrfCookie(reply, options.secureCookies);
    return reply.header("Cache-Control", "no-store").code(204).send();
  });
}
