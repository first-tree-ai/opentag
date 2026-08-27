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
 * nothing to consume, so the exchange is recorded against the token itself in a single statement that returns the
 * winning session — the first writer's. A later caller withdraws the session it had just created and hands back the
 * winner's, so every response carries the same token and it does not matter which `Set-Cookie` the browser applies
 * last. Without that, a replay or two tabs racing a `401` would each leave a live row invisible to the browser holding
 * the cookie, surviving the sign-out meant to end it.
 *
 * The record is the gate, so nothing here takes a lock. An advisory lock would be held by one connection while every
 * waiter held another, and the holder still needs a connection of its own to do the work: a pool of ten stalls on ten
 * concurrent exchanges of the same credential.
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
          const session = await createSession(ctx, credential.userId);

          const winner = await options.recordExchange({
            expiresAt: credential.expiresAt,
            sessionToken: session.token,
            tokenHash: hashSecret(refreshToken),
          });
          if (winner === session.token) {
            await setSessionCookie(ctx, { session, user });
            return ctx.json({ userId: credential.userId });
          }

          /*
           * Another exchange of this credential got there first. Withdraw the session just created — it was handed to
           * nobody — and hand back theirs, so the credential still corresponds to exactly one revocable row.
           */
          await ctx.context.internalAdapter.deleteSession(session.token);
          const existing = await ctx.context.internalAdapter.findSession(winner);
          if (!existing) {
            // The credential is spent and the session it produced is already gone; there is nothing to hand back.
            throw new APIError("UNAUTHORIZED", {
              code: "AUTH_INVALID_TOKEN",
              message: "The refresh token has already been exchanged",
            });
          }
          await setSessionCookie(ctx, { session: existing.session, user });
          return ctx.json({ userId: credential.userId });
        },
      ),
    },
  };
}

/** One exchange of a legacy credential. */
export interface LegacyExchange {
  expiresAt: Date;
  sessionToken: string;
  tokenHash: string;
}

export interface LegacyUpgradeOptions {
  /**
   * Records this exchange and answers with the session token that won, which is this one only on a first exchange.
   *
   * It has to decide the winner in one statement. Better Auth's `reserveVerificationValue` looks like the primitive
   * for exactly this and is not: its first-writer-wins comes from writing a derived primary key, and
   * `auth_verifications.id` is a `uuid` column with a default, so the derived id does not survive the insert and every
   * caller reserves successfully.
   */
  recordExchange: (exchange: LegacyExchange) => Promise<string>;
  resolveCredential: (refreshToken: string) => Promise<LegacyCredential>;
}

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
