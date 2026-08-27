import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { AuthServiceError } from "../services/auth/errors.js";

/**
 * Path below the Better Auth base path, deliberately absent from the published route allowlist.
 *
 * Nothing routes to it from outside: the only caller is the loopback-guarded OpenTag development route, which reaches
 * it server-side.
 */
export const DEV_SIGN_IN_PATH = "/dev/sign-in";

/**
 * Signs the one configured development Account in, with the session cookie Better Auth itself understands.
 *
 * Development sign-in has to mint a credential without a provider, which only an endpoint holding Better Auth's own
 * request context can do — a session token written into some other cookie is invisible to `getSession`, and therefore
 * to sign-out, which would leave every development sign-in unrevocable for the life of the session.
 *
 * It takes no input. The Account comes from `resolveUserId`, which is fixed at construction from configuration, so the
 * endpoint cannot be aimed at a different Account even by a caller that reaches it. Whether the request may sign in at
 * all is decided before this by the route's loopback fences; the plugin itself is only registered when development
 * sign-in is configured, which `parseServerConfig` already restricts to a loopback `OPENTAG_ENV=dev` server.
 */
export function devSignInPlugin(resolveUserId: () => Promise<string>): BetterAuthPlugin {
  return {
    id: "opentag-dev-sign-in",
    endpoints: {
      opentagDevSignIn: createAuthEndpoint(DEV_SIGN_IN_PATH, { method: "POST" }, async (ctx) => {
        /*
         * A misconfigured development email is an answerable failure, not a crash: reported as one so it is not logged
         * as an internal server error, which would bury it among real ones. Anything else propagates and is logged.
         */
        const userId = await resolveUserId().catch((cause: unknown) => {
          if (!(cause instanceof AuthServiceError)) throw cause;
          throw new APIError("SERVICE_UNAVAILABLE", { code: cause.code, message: cause.message });
        });
        const user = await ctx.context.internalAdapter.findUserById(userId);
        if (!user) {
          throw new APIError("SERVICE_UNAVAILABLE", { message: "The development sign-in user no longer exists" });
        }
        // Runs the same `session.create` hook every other sign-in does, so a suspended Account is refused here too.
        const session = await ctx.context.internalAdapter.createSession(userId);
        if (!session) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "A session could not be issued" });
        }
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ userId });
      }),
    },
  };
}
