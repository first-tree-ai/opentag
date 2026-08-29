import { resolveSignInDestination } from "@opentag/shared";
import { AuthServiceError } from "./errors.js";

/**
 * The only places a sign-in may land.
 *
 * Better Auth's `trustedOrigins` decides which origins may receive a callback; it does not decide which paths within
 * this one a caller may send a browser to. The allowlist that does lives in `@opentag/shared`, because the password
 * form navigates the browser itself and has to apply the same rule; this wrapper is the server's half, turning a
 * refused destination into the request failure a route reports.
 */
export function validateOAuthNext(value?: string): string {
  const destination = resolveSignInDestination(value);
  if (destination === undefined) {
    throw new AuthServiceError("AUTH_OAUTH_FAILED", "validation", "The sign-in destination is invalid", 400);
  }
  return destination;
}
