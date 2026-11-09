import { FEISHU_REQUIRED_TENANT_SCOPES, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings, slackInstallations, users } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { AuthService, type AuthTokenProvider } from "../../services/auth/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { FeishuSetupService } from "../../services/im-bindings/feishu/index.js";
import { encodeFeishuSetupCandidate } from "../../services/im-bindings/feishu/setup-context.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { type SlackApiClient, SlackConfigurationService } from "../../services/im-bindings/slack/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => testDatabase.reset());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.sql.end()));
});
afterAll(async () => testDatabase.stop());

async function fixture() {
  const client = createDatabaseClient(testDatabase.databaseUrl);
  clients.push(client);
  const { userId } = await bootstrapInitialAdmin(client.database, { displayName: "Owner", email: "owner@example.com" });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "Local",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!computer) throw new Error("Missing Computer");
  const agent = await new AgentService(client.database).createForAccount(userId, {
    name: "reader",
    displayName: "Reader",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 17));
  const artifact = vi.fn(async () => "ready" as const);
  const credential = vi.fn(async () => ({ status: "ready" as const }));
  const bindings = new ImBindingService(client.database, cipher, {
    imCliReadiness: artifact,
    credentialExecutionReadiness: credential,
  });
  const activated = await bindings.activateSlack(
    {
      intent: "create",
      agentId: agent.id,
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botAccessToken: "xoxb-test-secret",
      signingSecret: "test-signing-secret",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      installedAt: new Date(),
    },
    "B1",
  );
  await bindings.recordSlackIdentityClosure(activated.imBindingId, activated.credentialGeneration);
  const inspectInstallation = vi.fn();
  const slack = new SlackConfigurationService({
    database: client.database,
    cipher,
    imBindings: bindings,
    api: { inspectInstallation } as unknown as SlackApiClient,
  });
  const registrations = { start: vi.fn() };
  const activation = { activateAtomicAttempt: vi.fn() };
  const feishu = new FeishuSetupService({
    database: client.database,
    cipher,
    imBindings: bindings,
    instanceId: crypto.randomUUID(),
    registrations,
    activation,
  });
  return {
    bindingId: activated.imBindingId,
    ...client,
    cipher,
    userId,
    agent,
    bindings,
    slack,
    feishu,
    artifact,
    credential,
    inspectInstallation,
    registrations,
    activation,
  };
}

describe("paused messaging settings", () => {
  it.each(["active", "suspended"] as const)(
    "reads existing configuration for an owned %s Agent without mutations",
    async (status) => {
      const value = await fixture();
      await value.database.update(agents).set({ status }).where(eq(agents.id, value.agent.id));
      const before = {
        bindings: await value.database.select().from(imBindings),
        installations: await value.database.select().from(slackInstallations),
        agents: await value.database.select().from(agents),
      };
      expect(await value.bindings.getForAgent(value.userId, value.agent.id)).toMatchObject({
        provider: "slack",
        bindingState: "active",
      });
      expect(await value.bindings.getConfigForAgent(value.userId, value.agent.id)).toMatchObject({
        identity: { appId: "A1" },
        credentialGeneration: 1,
      });
      expect(await value.bindings.diagnostics(value.userId, value.bindingId)).toMatchObject({
        provider: "slack",
        credentialGeneration: 1,
      });
      expect(await value.bindings.getHandoffForAgent(value.userId, value.agent.id)).toMatchObject({
        bindingState: "active",
      });
      const view = await value.slack.view(value.userId, value.agent.id, "https://opentag.example");
      expect(view.binding?.identity).toMatchObject({ appId: "A1" });
      expect(JSON.stringify(view)).not.toMatch(/xoxb-test-secret|test-signing-secret|encryptedCredential/);
      expect(await value.feishu.getForAgent(value.userId, value.agent.id)).toBeUndefined();
      expect({
        bindings: await value.database.select().from(imBindings),
        installations: await value.database.select().from(slackInstallations),
        agents: await value.database.select().from(agents),
      }).toEqual(before);
      expect(value.inspectInstallation).not.toHaveBeenCalled();
      expect(value.registrations.start).not.toHaveBeenCalled();
      expect(value.activation.activateAtomicAttempt).not.toHaveBeenCalled();
      expect(value.artifact).toHaveBeenCalledWith(value.agent.id, "slack", value.bindingId, 1, status === "active");
      expect(value.credential).toHaveBeenCalledWith(value.agent.id, "slack", value.bindingId, 1, status === "active");
    },
  );

  it("keeps a stopped Feishu binding and its public refusal reason readable while paused", async () => {
    const value = await fixture();
    if (!value.agent.computerId) throw new Error("Missing fixture Computer");
    const agent = await new AgentService(value.database).createForAccount(value.userId, {
      name: "feishu-reader",
      displayName: "Feishu Reader",
      runtimeProvider: "codex",
      computerId: value.agent.computerId,
    });
    const bindingId = await value.bindings.activateFeishu({
      agentId: agent.id,
      appId: "cli_refused",
      appSecret: "refused-secret",
      teamId: "tenant_refused",
      botOpenId: "ou_refused",
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    await value.database
      .update(imBindings)
      .set({ status: "error", lastErrorCode: "FEISHU_CREDENTIAL_INVALID" })
      .where(eq(imBindings.id, bindingId));
    await value.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, agent.id));
    const before = await value.database.select().from(imBindings);
    const summary = await value.bindings.getForAgent(value.userId, agent.id);
    expect(summary).toMatchObject({
      id: bindingId,
      provider: "feishu",
      bindingState: "error",
      connectionFailure: "credentials_rejected",
    });
    expect(JSON.stringify(summary)).not.toMatch(/refused-secret|encryptedCredential|FEISHU_CREDENTIAL_INVALID/);
    expect(await value.bindings.getHandoffForAgent(value.userId, agent.id)).toMatchObject({
      bindingState: "error",
    });
    await expect(value.bindings.assertCanManage(value.userId, agent.id)).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
    });
    expect(await value.database.select().from(imBindings)).toEqual(before);
    expect(value.registrations.start).not.toHaveBeenCalled();
    expect(value.activation.activateAtomicAttempt).not.toHaveBeenCalled();
  });

  it("serves paused GETs through Account authentication and rejects revoked Accounts", async () => {
    const value = await fixture();
    const auth = new AuthService(value.database, {
      issuePairForUser: vi.fn(),
      rotate: vi.fn(),
      verifyRefresh: vi.fn(),
      verifyAccess: async () => ({ userId: value.userId, expiresAt: new Date(Date.now() + 60_000) }),
    } as AuthTokenProvider);
    const app = createApp({
      loggerLevel: "silent",
      authService: auth,
      imBindingService: value.bindings,
      feishuSetupService: value.feishu,
      slackConfiguration: { service: value.slack, publicOrigin: "https://opentag.example" },
    });
    try {
      await value.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
      const urls = ["", "/config", "/handoff", "/slack/configuration", "/feishu/setup-attempts"].map(
        (suffix) => `/api/v1/agents/${value.agent.id}/im-binding${suffix}`,
      );
      urls.push(`/api/v1/im-bindings/${value.bindingId}/diagnostics`);
      for (const url of urls) {
        const response = await app.inject({ method: "GET", url, headers: { authorization: "Bearer test" } });
        expect([200, 204]).toContain(response.statusCode);
        expect(response.body).not.toMatch(/xoxb-test-secret|test-signing-secret|encryptedCredential/);
      }
      await value.database.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, value.userId));
      for (const url of urls) {
        const response = await app.inject({ method: "GET", url, headers: { authorization: "Bearer test" } });
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe("AUTH_USER_SUSPENDED");
      }
    } finally {
      await app.close();
    }
  });

  it("keeps authorization and details in one PostgreSQL snapshot across an ownership transfer", async () => {
    const value = await fixture();
    const writer = createDatabaseClient(testDatabase.databaseUrl);
    clients.push(writer);
    const [other] = await writer.database
      .insert(users)
      .values({ email: "successor@example.com", displayName: "Successor" })
      .returning();
    if (!other) throw new Error("Missing successor");
    let entered = () => {};
    let release = () => {};
    const authorized = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = value.bindings.readForAgent(value.userId, value.agent.id, async (transaction) => {
      entered();
      await released;
      return value.bindings.getConfigForAgent(value.userId, value.agent.id, transaction);
    });
    try {
      await authorized;
      await writer.database.update(agents).set({ createdByUserId: other.id }).where(eq(agents.id, value.agent.id));
      await writer.database
        .update(imBindings)
        .set({ botDisplayName: "Successor bot" })
        .where(eq(imBindings.id, value.bindingId));
    } finally {
      release();
    }
    expect((await reading)?.bot.displayName).not.toBe("Successor bot");
    await expect(value.bindings.getConfigForAgent(value.userId, value.agent.id)).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
    });
    expect((await value.bindings.getConfigForAgent(other.id, value.agent.id))?.bot.displayName).toBe("Successor bot");
  });

  it("reads a paused Feishu candidate without checking, canceling, or exposing secrets", async () => {
    const value = await fixture();
    await value.bindings.disable(value.userId, value.bindingId);
    const bindingId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const now = new Date();
    const encryptedSetupContext = encodeFeishuSetupCandidate(
      value.cipher,
      {
        version: 1,
        kind: "feishu_candidate",
        bindingId,
        attemptId,
        appId: "cli_readonly",
        appSecret: "candidate-secret",
        teamBrand: "feishu",
        savedAt: now.toISOString(),
        nextCheckAt: now.toISOString(),
        observation: null,
      },
      bindingId,
      attemptId,
    );
    await value.database.insert(imBindings).values({
      id: bindingId,
      agentId: value.agent.id,
      provider: "feishu",
      status: "provisioning",
      setupAttemptId: attemptId,
      setupIntent: "create",
      setupState: "pending_activation",
      encryptedSetupContext,
      setupExpiresAt: new Date(now.getTime() + 60_000),
    });
    await value.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
    const before = await value.database.select().from(imBindings);
    for (const read of [
      () => value.feishu.get(value.userId, attemptId),
      () => value.feishu.getForAgent(value.userId, value.agent.id),
    ]) {
      const attempt = await read();
      expect(attempt).toMatchObject({
        id: attemptId,
        state: "pending_activation",
        activation: { appId: "cli_readonly" },
      });
      expect(JSON.stringify(attempt)).not.toContain("candidate-secret");
    }
    await expect(value.feishu.check(value.userId, attemptId)).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND" });
    await expect(value.feishu.cancel(value.userId, attemptId)).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND" });
    expect(await value.database.select().from(imBindings)).toEqual(before);
    expect(value.registrations.start).not.toHaveBeenCalled();
    expect(value.activation.activateAtomicAttempt).not.toHaveBeenCalled();
    await value.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, value.agent.id));
    await expect(value.feishu.get(value.userId, attemptId)).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND" });
  });

  it("keeps management and OAuth admission active-only while paused", async () => {
    const value = await fixture();
    await value.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
    const denied = { code: "IM_BINDING_NOT_FOUND", statusCode: 404 };
    await expect(value.bindings.assertCanManage(value.userId, value.agent.id)).rejects.toMatchObject(denied);
    await expect(value.bindings.disable(value.userId, value.bindingId)).rejects.toMatchObject(denied);
    await expect(value.slack.currentBinding(value.userId, value.agent.id)).rejects.toMatchObject(denied);
    await expect(
      value.slack.configureToken(value.userId, value.agent.id, {
        intent: "create",
        expectedMessaging: { kind: "unbound" },
        botAccessToken: "xoxb-test",
        signingSecret: "test",
      }),
    ).rejects.toMatchObject(denied);
    await expect(value.feishu.createOrReuse(value.userId, value.agent.id, "create")).rejects.toMatchObject(denied);
    expect(value.inspectInstallation).not.toHaveBeenCalled();
    expect(value.registrations.start).not.toHaveBeenCalled();
  });

  it.each(["cross-account", "deleted", "transferred"] as const)("rejects %s reads", async (kind) => {
    const value = await fixture();
    let caller = value.userId;
    if (kind === "cross-account") caller = crypto.randomUUID();
    if (kind === "deleted")
      await value.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, value.agent.id));
    if (kind === "transferred") {
      const [other] = await value.database
        .insert(users)
        .values({ email: "other@example.com", displayName: "Other" })
        .returning();
      if (!other) throw new Error("Missing Account");
      await value.database.update(agents).set({ createdByUserId: other.id }).where(eq(agents.id, value.agent.id));
    }
    for (const read of [
      () => value.bindings.getForAgent(caller, value.agent.id),
      () => value.bindings.diagnostics(caller, value.bindingId),
      () => value.bindings.getConfigForAgent(caller, value.agent.id),
      () => value.bindings.getHandoffForAgent(caller, value.agent.id),
      () => value.slack.view(caller, value.agent.id, "https://opentag.example"),
      () => value.feishu.getForAgent(caller, value.agent.id),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: "IM_BINDING_NOT_FOUND", statusCode: 404 });
    }
  });
});
