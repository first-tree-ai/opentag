import {
  agentSlackOAuthStartPath,
  FEISHU_REQUIRED_TENANT_SCOPES,
  SLACK_OAUTH_CALLBACK_PATH,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import { createApp } from "../app.js";
import { computerCredentials, computers, slackOAuthNonces } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { AuthServiceError } from "../services/auth/errors.js";
import type { UserAuthService } from "../services/auth/index.js";
import { hashSecret } from "../services/auth/security.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ImBindingService, ImBindingServiceError } from "../services/im-bindings/index.js";
import {
  type SlackApiClient,
  SlackConfigurationService,
  SlackConfigurationServiceError,
  type SlackInstallationInspection,
  SlackOAuthService,
} from "../services/im-bindings/slack/index.js";
import { SlackOAuthStateService } from "../services/im-bindings/slack/oauth-state.js";
import { signedInBrowser } from "./signed-in-browser.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const secret = "slack-oauth-state-secret-that-is-at-least-32-characters";
const now = new Date("2026-08-19T00:00:00.000Z");
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const apps: ReturnType<typeof createApp>[] = [];
let oauthDatabase: UnitDatabase;

beforeAll(async () => {
  oauthDatabase = await createUnitDatabase();
}, 60_000);
afterAll(async () => oauthDatabase?.close());
beforeEach(async () => oauthDatabase?.reset());
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function oauthFixture() {
  const bootstrap = await bootstrapTestAccount(oauthDatabase.database, {
    displayName: "OAuth Admin",
    email: `oauth-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await oauthDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "oauth-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  await oauthDatabase.database.insert(computerCredentials).values({
    computerId: computer.id,
    secretHash: `slack-oauth-${computer.id}`,
    issuedByUserId: bootstrap.userId,
  });
  const agent = await new AgentService(oauthDatabase.database).createForAccount(bootstrap.userId, {
    name: "oauth-agent",
    displayName: "OAuth Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindingService = new ImBindingService(oauthDatabase.database, cipher, { now: () => now });
  return { bootstrap, agent, computerId: computer.id, cipher, imBindingService };
}

function inspection(overrides: Partial<SlackInstallationInspection> = {}): SlackInstallationInspection {
  return {
    appId: "A1",
    teamId: "T1",
    enterpriseId: null,
    botUserId: "U1",
    botId: "B1",
    grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    ...overrides,
  };
}

function apiClient(): {
  api: SlackApiClient;
  inspectInstallation: ReturnType<typeof vi.fn>;
  oauthAccess: ReturnType<typeof vi.fn>;
} {
  const inspectInstallation = vi.fn();
  const oauthAccess = vi.fn();
  return {
    api: { inspectInstallation, oauthAccess } as unknown as SlackApiClient,
    inspectInstallation,
    oauthAccess,
  };
}

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn().mockResolvedValue({
      user: { id: userId, email: "admin@example.com", displayName: "Admin" },
      setupCompletedAt: null,
    }),
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

describe("SlackOAuthStateService", () => {
  it("signs a one-time nonce bound to account, exact Agent, intent, surface, and expected generation", async () => {
    const service = new SlackOAuthStateService(secret, { now: () => now });
    expect(service.ttlSeconds).toBe(10 * 60);
    const issued = await service.issue({
      userId,
      context: {
        agentId,
        intent: "reauthorize",
        returnSurface: "agent-setup",
        expectedMessaging: {
          kind: "bound",
          provider: "slack",
          bindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
          credentialGeneration: 4,
        },
      },
    });
    const payload = decodeJwt(issued.state);
    expect(payload).toMatchObject({
      userId,
      context: {
        agentId,
        intent: "reauthorize",
        returnSurface: "agent-setup",
        expectedMessaging: {
          kind: "bound",
          provider: "slack",
          bindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
          credentialGeneration: 4,
        },
      },
    });
    expect(payload).not.toHaveProperty("botAccessToken");
    expect(payload).not.toHaveProperty("signingSecret");
    expect(payload).not.toHaveProperty("returnUrl");
    expect(issued.nonceHash).toBe(hashSecret(String(payload.nonce)));
    expect(issued.payload.sessionBindingHash).toBe(hashSecret(issued.sessionBinding));
    await expect(service.verify(issued.state, issued.sessionBinding)).resolves.toMatchObject({
      userId,
      context: { agentId, intent: "reauthorize", returnSurface: "agent-setup" },
    });
  });

  it("refuses to sign a context that violates the OAuth context contract", async () => {
    const service = new SlackOAuthStateService(secret, { now: () => now });
    await expect(
      service.issue({
        userId,
        context: {
          agentId,
          intent: "create",
          returnSurface: "agent-setup",
          expectedMessaging: {
            kind: "bound",
            provider: "slack",
            bindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
            credentialGeneration: 1,
          },
        },
      }),
    ).rejects.toThrow("Slack create requires the Agent to remain unbound");
    await expect(
      service.issue({
        userId,
        context: {
          agentId,
          intent: "reauthorize",
          returnSurface: "agent-messaging-settings",
          expectedMessaging: { kind: "unbound" },
        },
      }),
    ).rejects.toThrow("Slack reauthorization requires the exact current Slack binding");
  });

  it("rejects cookie mismatch, expiry, tampering, and substitution", async () => {
    const service = new SlackOAuthStateService(secret, { now: () => now, ttlSeconds: 60 });
    const first = await service.issue({
      userId,
      context: {
        agentId,
        intent: "create",
        returnSurface: "agent-setup",
        expectedMessaging: { kind: "unbound" },
      },
    });
    const second = await service.issue({
      userId,
      context: {
        agentId,
        intent: "reauthorize",
        returnSurface: "agent-messaging-settings",
        expectedMessaging: {
          kind: "bound",
          provider: "slack",
          bindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0",
          credentialGeneration: 1,
        },
      },
    });
    await expect(service.verify(first.state, second.sessionBinding)).rejects.toMatchObject({
      code: "SLACK_OAUTH_FAILED",
    });
    await expect(service.verify(first.state, undefined)).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED" });
    const expired = new SlackOAuthStateService(secret, {
      now: () => new Date("2026-08-19T00:02:00.000Z"),
      ttlSeconds: 60,
    });
    await expect(expired.verify(first.state, first.sessionBinding)).rejects.toMatchObject({
      code: "SLACK_OAUTH_FAILED",
    });
    // A state re-signed by an attacker holding a different key never verifies.
    const forged = await new SlackOAuthStateService("attacker-controlled-signing-key-32-chars", {
      now: () => now,
      ttlSeconds: 60,
    }).issue({
      userId,
      context: {
        agentId,
        intent: "create",
        returnSurface: "agent-setup",
        expectedMessaging: { kind: "unbound" },
      },
    });
    await expect(service.verify(forged.state, forged.sessionBinding)).rejects.toMatchObject({
      code: "SLACK_OAUTH_FAILED",
    });
  });
});

describe("SlackConfigurationService persistence", () => {
  it("reads an empty binding and commits an inspected Slack installation", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    client.inspectInstallation.mockResolvedValue(inspection());
    const before = vi.fn().mockResolvedValue(undefined);
    const after = vi.fn().mockResolvedValue(undefined);
    const notify = vi.spyOn(value.imBindingService, "notifyProviderCliRequirementChanged");
    const service = new SlackConfigurationService({
      api: client.api,
      database: oauthDatabase.database,
      imBindings: value.imBindingService,
      now: () => now,
      beforeConfigurationTransaction: before,
      afterConfigurationTransaction: after,
    });
    await expect(service.currentBinding(value.bootstrap.userId, value.agent.id)).resolves.toBeNull();
    const result = await service.configure(value.bootstrap.userId, value.agent.id, {
      intent: "create",
      expectedBinding: null,
      appId: "A1",
      botAccessToken: "xoxb-token",
      signingSecret: "signing-secret",
    });
    expect(result).toMatchObject({
      agentId: value.agent.id,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      credentialGeneration: 1,
      bindingState: "active",
    });
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(value.agent.id);
    expect(await service.currentBinding(value.bootstrap.userId, value.agent.id)).toEqual({
      id: result.imBindingId,
      credentialGeneration: 1,
    });
  });

  it("maps Slack inspection, identity, and scope failures to safe errors", async () => {
    const value = await oauthFixture();
    const cases = [
      ["SLACK_AUTH_INVALID", "SLACK_AUTH_INVALID"],
      ["SLACK_AUTH_REJECTED", "SLACK_AUTH_INVALID"],
      ["SLACK_AUTH_IDENTITY_INCOMPLETE", "SLACK_AUTH_IDENTITY_INCOMPLETE"],
      ["transport failed", "SLACK_UPSTREAM_UNAVAILABLE"],
    ] as const;
    for (const [message, code] of cases) {
      const client = apiClient();
      client.inspectInstallation.mockRejectedValue(new Error(message));
      const caseService = new SlackConfigurationService({
        api: client.api,
        database: oauthDatabase.database,
        imBindings: value.imBindingService,
      });
      await expect(
        caseService.configure(value.bootstrap.userId, value.agent.id, {
          intent: "create",
          expectedBinding: null,
          appId: "A1",
          botAccessToken: "xoxb-token",
          signingSecret: "signing-secret",
        }),
      ).rejects.toMatchObject({ code });
    }

    const client = apiClient();
    const identityService = new SlackConfigurationService({
      api: client.api,
      database: oauthDatabase.database,
      imBindings: value.imBindingService,
    });
    client.inspectInstallation.mockResolvedValue(inspection({ appId: "A_OTHER" }));
    await expect(
      identityService.configure(value.bootstrap.userId, value.agent.id, {
        intent: "create",
        expectedBinding: null,
        appId: "A1",
        botAccessToken: "xoxb-token",
        signingSecret: "signing-secret",
      }),
    ).rejects.toMatchObject({ code: "SLACK_BINDING_IDENTITY_MISMATCH" });
    client.inspectInstallation.mockResolvedValue(inspection({ grantedBotScopes: ["chat:write"] }));
    await expect(
      identityService.configure(value.bootstrap.userId, value.agent.id, {
        intent: "create",
        expectedBinding: null,
        appId: "A1",
        botAccessToken: "xoxb-token",
        signingSecret: "signing-secret",
      }),
    ).rejects.toMatchObject({ code: "SLACK_SCOPE_REAUTH_REQUIRED" });
  });

  it("enforces unbind-required, intent, and expected-generation conflicts", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    client.inspectInstallation.mockResolvedValue(inspection());
    const service = new SlackConfigurationService({
      api: client.api,
      database: oauthDatabase.database,
      imBindings: value.imBindingService,
    });
    const feishuBindingId = await value.imBindingService.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_feishu",
      teamId: "tenant",
      botOpenId: "ou_bot",
      appSecret: "secret",
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    // A direct cross-Provider start fails closed with the exact binding the Account must unbind first.
    await expect(service.currentBinding(value.bootstrap.userId, value.agent.id)).rejects.toMatchObject({
      code: "IM_BINDING_UNBIND_REQUIRED",
      statusCode: 409,
      unbindRequired: {
        currentProvider: "feishu",
        currentBindingId: feishuBindingId,
        requestedProvider: "slack",
      },
    });
    await expect(
      service.configure(value.bootstrap.userId, value.agent.id, {
        intent: "create",
        expectedBinding: null,
        appId: "A1",
        botAccessToken: "xoxb-token",
        signingSecret: "signing-secret",
      }),
    ).rejects.toMatchObject({
      code: "IM_BINDING_UNBIND_REQUIRED",
      unbindRequired: {
        currentProvider: "feishu",
        currentBindingId: feishuBindingId,
        requestedProvider: "slack",
      },
    });

    const emptyAgent = await new AgentService(oauthDatabase.database).createForAccount(value.bootstrap.userId, {
      name: "oauth-empty-agent",
      displayName: "OAuth Empty Agent",
      runtimeProvider: "codex",
      computerId: value.computerId,
    });
    const emptyClient = apiClient();
    emptyClient.inspectInstallation.mockResolvedValue(inspection());
    const emptyService = new SlackConfigurationService({
      api: emptyClient.api,
      database: oauthDatabase.database,
      imBindings: value.imBindingService,
    });
    await expect(
      emptyService.configure(value.bootstrap.userId, emptyAgent.id, {
        intent: "reauthorize",
        expectedBinding: null,
        appId: "A1",
        botAccessToken: "xoxb-token",
        signingSecret: "signing-secret",
      }),
    ).rejects.toMatchObject({ code: "SLACK_CONFIGURATION_CONFLICT" });
    const configured = await value.imBindingService.activateSlack(
      {
        intent: "create",
        agentId: emptyAgent.id,
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
        botAccessToken: "xoxb-token",
        signingSecret: "signing-secret",
        installedAt: now,
      },
      "B1",
    );
    await expect(
      emptyService.configure(value.bootstrap.userId, emptyAgent.id, {
        intent: "create",
        expectedBinding: { id: configured.imBindingId, credentialGeneration: configured.credentialGeneration },
        appId: "A1",
        botAccessToken: "xoxb-token",
        signingSecret: "signing-secret",
      }),
    ).rejects.toMatchObject({ code: "SLACK_CONFIGURATION_CONFLICT" });
    await expect(
      emptyService.configure(value.bootstrap.userId, emptyAgent.id, {
        intent: "reauthorize",
        expectedBinding: { id: configured.imBindingId, credentialGeneration: 99 },
        appId: "A1",
        botAccessToken: "xoxb-token",
        signingSecret: "signing-secret",
      }),
    ).rejects.toMatchObject({ code: "SLACK_CONFIGURATION_CONFLICT" });
  });
});

describe("SlackOAuthService persistence", () => {
  function createService(
    _value: Awaited<ReturnType<typeof oauthFixture>>,
    client: ReturnType<typeof apiClient>,
    slack: { currentBinding: ReturnType<typeof vi.fn>; configure: ReturnType<typeof vi.fn> },
  ) {
    return new SlackOAuthService({
      api: client.api,
      app: {
        clientId: "client-id",
        clientSecret: "client-secret",
        signingSecret: "signing-secret",
        redirectUrl: "https://opentag.example.com/api/v1/im-bindings/slack/oauth/callback",
      },
      database: oauthDatabase.database,
      slack: slack as never,
      state: new SlackOAuthStateService(secret, { now: () => now }),
      now: () => now,
    });
  }

  it("starts OAuth, persists a nonce, and enforces intent conflicts", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    const slack = {
      currentBinding: vi.fn().mockResolvedValue(null),
      configure: vi.fn(),
    };
    const service = createService(value, client, slack);
    const started = await service.start(value.bootstrap.userId, value.agent.id, "create", "agent-setup");
    expect(started).toMatchObject({
      authorizationUrl: expect.stringContaining("client_id=client-id"),
      expiresAt: "2026-08-19T00:10:00.000Z",
      sessionBinding: expect.any(String),
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    expect(decodeJwt(state)).toMatchObject({
      userId: value.bootstrap.userId,
      context: {
        agentId: value.agent.id,
        intent: "create",
        returnSurface: "agent-setup",
        expectedMessaging: { kind: "unbound" },
      },
    });
    const rows = await oauthDatabase.database.select().from(slackOAuthNonces);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: value.bootstrap.userId,
      agentId: value.agent.id,
      intent: "create",
      expectedBindingId: null,
      expectedCredentialGeneration: null,
    });
    slack.currentBinding.mockResolvedValue({
      id: rows[0]?.expectedBindingId ?? crypto.randomUUID(),
      credentialGeneration: 1,
    });
    await expect(service.start(value.bootstrap.userId, value.agent.id, "create")).rejects.toMatchObject({
      code: "SLACK_CONFIGURATION_CONFLICT",
    });
    slack.currentBinding.mockResolvedValue(null);
    await expect(service.start(value.bootstrap.userId, value.agent.id, "reauthorize")).rejects.toMatchObject({
      code: "SLACK_CONFIGURATION_CONFLICT",
    });
  });

  it("signs the exact current binding generation into a reauthorize state", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    const bindingId = crypto.randomUUID();
    const slack = {
      currentBinding: vi.fn().mockResolvedValue({ id: bindingId, credentialGeneration: 3 }),
      configure: vi.fn(),
    };
    const service = createService(value, client, slack);
    const started = await service.start(value.bootstrap.userId, value.agent.id, "reauthorize");
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    expect(decodeJwt(state)).toMatchObject({
      context: {
        intent: "reauthorize",
        returnSurface: "agent-messaging-settings",
        expectedMessaging: { kind: "bound", provider: "slack", bindingId, credentialGeneration: 3 },
      },
    });
    const [row] = await oauthDatabase.database.select().from(slackOAuthNonces);
    expect(row).toMatchObject({ expectedBindingId: bindingId, expectedCredentialGeneration: 3 });
  });

  it("consumes a valid callback and binds the authenticated user", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    client.oauthAccess.mockResolvedValue({
      appId: "A1",
      teamId: "T1",
      enterpriseId: null,
      botUserId: "U1",
      botId: "B1",
      botAccessToken: "xoxb-token",
    });
    const result = { imBindingId: crypto.randomUUID(), agentId: value.agent.id };
    const slack = {
      currentBinding: vi.fn().mockResolvedValue(null),
      configure: vi.fn().mockResolvedValue(result),
    };
    const service = createService(value, client, slack);
    const started = await service.start(value.bootstrap.userId, value.agent.id, "create", "agent-setup");
    await expect(
      service.callback({
        authenticatedUserId: value.bootstrap.userId,
        code: "oauth-code",
        state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
        sessionBinding: started.sessionBinding,
      }),
    ).resolves.toEqual({ agentId: value.agent.id, returnSurface: "agent-setup", result });
    expect(slack.configure).toHaveBeenCalledWith(
      value.bootstrap.userId,
      value.agent.id,
      expect.objectContaining({ appId: "A1" }),
    );
  });

  it("rejects unauthenticated, mismatched, cancelled, and stale callbacks", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    const slack = { currentBinding: vi.fn().mockResolvedValue(null), configure: vi.fn() };
    const service = createService(value, client, slack);
    const start = () => service.start(value.bootstrap.userId, value.agent.id, "create");
    const missingAuth = await start();
    const state = new URL(missingAuth.authorizationUrl).searchParams.get("state") ?? "";
    await expect(service.callback({ state, sessionBinding: missingAuth.sessionBinding })).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
      slackOAuthAgentId: value.agent.id,
    });
    await expect(
      service.callback({ authenticatedUserId: crypto.randomUUID(), state, sessionBinding: missingAuth.sessionBinding }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await expect(
      service.callback({
        authenticatedUserId: value.bootstrap.userId,
        error: "access_denied",
        state,
        sessionBinding: missingAuth.sessionBinding,
      }),
    ).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED" });
  });

  it("rejects superseded, replayed, and forged callback states", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    client.oauthAccess.mockResolvedValue({
      appId: "A1",
      teamId: "T1",
      enterpriseId: null,
      botUserId: "U1",
      botId: "B1",
      botAccessToken: "xoxb-token",
    });
    const result = { imBindingId: crypto.randomUUID(), agentId: value.agent.id };
    const slack = { currentBinding: vi.fn().mockResolvedValue(null), configure: vi.fn().mockResolvedValue(result) };
    const service = createService(value, client, slack);

    // A newer start for the same Account and Agent supersedes every earlier unconsumed state.
    const superseded = await service.start(value.bootstrap.userId, value.agent.id, "create");
    const current = await service.start(value.bootstrap.userId, value.agent.id, "create");
    const stateOf = (start: { authorizationUrl: string }) =>
      new URL(start.authorizationUrl).searchParams.get("state") ?? "";
    await expect(
      service.callback({
        authenticatedUserId: value.bootstrap.userId,
        code: "oauth-code",
        state: stateOf(superseded),
        sessionBinding: superseded.sessionBinding,
      }),
    ).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED", slackOAuthAgentId: value.agent.id });
    expect(slack.configure).not.toHaveBeenCalled();

    // The surviving state completes exactly once: a replay finds its nonce already consumed.
    await expect(
      service.callback({
        authenticatedUserId: value.bootstrap.userId,
        code: "oauth-code",
        state: stateOf(current),
        sessionBinding: current.sessionBinding,
      }),
    ).resolves.toMatchObject({ agentId: value.agent.id, returnSurface: "agent-messaging-settings" });
    await expect(
      service.callback({
        authenticatedUserId: value.bootstrap.userId,
        code: "oauth-code",
        state: stateOf(current),
        sessionBinding: current.sessionBinding,
      }),
    ).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED" });
    expect(slack.configure).toHaveBeenCalledTimes(1);

    // A state minted under a different key is rejected before any nonce is consumed.
    const forged = await new SlackOAuthStateService("attacker-controlled-signing-key-32-chars", {
      now: () => now,
    }).issue({
      userId: value.bootstrap.userId,
      context: {
        agentId: value.agent.id,
        intent: "create",
        returnSurface: "agent-setup",
        expectedMessaging: { kind: "unbound" },
      },
    });
    await expect(
      service.callback({
        authenticatedUserId: value.bootstrap.userId,
        code: "oauth-code",
        state: forged.state,
        sessionBinding: forged.sessionBinding,
      }),
    ).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED" });
    expect(slack.configure).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the signed expectation no longer matches the consumed nonce", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    const slack = { currentBinding: vi.fn().mockResolvedValue(null), configure: vi.fn() };
    const service = createService(value, client, slack);
    const started = await service.start(value.bootstrap.userId, value.agent.id, "create");
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    // Tamper with the persisted fence after issuance: the signed context says unbound, the nonce row
    // now names an exact binding. Divergence is treated as a stale or tampered flow and rejected.
    await oauthDatabase.database
      .update(slackOAuthNonces)
      .set({ expectedBindingId: crypto.randomUUID(), expectedCredentialGeneration: 1 })
      .where(eq(slackOAuthNonces.agentId, value.agent.id));
    await expect(
      service.callback({
        authenticatedUserId: value.bootstrap.userId,
        code: "oauth-code",
        state,
        sessionBinding: started.sessionBinding,
      }),
    ).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED" });
    expect(slack.configure).not.toHaveBeenCalled();
    const [row] = await oauthDatabase.database.select().from(slackOAuthNonces);
    expect(row?.consumedAt).not.toBeNull();
  });

  it("maps exchange failures and propagates configuration errors", async () => {
    const value = await oauthFixture();
    const client = apiClient();
    const slack = { currentBinding: vi.fn().mockResolvedValue(null), configure: vi.fn() };
    const service = createService(value, client, slack);
    const failures = [
      ["SLACK_AUTH_INVALID", "SLACK_OAUTH_FAILED"],
      ["SLACK_AUTH_REJECTED", "SLACK_OAUTH_FAILED"],
      ["SLACK_AUTH_IDENTITY_INCOMPLETE", "SLACK_AUTH_IDENTITY_INCOMPLETE"],
      ["network unavailable", "SLACK_UPSTREAM_UNAVAILABLE"],
    ] as const;
    for (const [message, code] of failures) {
      client.oauthAccess.mockRejectedValueOnce(Object.assign(new Error(message), { cause: "invalid_code" }));
      const started = await service.start(value.bootstrap.userId, value.agent.id, "create");
      const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
      await expect(
        service.callback({
          authenticatedUserId: value.bootstrap.userId,
          code: "oauth-code",
          state,
          sessionBinding: started.sessionBinding,
        }),
      ).rejects.toMatchObject({ code });
    }
    client.oauthAccess.mockResolvedValue({
      appId: "A1",
      teamId: "T1",
      enterpriseId: null,
      botUserId: "U1",
      botId: "B1",
      botAccessToken: "xoxb",
    });
    const configurationError = new SlackConfigurationServiceError("SLACK_APP_TEAM_ALREADY_BOUND", 409, "bound");
    slack.configure.mockRejectedValue(configurationError);
    const started = await service.start(value.bootstrap.userId, value.agent.id, "create");
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
    await expect(
      service.callback({
        authenticatedUserId: value.bootstrap.userId,
        code: "oauth-code",
        state,
        sessionBinding: started.sessionBinding,
      }),
    ).rejects.toMatchObject({ code: "SLACK_APP_TEAM_ALREADY_BOUND", slackOAuthAgentId: value.agent.id });
  });
});

describe("Slack OAuth HTTP routes", () => {
  it("returns the callback only to the fixed surface the signed state named", async () => {
    const slackOAuth = {
      start: vi.fn(),
      callback: vi
        .fn()
        .mockResolvedValueOnce({
          agentId,
          returnSurface: "agent-setup",
          result: { imBindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0" },
        })
        .mockRejectedValueOnce(
          Object.assign(new SlackConfigurationServiceError("SLACK_CONFIGURATION_CONFLICT", 409, "changed"), {
            slackOAuthAgentId: agentId,
            slackOAuthReturnSurface: "agent-setup",
          }),
        ),
    };
    const app = createApp({
      authService: authService(),
      betterAuth: signedInBrowser(userId),
      slackOAuth: {
        authService: authService(),
        publicOrigin: "https://opentag.example.com",
        secureCookies: true,
        slackOAuth: slackOAuth as never,
      },
    });
    apps.push(app);

    // Adversarial navigation parameters are ignored: the redirect target comes from the signed state alone.
    const success = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?code=slack-oauth-code&state=signed-state&returnUrl=https%3A%2F%2Fevil.example.com&next=%2F%2Fevil.example.com`,
      headers: { cookie: "opentag.session_token=session; opentag_slack_oauth_context=session-binding" },
    });
    expect(success.statusCode).toBe(302);
    expect(success.headers.location).toBe(
      `https://opentag.example.com/agents/setup?agentId=${agentId}&slack_oauth=success`,
    );
    expect(JSON.stringify(success.headers)).not.toContain("evil.example.com");

    const failure = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?error=access_denied&state=signed-state`,
      headers: { cookie: "opentag.session_token=session; opentag_slack_oauth_context=session-binding" },
    });
    expect(failure.statusCode).toBe(302);
    expect(failure.headers.location).toBe(
      `https://opentag.example.com/agents/setup?agentId=${agentId}&slack_oauth_error=SLACK_CONFIGURATION_CONFLICT`,
    );
  });

  it("starts an authenticated install and keeps secrets out of the JSON body", async () => {
    const slackOAuth = {
      start: vi.fn().mockResolvedValue({
        authorizationUrl: `https://slack.com/oauth/v2/authorize?client_id=client&scope=${SLACK_REQUIRED_BOT_SCOPES.join(",")}&state=signed-state`,
        expiresAt: "2026-08-19T00:10:00.000Z",
        sessionBinding: "session-binding-secret",
      }),
      callback: vi.fn(),
    };
    const app = createApp({
      authService: authService(),
      betterAuth: signedInBrowser(userId),
      slackOAuth: {
        authService: authService(),
        publicOrigin: "https://opentag.example.com",
        secureCookies: true,
        slackOAuth: slackOAuth as never,
      },
    });
    apps.push(app);

    const started = await app.inject({
      method: "POST",
      url: agentSlackOAuthStartPath(agentId),
      headers: { authorization: "Bearer access", "content-type": "application/json" },
      payload: { intent: "create" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({
      authorizationUrl: expect.stringContaining("https://slack.com/oauth/v2/authorize"),
      expiresAt: "2026-08-19T00:10:00.000Z",
    });
    expect(JSON.stringify(started.json())).not.toContain("session-binding-secret");
    expect(started.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("opentag_slack_oauth_context=")]),
    );
    expect(String(started.headers["set-cookie"])).toContain("HttpOnly");
    expect(slackOAuth.start).toHaveBeenCalledWith(userId, agentId, "create", undefined, undefined);

    slackOAuth.start.mockClear();
    const setupStarted = await app.inject({
      method: "POST",
      url: agentSlackOAuthStartPath(agentId),
      headers: { authorization: "Bearer access", "content-type": "application/json" },
      payload: { intent: "create", returnSurface: "agent-setup" },
    });
    expect(setupStarted.statusCode).toBe(200);
    expect(slackOAuth.start).toHaveBeenCalledWith(userId, agentId, "create", "agent-setup", undefined);

    const invalidSurface = await app.inject({
      method: "POST",
      url: agentSlackOAuthStartPath(agentId),
      headers: { authorization: "Bearer access", "content-type": "application/json" },
      payload: { intent: "create", returnSurface: "https://evil.example.com/return" },
    });
    expect(invalidSurface.statusCode).toBe(400);
  });

  it("redirects public callback success and failures without exposing codes or state", async () => {
    const slackOAuth = {
      start: vi.fn(),
      callback: vi.fn().mockResolvedValueOnce({
        agentId,
        returnSurface: "agent-messaging-settings",
        result: { imBindingId: "6d93de68-ec32-4ac9-a41e-e96ed2d7dac0" },
      }),
    };
    const app = createApp({
      authService: authService(),
      betterAuth: signedInBrowser(userId),
      slackOAuth: {
        authService: authService(),
        publicOrigin: "https://opentag.example.com",
        secureCookies: true,
        slackOAuth: slackOAuth as never,
      },
    });
    apps.push(app);

    const success = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?code=slack-oauth-code&state=signed-state`,
      headers: { cookie: "opentag.session_token=session; opentag_slack_oauth_context=session-binding" },
    });
    expect(success.statusCode).toBe(302);
    expect(success.headers.location).toBe(
      `https://opentag.example.com/agents/${agentId}/settings/messaging?slack_oauth=success`,
    );
    expect(JSON.stringify(success.headers)).not.toContain("slack-oauth-code");
    expect(slackOAuth.callback).toHaveBeenCalledWith({
      // The route resolves the identity now, so a browser holding either credential reaches the same call.
      authenticatedUserId: userId,
      code: "slack-oauth-code",
      sessionBinding: "session-binding",
      state: "signed-state",
    });

    slackOAuth.callback.mockRejectedValueOnce(
      Object.assign(new SlackConfigurationServiceError("SLACK_APP_TEAM_ALREADY_BOUND", 409, "bound"), {
        slackOAuthAgentId: agentId,
      }),
    );
    const conflict = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?code=slack-oauth-code&state=signed-state`,
      headers: { cookie: "opentag.session_token=session; opentag_slack_oauth_context=session-binding" },
    });
    expect(conflict.statusCode).toBe(302);
    expect(conflict.headers.location).toBe(
      `https://opentag.example.com/agents/${agentId}/settings/messaging?slack_oauth_error=SLACK_APP_TEAM_ALREADY_BOUND`,
    );
    expect(JSON.stringify(conflict.headers)).not.toContain("slack-oauth-code");

    slackOAuth.callback.mockRejectedValueOnce(new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "invalid", 401));
    const authFailure = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?state=signed-state`,
      headers: { cookie: "opentag.session_token=session; opentag_slack_oauth_context=session-binding" },
    });
    expect(authFailure.statusCode).toBe(302);
    expect(authFailure.headers.location).toBe(
      "https://opentag.example.com/agents?slack_oauth_error=AUTH_INVALID_TOKEN",
    );

    slackOAuth.callback.mockRejectedValueOnce(new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "missing"));
    const bindingFailure = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?state=signed-state`,
      headers: { cookie: "opentag.session_token=session; opentag_slack_oauth_context=session-binding" },
    });
    expect(bindingFailure.headers.location).toBe(
      "https://opentag.example.com/agents?slack_oauth_error=IM_BINDING_NOT_FOUND",
    );

    slackOAuth.callback.mockRejectedValueOnce(
      Object.assign(new Error("upstream"), { upstreamSlackError: "invalid_code" }),
    );
    const genericFailure = await app.inject({
      method: "GET",
      url: `${SLACK_OAUTH_CALLBACK_PATH}?state=signed-state`,
      headers: { cookie: "opentag.session_token=session; opentag_slack_oauth_context=session-binding" },
    });
    expect(genericFailure.headers.location).toBe(
      "https://opentag.example.com/agents?slack_oauth_error=SLACK_OAUTH_FAILED",
    );
  });
});
