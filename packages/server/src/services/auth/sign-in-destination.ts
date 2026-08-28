import { AuthServiceError } from "./errors.js";

/**
 * The only places a sign-in may land.
 *
 * Better Auth's `trustedOrigins` decides which origins may receive a callback; it does not decide which paths within
 * this one a caller may send a browser to. This is the allowlist that does, so a `next` parameter cannot be turned into
 * an open redirect, and it stays in front of every sign-in route rather than being delegated to the library.
 */
export function validateOAuthNext(value?: string): string {
  const next = value ?? "/agents";
  if (
    next.length > 1024 ||
    next.includes("\\") ||
    next.includes("#") ||
    next.startsWith("//") ||
    Array.from(next).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new AuthServiceError("AUTH_OAUTH_FAILED", "validation", "The sign-in destination is invalid", 400);
  }
  if (/^\/(?:agents(?:\/[^?#]*)?|settings(?:\/[^?#]*)?|onboarding|login)(?:\?[^#]*)?$/.test(next)) {
    return next;
  }
  throw new AuthServiceError("AUTH_OAUTH_FAILED", "validation", "The sign-in destination is invalid", 400);
}
