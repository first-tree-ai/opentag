import { describe, expect, it, vi } from "vitest";
import { AuthServiceError, DefaultGoogleIdentityClient, GoogleBrowserAuthService } from "../services/auth/index.js";

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

describe("GoogleBrowserAuthService", () => {
  function createService(verify = vi.fn().mockResolvedValue({ next: "/admin", oidcNonce: "oidc-nonce" })) {
    const exchangeCode = vi.fn();
    const service = new GoogleBrowserAuthService({
      database: {} as never,
      flow: { verify } as never,
      google: { exchangeCode } as never,
      identities: {} as never,
      postAuthentication: {} as never,
      publicUrl: "https://opentag.example.com",
      tokenIssuer: {} as never,
    });
    return { exchangeCode, service, verify };
  }

  it.each([
    ["access_denied", "Google sign-in was cancelled"],
    ["temporarily_unavailable", "Google sign-in failed"],
  ])("verifies state before mapping provider error %s", async (error, message) => {
    const { exchangeCode, service, verify } = createService();
    const onVerified = vi.fn();

    await expect(service.callback({ error, state: "state" }, "signed-context", { onVerified })).rejects.toMatchObject({
      code: "AUTH_OAUTH_FAILED",
      category: "credential",
      message,
      statusCode: 401,
    });
    expect(verify).toHaveBeenCalledWith("state", "signed-context");
    expect(onVerified).toHaveBeenCalledOnce();
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("runs the verified lifecycle before exchanging an authorization code", async () => {
    const { exchangeCode, service } = createService();
    const onVerified = vi.fn();
    const exchangeFailure = new Error("provider exchange failed");
    exchangeCode.mockImplementationOnce(async () => {
      expect(onVerified).toHaveBeenCalledOnce();
      throw exchangeFailure;
    });

    await expect(service.callback({ code: "code", state: "state" }, "signed-context", { onVerified })).rejects.toBe(
      exchangeFailure,
    );
    expect(exchangeCode).toHaveBeenCalledOnce();
  });

  it("returns the Workspace selected while redeeming an invitation in the callback transaction", async () => {
    const token = "A".repeat(43);
    const selectedWorkspaceId = "3928e3dc-99b0-4a79-97c8-bf9c26b91add";
    const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
    const completeInTransaction = vi.fn().mockResolvedValue({ selectedWorkspaceId, userId });
    const issueTokensForUser = vi.fn().mockResolvedValue({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      tokenType: "Bearer",
      expiresIn: 900,
    });
    const service = new GoogleBrowserAuthService({
      database: { transaction: (callback: (transaction: object) => unknown) => callback({}) } as never,
      flow: { verify: vi.fn().mockResolvedValue({ next: `/invites/${token}`, oidcNonce: "oidc-nonce" }) } as never,
      google: { exchangeCode: vi.fn().mockResolvedValue({ provider: "google" }) } as never,
      identities: {
        resolveOrCreateInTransaction: vi.fn().mockResolvedValue({ accountWasCreated: true, userId }),
      } as never,
      postAuthentication: { completeInTransaction } as never,
      publicUrl: "https://opentag.example.com",
      tokenIssuer: { issueTokensForUser } as never,
    });

    await expect(
      service.callback({ code: "code", state: "state" }, "signed-context", { onVerified: vi.fn() }),
    ).resolves.toMatchObject({ next: `/invites/${token}`, selectedWorkspaceId });
    expect(completeInTransaction).toHaveBeenCalledWith(expect.anything(), userId, true, token);
    expect(issueTokensForUser).toHaveBeenCalledWith(userId);
  });

  it("returns the personal Workspace established by a solo OAuth completion", async () => {
    const selectedWorkspaceId = "3928e3dc-99b0-4a79-97c8-bf9c26b91add";
    const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
    const completeInTransaction = vi.fn().mockResolvedValue({ selectedWorkspaceId, userId });
    const service = new GoogleBrowserAuthService({
      database: { transaction: (callback: (transaction: object) => unknown) => callback({}) } as never,
      flow: { verify: vi.fn().mockResolvedValue({ next: "/onboarding", oidcNonce: "oidc-nonce" }) } as never,
      google: { exchangeCode: vi.fn().mockResolvedValue({ provider: "google" }) } as never,
      identities: {
        resolveOrCreateInTransaction: vi.fn().mockResolvedValue({ accountWasCreated: true, userId }),
      } as never,
      postAuthentication: { completeInTransaction } as never,
      publicUrl: "https://opentag.example.com",
      tokenIssuer: {
        issueTokensForUser: vi.fn().mockResolvedValue({
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          tokenType: "Bearer",
          expiresIn: 900,
        }),
      } as never,
    });

    await expect(
      service.callback({ code: "code", state: "state" }, "signed-context", { onVerified: vi.fn() }),
    ).resolves.toMatchObject({ next: "/onboarding", selectedWorkspaceId });
    expect(completeInTransaction).toHaveBeenCalledWith(expect.anything(), userId, true, undefined);
  });

  it("preserves invalid or expired flow errors before interpreting the provider result", async () => {
    const flowError = new AuthServiceError(
      "AUTH_OAUTH_FAILED",
      "credential",
      "The browser sign-in flow is invalid or expired",
      401,
    );
    const { exchangeCode, service } = createService(vi.fn().mockRejectedValue(flowError));
    const onVerified = vi.fn();

    await expect(
      service.callback({ error: "access_denied", state: "invalid-state" }, "expired-context", { onVerified }),
    ).rejects.toBe(flowError);
    expect(onVerified).not.toHaveBeenCalled();
    expect(exchangeCode).not.toHaveBeenCalled();
  });
});
