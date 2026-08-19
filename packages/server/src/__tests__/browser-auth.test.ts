import { HTTP_PATHS } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { DevBrowserAuthService, GoogleBrowserAuthService, UserAuthService } from "../services/auth/index.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    getActiveUserById: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e", email: "admin@example.com", displayName: "Admin" },
        memberships: [],
      },
    }),
    refresh: vi.fn().mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      tokenType: "Bearer",
      expiresIn: 900,
    }),
  };
}

function google() {
  return {
    start: vi
      .fn()
      .mockResolvedValue({ authorizationUrl: "https://accounts.google.com/auth", context: "signed-context" }),
    callback: vi.fn().mockResolvedValue({
      next: "/admin",
      tokens: { accessToken: "access-secret", refreshToken: "refresh-secret", tokenType: "Bearer", expiresIn: 900 },
    }),
  };
}

function dev() {
  return {
    signIn: vi.fn().mockResolvedValue({
      accessToken: "dev-access-secret",
      refreshToken: "dev-refresh-secret",
      tokenType: "Bearer",
      expiresIn: 900,
    }),
  };
}

function createBrowserApp(
  options: { devService?: ReturnType<typeof dev>; googleService?: ReturnType<typeof google> | null } = {},
) {
  const googleService = options.googleService === null ? undefined : (options.googleService ?? google());
  const auth = authService();
  const app = createApp({
    authService: auth,
    browserAuth: {
      ...(options.devService ? { dev: options.devService as unknown as DevBrowserAuthService } : {}),
      ...(googleService ? { google: googleService as unknown as GoogleBrowserAuthService } : {}),
      publicOrigin: "http://localhost:8000",
      refreshTokenTtlSeconds: 3600,
      secureCookies: false,
    },
  });
  apps.push(app);
  return { app, auth, googleService };
}

describe("browser authentication routes", () => {
  it("reports configured providers and starts Google without putting next in the provider URL itself", async () => {
    const { app, googleService } = createBrowserApp();
    expect((await app.inject({ method: "GET", url: HTTP_PATHS.authProviders })).json()).toEqual({
      providers: [
        { id: "google", enabled: true, startUrl: HTTP_PATHS.authGoogleStart },
        { id: "dev", enabled: false, startUrl: null },
      ],
    });
    const response = await app.inject({ method: "GET", url: `${HTTP_PATHS.authGoogleStart}?next=%2Fadmin` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://accounts.google.com/auth");
    expect(String(response.headers["set-cookie"])).toContain("opentag_oauth_context=signed-context");
    expect(googleService?.start).toHaveBeenCalledWith("/admin");
  });

  it("signs in the configured development user only from a loopback request", async () => {
    const devService = dev();
    const { app } = createBrowserApp({ devService, googleService: null });
    expect((await app.inject({ method: "GET", url: HTTP_PATHS.authProviders })).json()).toEqual({
      providers: [
        { id: "google", enabled: false, startUrl: null },
        { id: "dev", enabled: true, startUrl: HTTP_PATHS.authDevCallback },
      ],
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: HTTP_PATHS.authProviders,
          headers: { host: "example.com" },
          remoteAddress: "127.0.0.1",
        })
      ).json(),
    ).toMatchObject({ providers: [{ id: "google" }, { id: "dev", enabled: false, startUrl: null }] });

    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authDevCallback}?next=%2Fadmin`,
      headers: { host: "localhost:8000" },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/admin");
    expect(String(response.headers["set-cookie"])).toContain("opentag_access=dev-access-secret");
    expect(devService.signIn).toHaveBeenCalledOnce();

    for (const request of [
      { headers: { host: "localhost:8000" }, remoteAddress: "192.0.2.10" },
      { headers: { host: "example.com" }, remoteAddress: "127.0.0.1" },
    ]) {
      const rejected = await app.inject({ method: "GET", url: HTTP_PATHS.authDevCallback, ...request });
      expect(rejected.statusCode).toBe(404);
    }
    expect(devService.signIn).toHaveBeenCalledOnce();
  });

  it("rejects an external development redirect before issuing credentials", async () => {
    const devService = dev();
    const { app } = createBrowserApp({ devService, googleService: null });
    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authDevCallback}?next=${encodeURIComponent("https://example.com")}`,
      headers: { host: "localhost:8000" },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(400);
    expect(devService.signIn).not.toHaveBeenCalled();
  });

  it("sets HttpOnly browser tokens only in cookies after a verified callback", async () => {
    const { app, googleService } = createBrowserApp();
    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authGoogleCallback}?code=code&state=state`,
      headers: { cookie: "opentag_oauth_context=signed-context" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/admin");
    const cookies = String(response.headers["set-cookie"]);
    expect(cookies).toContain("opentag_access=access-secret");
    expect(cookies).toContain("opentag_refresh=refresh-secret");
    expect(cookies).toContain("HttpOnly");
    expect(response.body).not.toContain("access-secret");
    expect(googleService?.callback).toHaveBeenCalledWith("code", "state", "signed-context", expect.any(Object));
  });

  it("requires same-origin double-submit CSRF for refresh while bearer API auth remains unaffected", async () => {
    const { app, auth } = createBrowserApp();
    const rejected = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authBrowserRefresh,
      headers: { cookie: "opentag_refresh=refresh; opentag_csrf=csrf" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(auth.refresh).not.toHaveBeenCalled();

    const refreshed = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authBrowserRefresh,
      headers: {
        cookie: "opentag_refresh=refresh; opentag_csrf=csrf",
        origin: "http://localhost:8000",
        "x-opentag-csrf": "csrf",
      },
    });
    expect(refreshed.statusCode).toBe(204);
    expect(auth.refresh).toHaveBeenCalledWith("refresh");
  });
});
