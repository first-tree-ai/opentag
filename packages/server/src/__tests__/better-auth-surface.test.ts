import { HTTP_PATHS } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import { SESSION_COOKIE_NAME, signedInBrowser } from "./signed-in-browser.js";

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    getActiveUserById: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    refresh: vi.fn(),
    updateSelfProfile: vi.fn(),
  };
}

/**
 * Answers every request, so a path reaching Better Auth is visible as a `200 reached` rather than as whatever the
 * library would have replied. Anything OpenTag has not published must never get here.
 */
function recordingBetterAuth(): { handler: ReturnType<typeof vi.fn>; instance: OpenTagBetterAuth } {
  const handler = vi.fn(async () => new Response("reached", { status: 200 }));
  const context = Promise.resolve({ authCookies: { sessionToken: { name: "opentag.session_token" } } });
  return {
    handler,
    instance: { $context: context, api: { getSession: vi.fn() }, handler } as unknown as OpenTagBetterAuth,
  };
}

function build(betterAuth: OpenTagBetterAuth) {
  const app = createApp({
    authService: authService(),
    betterAuth: { instance: betterAuth, publicUrl: "https://opentag.example.com" },
  });
  apps.push(app);
  return app;
}

describe("published Better Auth surface", () => {
  it("serves the OAuth callback and nothing else the library defines", async () => {
    const { handler, instance } = recordingBetterAuth();
    const app = build(instance);

    const callback = await app.inject({ method: "GET", url: "/api/v1/auth/callback/google?code=x&state=y" });
    expect(callback.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    /*
     * `/update-user` is the one that matters: `user.name` maps to `users.display_name`, so reaching Better Auth here
     * would be a second Account-profile writer bypassing `UserDisplayNameSchema`, the suspension guard, and the
     * authenticated, origin-checked `/api/v1/me`. The rest are listed so an accidental catch-all is caught here.
     */
    const unpublished = [
      { method: "POST" as const, url: "/api/v1/auth/update-user" },
      // Mints a session with no credential at all. It exists only on a loopback development server, and even there
      // nothing but the fenced OpenTag route may reach it.
      { method: "POST" as const, url: "/api/v1/auth/dev/sign-in" },
      // Reachable only through the route that owns the refresh cookie, and only for as long as legacy credentials do.
      { method: "POST" as const, url: "/api/v1/auth/legacy/upgrade" },
      { method: "POST" as const, url: "/api/v1/auth/sign-in/social" },
      { method: "POST" as const, url: "/api/v1/auth/sign-out" },
      { method: "GET" as const, url: "/api/v1/auth/get-session" },
      { method: "POST" as const, url: "/api/v1/auth/sign-up/email" },
      { method: "GET" as const, url: "/api/v1/auth/list-sessions" },
    ];
    for (const request of unpublished) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url} reached Better Auth`).toBe(404);
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("issues the double-submit token alongside a session, so a fresh sign-in can mutate", async () => {
    /*
     * Better Auth's session cookie is not enough on its own: every browser mutation, sign-out included, also needs
     * OpenTag's readable double-submit token. Without this a user who signs in can read but never write.
     */
    const handler = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "/agents", "set-cookie": "opentag.session_token=abc; Path=/; HttpOnly" },
        }),
    );
    const context = Promise.resolve({ authCookies: { sessionToken: { name: "opentag.session_token" } } });
    const app = build({ $context: context, api: { getSession: vi.fn() }, handler } as unknown as OpenTagBetterAuth);

    const response = await app.inject({ method: "GET", url: "/api/v1/auth/callback/google?code=x&state=y" });

    const cookies = ([] as string[]).concat(response.headers["set-cookie"] as string | string[]);
    expect(cookies.some((value) => value.startsWith("opentag.session_token="))).toBe(true);
    expect(cookies.some((value) => value.startsWith("opentag_csrf="))).toBe(true);
  });

  it("does not hand out a double-submit token when sign-in failed", async () => {
    const handler = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 401 }));
    const context = Promise.resolve({ authCookies: { sessionToken: { name: "opentag.session_token" } } });
    const app = build({ $context: context, api: { getSession: vi.fn() }, handler } as unknown as OpenTagBetterAuth);

    const response = await app.inject({ method: "GET", url: "/api/v1/auth/callback/google?error=denied&state=y" });

    const header = response.headers["set-cookie"];
    const cookies = header === undefined ? [] : ([] as string[]).concat(header as string | string[]);
    expect(cookies.some((value) => value.startsWith("opentag_csrf="))).toBe(false);
  });

  it("keeps the browser's token when revocation could not be verified", async () => {
    /*
     * Better Auth clears the session cookie even when its own delete failed, and Fastify keeps headers already placed
     * on the reply. Propagating them before the survivor check would destroy the browser's only copy of a token whose
     * session is still live — nothing left to retry revocation with, and a stolen copy usable until expiry.
     */
    const surviving = { token: "still-here" };
    const context = Promise.resolve({
      authCookies: { sessionToken: { name: "opentag.session_token" } },
      internalAdapter: { findSession: vi.fn(async () => surviving) },
    });
    const instance = {
      $context: context,
      api: { getSession: vi.fn(async () => ({ session: surviving, user: { id: "u" } })) },
      handler: vi.fn(
        async () =>
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "set-cookie": "opentag.session_token=; Path=/; Max-Age=0" },
          }),
      ),
    } as unknown as OpenTagBetterAuth;

    const app = createApp({
      authService: authService(),
      betterAuth: { instance, publicUrl: "https://opentag.example.com" },
      browserAuth: {
        betterAuth: { instance, publicUrl: "https://opentag.example.com" },
        publicOrigin: "https://opentag.example.com",
        sessionTtlSeconds: 3600,
        secureCookies: true,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/browser/logout",
      headers: {
        origin: "https://opentag.example.com",
        cookie: "opentag_csrf=token; opentag.session_token=abc",
        "x-opentag-csrf": "token",
      },
    });

    expect(response.statusCode).toBe(500);
    const header = response.headers["set-cookie"];
    const cookies = header === undefined ? [] : ([] as string[]).concat(header as string | string[]);
    expect(cookies, "a failed revocation must not strip the caller's credential").toEqual([]);
  });

  it("renews the double-submit token through the composition the server actually builds", async () => {
    /*
     * The renewal lives in the pre-handler, but whether it happens at all is decided by `createApp`: the options it
     * assembles are what tell the pre-handler the session lifetime. Constructing the pre-handler directly proves the
     * logic and nothing about the wiring, and a composition that omits those options fails silently — Better Auth
     * keeps rolling the session while `opentag_csrf` expires on its original schedule, leaving an authenticated
     * browser able to read but not to mutate or sign out.
     */
    const betterAuth = signedInBrowser("53e2babe-e4ac-4e2c-b7d1-d092d5a4568e", {
      publicUrl: "https://opentag.example.com",
    });
    const app = createApp({
      authService: {
        ...authService(),
        getActiveUserById: vi.fn().mockResolvedValue({
          user: { id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e", email: "admin@example.com", displayName: "Admin" },
          workspaces: [],
        }),
      },
      betterAuth,
      browserAuth: {
        publicOrigin: "https://opentag.example.com",
        secureCookies: true,
        sessionTtlSeconds: 4242,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: HTTP_PATHS.me,
      headers: { cookie: `${SESSION_COOKIE_NAME}=session; opentag_csrf=carried-token` },
    });

    expect(response.statusCode).toBe(200);
    const cookies = ([] as string[]).concat((response.headers["set-cookie"] ?? []) as string | string[]);
    const renewed = cookies.find((value) => value.startsWith("opentag_csrf="));
    expect(renewed, "the double-submit token was not renewed alongside the session").toBeDefined();
    // Re-sent unchanged, so a tab that already read it stays correct, and on the session's schedule rather than its own.
    expect(renewed).toContain("opentag_csrf=carried-token");
    expect(renewed).toContain("Max-Age=4242");
  });

  it("builds the forwarded URL from the configured origin, not the request Host", async () => {
    const { handler, instance } = recordingBetterAuth();
    const app = build(instance);

    await app.inject({
      method: "GET",
      url: "/api/v1/auth/callback/google?code=x&state=y",
      headers: { host: "attacker.example.net" },
    });

    const forwarded = handler.mock.calls[0]?.[0] as Request;
    expect(new URL(forwarded.url).origin).toBe("https://opentag.example.com");
  });
});
