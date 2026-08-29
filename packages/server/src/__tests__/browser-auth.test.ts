import { HTTP_PATHS } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

/** Stands in for the Better Auth mount, recording which endpoint a route drove rather than guessing from its effects. */
function betterAuthStub(reply: () => Response) {
  const paths: string[] = [];
  const handler = vi.fn(async (request: Request) => {
    paths.push(new URL(request.url).pathname);
    return reply();
  });
  const instance = {
    $context: Promise.resolve({ authCookies: { sessionToken: { name: "opentag.session_token" } } }),
    api: { getSession: vi.fn().mockResolvedValue(null) },
    handler,
  } as unknown as OpenTagBetterAuth;
  return { instance: { instance, publicUrl: "http://localhost:8000" }, paths };
}

function devSession() {
  return new Response(JSON.stringify({ userId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "opentag.session_token=dev-session; Path=/; HttpOnly",
    },
  });
}

function googleRedirect() {
  return new Response(JSON.stringify({ url: "https://accounts.google.com/auth" }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "opentag.state=pkce; Path=/; HttpOnly",
    },
  });
}

function createBrowserApp(
  options: {
    betterAuth?: { instance: OpenTagBetterAuth; publicUrl: string };
    devSignIn?: boolean;
    googleSignIn?: boolean;
  } = {},
) {
  const app = createApp({
    ...(options.betterAuth ? { betterAuth: options.betterAuth } : {}),
    browserAuth: {
      ...(options.betterAuth ? { betterAuth: options.betterAuth } : {}),
      ...(options.devSignIn ? { devSignIn: true } : {}),
      ...(options.googleSignIn ? { googleSignIn: true } : {}),
      publicOrigin: "http://localhost:8000",
      secureCookies: false,
      sessionTtlSeconds: 3600,
    },
  });
  apps.push(app);
  return { app };
}

describe("browser authentication routes", () => {
  it("starts Google through Better Auth without putting next in the provider URL itself", async () => {
    const betterAuth = betterAuthStub(googleRedirect);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, googleSignIn: true });

    expect((await app.inject({ method: "GET", url: HTTP_PATHS.authProviders })).json()).toEqual({
      providers: [
        { id: "google", enabled: true, startUrl: HTTP_PATHS.authGoogleStart },
        { id: "dev", enabled: false, startUrl: null },
      ],
    });

    const response = await app.inject({ method: "GET", url: `${HTTP_PATHS.authGoogleStart}?next=%2Fagents` });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://accounts.google.com/auth");
    expect(betterAuth.paths).toEqual(["/api/v1/auth/sign-in/social"]);
    // The provider's own state and PKCE cookies have to survive the hop, or the callback cannot be verified.
    expect(String(response.headers["set-cookie"])).toContain("opentag.state=pkce");
  });

  it("refuses Google sign-in when it is not configured", async () => {
    const betterAuth = betterAuthStub(googleRedirect);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance });

    expect((await app.inject({ method: "GET", url: HTTP_PATHS.authProviders })).json()).toMatchObject({
      providers: [{ id: "google", enabled: false, startUrl: null }, { id: "dev" }],
    });
    const response = await app.inject({ method: "GET", url: HTTP_PATHS.authGoogleStart });
    expect(response.statusCode).toBe(404);
    expect(betterAuth.paths).toEqual([]);
  });

  it("rejects an external sign-in destination before reaching the provider", async () => {
    const betterAuth = betterAuthStub(googleRedirect);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, googleSignIn: true });

    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authGoogleStart}?next=${encodeURIComponent("https://example.com")}`,
    });

    expect(response.statusCode).toBe(400);
    expect(betterAuth.paths).toEqual([]);
  });

  it("signs in the configured development user only from a loopback request", async () => {
    const betterAuth = betterAuthStub(devSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, devSignIn: true });
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
      url: `${HTTP_PATHS.authDevCallback}?next=%2Fagents`,
      headers: { host: "localhost:8000" },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/agents");
    expect(betterAuth.paths).toEqual(["/api/v1/auth/dev/sign-in"]);
    const cookies = String(response.headers["set-cookie"]);
    expect(cookies).toContain("opentag.session_token=dev-session");
    // Without the double-submit token a signed-in development browser could read but never write, sign-out included.
    expect(cookies).toContain("opentag_csrf=");

    for (const request of [
      { headers: { host: "localhost:8000" }, remoteAddress: "192.0.2.10" },
      { headers: { host: "example.com" }, remoteAddress: "127.0.0.1" },
    ]) {
      const rejected = await app.inject({ method: "GET", url: HTTP_PATHS.authDevCallback, ...request });
      expect(rejected.statusCode).toBe(404);
    }
    expect(betterAuth.paths).toEqual(["/api/v1/auth/dev/sign-in"]);
  });

  it("rejects an external development redirect before issuing credentials", async () => {
    const betterAuth = betterAuthStub(devSession);
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, devSignIn: true });
    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authDevCallback}?next=${encodeURIComponent("https://example.com")}`,
      headers: { host: "localhost:8000" },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(400);
    expect(betterAuth.paths).toEqual([]);
  });

  it("reports an unresolvable development user instead of redirecting to a signed-out page", async () => {
    const betterAuth = betterAuthStub(() => new Response(JSON.stringify({ message: "gone" }), { status: 503 }));
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance, devSignIn: true });
    const response = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.authDevCallback}?next=%2Fagents`,
      headers: { host: "localhost:8000" },
      remoteAddress: "127.0.0.1",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "AUTH_DEV_USER_UNAVAILABLE" } });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("requires same-origin double-submit CSRF to sign out", async () => {
    /*
     * Better Auth's session cookie proves who the browser is, not that the request came from this origin's own pages.
     * Sign-out is a mutation like any other, so it carries the readable token too.
     */
    const betterAuth = betterAuthStub(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const { app } = createBrowserApp({ betterAuth: betterAuth.instance });

    const rejected = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authBrowserLogout,
      headers: { cookie: "opentag_csrf=csrf" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(betterAuth.paths).toEqual([]);

    const accepted = await app.inject({
      method: "POST",
      url: HTTP_PATHS.authBrowserLogout,
      headers: {
        cookie: "opentag_csrf=csrf",
        origin: "http://localhost:8000",
        "x-opentag-csrf": "csrf",
      },
    });
    expect(accepted.statusCode).toBe(204);
    expect(betterAuth.paths).toEqual(["/api/v1/auth/sign-out"]);
    // The double-submit token is OpenTag's, so Better Auth's sign-out cannot retire it.
    expect(String(accepted.headers["set-cookie"])).toContain("opentag_csrf=;");
  });
});
