import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";

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
      me: {
        user: {
          id: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
          email: "admin@example.com",
          displayName: "Admin",
        },
        memberships: [
          {
            teamId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
            teamSlug: "example",
            teamDisplayName: "Example",
            role: "admin",
          },
        ],
      },
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
      url: "/v1/auth/connect/exchange",
      payload: { code: "1234567890abcdef" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
    expect(authService.exchangeConnectCode).toHaveBeenCalledWith("1234567890abcdef");
  });

  it("rejects extra request authority fields", async () => {
    const authService = createAuthService();
    const app = createApp({ authService });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/connect/exchange",
      payload: { code: "1234567890abcdef", teamId: "caller-authority" },
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
      url: "/v1/auth/connect/exchange",
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
      url: "/v1/auth/connect/exchange",
      payload: { code: "1234567890abcdef" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR", category: "transient" } });
  });

  it("authenticates /v1/me and returns live membership data", async () => {
    const authService = createAuthService();
    const app = createApp({ authService });
    apps.push(app);

    const missing = await app.inject({ method: "GET", url: "/v1/me" });
    expect(missing.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer access" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ memberships: [{ teamSlug: "example", role: "admin" }] });
    expect(authService.getAuthenticatedUser).toHaveBeenCalledWith("access");
  });
});
