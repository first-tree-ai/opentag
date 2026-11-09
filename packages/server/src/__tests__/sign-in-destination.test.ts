import { MCP_OAUTH_HANDOFF_PATH } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { validateOAuthNext } from "../services/auth/index.js";

/*
 * Better Auth's `trustedOrigins` decides which origins may receive a callback. It does not decide which paths within
 * this one a `next` parameter may name, so this allowlist stays in front of every sign-in route — it is the only thing
 * between a sign-in link and an open redirect.
 */
describe("sign-in destinations", () => {
  it("allows the pages a sign-in may land on", () => {
    expect(validateOAuthNext()).toBe("/agents");
    const allowed = [
      "/agents",
      "/agents/example/runtime",
      "/settings",
      "/settings/profile",
      "/agents/setup",
      "/login",
      "/agents?tab=runtime",
    ];
    for (const next of allowed) {
      expect(validateOAuthNext(next), next).toBe(next);
    }
  });

  it("allows the MCP OAuth handoff, so an Agent's link survives a sign-in round trip", () => {
    /*
     * An Agent hands the handoff URL to a human who may not be signed in yet. The route sends them to
     * `/login?next=<handoff>` and this allowlist has to accept it, or the flow could never be completed.
     * Pinned to the exported path so the route and the allowlist cannot drift apart.
     */
    const next = `${MCP_OAUTH_HANDOFF_PATH}?token=sealed-token`;
    expect(validateOAuthNext(next)).toBe(next);
    expect(validateOAuthNext(MCP_OAUTH_HANDOFF_PATH)).toBe(MCP_OAUTH_HANDOFF_PATH);
    // Still one origin: the handoff entry is a path, not a prefix a sibling route can hide behind.
    for (const rejected of [`${MCP_OAUTH_HANDOFF_PATH}/../admin`, `${MCP_OAUTH_HANDOFF_PATH}#x`]) {
      expect(() => validateOAuthNext(rejected), rejected).toThrow();
    }
  });

  it("rejects destinations that leave this origin or name a page sign-in may not reach", () => {
    const rejected = [
      "https://evil.example",
      "//evil.example",
      "/agents\\evil",
      "/agents#fragment",
      "/admin",
      "agents",
      `/invites/${"A".repeat(43)}`,
      `/agents${"?".repeat(5000)}`,
    ];
    for (const next of rejected) {
      expect(() => validateOAuthNext(next), next).toThrow(
        expect.objectContaining({ code: "AUTH_OAUTH_FAILED", statusCode: 400 }),
      );
    }
  });
});
