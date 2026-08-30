import { HTTP_PATHS } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { ConnectCodeIssuer, UserAuthService } from "../services/auth/index.js";
import { signedInBrowser } from "./signed-in-browser.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createAuthService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn().mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresIn: 900,
    }),
    refresh: vi.fn().mockResolvedValue({
      accessToken: "next-access",
      refreshToken: "next-refresh",
      tokenType: "Bearer",
      expiresIn: 900,
    }),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: {
          id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
          email: "admin@example.com",
          displayName: "Admin",
        },
        setupCompletedAt: null,
      },
    }),
    getActiveUserById: vi.fn().mockResolvedValue({
      user: { id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e", email: "admin@example.com", displayName: "Admin" },
      setupCompletedAt: null,
    }),
    updateSelfProfile: vi.fn().mockResolvedValue({
      id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
      email: "admin@example.com",
      displayName: "Updated Admin",
    }),
  };
}

describe("auth HTTP API", () => {
  it("exchanges a valid connect code through the strict shared contract", async () => {
    const authService = createAuthService();
    const app = createApp({ authService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authConnectExchange,
      payload: { code: "1234567890abcdef" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
    expect(authService.exchangeConnectCode).toHaveBeenCalledWith("1234567890abcdef", undefined);
  });

  it("rejects extra request authority fields", async () => {
    const authService = createAuthService();
    const app = createApp({ authService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authConnectExchange,
      payload: { code: "1234567890abcdef", accountId: "caller-authority" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", category: "validation" } });
    expect(authService.exchangeConnectCode).not.toHaveBeenCalled();
  });

  it("preserves malformed JSON as a typed client error", async () => {
    const authService = createAuthService();
    const app = createApp({ authService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authConnectExchange,
      headers: { "content-type": "application/json" },
      payload: '{"code":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", category: "validation" } });
    expect(authService.exchangeConnectCode).not.toHaveBeenCalled();
  });

  it("classifies an invalid service response as an internal error", async () => {
    const authService = createAuthService();
    vi.mocked(authService.exchangeConnectCode).mockResolvedValue({ accessToken: "missing-fields" } as never);
    const app = createApp({ authService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authConnectExchange,
      payload: { code: "1234567890abcdef" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR", category: "transient" } });
  });

  it("refreshes a bearer session through the strict response contract", async () => {
    const authService = createAuthService();
    const app = createApp({ authService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authRefresh,
      payload: { refreshToken: "refresh-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accessToken: "next-access", refreshToken: "next-refresh" });
    expect(authService.refresh).toHaveBeenCalledWith("refresh-token");
  });

  it("authenticates /api/v1/me with the Account projection", async () => {
    const authService = createAuthService();
    const app = createApp({ authService });
    apps.push(app);

    const missing = await app.inject({ method: "GET", url: HTTP_PATHS.me });
    expect(missing.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: HTTP_PATHS.me,
      headers: { authorization: "Bearer access" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        email: "admin@example.com",
        displayName: "Admin",
      },
      setupCompletedAt: null,
    });
    expect(authService.getAuthenticatedUser).toHaveBeenCalledWith("access");
  });

  it("updates only the authenticated user's strict profile through bearer auth", async () => {
    const authService = createAuthService();
    const app = createApp({ authService });
    apps.push(app);

    const response = await app.inject({
      method: "PATCH",
      url: HTTP_PATHS.me,
      headers: { authorization: "Bearer access" },
      payload: { displayName: "  Updated Admin  " },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
      email: "admin@example.com",
      displayName: "Updated Admin",
    });
    expect(authService.updateSelfProfile).toHaveBeenCalledWith("53e2babe-e4ac-4e2c-b7d1-d092d5a4568e", {
      displayName: "Updated Admin",
    });

    const rejected = await app.inject({
      method: "PATCH",
      url: HTTP_PATHS.me,
      headers: { authorization: "Bearer access" },
      payload: { displayName: "Override", userId: "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(authService.updateSelfProfile).toHaveBeenCalledOnce();
  });

  it("requires browser mutation CSRF for self-profile updates", async () => {
    const authService = createAuthService();
    const app = createApp({
      authService,
      betterAuth: signedInBrowser("53e2babe-e4ac-4e2c-b7d1-d092d5a4568e"),
      browserAuth: {
        publicOrigin: "https://dev.example.com",
        sessionTtlSeconds: 3600,
        secureCookies: true,
      },
    });
    apps.push(app);

    const rejected = await app.inject({
      method: "PATCH",
      url: HTTP_PATHS.me,
      headers: { cookie: "opentag.session_token=session; opentag_csrf=csrf" },
      payload: { displayName: "Updated Admin" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(authService.updateSelfProfile).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "PATCH",
      url: HTTP_PATHS.me,
      headers: {
        cookie: "opentag.session_token=session; opentag_csrf=csrf",
        origin: "https://dev.example.com",
        "x-opentag-csrf": "csrf",
      },
      payload: { displayName: "Updated Admin" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(authService.updateSelfProfile).toHaveBeenCalledOnce();
  });

  it("issues a server-authored connect command only for the authenticated user", async () => {
    const authService = createAuthService();
    const issuer: ConnectCodeIssuer = {
      issueForUser: vi.fn().mockResolvedValue({
        code: "short_lived_code",
        expiresAt: new Date("2030-01-01T00:15:00.000Z"),
        expiresIn: 900,
        issuedAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    };
    const app = createApp({
      authService,
      connectCode: { environment: "staging", issuer, publicUrl: "https://dev.example.com" },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.meConnectCodes,
      headers: { authorization: "Bearer access" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      bootstrapCommand:
        "npm i -g open-tag-staging && opentag-staging login --server https://dev.example.com -- short_lived_code",
      expiresIn: 900,
      issuedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(issuer.issueForUser).toHaveBeenCalledWith("53e2babe-e4ac-4e2c-b7d1-d092d5a4568e");
  });

  it("requires same-origin CSRF for browser connect-code issuance", async () => {
    const authService = createAuthService();
    const issuer: ConnectCodeIssuer = {
      issueForUser: vi.fn().mockResolvedValue({
        code: "short_lived_code",
        expiresAt: new Date("2030-01-01T00:15:00.000Z"),
        expiresIn: 900,
        issuedAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    };
    const app = createApp({
      authService,
      betterAuth: signedInBrowser("53e2babe-e4ac-4e2c-b7d1-d092d5a4568e"),
      browserAuth: {
        publicOrigin: "https://dev.example.com",
        sessionTtlSeconds: 3600,
        secureCookies: true,
      },
      connectCode: { environment: "staging", issuer, publicUrl: "https://dev.example.com" },
    });
    apps.push(app);

    const rejected = await app.inject({
      method: "POST",
      url: HTTP_PATHS.meConnectCodes,
      headers: { cookie: "opentag.session_token=session; opentag_csrf=csrf" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(issuer.issueForUser).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "POST",
      url: HTTP_PATHS.meConnectCodes,
      headers: {
        cookie: "opentag.session_token=session; opentag_csrf=csrf",
        origin: "https://dev.example.com",
        "x-opentag-csrf": "csrf",
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(issuer.issueForUser).toHaveBeenCalledOnce();
  });
});
