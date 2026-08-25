import {
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingHandoffPath,
  agentImBindingPath,
  agentSlackConfigurationPath,
  feishuSetupAttemptPath,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SUBSCRIBED_BOT_EVENTS,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { UserAuthService } from "../services/auth/index.js";
import { FeishuOperationError, type FeishuSetupService } from "../services/im-bindings/feishu/index.js";
import type { ImBindingService } from "../services/im-bindings/index.js";
import { type SlackConfigurationService, SlackConfigurationServiceError } from "../services/im-bindings/slack/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const imBindingId = "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0";
const attemptId = "f645f26d-9184-4f2f-98a1-4ee83ae6a603";
const authorization = { authorization: "Bearer access" };

const feishuAttempt = {
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

const slackConfiguration = {
  agentId,
  manifest: { display_information: { name: "Assistant - OpenTag" } },
  manifestUrl: "https://api.slack.com/apps?new_app=1&manifest_json=example",
  eventsUrl: `https://opentag.example.com/api/v1/agents/${agentId}/im-binding/slack/events`,
  requiredBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
  subscribedBotEvents: [...SLACK_SUBSCRIBED_BOT_EVENTS],
  currentBinding: null,
};

const slackDetail = {
  id: imBindingId,
  agentId,
  provider: "slack" as const,
  bindingState: "active" as const,
  bot: { displayName: null, avatarUrl: null },
  receiveMode: "mention_only" as const,
  lastInboundAt: null,
  lastValidatedAt: "2026-08-19T00:00:00.000Z",
  lastRuntimeObservationAt: null,
  identity: {
    provider: "slack" as const,
    appId: "A1",
    teamId: "T1",
    enterpriseId: null,
    botUserId: "U1",
    appIdEvidence: "configured" as const,
  },
  credentialGeneration: 1,
  grantedCapabilities: [...SLACK_REQUIRED_BOT_SCOPES],
  reauthorizationRequired: false,
  lastErrorCode: null,
};

const slackConfigurationResult = {
  imBindingId,
  agentId,
  appId: "A1",
  teamId: "T1",
  botUserId: "U1",
  credentialGeneration: 1,
  bindingState: "active" as const,
  identityClosure: { status: "pending" as const, verifiedAt: null },
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
        workspaces: [
          {
            id: workspaceId,
            name: "example",
            displayName: "Example",
            setupCompletedAt: null,
            grantedAt: "2030-01-01T00:00:00.000Z",
          },
        ],
      },
    }),
  };
}

function services() {
  const imBindings = {
    getForAgent: vi.fn().mockResolvedValue(undefined),
    getHandoffForAgent: vi.fn().mockResolvedValue({ bindingState: "active", handoffReady: false }),
    getConfigForAgent: vi.fn().mockResolvedValue(slackDetail),
    disable: vi.fn().mockResolvedValue(undefined),
    diagnostics: vi.fn().mockResolvedValue({
      imBindingId,
      provider: "feishu",
      ready: false,
      agentRuntimeReadiness: "ready",
      providerCliReadiness: "install",
      credentialGeneration: 1,
      credentialStatus: "valid",
      requiredCapabilities: [],
      grantedCapabilities: [],
      missingCapabilities: [],
      reauthorizationRequired: false,
      slackAppId: null,
      slackIdentityClosure: null,
      connection: null,
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
      lastErrorCode: null,
    }),
  };
  const feishu = {
    createOrReuse: vi.fn().mockResolvedValue(feishuAttempt),
    get: vi.fn().mockResolvedValue(feishuAttempt),
    cancel: vi.fn().mockResolvedValue({ ...feishuAttempt, state: "canceled", errorCode: "FEISHU_SETUP_CANCELED" }),
  };
  const slack = {
    get: vi.fn().mockResolvedValue(slackConfiguration),
    configure: vi.fn().mockResolvedValue(slackConfigurationResult),
  };
  return { imBindings, feishu, slack };
}

describe("ImBinding HTTP API", () => {
  it("serves Feishu setup, generic diagnostics, and one stateless Slack configuration endpoint", async () => {
    const service = services();
    service.imBindings.getConfigForAgent.mockResolvedValueOnce(undefined);
    const app = createApp({
      authService: authService(),
      imBindingService: service.imBindings as unknown as ImBindingService,
      feishuSetupService: service.feishu as unknown as FeishuSetupService,
      slackConfigurationService: service.slack as unknown as SlackConfigurationService,
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
    expect(handoff.json()).toEqual({ bindingState: "active", handoffReady: false });

    const createFeishu = await app.inject({
      method: "POST",
      url: agentFeishuSetupAttemptsPath(agentId),
      headers: authorization,
      payload: { intent: "create" },
    });
    expect(createFeishu.statusCode).toBe(201);
    expect(createFeishu.json()).toEqual(feishuAttempt);
    expect(
      (await app.inject({ method: "GET", url: feishuSetupAttemptPath(attemptId), headers: authorization })).json(),
    ).toEqual(feishuAttempt);
    expect(
      (await app.inject({ method: "GET", url: imBindingDiagnosticsPath(imBindingId), headers: authorization })).json(),
    ).toMatchObject({ provider: "feishu", ready: false, slackAppId: null });

    const guide = await app.inject({
      method: "GET",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
    });
    expect(guide.statusCode).toBe(200);
    expect(guide.json()).toEqual(slackConfiguration);

    const input = {
      intent: "create",
      expectedBinding: null,
      appId: "A1",
      botAccessToken: "xoxb-secret-token",
      signingSecret: "signing-secret",
    };
    const configured = await app.inject({
      method: "PUT",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
      payload: input,
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toEqual(slackConfigurationResult);
    expect(service.slack.configure).toHaveBeenCalledWith(userId, agentId, input);
    expect(service.imBindings.getConfigForAgent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(configured.json())).not.toMatch(/xoxb|signing-secret/);

    expect(
      (await app.inject({ method: "POST", url: imBindingDisablePath(imBindingId), headers: authorization })).statusCode,
    ).toBe(204);
    expect(service.imBindings.disable).toHaveBeenCalledWith(userId, imBindingId);
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

  it("returns Slack configuration failures through the public typed error contract", async () => {
    const service = services();
    service.slack.configure = vi
      .fn()
      .mockRejectedValue(
        new SlackConfigurationServiceError("SLACK_AUTH_INVALID", 400, "Slack rejected the token", "credential"),
      );
    const app = createApp({
      authService: authService(),
      imBindingService: service.imBindings as unknown as ImBindingService,
      slackConfigurationService: service.slack as unknown as SlackConfigurationService,
    });
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
      payload: {
        intent: "create",
        expectedBinding: null,
        appId: "A1",
        botAccessToken: "xoxb-invalid",
        signingSecret: "signing-secret",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "SLACK_AUTH_INVALID", category: "credential" });
    expect(JSON.stringify(response.json())).not.toMatch(/xoxb-invalid|signing-secret|stack/);

    service.slack.configure.mockRejectedValueOnce(
      new SlackConfigurationServiceError(
        "SLACK_AUTH_IDENTITY_INCOMPLETE",
        400,
        "Slack token has no Bot identity",
        "credential",
      ),
    );
    const userToken = await app.inject({
      method: "PUT",
      url: agentSlackConfigurationPath(agentId),
      headers: authorization,
      payload: {
        intent: "create",
        expectedBinding: null,
        appId: "A1",
        botAccessToken: "xoxp-user-token",
        signingSecret: "signing-secret",
      },
    });
    expect(userToken.statusCode).toBe(400);
    expect(userToken.json().error).toMatchObject({
      code: "SLACK_AUTH_IDENTITY_INCOMPLETE",
      category: "credential",
    });
    expect(JSON.stringify(userToken.json())).not.toMatch(/xoxp-user-token|signing-secret|stack/);
  });
});
