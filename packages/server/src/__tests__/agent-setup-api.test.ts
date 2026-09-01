/**
 * The authenticated exact-Agent setup route. The service is stubbed here; the behavior under test is
 * the HTTP contract itself — authentication, params validation, the schema-checked response, and the
 * error envelopes a caller can rely on.
 */

import { agentSetupPath } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AgentService, AgentSetupService } from "../services/agents/index.js";
import { AgentServiceError } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const observedAt = "2026-09-01T10:00:00.000Z";

const snapshot = {
  agent: {
    id: agentId,
    name: "code-reviewer",
    displayName: "Code Reviewer",
    runtimeProvider: "codex",
    receiveMode: "all_message",
    status: "active",
    createdBy: { userId, displayName: "Admin" },
    computer: { computerId, displayName: "Laptop", platform: "linux" },
    createdAt: observedAt,
    updatedAt: observedAt,
  },
  stage: "needs-messaging",
  computer: {
    kind: "bound",
    computerId,
    displayName: "Laptop",
    platform: "linux",
    connectionStatus: "online",
    lastSeenAt: observedAt,
    observedAt,
  },
  runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
  messaging: { kind: "not-configured" },
  blockers: [{ code: "messaging-not-configured" }],
  actions: [
    { kind: "start-messaging", provider: "feishu" },
    { kind: "start-messaging", provider: "slack" },
  ],
  observedAt,
};

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

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

function appWith(getSetupById: AgentSetupService["getSetupById"]) {
  const agentSetupService = { getSetupById } as unknown as AgentSetupService;
  const agentService = {} as unknown as AgentService;
  const app = createApp({ authService: authService(), agentService, agentSetupService });
  apps.push(app);
  return app;
}

const authorization = { authorization: "Bearer access" };

describe("Agent setup HTTP API", () => {
  it("reads the exact-Agent setup snapshot for the authenticated Account", async () => {
    const getSetupById = vi.fn().mockResolvedValue(snapshot);
    const app = appWith(getSetupById);

    const response = await app.inject({ method: "GET", url: agentSetupPath(agentId), headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(getSetupById).toHaveBeenCalledWith(userId, agentId);
  });

  it("requires authentication", async () => {
    const getSetupById = vi.fn();
    const app = appWith(getSetupById);

    const response = await app.inject({ method: "GET", url: agentSetupPath(agentId) });
    expect(response.statusCode).toBe(401);
    expect(getSetupById).not.toHaveBeenCalled();
  });

  it("validates the Agent id in the path", async () => {
    const getSetupById = vi.fn();
    const app = appWith(getSetupById);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/agents/not-a-uuid/setup",
      headers: authorization,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(getSetupById).not.toHaveBeenCalled();
  });

  it("maps an unknown or foreign Agent to a 404 envelope", async () => {
    const app = appWith(
      vi.fn().mockRejectedValue(new AgentServiceError("RESOURCE_NOT_FOUND", "deterministic", "not found", 404)),
    );

    const response = await app.inject({ method: "GET", url: agentSetupPath(agentId), headers: authorization });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "RESOURCE_NOT_FOUND", category: "deterministic" } });
  });

  it("maps a suspended Agent to a 409 lifecycle envelope", async () => {
    const app = appWith(
      vi.fn().mockRejectedValue(new AgentServiceError("AGENT_LIFECYCLE_CONFLICT", "deterministic", "not active", 409)),
    );

    const response = await app.inject({ method: "GET", url: agentSetupPath(agentId), headers: authorization });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "AGENT_LIFECYCLE_CONFLICT", category: "deterministic" } });
  });
});
