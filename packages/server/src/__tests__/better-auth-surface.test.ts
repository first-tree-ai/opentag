import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { OpenTagBetterAuth } from "../auth/better-auth.js";
import type { UserAuthService } from "../services/auth/index.js";

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
  return { handler, instance: { api: { getSession: vi.fn() }, handler } as unknown as OpenTagBetterAuth };
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
