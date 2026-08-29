/** Where a sign-in lands when it was not asked to land anywhere in particular. */
export const DEFAULT_SIGN_IN_DESTINATION = "/agents";

/**
 * The single contract for where any sign-in may land.
 *
 * It lives here rather than on the server because the password form navigates the browser itself, while the redirect
 * providers hand their destination to the server. Two implementations of "is this a local path" would eventually
 * disagree, and the half that was more permissive would be the one an attacker used.
 *
 * Returns the destination, or `undefined` when it is not an allowed local path — the caller decides whether that is a
 * rejected request or a silent fall back to {@link DEFAULT_SIGN_IN_DESTINATION}.
 */
export function resolveSignInDestination(value?: string): string | undefined {
  const next = value ?? DEFAULT_SIGN_IN_DESTINATION;
  /*
   * Refused before the shape is even considered. A backslash is a path separator to some parsers and not others, `//`
   * and `#` change which origin or document the browser ends up at, and a control character can truncate whatever
   * reads the value afterwards.
   */
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
    return undefined;
  }
  // An allowlist rather than a "starts with /" test: only these areas are somewhere a sign-in is meant to arrive at.
  if (/^\/(?:agents(?:\/[^?#]*)?|settings(?:\/[^?#]*)?|onboarding|login)(?:\?[^#]*)?$/.test(next)) {
    return next;
  }
  return undefined;
}
