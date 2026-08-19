import {
  agentFeishuSetupAttemptsPath,
  agentIntegrationPath,
  feishuSetupAttemptPath,
  integrationDiagnosticsPath,
  integrationDisablePath,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { FeishuSetupService } from "../services/integrations/feishu/index.js";
import type { IntegrationService } from "../services/integrations/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const integrationId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";
const attemptId = "f645f26d-9184-4f2f-98a1-4ee83ae6a603";
const authorization = { authorization: "Bearer access" };

const attempt = {
  id: attemptId,
  agentId,
  intent: "create" as const,
  state: "awaiting_user" as const,
  qrUrl: "https://open.feishu.cn/qr/example",
  expiresAt: "2026-08-19T01:00:00.000Z",
  errorCode: null,
  completedAt: null,
  createdAt: "2026-08-19T00:00:00.000Z",
};

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Admin" },
        memberships: [{ teamId, teamName: "example", teamDisplayName: "Example", role: "admin" }],
      },
    }),
  };
}

function services() {
  const integrations = {
    getForAgent: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    diagnostics: vi.fn().mockResolvedValue({
      integrationId,
      provider: "feishu",
      ready: false,
      runtimeToolAvailable: false,
      credentialGeneration: 1,
      reauthorizationRequired: false,
      connection: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastErrorCode: null,
    }),
  };
  const feishu = {
    createOrReuse: vi.fn().mockResolvedValue(attempt),
    get: vi.fn().mockResolvedValue(attempt),
    cancel: vi.fn().mockResolvedValue({ ...attempt, state: "canceled", errorCode: "FEISHU_SETUP_CANCELED" }),
  };
  return { integrations, feishu };
}

describe("Integration HTTP API", () => {
  it("serves the Feishu setup lifecycle and generic diagnostics without exposing credentials", async () => {
    const service = services();
    const app = createApp({
      authService: authService(),
      integrationService: service.integrations as unknown as IntegrationService,
      feishuSetupService: service.feishu as unknown as FeishuSetupService,
    });
    apps.push(app);
    expect(
      (await app.inject({ method: "GET", url: agentIntegrationPath(agentId), headers: authorization })).statusCode,
    ).toBe(204);
    const create = await app.inject({
      method: "POST",
      url: agentFeishuSetupAttemptsPath(agentId),
      headers: authorization,
      payload: { intent: "create" },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual(attempt);
    expect(service.feishu.createOrReuse).toHaveBeenCalledWith(userId, agentId, "create");
    expect(
      (await app.inject({ method: "GET", url: feishuSetupAttemptPath(attemptId), headers: authorization })).json(),
    ).toEqual(attempt);
    expect(
      (
        await app.inject({ method: "GET", url: integrationDiagnosticsPath(integrationId), headers: authorization })
      ).json(),
    ).toMatchObject({ provider: "feishu", ready: false, connection: null });
    expect(
      (await app.inject({ method: "POST", url: integrationDisablePath(integrationId), headers: authorization }))
        .statusCode,
    ).toBe(204);
    expect(service.integrations.disable).toHaveBeenCalledWith(userId, integrationId);
    expect(JSON.stringify(create.json())).not.toContain("secret");
  });
});
