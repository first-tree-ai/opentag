import { decodeJwt, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { OAuthFlowService, validateOAuthNext } from "../services/auth/index.js";

const secret = "oauth-state-secret-that-is-at-least-32-characters";
const now = new Date("2026-08-19T00:00:00.000Z");

describe("OAuthFlowService", () => {
  it("binds state to a signed context without a retired invitation intent", async () => {
    const service = new OAuthFlowService(secret, { now: () => now });
    const started = await service.start("/agents");
    expect(decodeJwt(started.state)).not.toHaveProperty("intent");
    expect(await service.verify(started.state, started.context)).toMatchObject({ next: "/agents" });
    expect(() => validateOAuthNext(`/invites/${"A".repeat(43)}`)).toThrow();
  });

  it("rejects flow substitution, expiry, and unsafe redirect destinations", async () => {
    const service = new OAuthFlowService(secret, { now: () => now, ttlSeconds: 60 });
    const first = await service.start("/agents/example/runtime");
    const second = await service.start("/agents");
    await expect(service.verify(first.state, second.context)).rejects.toMatchObject({ code: "AUTH_OAUTH_FAILED" });
    expect(() => validateOAuthNext("https://evil.example")).toThrow();
    expect(() => validateOAuthNext("//evil.example")).toThrow();
    expect(() => validateOAuthNext("/agents\\evil")).toThrow();
    expect(() => validateOAuthNext("/admin")).toThrow();
  });

  it("redirects retired Workspace creation starts and pre-deployment callbacks to the landing page", async () => {
    const service = new OAuthFlowService(secret, { now: () => now });
    const started = await service.start("/workspaces/new");
    const flowNonce = "legacy-flow-nonce";
    const issuedAt = Math.floor(now.getTime() / 1000);
    const sign = (payload: Record<string, string>, audience: string) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("opentag")
        .setAudience(audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 600)
        .sign(new TextEncoder().encode(secret));
    const [legacyState, legacyContext] = await Promise.all([
      sign({ flowNonce, provider: "google", intent: "login" }, "opentag-oauth-state"),
      sign(
        { flowNonce, next: "/workspaces/new", oidcNonce: "legacy-oidc-nonce", provider: "google" },
        "opentag-oauth-context",
      ),
    ]);

    expect(started.next).toBe("/agents");
    expect(await service.verify(started.state, started.context)).toMatchObject({ next: "/agents" });
    expect(await service.verify(legacyState, legacyContext)).toEqual({
      next: "/agents",
      oidcNonce: "legacy-oidc-nonce",
    });
    expect(validateOAuthNext("/workspaces/new?legacy=1")).toBe("/agents");
  });
});
