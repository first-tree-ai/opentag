import {
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingHandoffPath,
  agentImBindingPath,
  agentSlackOAuthStartPath,
  FEISHU_REQUIRED_TENANT_SCOPES,
  feishuSetupAttemptPath,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  accountComputers,
  computerCredentials,
  computers,
  imBindings,
  sessionPlacements,
  sessions,
  slackInstallations,
  workspaceComputers,
} from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { FeishuOperationError, type FeishuSetupService } from "../services/im-bindings/feishu/index.js";
import {
  disableImBindingInTransaction,
  isImBindingUniqueViolation,
} from "../services/im-bindings/im-binding-service.js";
import type { ImBindingService } from "../services/im-bindings/index.js";
import { ImBindingServiceError, ImBindingService as RealImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";
import { bootstrapTestAccount } from "./test-account.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
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
  grantedCapabilities: [
    "app_mentions:read",
    "channels:history",
    "chat:write",
    "files:read",
    "groups:history",
    "im:history",
    "mpim:history",
  ],
  reauthorizationRequired: false,
  lastErrorCode: null,
};

const apps: ReturnType<typeof createApp>[] = [];

let unitDatabase: UnitDatabase;
const fixedNow = new Date("2026-08-19T00:00:00.000Z");

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unitDatabase?.close();
});

beforeEach(async () => {
  await unitDatabase?.reset();
});

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function persistedFixture() {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Admin",
    email: `admin-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await unitDatabase.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [workspaceComputer] = await unitDatabase.database
    .insert(workspaceComputers)
    .values({
      workspaceId: bootstrap.workspaceId,
      computerId: computer.id,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
      enrolledByUserId: bootstrap.userId,
    })
    .returning();
  if (!workspaceComputer) throw new Error("Workspace Computer fixture was not created");
  await unitDatabase.database.insert(accountComputers).values({
    id: workspaceComputer.id,
    ownerAccountId: bootstrap.userId,
    currentInstallationId: computer.id,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.1",
  });
  await unitDatabase.database.insert(computerCredentials).values({
    computerId: workspaceComputer.id,
    secretHash: `im-binding-${computer.id}`,
    issuedByUserId: bootstrap.userId,
  });
  const agent = await new AgentService(unitDatabase.database).createForAccount(bootstrap.userId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: workspaceComputer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const service = new RealImBindingService(unitDatabase.database, cipher, {
    now: () => fixedNow,
    imCliReadiness: () => "ready",
    credentialExecutionReadiness: () => ({ status: "ready" }),
  });
  return { bootstrap, agent, cipher, service, computer, workspaceComputer };
}

function slackInput(agentId: string, overrides: Partial<Parameters<RealImBindingService["activateSlack"]>[0]> = {}) {
  return {
    intent: "create" as const,
    agentId,
    appId: "A1",
    teamId: "T1",
    botUserId: "U1",
    grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    botAccessToken: "xoxb-secret",
    signingSecret: "signing-secret",
    installedAt: fixedNow,
    ...overrides,
  };
}

function feishuInput(agentId: string, overrides: Partial<Parameters<RealImBindingService["activateFeishu"]>[0]> = {}) {
  return {
    agentId,
    appId: "cli_1",
    teamId: "tenant_1",
    botOpenId: "ou_bot",
    appSecret: "app-secret",
    grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    ...overrides,
  };
}

async function createSiblingAgent(value: Awaited<ReturnType<typeof persistedFixture>>, name: string) {
  return new AgentService(unitDatabase.database).createForAccount(value.bootstrap.userId, {
    name,
    displayName: name,
    runtimeProvider: "codex",
    computerId: value.workspaceComputer.id,
  });
}

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
      credentialExecutionReadiness: "unconfirmed",
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
  return { imBindings, feishu };
}

describe("ImBinding HTTP API", () => {
  it("serves Feishu setup, generic diagnostics, and disable without a Slack configuration route", async () => {
    const service = services();
    service.imBindings.getConfigForAgent.mockResolvedValueOnce(undefined);
    const app = createApp({
      authService: authService(),
      imBindingService: service.imBindings as unknown as ImBindingService,
      feishuSetupService: service.feishu as unknown as FeishuSetupService,
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
    const canceled = await app.inject({
      method: "POST",
      url: `${feishuSetupAttemptPath(attemptId)}/cancel`,
      headers: authorization,
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ state: "canceled", errorCode: "FEISHU_SETUP_CANCELED" });
    expect(service.feishu.cancel).toHaveBeenCalledWith(userId, attemptId);
    expect(
      (await app.inject({ method: "GET", url: imBindingDiagnosticsPath(imBindingId), headers: authorization })).json(),
    ).toMatchObject({ provider: "feishu", ready: false, slackAppId: null });

    const missingGuide = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/im-binding/slack/configuration`,
      headers: authorization,
    });
    expect(missingGuide.statusCode).toBe(404);
    const missingWrite = await app.inject({
      method: "PUT",
      url: `/api/v1/agents/${agentId}/im-binding/slack/configuration`,
      headers: authorization,
      payload: {
        intent: "create",
        expectedBinding: null,
        appId: "A1",
        botAccessToken: "xoxb-secret-token",
        signingSecret: "signing-secret",
      },
    });
    expect(missingWrite.statusCode).toBe(404);
    expect(JSON.stringify(missingWrite.json())).not.toMatch(/xoxb|signing-secret/);

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

  it("answers an Agent with no Computer with a conflict the Account can act on", async () => {
    // The refusal is deterministic and permanent until a Computer is bound, so it must not reach the
    // Account as an internal failure -- which is what an error code outside the published set
    // becomes when the envelope refuses to carry it.
    const service = services();
    service.feishu.createOrReuse = vi
      .fn()
      .mockRejectedValue(
        new ImBindingServiceError(
          "AGENT_COMPUTER_NOT_BOUND",
          409,
          "The Agent must be bound to a Computer before messaging can be connected",
        ),
      );
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
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "AGENT_COMPUTER_NOT_BOUND", category: "deterministic" });
  });

  it("requires authentication to start Slack OAuth", async () => {
    const app = createApp({
      authService: authService(),
      slackOAuth: {
        authService: authService(),
        publicOrigin: "https://opentag.example.com",
        secureCookies: true,
        slackOAuth: { start: vi.fn(), callback: vi.fn() } as never,
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: agentSlackOAuthStartPath(agentId),
      payload: { intent: "create" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("ImBindingService persistence", () => {
  it("activates Feishu, projects material, readiness, diagnostics, and activity", async () => {
    const value = await persistedFixture();
    expect(await value.service.getAgentWorkspaceComputerId(value.agent.id)).toBe(value.workspaceComputer.id);
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    const material = await value.service.getFeishuConnectionMaterial(bindingId);
    expect(material).toMatchObject({
      imBindingId: bindingId,
      generation: 1,
      appId: "cli_1",
      teamId: "tenant_1",
      botOpenId: "ou_bot",
      appSecret: "app-secret",
    });
    expect(material?.grantedScopes).toEqual([...FEISHU_REQUIRED_TENANT_SCOPES].sort());
    expect(await value.service.listFeishuConnectionIds(undefined)).toEqual([bindingId]);
    expect(await value.service.listFeishuConnectionIds(bindingId)).toEqual([]);
    expect(await value.service.getForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
      id: bindingId,
      provider: "feishu",
      bindingState: "active",
    });
    const config = await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id);
    expect(config).toMatchObject({
      id: bindingId,
      identity: { provider: "feishu", appId: "cli_1", botOpenId: "ou_bot" },
      credentialGeneration: 1,
      reauthorizationRequired: false,
    });
    await value.service.recordDiagnosticError(bindingId, "E".repeat(200));
    expect((await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id))?.lastErrorCode).toHaveLength(
      120,
    );
    const diagnostics = await value.service.diagnostics(value.bootstrap.userId, bindingId);
    expect(diagnostics).toMatchObject({
      provider: "feishu",
      credentialStatus: "valid",
      ready: false,
      connection: null,
      lastErrorCode: expect.any(String),
    });
    expect(await value.service.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
      bindingState: "active",
      handoffReady: false,
    });
  });

  it("handles Feishu replacement, identity validation, scope projection, and authorization errors", async () => {
    const value = await persistedFixture();
    await expect(value.service.activateFeishu(feishuInput(crypto.randomUUID()))).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    const first = await value.service.activateFeishu(feishuInput(value.agent.id));
    await expect(
      value.service.activateFeishu(
        feishuInput(value.agent.id, { appId: "cli_1", teamId: "tenant_2", botOpenId: "ou_2" }),
      ),
    ).rejects.toMatchObject({ code: "FEISHU_BINDING_IDENTITY_MISMATCH" });
    await expect(
      value.service.activateFeishu(feishuInput(value.agent.id, { grantedScopes: ["im:message:send_as_bot"] })),
    ).rejects.toMatchObject({ code: "IM_BINDING_SCOPE_REAUTH_REQUIRED" });
    const same = await value.service.activateFeishu(feishuInput(value.agent.id, { teamId: null }));
    expect(same).toBe(first);
    await expect(
      value.service.activateFeishu(feishuInput(value.agent.id, { appId: "cli_1", teamId: "tenant_1" })),
    ).resolves.toBe(first);
    await value.service.disable(value.bootstrap.userId, first);
    await expect(value.service.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toBeUndefined();
    await expect(value.service.disable(value.bootstrap.userId, first)).resolves.toBeUndefined();
    await expect(
      value.service.getConfigForAgent("00000000-0000-0000-0000-000000000000", value.agent.id),
    ).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
    });
  });

  it("routes Slack installations, observes identity closure, and fences generations", async () => {
    const value = await persistedFixture();
    const activated = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    expect(activated).toMatchObject({
      agentId: value.agent.id,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      credentialGeneration: 1,
    });
    expect(await value.service.findSlackInstallationIngress("A1", "T1")).toMatchObject({
      installationId: expect.any(String),
      generation: 1,
      botId: "B1",
      botAccessToken: "xoxb-secret",
    });
    expect(await value.service.findSlackIngressBinding("A1", "T1")).toMatchObject({
      imBindingId: activated.imBindingId,
    });
    expect(await value.service.findSlackInstallationIngressForAgent(value.agent.id)).toBeTruthy();
    expect(await value.service.findSlackIngressBindingForAgent(value.agent.id)).toMatchObject({
      imBindingId: activated.imBindingId,
    });
    expect(await value.service.getSlackConnectionMaterial(activated.imBindingId)).toBeUndefined();
    expect(await value.service.recordSlackObservation(activated.imBindingId, 1)).toBe(true);
    expect(await value.service.recordSlackIdentityClosure(activated.imBindingId, 1)).toBe(true);
    const connection = await value.service.getSlackConnectionMaterial(activated.imBindingId);
    expect(connection).toMatchObject({
      imBindingId: activated.imBindingId,
      generation: 1,
      botId: "B1",
      botAccessToken: "xoxb-secret",
    });
    expect(await value.service.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
      handoffReady: true,
    });
    expect(await value.service.recordSlackObservation(activated.imBindingId, 99)).toBe(false);
    expect(await value.service.recordSlackIdentityClosure(activated.imBindingId, 99)).toBe(false);
    expect(await value.service.requireReauthorization(activated.imBindingId, 1, "SLACK_TOKEN_REVOKED")).toBe(true);
    expect(await value.service.requireReauthorization(activated.imBindingId, 1, "ignored")).toBe(false);
    expect(await value.service.disableFromProvider(activated.imBindingId, 1)).toBe(true);
    expect(await value.service.findSlackInstallationIngress("A1", "T1")).toBeUndefined();
  });

  it("projects Slack configuration details and provider-side reauthorization state", async () => {
    const value = await persistedFixture();
    const activated = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    const config = await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id);
    expect(config).toMatchObject({
      provider: "slack",
      identity: { provider: "slack", appId: "A1", teamId: "T1", botUserId: "U1", appIdEvidence: "configured" },
      credentialGeneration: 1,
      reauthorizationRequired: false,
    });
    await value.service.requireReauthorization(activated.imBindingId, 1, "SLACK_SCOPE_REAUTH_REQUIRED");
    expect(await value.service.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
      bindingState: "reauthorization_required",
      handoffReady: false,
    });
    const diagnostics = await value.service.diagnostics(value.bootstrap.userId, activated.imBindingId);
    expect(diagnostics).toMatchObject({
      provider: "slack",
      slackAppId: { value: "A1", evidence: "configured", ingressMatchRequired: true },
      slackIdentityClosure: { status: "pending" },
      lastErrorCode: "SLACK_SCOPE_REAUTH_REQUIRED",
    });
  });

  it("rejects Slack scope, provider, route, and authorization conflicts", async () => {
    const value = await persistedFixture();
    await expect(
      value.service.activateSlack(slackInput(value.agent.id, { grantedBotScopes: ["chat:write"] }), "B1"),
    ).rejects.toMatchObject({
      code: "IM_BINDING_SCOPE_REAUTH_REQUIRED",
    });
    await expect(value.service.activateSlack(slackInput(crypto.randomUUID()), "B1")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    const feishu = await value.service.activateFeishu(feishuInput(value.agent.id));
    await expect(value.service.activateSlack(slackInput(value.agent.id), "B1")).rejects.toMatchObject({
      code: "IM_BINDING_PROVIDER_IMMUTABLE",
    });
    await value.service.disable(value.bootstrap.userId, feishu);
    const first = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    await expect(value.service.activateSlack(slackInput(value.agent.id), "B1")).rejects.toMatchObject({
      code: "SLACK_CONFIGURATION_CONFLICT",
    });
    const reauth = await value.service.activateSlack(slackInput(value.agent.id, { intent: "reauthorize" }), "B1");
    expect(reauth.credentialGeneration).toBe(2);
    const replacement = await value.service.activateSlack(
      slackInput(value.agent.id, { intent: "reauthorize", appId: "A2", teamId: "T2" }),
      "B2",
    );
    expect(replacement.credentialGeneration).toBe(1);
    expect(first.imBindingId).toBe(reauth.imBindingId);
  });

  it("rejects provider identities already owned by another Agent", async () => {
    const value = await persistedFixture();
    const sibling = await createSiblingAgent(value, "sibling");
    await value.service.activateFeishu(feishuInput(value.agent.id));
    await expect(value.service.activateFeishu(feishuInput(sibling.id))).rejects.toMatchObject({
      code: "FEISHU_APP_ALREADY_BOUND",
    });
    await value.service.disable(
      value.bootstrap.userId,
      (await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id))?.id ?? "",
    );
    await value.service.activateSlack(slackInput(value.agent.id), "B1");
    await expect(value.service.activateSlack(slackInput(sibling.id), "B1")).rejects.toMatchObject({
      code: "SLACK_APP_TEAM_ALREADY_BOUND",
    });
  });

  it("reports Feishu connection readiness states and missing scope projections", async () => {
    const value = await persistedFixture();
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    await unitDatabase.database
      .update(imBindings)
      .set({
        grantedCapabilities: ["im:message:send_as_bot"],
        connectionOwnerInstanceId: crypto.randomUUID(),
        observedAt: fixedNow,
        observedConnectedAt: fixedNow,
        connectionLeaseExpiresAt: new Date(fixedNow.getTime() + 60_000),
      })
      .where(eq(imBindings.id, bindingId));
    const config = await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id);
    expect(config).toMatchObject({
      bindingState: "reauthorization_required",
      lastErrorCode: "FEISHU_SCOPE_REAUTH_REQUIRED",
    });
    const diagnostics = await value.service.diagnostics(value.bootstrap.userId, bindingId);
    expect(diagnostics).toMatchObject({
      connection: { state: "connected", observedAt: fixedNow.toISOString() },
      reauthorizationRequired: true,
      missingCapabilities: expect.arrayContaining(["im:message", "im:chat:readonly"]),
    });
    const noRuntime = new RealImBindingService(unitDatabase.database, value.cipher, {
      now: () => fixedNow,
      agentRuntimeReadiness: () => "unavailable",
      imCliReadiness: () => "install",
    });
    expect(await noRuntime.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
      handoffReady: false,
    });
  });

  it("projects invalid credentials and safe unique-violation detection", async () => {
    const value = await persistedFixture();
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    await unitDatabase.database
      .update(imBindings)
      .set({ encryptedCredential: "broken" })
      .where(eq(imBindings.id, bindingId));
    const config = await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id);
    expect(config).toMatchObject({ reauthorizationRequired: true, lastErrorCode: "IM_BINDING_CREDENTIAL_INVALID" });
    await expect(value.service.getFeishuConnectionMaterial(bindingId)).resolves.toBeUndefined();
    const chain = { code: "23505", constraint_name: "target", cause: { code: "23505", constraint_name: "other" } };
    expect(isImBindingUniqueViolation(chain, "target")).toBe(true);
    expect(isImBindingUniqueViolation({ cause: chain }, "missing")).toBe(false);
  });

  it("enforces creator authority and disables active sessions", async () => {
    const value = await persistedFixture();
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    const [session] = await unitDatabase.database
      .insert(sessions)
      .values({
        imBindingId: bindingId,
        channelId: "C1",
        conversationKind: "channel",
        kind: "channel",
        revision: 1,
        createdAt: fixedNow,
      })
      .returning();
    expect(session).toBeTruthy();
    await value.service.disable(value.bootstrap.userId, bindingId);
    const rows = await unitDatabase.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, session?.id ?? ""));
    expect(rows[0]?.endedAt).toEqual(fixedNow);
    await expect(
      value.service.assertCanManage("00000000-0000-0000-0000-000000000000", value.agent.id),
    ).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
    });
  });

  it("issues versioned runtime credential grants and rejects stale authority", async () => {
    const value = await persistedFixture();
    const activated = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    await value.service.recordSlackIdentityClosure(activated.imBindingId, 1);
    const [session] = await unitDatabase.database
      .insert(sessions)
      .values({
        imBindingId: activated.imBindingId,
        channelId: "C-credential",
        conversationKind: "channel",
        kind: "channel",
        createdAt: fixedNow,
      })
      .returning();
    if (!session) throw new Error("Session fixture was not created");
    await unitDatabase.database.insert(sessionPlacements).values({
      sessionId: session.id,
      workspaceComputerId: value.workspaceComputer.id,
      computerId: value.workspaceComputer.id,
      generation: 1,
    });
    const request = {
      type: "im:credential" as const,
      requestId: crypto.randomUUID(),
      sessionId: session.id,
      agentId: value.agent.id,
      placementGeneration: 1,
    };
    const auth = {
      computerId: value.computer.id,
      workspaceComputerId: value.workspaceComputer.id,
      workspaceId: value.bootstrap.workspaceId,
    };
    await expect(value.service.issueRuntimeCredentialGrant(request, auth)).resolves.toMatchObject({
      status: "succeeded",
      grant: { provider: "slack", botAccessToken: "xoxb-secret" },
    });
    await expect(
      value.service.issueRuntimeCredentialGrant(request, { ...auth, imCredentialGrantVersion: 2 }),
    ).resolves.toMatchObject({
      status: "succeeded",
      outboxContext: { provider: "slack", sessionKind: "channel", channelId: "C-credential" },
    });
    const providerCliUnready = new RealImBindingService(unitDatabase.database, value.cipher, {
      now: () => fixedNow,
      imCliReadiness: () => "checking",
      credentialExecutionReadiness: () => ({ status: "ready" }),
    });
    await expect(
      providerCliUnready.issueRuntimeCredentialGrant({ ...request, requestId: crypto.randomUUID() }, auth),
    ).resolves.toMatchObject({ status: "rejected", code: "provider_cli_unready" });
    await expect(
      value.service.issueRuntimeCredentialGrant({ ...request, placementGeneration: 2 }, auth),
    ).resolves.toMatchObject({ status: "rejected", code: "placement_stale" });
    await expect(
      value.service.issueRuntimeCredentialGrant({ ...request, agentId: crypto.randomUUID() }, auth),
    ).resolves.toMatchObject({ status: "rejected", code: "agent_mismatch" });
    await unitDatabase.database.update(sessions).set({ endedAt: fixedNow }).where(eq(sessions.id, session.id));
    await expect(
      value.service.issueRuntimeCredentialGrant({ ...request, requestId: crypto.randomUUID() }, auth),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "placement_stale",
    });
    await unitDatabase.database.update(sessions).set({ endedAt: null }).where(eq(sessions.id, session.id));
    await unitDatabase.database
      .update(imBindings)
      .set({ status: "reauthorization_required" })
      .where(eq(imBindings.id, activated.imBindingId));
    await expect(
      value.service.issueRuntimeCredentialGrant({ ...request, requestId: crypto.randomUUID() }, auth),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "binding_inactive",
    });
  });

  it("issues Feishu grants with outbox context and validates material shape", async () => {
    const value = await persistedFixture();
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id, { teamBrand: "lark" }));
    const [session] = await unitDatabase.database
      .insert(sessions)
      .values({
        imBindingId: bindingId,
        channelId: "C-feishu",
        conversationKind: "channel",
        kind: "thread",
        threadKey: "thread-1",
        createdAt: fixedNow,
      })
      .returning();
    if (!session) throw new Error("Thread fixture was not created");
    await unitDatabase.database.insert(sessionPlacements).values({
      sessionId: session.id,
      workspaceComputerId: value.workspaceComputer.id,
      computerId: value.workspaceComputer.id,
      generation: 1,
    });
    const request = {
      type: "im:credential" as const,
      requestId: crypto.randomUUID(),
      sessionId: session.id,
      agentId: value.agent.id,
      placementGeneration: 1,
    };
    const auth = {
      computerId: value.computer.id,
      workspaceComputerId: value.workspaceComputer.id,
      workspaceId: value.bootstrap.workspaceId,
      imCredentialGrantVersion: 2 as const,
    };
    await expect(value.service.issueRuntimeCredentialGrant(request, auth)).resolves.toMatchObject({
      status: "succeeded",
      grant: { provider: "feishu", appId: "cli_1", appSecret: "app-secret", teamBrand: "lark" },
      outboxContext: { provider: "feishu", sessionKind: "thread", chatId: "C-feishu", threadId: "thread-1" },
    });
    await unitDatabase.database.update(imBindings).set({ externalAppId: "wrong" }).where(eq(imBindings.id, bindingId));
    await expect(
      value.service.issueRuntimeCredentialGrant({ ...request, requestId: crypto.randomUUID() }, auth),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "credential_stale",
    });
  });

  it("covers legacy grant output and disconnected readiness projections", async () => {
    const value = await persistedFixture();
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    const [session] = await unitDatabase.database
      .insert(sessions)
      .values({ imBindingId: bindingId, channelId: "C-legacy", conversationKind: "channel", kind: "channel" })
      .returning();
    if (!session) throw new Error("Session fixture was not created");
    await unitDatabase.database.insert(sessionPlacements).values({
      sessionId: session.id,
      workspaceComputerId: value.workspaceComputer.id,
      computerId: value.workspaceComputer.id,
      generation: 1,
    });
    const request = {
      type: "im:credential" as const,
      requestId: crypto.randomUUID(),
      sessionId: session.id,
      agentId: value.agent.id,
      placementGeneration: 1,
    };
    await expect(
      value.service.issueRuntimeCredentialGrant(request, {
        computerId: value.computer.id,
        workspaceComputerId: value.workspaceComputer.id,
        workspaceId: value.bootstrap.workspaceId,
      }),
    ).resolves.toMatchObject({ status: "succeeded", grant: { provider: "feishu" } });
    await unitDatabase.database
      .update(imBindings)
      .set({
        connectionOwnerInstanceId: crypto.randomUUID(),
        observedAt: fixedNow,
        observedConnectedAt: null,
        connectionLeaseExpiresAt: new Date(fixedNow.getTime() - 1),
      })
      .where(eq(imBindings.id, bindingId));
    expect(await value.service.diagnostics(value.bootstrap.userId, bindingId)).toMatchObject({
      connection: { state: "disconnected" },
    });
  });

  it("rejects unready Slack grants and handles missing installation credentials", async () => {
    const value = await persistedFixture();
    const activated = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    const [session] = await unitDatabase.database
      .insert(sessions)
      .values({
        imBindingId: activated.imBindingId,
        channelId: "C-slack-unready",
        conversationKind: "channel",
        kind: "channel",
        createdAt: fixedNow,
      })
      .returning();
    if (!session) throw new Error("Session fixture was not created");
    await unitDatabase.database.insert(sessionPlacements).values({
      sessionId: session.id,
      workspaceComputerId: value.workspaceComputer.id,
      computerId: value.workspaceComputer.id,
      generation: 1,
    });
    const request = {
      type: "im:credential" as const,
      requestId: crypto.randomUUID(),
      sessionId: session.id,
      agentId: value.agent.id,
      placementGeneration: 1,
    };
    const auth = {
      computerId: value.computer.id,
      workspaceComputerId: value.workspaceComputer.id,
      workspaceId: value.bootstrap.workspaceId,
    };
    await expect(value.service.issueRuntimeCredentialGrant(request, auth)).resolves.toMatchObject({
      status: "rejected",
      code: "binding_inactive",
    });
    const installationId = (await value.service.findSlackInstallationIngress("A1", "T1"))?.installationId;
    const [installation] = await unitDatabase.database
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.id, installationId ?? ""));
    if (!installation) throw new Error("Slack installation fixture was not created");
    await unitDatabase.database
      .update(slackInstallations)
      .set({ observedAt: fixedNow, observedConnectedAt: fixedNow, encryptedCredential: "broken" })
      .where(eq(slackInstallations.id, installation.id));
    await expect(
      value.service.issueRuntimeCredentialGrant({ ...request, requestId: crypto.randomUUID() }, auth),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "credential_stale",
    });
    await unitDatabase.database
      .update(imBindings)
      .set({ status: "provisioning", slackInstallationId: null })
      .where(eq(imBindings.id, activated.imBindingId));
    expect(await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
      provider: "slack",
      reauthorizationRequired: false,
    });
  });

  it("enforces provider immutability in the Feishu activation path", async () => {
    const value = await persistedFixture();
    await value.service.activateSlack(slackInput(value.agent.id), "B1");
    await expect(value.service.activateFeishu(feishuInput(value.agent.id))).rejects.toMatchObject({
      code: "IM_BINDING_PROVIDER_IMMUTABLE",
    });
  });

  it("requires a configured route before Slack reauthorization", async () => {
    const value = await persistedFixture();
    const activated = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    await unitDatabase.database
      .update(imBindings)
      .set({ status: "provisioning" })
      .where(eq(imBindings.id, activated.imBindingId));
    await expect(
      value.service.activateSlack(slackInput(value.agent.id, { intent: "reauthorize" }), "B1"),
    ).rejects.toMatchObject({ code: "SLACK_CONFIGURATION_CONFLICT" });
  });

  it("rejects missing and malformed rows while preserving deterministic errors", async () => {
    const value = await persistedFixture();
    await expect(value.service.disable(value.bootstrap.userId, crypto.randomUUID())).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
    });
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    await unitDatabase.database
      .update(imBindings)
      .set({ credentialSchemaVersion: 2 })
      .where(eq(imBindings.id, bindingId));
    expect(await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
      reauthorizationRequired: true,
      lastErrorCode: "IM_BINDING_CREDENTIAL_INVALID",
    });
    await unitDatabase.database
      .update(imBindings)
      .set({ credentialSchemaVersion: 1, encryptedCredential: "broken" })
      .where(eq(imBindings.id, bindingId));
    expect(await value.service.getConfigForAgent(value.bootstrap.userId, value.agent.id)).toMatchObject({
      reauthorizationRequired: true,
      lastErrorCode: "IM_BINDING_CREDENTIAL_INVALID",
    });
    await expect(value.service.diagnostics(value.bootstrap.userId, crypto.randomUUID())).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
    });
  });

  it("handles Slack reauthorization replacement and orphan installation cleanup", async () => {
    const value = await persistedFixture();
    const first = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    const replacement = await value.service.activateSlack(
      slackInput(value.agent.id, { intent: "reauthorize", appId: "A2", teamId: "T2", botUserId: "U2" }),
      "B2",
    );
    expect(replacement.imBindingId).not.toBe(first.imBindingId);
    const [oldRoute] = await unitDatabase.database
      .select()
      .from(imBindings)
      .where(eq(imBindings.id, first.imBindingId));
    expect(oldRoute?.status).toBe("disabled");
    const [oldInstallation] = await unitDatabase.database
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.externalAppId, "A1"));
    expect(oldInstallation?.replacementSlackInstallationId).toBeTruthy();
    await value.service.disable(value.bootstrap.userId, replacement.imBindingId);
    expect(
      await value.service.disableSlackInstallationFromProvider(oldInstallation?.id ?? crypto.randomUUID(), 999),
    ).toBe(false);
  });

  it("returns no Slack route when an installation has no current route", async () => {
    const value = await persistedFixture();
    const activated = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    const [installation] = await unitDatabase.database
      .select()
      .from(slackInstallations)
      .where(
        eq(slackInstallations.id, (await value.service.findSlackInstallationIngress("A1", "T1"))?.installationId ?? ""),
      );
    expect(installation).toBeTruthy();
    await value.service.disable(value.bootstrap.userId, activated.imBindingId);
    expect(await value.service.resolveSlackDefaultRoute(installation?.id ?? crypto.randomUUID())).toBeUndefined();
  });

  it("releases an unused Slack installation when disabling a route in a transaction", async () => {
    const value = await persistedFixture();
    const activated = await value.service.activateSlack(slackInput(value.agent.id), "B1");
    await unitDatabase.database.transaction(async (transaction) => {
      expect(await disableImBindingInTransaction(transaction, activated.imBindingId, fixedNow)).toBe(true);
    });
    const [route] = await unitDatabase.database
      .select()
      .from(imBindings)
      .where(eq(imBindings.id, activated.imBindingId));
    expect(route?.status).toBe("disabled");
    const installations = await unitDatabase.database.select().from(slackInstallations);
    expect(installations[0]?.status).toBe("disabled");
    expect(installations[0]?.encryptedCredential).toBeNull();
  });

  it("notifies Provider CLI reconcile only after an owned transaction commits", async () => {
    const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
      displayName: "Admin",
      email: `admin-${crypto.randomUUID()}@example.com`,
    });
    const [computer] = await unitDatabase.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
    if (!computer) throw new Error("Computer fixture was not created");
    const [workspaceComputer] = await unitDatabase.database
      .insert(workspaceComputers)
      .values({
        workspaceId: bootstrap.workspaceId,
        computerId: computer.id,
        displayName: "workstation",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
        enrolledByUserId: bootstrap.userId,
      })
      .returning();
    if (!workspaceComputer) throw new Error("Workspace Computer fixture was not created");
    await unitDatabase.database.insert(accountComputers).values({
      id: workspaceComputer.id,
      ownerAccountId: bootstrap.userId,
      currentInstallationId: computer.id,
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    });
    const agent = await new AgentService(unitDatabase.database).createForAccount(bootstrap.userId, {
      name: "assistant",
      displayName: "Assistant",
      runtimeProvider: "codex",
      computerId: workspaceComputer.id,
    });
    const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
    const changed = vi.fn();
    const service = new RealImBindingService(unitDatabase.database, cipher, {
      now: () => fixedNow,
      onActiveBindingChanged: changed,
    });
    const bindingId = await unitDatabase.database.transaction(async (transaction) => {
      const id = await service.activateFeishu(feishuInput(agent.id), transaction);
      expect(changed).not.toHaveBeenCalled();
      return id;
    });
    expect(changed).not.toHaveBeenCalled();
    await service.notifyProviderCliRequirementChanged(agent.id);
    expect(changed).toHaveBeenCalledWith({
      agentId: agent.id,
      workspaceComputerId: workspaceComputer.id,
    });
    changed.mockClear();
    await service.disable(bootstrap.userId, bindingId);
    expect(changed).toHaveBeenCalledWith({
      agentId: agent.id,
      workspaceComputerId: workspaceComputer.id,
    });
    const slack = await service.activateSlack(slackInput(agent.id), "B1");
    changed.mockClear();
    await expect(service.requireReauthorization(slack.imBindingId, 1, "SLACK_TOKEN_REVOKED")).resolves.toBe(true);
    expect(changed).toHaveBeenCalledWith({
      agentId: agent.id,
      workspaceComputerId: workspaceComputer.id,
    });
  });

  it("fails closed when Provider CLI observation callbacks are omitted", async () => {
    const value = await persistedFixture();
    const closed = new RealImBindingService(unitDatabase.database, value.cipher, { now: () => fixedNow });
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    await unitDatabase.database
      .update(imBindings)
      .set({
        connectionOwnerInstanceId: crypto.randomUUID(),
        observedAt: fixedNow,
        observedConnectedAt: fixedNow,
        connectionLeaseExpiresAt: new Date(fixedNow.getTime() + 60_000),
      })
      .where(eq(imBindings.id, bindingId));
    await expect(closed.getHandoffForAgent(value.bootstrap.userId, value.agent.id)).resolves.toMatchObject({
      bindingState: "active",
      handoffReady: false,
      providerCli: { phase: "preparing_cli" },
    });
    await expect(closed.diagnostics(value.bootstrap.userId, bindingId)).resolves.toMatchObject({
      providerCliReadiness: "checking",
      credentialExecutionReadiness: "unconfirmed",
      ready: false,
    });
  });

  it("refuses a validation grant when the Computer installation no longer matches", async () => {
    const value = await persistedFixture();
    const bindingId = await value.service.activateFeishu(feishuInput(value.agent.id));
    await expect(
      value.service.issueIntegrationCliValidationGrant({
        agentId: value.agent.id,
        computerId: crypto.randomUUID(),
        credentialGeneration: 1,
        integrationId: bindingId,
        provider: "feishu",
        workspaceComputerId: value.workspaceComputer.id,
      }),
    ).resolves.toBeUndefined();
    await expect(
      value.service.issueIntegrationCliValidationGrant({
        agentId: value.agent.id,
        computerId: value.computer.id,
        credentialGeneration: 1,
        integrationId: bindingId,
        provider: "feishu",
        workspaceComputerId: value.workspaceComputer.id,
      }),
    ).resolves.toMatchObject({ grant: { provider: "feishu" } });
  });
});
