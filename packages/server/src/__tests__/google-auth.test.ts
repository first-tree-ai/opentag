import { describe, expect, it, vi } from "vitest";
import { DefaultGoogleIdentityClient } from "../services/auth/index.js";

describe("DefaultGoogleIdentityClient", () => {
  it("builds an OIDC request and verifies provider results through injected network boundaries", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id_token: "signed-id-token", access_token: "provider-secret" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const verifyIdToken = vi.fn().mockResolvedValue({
      sub: "google-subject",
      email: "person@example.com",
      email_verified: true,
      name: "Person",
      nonce: "oidc-nonce",
    });
    const client = new DefaultGoogleIdentityClient("client-id", "client-secret", { fetch: fetchImpl, verifyIdToken });
    const authorization = new URL(
      client.authorizationUrl({
        nonce: "oidc-nonce",
        redirectUri: "https://opentag.example.com/callback",
        state: "state",
      }),
    );
    expect(authorization.searchParams.get("scope")).toBe("openid email profile");
    expect(authorization.searchParams.get("nonce")).toBe("oidc-nonce");

    await expect(
      client.exchangeCode({ code: "code", nonce: "oidc-nonce", redirectUri: "https://opentag.example.com/callback" }),
    ).resolves.toEqual({
      provider: "google",
      issuer: "https://accounts.google.com",
      subject: "google-subject",
      email: "person@example.com",
      displayName: "Person",
    });
    expect(verifyIdToken).toHaveBeenCalledWith("signed-id-token");
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain("client_secret=client-secret");
  });

  it("rejects nonce mismatch and unverified email without reflecting provider details", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ id_token: "signed-id-token" }), { status: 200 }));
    const client = new DefaultGoogleIdentityClient("client-id", "client-secret", {
      fetch: fetchImpl,
      verifyIdToken: async () => ({
        sub: "google-subject",
        email: "person@example.com",
        email_verified: false,
        nonce: "wrong",
      }),
    });
    await expect(
      client.exchangeCode({
        code: "provider-error-body",
        nonce: "expected",
        redirectUri: "https://example.com/callback",
      }),
    ).rejects.toMatchObject({ code: "AUTH_OAUTH_FAILED", message: "Google sign-in could not be verified" });
  });
});
