import { describe, expect, it } from "vitest";
import { MCP_OAUTH_HANDOFF_PATH } from "../http-paths.js";
import {
  DEFAULT_SIGN_IN_DESTINATION,
  resolveSignInDestination,
  SIGN_IN_DESTINATION_MAX_LENGTH,
} from "../sign-in-destination.js";

/**
 * A destination of the shape the server actually mints for an MCP OAuth handoff.
 *
 * The real token is the base64url of a sealed envelope, so it is long and URL-safe; this is the same
 * shape at the length a measured production URL reached, which is what the old 1024-character bound
 * refused.
 */
function handoffDestination(payloadLength: number): string {
  const token = Array.from(
    { length: payloadLength },
    (_, index) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[index % 64],
  ).join("");
  return `${MCP_OAUTH_HANDOFF_PATH}?token=${token}`;
}

describe("sign-in destination", () => {
  it("defaults when a caller asked for nowhere in particular", () => {
    expect(resolveSignInDestination()).toBe(DEFAULT_SIGN_IN_DESTINATION);
    expect(resolveSignInDestination(undefined)).toBe(DEFAULT_SIGN_IN_DESTINATION);
  });

  it("allows the areas a sign-in is meant to arrive at", () => {
    for (const destination of [
      "/agents",
      "/agents/1a63a21e-f6c7-4474-91ea-4dabf0566a24",
      "/agents?tab=all",
      "/settings",
      "/settings/profile",
      "/account",
      "/account?from=checkout",
      "/usage",
      "/usage?windowDays=7",
      "/agents/setup",
      "/login",
    ]) {
      expect(resolveSignInDestination(destination)).toBe(destination);
    }
  });

  it("refuses every way of naming somewhere else", () => {
    for (const destination of [
      // Absolute and scheme-relative targets leave the origin entirely.
      "https://evil.example",
      "http://evil.example/agents",
      "//evil.example",
      "//evil.example/agents",
      // A backslash is a path separator to some parsers and not others, so the two disagree about where this goes.
      "/\\evil.example",
      "\\\\evil.example",
      "/agents\\..\\settings",
      // A fragment changes which document the browser ends up showing.
      "/agents#/../evil",
      // Control characters truncate whatever reads the value next, so the two readers disagree about the target.
      "/agents\n/evil",
      "/agents\r\nLocation: https://evil.example",
      "/agents\u0000",
      "/agents\u007f",
      // A trailing space is not part of any allowed path, and trimming it would accept a value nobody wrote.
      "/agents ",
      // Local, but not somewhere a sign-in lands.
      "/",
      "/internal",
      "/api/v1/me",
      "/accounting",
      "/account/other",
      "/usage/other",
      "agents",
      "",
    ]) {
      expect(resolveSignInDestination(destination)).toBeUndefined();
    }
  });

  it("keeps a real generated handoff destination that is longer than a page path", () => {
    /*
     * A real handoff URL measured past 1200 characters. At the previous 1024-character bound this was
     * refused, so a visitor who signed in on the way was dropped on `/agents` and the OAuth flow could
     * never finish — the whole point of putting the handoff on the allowlist.
     */
    for (const length of [1000, 1200, 1216, 2000]) {
      const destination = handoffDestination(length);
      expect(destination.length).toBeGreaterThan(1024);
      expect(resolveSignInDestination(destination), String(length)).toBe(destination);
    }
  });

  it("refuses a destination longer than the bound", () => {
    // The bound is a bound, not a suggestion: one character past it is refused.
    const base = MCP_OAUTH_HANDOFF_PATH;
    const atLimit = `${base}?token=${"a".repeat(SIGN_IN_DESTINATION_MAX_LENGTH - base.length - "?token=".length)}`;
    expect(atLimit).toHaveLength(SIGN_IN_DESTINATION_MAX_LENGTH);
    expect(resolveSignInDestination(atLimit)).toBe(atLimit);
    expect(resolveSignInDestination(`${atLimit}a`)).toBeUndefined();
    expect(resolveSignInDestination(`/agents?q=${"a".repeat(SIGN_IN_DESTINATION_MAX_LENGTH)}`)).toBeUndefined();
  });
});
