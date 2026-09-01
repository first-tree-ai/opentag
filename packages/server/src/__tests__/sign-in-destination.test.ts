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
      "/onboarding",
      "/login",
      "/agents?tab=runtime",
    ];
    for (const next of allowed) {
      expect(validateOAuthNext(next), next).toBe(next);
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
      `/agents${"?".repeat(1025)}`,
    ];
    for (const next of rejected) {
      expect(() => validateOAuthNext(next), next).toThrow(
        expect.objectContaining({ code: "AUTH_OAUTH_FAILED", statusCode: 400 }),
      );
    }
  });
});
