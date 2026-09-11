import { HTTP_PATHS } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import { SESSION_COOKIE_NAME, signedInBrowser } from "./signed-in-browser.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const cookie = `${SESSION_COOKIE_NAME}=session`;
const origin = "https://opentag.build";
const url = HTTP_PATHS.authBrowserSessionStatus;
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(publicOrigin = "https://app.opentag.build") {
  const authService = {
    getActiveUserById: vi.fn().mockResolvedValue({
      user: { id: userId, email: "ada@example.com", displayName: "Ada" },
      setupCompletedAt: null,
    }),
  } as unknown as UserAuthService;
  const betterAuth = signedInBrowser(userId, { publicUrl: publicOrigin });
  const app = createApp({
    authService,
    betterAuth,
    browserAuth: { publicOrigin, secureCookies: true, sessionTtlSeconds: 3600 },
  });
  apps.push(app);
  return { app, authService, getSession: vi.mocked(betterAuth.instance.api.getSession) };
}

describe("website session status", () => {
  it.each([origin, "https://www.opentag.build"])("shares only session presence with %s", async (website) => {
    const { app, authService, getSession } = setup();
    const response = await app.inject({ url, headers: { origin: website, cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: true });
    expect(response.headers["access-control-allow-origin"]).toBe(website);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers.vary).toBe("Origin");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(authService.getActiveUserById).toHaveBeenCalledWith(userId);
    expect(getSession.mock.calls[0]?.[0]?.query).toEqual({ disableRefresh: true, disableCookieCache: true });
  });

  it("reports anonymous browsers without looking up an Account", async () => {
    const { app, authService } = setup();
    const response = await app.inject({ url, headers: { origin } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: false });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(authService.getActiveUserById).not.toHaveBeenCalled();
  });

  it("observes a revoked or expired session on the next read", async () => {
    const { app, getSession } = setup();
    expect((await app.inject({ url, headers: { origin, cookie } })).json()).toEqual({ authenticated: true });
    getSession.mockResolvedValueOnce(null);
    expect((await app.inject({ url, headers: { origin, cookie } })).json()).toEqual({ authenticated: false });
  });

  it.each(["AUTH_INVALID_TOKEN", "AUTH_USER_SUSPENDED"] as const)("rejects an inactive Account: %s", async (code) => {
    const { app, authService } = setup();
    vi.mocked(authService.getActiveUserById).mockRejectedValue(
      new AuthServiceError(code, "credential", "Inactive", 403),
    );
    const response = await app.inject({ url, headers: { origin, cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authenticated: false });
  });

  it("does not accept a CLI bearer as a browser session", async () => {
    const { app, getSession } = setup();
    const response = await app.inject({ url, headers: { origin, authorization: "Bearer cli-token" } });
    expect(response.json()).toEqual({ authenticated: false });
    const headers = getSession.mock.calls[0]?.[0]?.headers;
    expect(new Headers(headers).has("authorization")).toBe(false);
  });

  it.each([
    undefined,
    "null",
    "http://opentag.build",
    "https://opentag.build.evil.example",
    "https://staging.opentag.build",
  ])("denies unapproved origins before reading a session: %s", async (website) => {
    const { app, getSession } = setup();
    const response = await app.inject({ url, headers: { ...(website ? { origin: website } : {}), cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each(["https://self-hosted.example", "https://staging.opentag.build", "http://localhost:3000"])(
    "does not expose website session detection on %s",
    async (publicOrigin) => {
      const { app, getSession } = setup(publicOrigin);
      const response = await app.inject({ url, headers: { origin, cookie } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(getSession).not.toHaveBeenCalled();
    },
  );

  it.each(["session", "account"])("keeps a %s service outage distinct from sign-out", async (failure) => {
    const { app, authService, getSession } = setup();
    if (failure === "session") getSession.mockRejectedValueOnce(new Error("Database unavailable"));
    else vi.mocked(authService.getActiveUserById).mockRejectedValueOnce(new Error("Database unavailable"));
    const response = await app.inject({ url, headers: { origin, cookie } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty("authenticated");
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("allows a GET preflight without reading a session", async () => {
    const { app, getSession } = setup();
    const response = await app.inject({
      method: "OPTIONS",
      url,
      headers: { origin, "access-control-request-method": "GET" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toBe("GET");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    { "access-control-request-method": "POST" },
    { "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  ])("refuses broader preflight permissions: %j", async (headers) => {
    const { app, getSession } = setup();
    const response = await app.inject({ method: "OPTIONS", url, headers: { origin, ...headers } });
    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-methods"]).toBeUndefined();
    expect(response.headers["access-control-allow-headers"]).toBeUndefined();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("does not enable cross-origin Account reads or session writes", async () => {
    const { app } = setup();
    const me = await app.inject({ url: HTTP_PATHS.me, headers: { origin, cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.headers["access-control-allow-origin"]).toBeUndefined();
    const logout = await app.inject({ method: "POST", url: HTTP_PATHS.authBrowserLogout, headers: { origin, cookie } });
    expect(logout.statusCode).toBe(403);
    expect(logout.headers["access-control-allow-origin"]).toBeUndefined();
    const write = await app.inject({ method: "POST", url, headers: { origin, cookie } });
    expect(write.statusCode).toBe(404);
    expect(write.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
