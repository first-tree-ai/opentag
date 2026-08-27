import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { AuthServiceError } from "../services/auth/errors.js";
import { hashSecret } from "../services/auth/security.js";

/**
 * Paths below the Better Auth base path, both deliberately absent from the published route allowlist.
 *
 * Nothing routes to them from outside. Their only callers are OpenTag routes that have already decided the request may
 * have a session, and reach them server-side.
 */
export const DEV_SIGN_IN_PATH = "/dev/sign-in";
export const LEGACY_UPGRADE_PATH = "/legacy/upgrade";

/** Whatever an endpoint here can be told; the Account it acts on never comes from the caller. */
const LegacyUpgradeBodySchema = z.object({ refreshToken: z.string().min(1).max(4096) });

/**
 * Signs the one configured development Account in.
 *
 * It takes no input at all. The Account comes from `resolveUserId`, fixed at construction from configuration, so the
 * endpoint cannot be aimed at a different Account even by a caller that reaches it. Whether a request may sign in this
 * way is decided before this by the route's loopback fences; the plugin itself is only registered when development
 * sign-in is configured, which `parseServerConfig` already restricts to a loopback `OPENTAG_ENV=dev` server.
 */
export function devSignInPlugin(resolveUserId: () => Promise<string>): BetterAuthPlugin {
  return {
    id: "opentag-dev-sign-in",
    endpoints: {
      opentagDevSignIn: createAuthEndpoint(DEV_SIGN_IN_PATH, { method: "POST" }, async (ctx) => {
        const userId = await resolve(resolveUserId());
        await establishSession(ctx, userId);
        return ctx.json({ userId });
      }),
    },
  };
}

/** What a presented legacy credential resolves to, once it has been verified. */
export interface LegacyCredential {
  /** When the presented credential itself expires, which bounds how long its exchange has to stay recorded. */
  expiresAt: Date;
  userId: string;
}

/**
 * Exchanges a credential the previous revision issued for the session that replaces it.
 *
 * This is not a way to sign in without one: the caller must present a refresh token that still verifies, and
 * `resolveCredential` is what decides whether it does. It exists so a browser that has not signed in since the cutover
 * moves across on its next refresh rather than being asked to sign in again.
 *
 * One legacy credential converges on one session, however many times it is presented. A stateless refresh token has
 * nothing to consume, so the exchange is recorded against the token itself and the first writer wins: a replay — or a
 * second tab whose request raced the first — is handed the session that already exists rather than minting another.
 * Without that, the loser's row would stay live and invisible to the browser that created it, surviving the sign-out
 * that was supposed to end it.
 */
export function legacyUpgradePlugin(options: LegacyUpgradeOptions): BetterAuthPlugin {
  return {
    id: "opentag-legacy-upgrade",
    endpoints: {
      opentagLegacyUpgrade: createAuthEndpoint(
        LEGACY_UPGRADE_PATH,
        { body: LegacyUpgradeBodySchema, method: "POST" },
        async (ctx) => {
          const refreshToken = ctx.body.refreshToken;
          const credential = await resolve(options.resolveCredential(refreshToken));
          const user = await requireUser(ctx, credential.userId);
          const exchange = `${LEGACY_EXCHANGE_PREFIX}${hashSecret(refreshToken)}`;

          const session = await options.serialize(exchange, async () => {
            const recorded = await ctx.context.internalAdapter.findVerificationValue(exchange);
            if (!recorded) {
              const created = await createSession(ctx, credential.userId);
              await ctx.context.internalAdapter.createVerificationValue({
                identifier: exchange,
                value: created.token,
                expiresAt: credential.expiresAt,
              });
              return created;
            }
            const existing = await ctx.context.internalAdapter.findSession(recorded.value);
            if (!existing) {
              // The credential is spent and the session it produced is already gone; there is nothing to hand back.
              throw new APIError("UNAUTHORIZED", {
                code: "AUTH_INVALID_TOKEN",
                message: "The refresh token has already been exchanged",
              });
            }
            return existing.session;
          });

          await setSessionCookie(ctx, { session, user });
          return ctx.json({ userId: credential.userId });
        },
      ),
    },
  };
}

export interface LegacyUpgradeOptions {
  resolveCredential: (refreshToken: string) => Promise<LegacyCredential>;
  /**
   * Runs the exchange with every other exchange of the same credential held off.
   *
   * Better Auth's own `reserveVerificationValue` would be the natural gate, but its first-writer-wins comes from
   * writing a derived primary key, and `auth_verifications.id` is a `uuid` column with a default — the derived id does
   * not survive the insert, so every caller reserves successfully. A lock keyed on the exchange is what actually
   * serializes it.
   */
  serialize: <T>(key: string, run: () => Promise<T>) => Promise<T>;
}

const LEGACY_EXCHANGE_PREFIX = "opentag-legacy-upgrade:";

/** The statuses OpenTag's authentication decisions produce, named as Better Auth's error constructor wants them. */
const API_STATUSES = {
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  409: "CONFLICT",
  429: "TOO_MANY_REQUESTS",
  503: "SERVICE_UNAVAILABLE",
} as const;

/**
 * Reports an answerable failure as one.
 *
 * An `AuthServiceError` is a decision — a rejected credential, a misconfigured address — and carries the status and
 * code the caller should see. Letting it escape would log it as an internal server error, burying it among real ones,
 * and would flatten every decision to the same 500. Anything else is unexpected and propagates untouched.
 */
function resolve<T>(resolved: Promise<T>): Promise<T> {
  return resolved.catch((cause: unknown) => {
    if (!(cause instanceof AuthServiceError)) throw cause;
    const status = API_STATUSES[cause.statusCode as keyof typeof API_STATUSES] ?? "INTERNAL_SERVER_ERROR";
    throw new APIError(status, { code: cause.code, message: cause.message });
  });
}

type EndpointContext = Parameters<typeof setSessionCookie>[0];

/** Issues the session and the cookie Better Auth itself reads, so sign-out can end what this established. */
async function establishSession(ctx: EndpointContext, userId: string): Promise<void> {
  const user = await requireUser(ctx, userId);
  await setSessionCookie(ctx, { session: await createSession(ctx, userId), user });
}

async function requireUser(ctx: EndpointContext, userId: string) {
  const user = await ctx.context.internalAdapter.findUserById(userId);
  if (!user) {
    throw new APIError("UNAUTHORIZED", { code: "AUTH_INVALID_TOKEN", message: "The Account no longer exists" });
  }
  return user;
}

/** Runs the same `session.create` hook every other sign-in does, so a suspended Account is refused here too. */
async function createSession(ctx: EndpointContext, userId: string) {
  const session = await ctx.context.internalAdapter.createSession(userId);
  if (!session) {
    throw new APIError("INTERNAL_SERVER_ERROR", { message: "A session could not be issued" });
  }
  return session;
}
