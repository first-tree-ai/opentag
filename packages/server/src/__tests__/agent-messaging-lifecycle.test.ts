import {
  agentFeishuSetupAttemptsPath,
  agentImBindingUnbindPath,
  FEISHU_REQUIRED_TENANT_SCOPES,
  type ImBindingMessagingExpectation,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import { createApp } from "../app.js";
import {
  agents as agentRows,
  computers,
  imBindings,
  imMessages,
  sessions,
  slackInstallations,
} from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import type { FeishuRegistrationGateway } from "../services/im-bindings/feishu/index.js";
import { FeishuSetupService } from "../services/im-bindings/feishu/index.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import type { SlackApiClient, SlackInstallationInspection } from "../services/im-bindings/slack/index.js";
import {
  SlackConfigurationService,
  SlackOAuthService,
  SlackOAuthStateService,
} from "../services/im-bindings/slack/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

const fixedNow = new Date("2026-08-19T00:00:00.000Z");
const slackStateSecret = "agent-messaging-lifecycle-test-secret-32";
const apps: ReturnType<typeof createApp>[] = [];

let unitDatabase: UnitDatabase;

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

async function fixture() {
  const bootstrap = await bootstrapTestAccount(unitDatabase.database, {
    displayName: "Lifecycle Admin",
    email: `lifecycle-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "lifecycle-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const service = new ImBindingService(unitDatabase.database, cipher, { now: () => fixedNow });
  const agents = new AgentService(unitDatabase.database);
  const agent = await agents.createForAccount(bootstrap.userId, {
    name: "lifecycle-agent",
    displayName: "Lifecycle Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  return { agents, bootstrap, cipher, computer, service, agent };
}

function feishuActivationInput(agentId: string) {
  return {
    agentId,
    appId: "cli_lifecycle",
    teamId: "tenant_lifecycle",
    botOpenId: "ou_lifecycle",
    appSecret: "feishu-secret",
    grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
  };
}

function slackActivationInput(agentId: string) {
  return {
    intent: "create" as const,
    agentId,
    appId: "A_LIFECYCLE",
    teamId: "T_LIFECYCLE",
    botUserId: "U_LIFECYCLE",
    grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    botAccessToken: "xoxb-lifecycle",
    signingSecret: "signing-secret",
    installedAt: fixedNow,
  };
}

function pendingRegistration() {
  let resolve!: (result: { appId: string; appSecret: string; teamBrand?: "feishu" | "lark" }) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<{ appId: string; appSecret: string; teamBrand?: "feishu" | "lark" }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void result.catch(() => undefined);
  const registration = {
    // The setup service measures QR expiry against real time, so the fixture must live in the real future.
    qrReady: Promise.resolve({
      url: "https://feishu.example/qr/lifecycle",
      expiresAt: new Date(Date.now() + 60_000),
    }),
    result,
    abort: vi.fn(),
  };
  return { registration, resolve, reject };
}

function feishuSetup(value: Awaited<ReturnType<typeof fixture>>, gateway: FeishuRegistrationGateway) {
  return new FeishuSetupService({
    database: unitDatabase.database,
    cipher: value.cipher,
    instanceId: crypto.randomUUID(),
    imBindings: value.service,
    registrations: gateway,
    activation: { activateAtomicAttempt: vi.fn() },
  });
}

function slackInspection(overrides: Partial<SlackInstallationInspection> = {}): SlackInstallationInspection {
  return {
    appId: "A_LIFECYCLE",
    teamId: "T_LIFECYCLE",
    enterpriseId: null,
    botUserId: "U_LIFECYCLE",
    botId: "B_LIFECYCLE",
    grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    ...overrides,
  };
}

function slackOAuth(value: Awaited<ReturnType<typeof fixture>>) {
  const api = {
    inspectInstallation: vi.fn().mockResolvedValue(slackInspection()),
    oauthAccess: vi.fn().mockResolvedValue({
      appId: "A_LIFECYCLE",
      teamId: "T_LIFECYCLE",
      enterpriseId: null,
      botUserId: "U_LIFECYCLE",
      botId: "B_LIFECYCLE",
      botAccessToken: "xoxb-lifecycle",
    }),
  } as unknown as SlackApiClient;
  const slack = new SlackConfigurationService({ api, database: unitDatabase.database, imBindings: value.service });
  const oauth = new SlackOAuthService({
    api,
    app: {
      clientId: "client-id",
      clientSecret: "client-secret",
      signingSecret: "signing-secret",
      redirectUrl: "https://opentag.example.com/api/v1/im-bindings/slack/oauth/callback",
    },
    database: unitDatabase.database,
    slack,
    state: new SlackOAuthStateService(slackStateSecret, { now: () => fixedNow }),
    now: () => fixedNow,
  });
  return { api, oauth, slack };
}

function authServiceFor(userId: string): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Lifecycle Admin" },
        setupCompletedAt: null,
      },
    }),
  };
}

describe("Agent messaging unbind lifecycle", () => {
  it("atomically disables the binding, clears credentials, setup and leases, ends sessions, retains history", async () => {
    const value = await fixture();
    const bindingId = await value.service.activateFeishu(feishuActivationInput(value.agent.id));
    await unitDatabase.database
      .update(imBindings)
      .set({
        connectionOwnerInstanceId: crypto.randomUUID(),
        connectionLeaseExpiresAt: new Date(fixedNow.getTime() + 60_000),
        observedAt: fixedNow,
        observedConnectedAt: fixedNow,
      })
      .where(eq(imBindings.id, bindingId));
    const [session] = await unitDatabase.database
      .insert(sessions)
      .values({ imBindingId: bindingId, channelId: "C-chat", conversationKind: "channel", kind: "channel" })
      .returning();
    if (!session) throw new Error("Session fixture was not created");
    const [message] = await unitDatabase.database
      .insert(imMessages)
      .values({
        imBindingId: bindingId,
        channelId: "C-chat",
        externalMessageId: "m-1",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "hello", blocks: [], truncated: false },
        providerContext: { provider: "feishu" },
        occurredAt: fixedNow,
      })
      .returning();
    if (!message) throw new Error("Message fixture was not created");

    await value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, {
      provider: "feishu",
      bindingId,
    });

    const [binding] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
    expect(binding).toMatchObject({
      status: "disabled",
      encryptedCredential: null,
      connectionOwnerInstanceId: null,
      connectionLeaseExpiresAt: null,
      disabledAt: fixedNow,
    });
    const [endedSession] = await unitDatabase.database.select().from(sessions).where(eq(sessions.id, session.id));
    expect(endedSession?.endedAt).toEqual(fixedNow);
    // History is retained: the ended Session and every exchanged message survive the unbind.
    const retainedMessages = await unitDatabase.database
      .select()
      .from(imMessages)
      .where(eq(imMessages.imBindingId, bindingId));
    expect(retainedMessages).toHaveLength(1);
    await expect(value.service.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toBeUndefined();

    // Any Provider may bind afterwards.
    const slack = await value.service.activateSlack(slackActivationInput(value.agent.id), "B_LIFECYCLE");
    expect(slack).toMatchObject({ agentId: value.agent.id, credentialGeneration: 1 });
  });

  it("releases the Agent-owned Slack installation and allows a Feishu bind afterwards", async () => {
    const value = await fixture();
    const activated = await value.service.activateSlack(slackActivationInput(value.agent.id), "B_LIFECYCLE");
    await value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, {
      provider: "slack",
      bindingId: activated.imBindingId,
    });
    const installations = await unitDatabase.database.select().from(slackInstallations);
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({ status: "disabled", encryptedCredential: null });
    const feishu = await value.service.activateFeishu(feishuActivationInput(value.agent.id));
    expect(feishu).toEqual(expect.any(String));
  });

  it("fails closed on stale, foreign, or repeated unbind fences", async () => {
    const value = await fixture();
    // No current binding at all: the named binding is not current.
    await expect(
      value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, {
        provider: "feishu",
        bindingId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT", statusCode: 409 });

    const bindingId = await value.service.activateFeishu(feishuActivationInput(value.agent.id));
    await expect(
      value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, {
        provider: "feishu",
        bindingId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT" });
    await expect(
      value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, { provider: "slack", bindingId }),
    ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT" });
    await expect(
      value.service.unbindForAgent(crypto.randomUUID(), value.agent.id, { provider: "feishu", bindingId }),
    ).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND", statusCode: 404 });
    // None of the failed attempts touched the binding.
    await expect(value.service.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toMatchObject({
      id: bindingId,
      bindingState: "active",
    });

    await value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, { provider: "feishu", bindingId });
    await expect(
      value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, { provider: "feishu", bindingId }),
    ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT" });
  });

  it("unbinds a provisioning binding and leaves the racing Feishu completion nothing to claim", async () => {
    const value = await fixture();
    const pending = pendingRegistration();
    const activation = { activateAtomicAttempt: vi.fn() };
    const setup = new FeishuSetupService({
      database: unitDatabase.database,
      cipher: value.cipher,
      instanceId: crypto.randomUUID(),
      imBindings: value.service,
      registrations: { start: vi.fn(() => pending.registration) },
      activation,
    });
    try {
      const attempt = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create");
      const [slot] = await unitDatabase.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.setupAttemptId, attempt.id));
      if (!slot) throw new Error("Setup slot fixture was not created");

      await value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, {
        provider: "feishu",
        bindingId: slot.id,
      });
      const [disabled] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, slot.id));
      expect(disabled).toMatchObject({
        status: "disabled",
        setupOwnerInstanceId: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
      });

      // The provider round trip finishes after the unbind: the cleared owner can never claim the slot.
      pending.resolve({ appId: "cli_lifecycle", appSecret: "secret", teamBrand: "feishu" });
      await vi.waitFor(async () => {
        const [row] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, slot.id));
        expect(row?.setupState).not.toBe("validating");
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(activation.activateAtomicAttempt).not.toHaveBeenCalled();
      const [finalRow] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, slot.id));
      expect(finalRow).toMatchObject({ status: "disabled", encryptedCredential: null });
    } finally {
      await setup.stop();
    }
  });
});

describe("cross-Provider messaging starts", () => {
  it("rejects setup reads and writes after the exact Agent is suspended", async () => {
    const value = await fixture();
    const bindingId = await value.service.activateFeishu(feishuActivationInput(value.agent.id));
    await unitDatabase.database.update(agentRows).set({ status: "suspended" }).where(eq(agentRows.id, value.agent.id));
    const gateway: FeishuRegistrationGateway = { start: vi.fn() };
    const setup = feishuSetup(value, gateway);
    const { api, oauth } = slackOAuth(value);
    try {
      await expect(setup.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize")).rejects.toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
      });
      await expect(oauth.start(value.bootstrap.userId, value.agent.id, "create")).rejects.toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
      });
      await expect(
        value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, { provider: "feishu", bindingId }),
      ).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND", statusCode: 404 });
      await expect(value.service.activateFeishu(feishuActivationInput(value.agent.id))).rejects.toMatchObject({
        code: "IM_BINDING_NOT_FOUND",
        statusCode: 404,
      });
      expect(gateway.start).not.toHaveBeenCalled();
      expect(api.oauthAccess).not.toHaveBeenCalled();
      const [binding] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
      expect(binding).toMatchObject({ status: "active", credentialGeneration: 1 });
    } finally {
      await setup.stop();
    }
  });

  it("fails a Slack start against a Feishu binding with the structured unbind-required identity", async () => {
    const value = await fixture();
    const feishuBindingId = await value.service.activateFeishu(feishuActivationInput(value.agent.id));
    const { api, oauth } = slackOAuth(value);
    for (const intent of ["create", "reauthorize"] as const) {
      await expect(oauth.start(value.bootstrap.userId, value.agent.id, intent)).rejects.toMatchObject({
        code: "IM_BINDING_UNBIND_REQUIRED",
        statusCode: 409,
        unbindRequired: {
          currentProvider: "feishu",
          currentBindingId: feishuBindingId,
          requestedProvider: "slack",
        },
      });
    }
    expect(api.oauthAccess).not.toHaveBeenCalled();
  });

  it("fails every Feishu setup intent against a Slack binding with the unbind-required identity", async () => {
    const value = await fixture();
    const activated = await value.service.activateSlack(slackActivationInput(value.agent.id), "B_LIFECYCLE");
    const gateway: FeishuRegistrationGateway = { start: vi.fn() };
    const setup = feishuSetup(value, gateway);
    try {
      for (const intent of ["create", "reauthorize", "replace"] as const) {
        await expect(setup.createOrReuse(value.bootstrap.userId, value.agent.id, intent)).rejects.toMatchObject({
          code: "IM_BINDING_UNBIND_REQUIRED",
          statusCode: 409,
          unbindRequired: {
            currentProvider: "slack",
            currentBindingId: activated.imBindingId,
            requestedProvider: "feishu",
          },
        });
      }
      // Nothing external was asked for: no Feishu App registration is started for a refused command.
      expect(gateway.start).not.toHaveBeenCalled();
    } finally {
      await setup.stop();
    }
  });

  it("surfaces the structured identity through the Feishu mutation route", async () => {
    const value = await fixture();
    const activated = await value.service.activateSlack(slackActivationInput(value.agent.id), "B_LIFECYCLE");
    const setup = feishuSetup(value, { start: vi.fn() });
    const app = createApp({
      authService: authServiceFor(value.bootstrap.userId),
      imBindingService: value.service,
      feishuSetupService: setup,
    });
    apps.push(app);
    try {
      const response = await app.inject({
        method: "POST",
        url: agentFeishuSetupAttemptsPath(value.agent.id),
        headers: { authorization: "Bearer access" },
        payload: { intent: "create" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: "IM_BINDING_UNBIND_REQUIRED",
          category: "deterministic",
          unbindRequired: {
            currentProvider: "slack",
            currentBindingId: activated.imBindingId,
            requestedProvider: "feishu",
          },
        },
      });
      expect(JSON.stringify(response.json())).not.toContain("xoxb-lifecycle");

      const unbound = await app.inject({
        method: "POST",
        url: agentImBindingUnbindPath(value.agent.id),
        headers: { authorization: "Bearer access" },
        payload: { provider: "slack", bindingId: activated.imBindingId },
      });
      expect(unbound.statusCode).toBe(204);
      const retry = await app.inject({
        method: "POST",
        url: agentImBindingUnbindPath(value.agent.id),
        headers: { authorization: "Bearer access" },
        payload: { provider: "slack", bindingId: activated.imBindingId },
      });
      expect(retry.statusCode).toBe(409);
      expect(retry.json().error).toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT" });
    } finally {
      await setup.stop();
    }
  });
});

describe("Feishu setup command fencing", () => {
  it("admits a create that declares the observed unbound state", async () => {
    const value = await fixture();
    const pending = pendingRegistration();
    const setup = feishuSetup(value, { start: vi.fn(() => pending.registration) });
    try {
      const attempt = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create", {
        kind: "unbound",
      });
      expect(attempt).toMatchObject({ state: "awaiting_user", intent: "create" });
    } finally {
      await setup.stop();
    }
  });

  it("rejects a create whose unbound expectation or intent is stale before any registration", async () => {
    const value = await fixture();
    await value.service.activateFeishu(feishuActivationInput(value.agent.id));
    const gateway: FeishuRegistrationGateway = { start: vi.fn() };
    const setup = feishuSetup(value, gateway);
    try {
      await expect(
        setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create", { kind: "unbound" }),
      ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT", statusCode: 409 });
      await expect(setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create")).rejects.toMatchObject({
        code: "IM_BINDING_CONFIGURATION_CONFLICT",
      });
      expect(gateway.start).not.toHaveBeenCalled();
    } finally {
      await setup.stop();
    }
  });

  it("admits same-Provider reauthorize and replace only against the exact binding generation", async () => {
    const value = await fixture();
    const bindingId = await value.service.activateFeishu(feishuActivationInput(value.agent.id));
    const pending = pendingRegistration();
    const gateway: FeishuRegistrationGateway = { start: vi.fn(() => pending.registration) };
    const setup = feishuSetup(value, gateway);
    try {
      const exact: ImBindingMessagingExpectation = {
        kind: "bound",
        provider: "feishu",
        bindingId,
        credentialGeneration: 1,
      };
      const attempt = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize", exact);
      expect(attempt).toMatchObject({ state: "awaiting_user", intent: "reauthorize" });
      await setup.cancel(value.bootstrap.userId, attempt.id);

      // Generation and identity drift are both stale: fail closed without starting a registration.
      const startsBefore = (gateway.start as ReturnType<typeof vi.fn>).mock.calls.length;
      await expect(
        setup.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize", {
          kind: "bound",
          provider: "feishu",
          bindingId,
          credentialGeneration: 99,
        }),
      ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT" });
      await expect(
        setup.createOrReuse(value.bootstrap.userId, value.agent.id, "replace", {
          kind: "bound",
          provider: "feishu",
          bindingId: crypto.randomUUID(),
          credentialGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT" });
      // A bound expectation that names the other Provider never matches this binding.
      await expect(
        setup.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize", {
          kind: "bound",
          provider: "slack",
          bindingId,
          credentialGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT" });
      expect((gateway.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(startsBefore);

      const replacement = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "replace", exact);
      expect(replacement).toMatchObject({ state: "awaiting_user", intent: "replace" });
    } finally {
      await setup.stop();
    }
  });

  it("fences the authoritative transaction against a binding that changed mid-command", async () => {
    const value = await fixture();
    const pending = pendingRegistration();
    // The caller declared the Agent unbound, but a configured binding appears while the command awaits the
    // provider handshake: the transaction-time fence, not the earlier observation, must decide.
    const abort = vi.fn();
    const racingGateway: FeishuRegistrationGateway = {
      start: vi.fn(() => ({
        qrReady: value.service.activateFeishu(feishuActivationInput(value.agent.id)).then(() => ({
          url: "https://feishu.example/qr/race",
          expiresAt: new Date(Date.now() + 60_000),
        })),
        result: pending.registration.result,
        abort,
      })),
    };
    const setup = feishuSetup(value, racingGateway);
    try {
      await expect(
        setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create", { kind: "unbound" }),
      ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT", statusCode: 409 });
      expect(racingGateway.start).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalled();
      const [row] = await unitDatabase.database.select().from(imBindings).where(eq(imBindings.agentId, value.agent.id));
      expect(row).toMatchObject({ status: "active", setupAttemptId: null });
    } finally {
      await setup.stop();
    }
  });

  it("does not turn a transaction-time stale expectation into a concurrent attempt success", async () => {
    const value = await fixture();
    const bindingId = await value.service.activateFeishu(feishuActivationInput(value.agent.id));
    let releaseQr!: () => void;
    const qrReady = new Promise<{ url: string; expiresAt: Date }>((resolve) => {
      releaseQr = () => resolve({ url: "https://feishu.example/qr/fenced", expiresAt: new Date(Date.now() + 60_000) });
    });
    const pending = pendingRegistration();
    const abort = vi.fn();
    const start = vi.fn(() => ({ qrReady, result: pending.registration.result, abort }));
    const setup = feishuSetup(value, { start });
    try {
      const command = setup.createOrReuse(value.bootstrap.userId, value.agent.id, "reauthorize", {
        kind: "bound",
        provider: "feishu",
        bindingId,
        credentialGeneration: 1,
      });
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      const concurrentAttemptId = crypto.randomUUID();
      await unitDatabase.database
        .update(imBindings)
        .set({
          credentialGeneration: 2,
          setupAttemptId: concurrentAttemptId,
          setupIntent: "reauthorize",
          setupState: "awaiting_user",
          setupOwnerInstanceId: crypto.randomUUID(),
          setupOwnerHeartbeatAt: new Date(),
          encryptedSetupContext: value.cipher.encrypt(
            JSON.stringify({ qrUrl: "https://feishu.example/qr/concurrent" }),
          ),
          setupExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(eq(imBindings.id, bindingId));

      releaseQr();
      await expect(command).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT", statusCode: 409 });
      expect(abort).toHaveBeenCalled();
    } finally {
      await setup.stop();
    }
  });

  it("lets cancel win while a Feishu attempt is validating", async () => {
    const value = await fixture();
    const pending = pendingRegistration();
    const setup = feishuSetup(value, { start: vi.fn(() => pending.registration) });
    try {
      const attempt = await setup.createOrReuse(value.bootstrap.userId, value.agent.id, "create", { kind: "unbound" });
      await unitDatabase.database
        .update(imBindings)
        .set({ setupState: "validating" })
        .where(eq(imBindings.setupAttemptId, attempt.id));

      const canceled = await setup.cancel(value.bootstrap.userId, attempt.id);
      expect(canceled).toMatchObject({ state: "canceled", errorCode: "FEISHU_SETUP_CANCELED" });
      expect(pending.registration.abort).toHaveBeenCalled();
    } finally {
      await setup.stop();
    }
  });
});

describe("Slack OAuth attempt fencing", () => {
  it("fails a reauthorize callback closed when the binding was unbound mid-flight", async () => {
    const value = await fixture();
    const activated = await value.service.activateSlack(slackActivationInput(value.agent.id), "B_LIFECYCLE");
    const { api, oauth } = slackOAuth(value);
    const started = await oauth.start(value.bootstrap.userId, value.agent.id, "reauthorize", "agent-setup");
    const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";

    await value.service.unbindForAgent(value.bootstrap.userId, value.agent.id, {
      provider: "slack",
      bindingId: activated.imBindingId,
    });

    await expect(
      oauth.callback({
        authenticatedUserId: value.bootstrap.userId,
        code: "oauth-code",
        state,
        sessionBinding: started.sessionBinding,
      }),
    ).rejects.toMatchObject({
      code: "SLACK_CONFIGURATION_CONFLICT",
      slackOAuthAgentId: value.agent.id,
      slackOAuthReturnSurface: "agent-setup",
    });
    // The unbound state is final: nothing was re-bound and the installation stays disabled.
    await expect(value.service.getForAgent(value.bootstrap.userId, value.agent.id)).resolves.toBeUndefined();
    const installations = await unitDatabase.database.select().from(slackInstallations);
    expect(installations[0]).toMatchObject({ status: "disabled", encryptedCredential: null });
    expect(api.inspectInstallation).toHaveBeenCalled();
  });

  it("completes a same-Provider reauthorize against the exact signed generation", async () => {
    const value = await fixture();
    const activated = await value.service.activateSlack(slackActivationInput(value.agent.id), "B_LIFECYCLE");
    const { oauth } = slackOAuth(value);
    const started = await oauth.start(value.bootstrap.userId, value.agent.id, "reauthorize");
    const result = await oauth.callback({
      authenticatedUserId: value.bootstrap.userId,
      code: "oauth-code",
      state: new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      sessionBinding: started.sessionBinding,
    });
    expect(result).toMatchObject({
      agentId: value.agent.id,
      returnSurface: "agent-messaging-settings",
      result: { imBindingId: activated.imBindingId, credentialGeneration: 2 },
    });
  });
});
