/** Where a sign-in lands when it was not asked to land anywhere in particular. */
export const DEFAULT_SIGN_IN_DESTINATION = "/agents";

/**
 * The longest destination a sign-in will carry.
 *
 * The bound exists so an unbounded query string can never become this module's problem, not to be
 * tight. It has to clear a real MCP OAuth handoff URL, which is minted by this deployment and is long
 * by construction: the sealed token alone carries the flow secret, the provider's authorize URL, the
 * hashed state, and the expiry, and a measured URL runs past 1200 characters. At 1024 the handoff
 * every Agent produces was refused, so an unauthenticated visitor was returned to `/agents` after
 * signing in and the flow could never be completed. 4096 keeps roughly three times the headroom while
 * still refusing anything a browser would not send.
 */
export const SIGN_IN_DESTINATION_MAX_LENGTH = 4096;

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
    next.length > SIGN_IN_DESTINATION_MAX_LENGTH ||
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
  /*
   * An allowlist rather than a "starts with /" test: only these areas are somewhere a sign-in is meant
   * to arrive at. `/api/v1/mcp-servers/oauth/handoff` (MCP_OAUTH_HANDOFF_PATH) is on it because an
   * Agent hands that link to a human who may not be signed in yet, and completing the round trip after
   * signing in is the point. The destination test pins it to the real path.
   */
  if (
    /^\/(?:agents(?:\/[^?#]*)?|settings(?:\/[^?#]*)?|account|usage|login|api\/v1\/mcp-servers\/oauth\/handoff)(?:\?[^#]*)?$/.test(
      next,
    )
  ) {
    return next;
  }
  return undefined;
}
