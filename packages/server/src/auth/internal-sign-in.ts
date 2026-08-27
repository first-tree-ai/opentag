import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { AuthServiceError } from "../services/auth/errors.js";

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

/**
 * Exchanges a credential the previous revision issued for the session that replaces it.
 *
 * This is not a way to sign in without one: the caller must present a refresh token that still verifies, and
 * `resolveUserId` is what decides whether it does. It exists so a browser that has not signed in since the cutover
 * moves across on its next refresh rather than being asked to sign in again.
 */
export function legacyUpgradePlugin(resolveUserId: (refreshToken: string) => Promise<string>): BetterAuthPlugin {
  return {
    id: "opentag-legacy-upgrade",
    endpoints: {
      opentagLegacyUpgrade: createAuthEndpoint(
        LEGACY_UPGRADE_PATH,
        { body: LegacyUpgradeBodySchema, method: "POST" },
        async (ctx) => {
          const userId = await resolve(resolveUserId(ctx.body.refreshToken));
          await establishSession(ctx, userId);
          return ctx.json({ userId });
        },
      ),
    },
  };
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
function resolve(userId: Promise<string>): Promise<string> {
  return userId.catch((cause: unknown) => {
    if (!(cause instanceof AuthServiceError)) throw cause;
    const status = API_STATUSES[cause.statusCode as keyof typeof API_STATUSES] ?? "INTERNAL_SERVER_ERROR";
    throw new APIError(status, { code: cause.code, message: cause.message });
  });
}

/** Issues the session and the cookie Better Auth itself reads, so sign-out can end what this established. */
async function establishSession(ctx: Parameters<typeof setSessionCookie>[0], userId: string): Promise<void> {
  const user = await ctx.context.internalAdapter.findUserById(userId);
  if (!user) {
    throw new APIError("UNAUTHORIZED", { code: "AUTH_INVALID_TOKEN", message: "The Account no longer exists" });
  }
  // Runs the same `session.create` hook every other sign-in does, so a suspended Account is refused here too.
  const session = await ctx.context.internalAdapter.createSession(userId);
  if (!session) {
    throw new APIError("INTERNAL_SERVER_ERROR", { message: "A session could not be issued" });
  }
  await setSessionCookie(ctx, { session, user });
}
