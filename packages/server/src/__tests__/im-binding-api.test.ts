import {
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingHandoffPath,
  agentImBindingPath,
  agentSlackSetupAttemptsPath,
  feishuSetupAttemptPath,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  slackSetupAttemptPath,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import { FeishuOperationError, type FeishuSetupService } from "../services/im-bindings/feishu/index.js";
import type { ImBindingService } from "../services/im-bindings/index.js";
import { type SlackSetupService, SlackSetupServiceError } from "../services/im-bindings/slack/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const imBindingId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";
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

const slackAttempt = {
  id: "f645f26d-9184-4f2f-98a1-4ee83ae6a604",
  agentId,
  intent: "create" as const,
  state: "awaiting_credentials" as const,
  manifest: { display_information: { name: "Assistant - OpenTag" } },
  manifestUrl: "https://api.slack.com/apps?new_app=1&manifest_json=example",
  eventsUrl: `https://opentag.example.com/api/v1/agents/${agentId}/im-binding/slack/events`,
  requiredBotScopes: ["app_mentions:read", "chat:write", "files:read", "im:history"],
  currentAppId: null,
  identity: null,
  challengeVerified: false,
  lastVerificationErrorCode: null,
  lastVerificationAt: null,
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
    updateSelfProfile: vi.fn(),
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
  const imBindings = {
    getForAgent: vi.fn().mockResolvedValue(undefined),
    getHandoffForAgent: vi.fn().mockResolvedValue({ bindingState: "active", handoffReady: false }),
    getConfigForAgent: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    diagnostics: vi.fn().mockResolvedValue({
      imBindingId,
      provider: "feishu",
      ready: false,
      agentRuntimeReadiness: "ready",
      providerCliReadiness: "install",
      credentialGeneration: 1,
      reauthorizationRequired: false,
      pendingReceiveMode: null,
      connection: null,
      lastInboundAt: null,
      lastErrorCode: null,
    }),
  };
  const feishu = {
    createOrReuse: vi.fn().mockResolvedValue(attempt),
    get: vi.fn().mockResolvedValue(attempt),
    cancel: vi.fn().mockResolvedValue({ ...attempt, state: "canceled", errorCode: "FEISHU_SETUP_CANCELED" }),
  };
  const slack = {
    createOrReuse: vi.fn().mockResolvedValue(slackAttempt),
    get: vi.fn().mockResolvedValue(slackAttempt),
    submitCredentials: vi.fn().mockResolvedValue({
      ...slackAttempt,
      state: "awaiting_verification",
      identity: { appId: "A1", teamId: "T1", enterpriseId: null, botUserId: "U1" },
    }),
    cancel: vi.fn().mockResolvedValue({ ...slackAttempt, state: "canceled", errorCode: "SLACK_SETUP_CANCELED" }),
  };
  return { imBindings, feishu, slack };
}

describe("ImBinding HTTP API", () => {
  it("serves the Feishu setup lifecycle and generic diagnostics without exposing credentials", async () => {
    const service = services();
    const app = createApp({
      authService: authService(),
      imBindingService: service.imBindings as unknown as ImBindingService,
      feishuSetupService: service.feishu as unknown as FeishuSetupService,
      slackSetupService: service.slack as unknown as SlackSetupService,
    });
    apps.push(app);
    expect(
      (await app.inject({ method: "GET", url: agentImBindingPath(agentId), headers: authorization })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: agentImBindingConfigPath(agentId), headers: authorization })).statusCode,
    ).toBe(204);
    const handoff = await app.inject({
      method: "GET",
      url: agentImBindingHandoffPath(agentId),
      headers: authorization,
    });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json()).toEqual({ bindingState: "active", handoffReady: false });
    expect(service.imBindings.getHandoffForAgent).toHaveBeenCalledWith(userId, agentId);
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
      (await app.inject({ method: "GET", url: imBindingDiagnosticsPath(imBindingId), headers: authorization })).json(),
    ).toMatchObject({ provider: "feishu", ready: false, connection: null });
    expect(
      (await app.inject({ method: "POST", url: imBindingDisablePath(imBindingId), headers: authorization })).statusCode,
    ).toBe(204);
    expect(service.imBindings.disable).toHaveBeenCalledWith(userId, imBindingId);
    expect(JSON.stringify(handoff.json())).not.toMatch(/credential|identity|error|connection|secret/i);
    expect(JSON.stringify(create.json())).not.toContain("secret");

    const createSlack = await app.inject({
      method: "POST",
      url: agentSlackSetupAttemptsPath(agentId),
      headers: authorization,
      payload: { intent: "create" },
    });
    expect(createSlack.statusCode).toBe(201);
    expect(createSlack.json()).toEqual(slackAttempt);
    expect(service.slack.createOrReuse).toHaveBeenCalledWith(userId, agentId, "create");
    const credentials = await app.inject({
      method: "POST",
      url: `${slackSetupAttemptPath(slackAttempt.id)}/credentials`,
      headers: authorization,
      payload: { botAccessToken: "xoxb-secret-token", signingSecret: "signing-secret" },
    });
    expect(credentials.statusCode).toBe(200);
    expect(credentials.json()).toMatchObject({
      state: "awaiting_verification",
      identity: { appId: "A1", teamId: "T1", botUserId: "U1" },
    });
    expect(service.slack.submitCredentials).toHaveBeenCalledWith(userId, slackAttempt.id, {
      botAccessToken: "xoxb-secret-token",
      signingSecret: "signing-secret",
    });
    expect(JSON.stringify(credentials.json())).not.toMatch(/xoxb|signing-secret/);
  });

  it.each([
    ["an unreachable Feishu platform", "FEISHU_UPSTREAM_UNAVAILABLE", 502, "FEISHU_UPSTREAM_UNAVAILABLE", "transient"],
    ["an internal setup race", "FEISHU_SETUP_FENCE_STALE", 500, "INTERNAL_ERROR", "transient"],
  ] as const)("answers %s with a typed error", async (_label, thrown, statusCode, code, category) => {
    const service = services();
    service.feishu.createOrReuse = vi.fn().mockRejectedValue(new FeishuOperationError(thrown));
    const app = createApp({
      authService: authService(),
      imBindingService: service.imBindings as unknown as ImBindingService,
      feishuSetupService: service.feishu as unknown as FeishuSetupService,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: agentFeishuSetupAttemptsPath(agentId),
      headers: authorization,
      payload: { intent: "create" },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json().error).toMatchObject({ code, category });
    expect(JSON.stringify(response.json())).not.toContain("stack");
  });

  it("returns Slack setup failures through the public typed error contract", async () => {
    const service = services();
    service.slack.submitCredentials = vi
      .fn()
      .mockRejectedValue(
        new SlackSetupServiceError("SLACK_AUTH_INVALID", 400, "Slack rejected the token", "credential"),
      );
    const app = createApp({
      authService: authService(),
      imBindingService: service.imBindings as unknown as ImBindingService,
      slackSetupService: service.slack as unknown as SlackSetupService,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `${slackSetupAttemptPath(slackAttempt.id)}/credentials`,
      headers: authorization,
      payload: { botAccessToken: "xoxb-invalid", signingSecret: "signing-secret" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "SLACK_AUTH_INVALID", category: "credential" });
    expect(JSON.stringify(response.json())).not.toMatch(/xoxb-invalid|signing-secret|stack/);
  });
});
