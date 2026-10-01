import { Readable } from "node:stream";
import { agentAvatarPath } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ImBindingServiceError } from "../services/im-bindings/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const authorization = { authorization: "Bearer access" };
const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Admin" },
        setupCompletedAt: null,
      },
    }),
  };
}

function appWith(openAvatar: ReturnType<typeof vi.fn>) {
  const app = createApp({
    authService: authService(),
    agentService: {} as AgentService,
    imResourceService: { openAvatar } as never,
  });
  apps.push(app);
  return app;
}

describe("Agent avatar HTTP API", () => {
  it("requires an authenticated Account before opening an avatar", async () => {
    const openAvatar = vi.fn();
    const app = appWith(openAvatar);

    const response = await app.inject({ method: "GET", url: agentAvatarPath(agentId) });

    expect(response.statusCode).toBe(401);
    expect(openAvatar).not.toHaveBeenCalled();
  });

  it("streams only the validated image bytes for the owning Account", async () => {
    const openAvatar = vi.fn().mockResolvedValue({
      mediaType: "image/png",
      sizeBytes: 5,
      stream: Readable.from([Buffer.from("image")]),
    });
    const app = appWith(openAvatar);

    const response = await app.inject({ method: "GET", url: agentAvatarPath(agentId), headers: authorization });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("image");
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-length"]).toBe("5");
    expect(response.headers["cache-control"]).toContain("private");
    expect(response.headers.vary).toContain("Cookie");
    expect(openAvatar).toHaveBeenCalledWith(userId, agentId);
    expect(response.body).not.toContain("https://provider.example");
  });

  it("does not disclose a cross-Account avatar", async () => {
    const openAvatar = vi
      .fn()
      .mockRejectedValue(new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent avatar was not found"));
    const app = appWith(openAvatar);

    const response = await app.inject({ method: "GET", url: agentAvatarPath(agentId), headers: authorization });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "IM_BINDING_NOT_FOUND" } });
  });

  it("returns a graceful upstream failure for the browser fallback", async () => {
    const openAvatar = vi
      .fn()
      .mockRejectedValue(
        new ImBindingServiceError(
          "IM_BINDING_TEMPORARILY_UNAVAILABLE",
          503,
          "The Agent avatar is temporarily unavailable",
          "transient",
        ),
      );
    const app = appWith(openAvatar);

    const response = await app.inject({ method: "GET", url: agentAvatarPath(agentId), headers: authorization });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "IM_BINDING_TEMPORARILY_UNAVAILABLE" } });
  });

  it("rejects a non-image upstream response", async () => {
    const openAvatar = vi
      .fn()
      .mockRejectedValue(
        new ImBindingServiceError("VALIDATION_ERROR", 415, "The Agent avatar is not an allowed image"),
      );
    const app = appWith(openAvatar);

    const response = await app.inject({ method: "GET", url: agentAvatarPath(agentId), headers: authorization });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", category: "deterministic" } });
  });
});
