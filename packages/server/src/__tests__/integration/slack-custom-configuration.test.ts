import {
  SaveSlackConfigurationRequestSchema,
  SLACK_REQUIRED_BOT_SCOPES,
  SlackConfigurationViewSchema,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings, slackInstallations } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { readSlackConfigurationMaterial } from "../../services/im-bindings/slack/configuration-material.js";
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
  const { userId } = await bootstrapInitialAdmin(client.database, {
    email: "custom-app@example.com",
    displayName: "Custom App QA",
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "Custom App QA Computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!computer) throw new Error("Missing Computer fixture");
  const agentService = new AgentService(client.database);
  const first = await agentService.createForAccount(userId, {
    name: "custom-first",
    displayName: "First",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const second = await agentService.createForAccount(userId, {
    name: "custom-second",
    displayName: "Second",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 11));
  const bindings = new ImBindingService(client.database, cipher);
  const inspectInstallation = vi.fn(async (token: string) => {
    const suffix = token.includes("second") ? "2" : "1";
    return {
      appId: null,
      teamId: "T_LOCAL",
      enterpriseId: null,
      botUserId: `U${suffix}`,
      botId: `B${suffix}`,
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    };
  });
  const botInfo = vi.fn(async (_token: string, botId: string) => ({
    id: botId,
    userId: `U${botId.slice(1)}`,
    appId: `A${botId.slice(1)}`,
    deleted: false,
  }));
  const api = { inspectInstallation, botInfo } as unknown as SlackApiClient;
  const service = new SlackConfigurationService({ api, cipher, database: client.database, imBindings: bindings });
  return {
    ...client,
    userId,
    first,
    second,
    cipher,
    bindings,
    service,
    api,
    inspectInstallation,
    botInfo,
    agentService,
  };
}

function createInput(token = "xoxb-first") {
  return {
    intent: "create" as const,
    expectedMessaging: { kind: "unbound" as const },
    botAccessToken: token,
    signingSecret: "test-signing-secret",
  };
}

async function updateInput(value: Awaited<ReturnType<typeof fixture>>) {
  const view = await value.service.view(value.userId, value.first.id, "https://opentag.example");
  const expected = view.expectedMessaging;
  if (expected?.kind !== "bound" || expected.provider !== "slack") throw new Error("Missing Slack fixture");
  return { intent: "reauthorize" as const, expectedMessaging: { ...expected, provider: "slack" as const } };
}

describe("custom Slack App configuration", () => {
  it("rejects another Account before reading credentials or calling Slack", async () => {
    const value = await fixture();
    const otherUser = crypto.randomUUID();
    await expect(value.service.view(otherUser, value.first.id, "https://opentag.example")).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
    });
    await expect(value.service.configureToken(otherUser, value.first.id, createInput())).rejects.toMatchObject({
      code: "IM_BINDING_NOT_FOUND",
    });
    expect(value.inspectInstallation).not.toHaveBeenCalled();
    expect(value.botInfo).not.toHaveBeenCalled();
    expect(await value.database.select().from(slackInstallations)).toEqual([]);
  });

  it("returns a trusted Agent URL before installation without creating records", async () => {
    const value = await fixture();
    const view = SlackConfigurationViewSchema.parse(
      await value.service.view(value.userId, value.first.id, "https://opentag.example"),
    );
    expect(view).toMatchObject({
      allowedIntent: "create",
      eventsUrl: `https://opentag.example/api/v1/agents/${value.first.id}/im-binding/slack/events`,
    });
    expect(await value.database.select().from(slackInstallations)).toEqual([]);
    expect(await value.database.select().from(imBindings)).toEqual([]);
  });

  it("supports two different Apps in one Team and keeps the exact Agent routes", async () => {
    const value = await fixture();
    const first = await value.service.configureToken(value.userId, value.first.id, createInput());
    const second = await value.service.configureToken(value.userId, value.second.id, createInput("xoxb-second"));
    expect(first.teamId).toBe(second.teamId);
    expect(first.appId).not.toBe(second.appId);
    const firstRoute = await value.bindings.findSlackIngressBindingForAgent(value.first.id);
    const secondRoute = await value.bindings.findSlackIngressBindingForAgent(value.second.id);
    expect(firstRoute?.botAccessToken).toBe("xoxb-first");
    expect(secondRoute?.botAccessToken).toBe("xoxb-second");
    expect(firstRoute?.imBindingId).not.toBe(secondRoute?.imBindingId);
    expect(value.inspectInstallation).toHaveBeenCalledTimes(2);
    expect(value.botInfo).toHaveBeenCalledTimes(2);
  });

  it("allows only one claimant for concurrent installs of the same App/Team", async () => {
    const value = await fixture();
    const outcomes = await Promise.allSettled([
      value.service.configureToken(value.userId, value.first.id, createInput()),
      value.service.configureToken(value.userId, value.second.id, createInput()),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const failed = outcomes.find((item) => item.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toMatchObject({ code: "SLACK_APP_TEAM_ALREADY_BOUND" });
    expect(await value.database.select().from(slackInstallations)).toHaveLength(1);
    expect(await value.database.select().from(imBindings)).toHaveLength(1);
  });

  it("keeps the binding, Secret and Agent receive mode on a Token-only update before identity verification", async () => {
    const value = await fixture();
    await value.database.update(agents).set({ receiveMode: "all_message" }).where(eq(agents.id, value.first.id));
    const first = await value.service.configureToken(value.userId, value.first.id, createInput());
    const next = await value.service.configureToken(value.userId, value.first.id, {
      ...(await updateInput(value)),
      botAccessToken: "xoxb-first-rotated",
    });
    expect(next.imBindingId).toBe(first.imBindingId);
    expect(next.credentialGeneration).toBe(first.credentialGeneration + 1);
    const material = await readSlackConfigurationMaterial(value.database, value.cipher, value.first.id);
    expect(material).toMatchObject({
      botAccessToken: "xoxb-first-rotated",
      signingSecret: "test-signing-secret",
      observedConnectedAt: null,
    });
    expect((await value.bindings.getForAgent(value.userId, value.first.id))?.receiveMode).toBe("all_message");
  });

  it("repairs only the Secret and does not elevate pending identity", async () => {
    const value = await fixture();
    await value.service.configureToken(value.userId, value.first.id, createInput());
    await value.service.configureToken(value.userId, value.first.id, {
      ...(await updateInput(value)),
      signingSecret: "corrected-secret",
    });
    const material = await readSlackConfigurationMaterial(value.database, value.cipher, value.first.id);
    expect(material).toMatchObject({
      botAccessToken: "xoxb-first",
      signingSecret: "corrected-secret",
      observedConnectedAt: null,
    });
    const view = await value.service.view(value.userId, value.first.id, "https://opentag.example");
    expect(view.identityClosure?.status).toBe("pending");
    expect(JSON.stringify(view)).not.toContain("corrected-secret");
    expect(JSON.stringify(view)).not.toContain("xoxb-first");
  });

  it("rejects a different App/Bot update and preserves original encrypted rows", async () => {
    const value = await fixture();
    await value.service.configureToken(value.userId, value.first.id, createInput());
    const before = await value.database.select().from(slackInstallations);
    await expect(
      value.service.configureToken(value.userId, value.first.id, {
        ...(await updateInput(value)),
        botAccessToken: "xoxb-second",
      }),
    ).rejects.toMatchObject({ code: "SLACK_BINDING_IDENTITY_MISMATCH" });
    expect(await value.database.select().from(slackInstallations)).toEqual(before);
  });

  it("rejects incomplete/deleted Bot identity before committing", async () => {
    const value = await fixture();
    value.botInfo.mockResolvedValue({ id: "B1", userId: "U1", appId: "A1", deleted: true });
    await expect(value.service.configureToken(value.userId, value.first.id, createInput())).rejects.toMatchObject({
      code: "SLACK_AUTH_IDENTITY_INCOMPLETE",
    });
    expect(await value.database.select().from(slackInstallations)).toHaveLength(0);
  });

  it("rejects missing actual grants despite a correct Manifest", async () => {
    const value = await fixture();
    value.inspectInstallation.mockResolvedValue({
      appId: null,
      teamId: "T_LOCAL",
      enterpriseId: null,
      botUserId: "U1",
      botId: "B1",
      grantedBotScopes: [],
    });
    await expect(value.service.configureToken(value.userId, value.first.id, createInput())).rejects.toMatchObject({
      code: "SLACK_SCOPE_REAUTH_REQUIRED",
    });
    expect(await value.database.select().from(slackInstallations)).toHaveLength(0);
  });

  it("rejects an old partial update after another writer changes the generation", async () => {
    const value = await fixture();
    await value.service.configureToken(value.userId, value.first.id, createInput());
    const expected = await updateInput(value);
    const staleWriter = new SlackConfigurationService({
      api: value.api,
      cipher: value.cipher,
      database: value.database,
      imBindings: value.bindings,
      beforeConfigurationTransaction: async () => {
        await value.service.configureToken(value.userId, value.first.id, {
          ...expected,
          signingSecret: "newer-secret",
        });
      },
    });
    await expect(
      staleWriter.configureToken(value.userId, value.first.id, { ...expected, botAccessToken: "xoxb-first-stale" }),
    ).rejects.toMatchObject({ code: "SLACK_CONFIGURATION_CONFLICT" });
    expect(await readSlackConfigurationMaterial(value.database, value.cipher, value.first.id)).toMatchObject({
      botAccessToken: "xoxb-first",
      signingSecret: "newer-secret",
    });
  });

  it("supports revoked-Token recovery using the same App and saved Secret", async () => {
    const value = await fixture();
    await value.service.configureToken(value.userId, value.first.id, createInput());
    const material = await readSlackConfigurationMaterial(value.database, value.cipher, value.first.id);
    if (!material) throw new Error("Missing material");
    await value.bindings.requireSlackInstallationReauthorization(
      material.installationId,
      material.generation,
      "SLACK_TOKEN_REVOKED",
    );
    await value.service.configureToken(value.userId, value.first.id, {
      ...(await updateInput(value)),
      botAccessToken: "xoxb-first-recovered",
    });
    expect(await readSlackConfigurationMaterial(value.database, value.cipher, value.first.id)).toMatchObject({
      botAccessToken: "xoxb-first-recovered",
      signingSecret: "test-signing-secret",
    });
  });

  it("rejects a partial update if official OAuth replaces the App during Token inspection", async () => {
    const value = await fixture();
    const first = await value.service.configureToken(value.userId, value.first.id, createInput());
    const expected = await updateInput(value);
    const staleWriter = new SlackConfigurationService({
      api: value.api,
      cipher: value.cipher,
      database: value.database,
      imBindings: value.bindings,
      beforeConfigurationTransaction: async () => {
        await value.service.configure(value.userId, value.first.id, {
          intent: "reauthorize",
          expectedBinding: { id: first.imBindingId, credentialGeneration: first.credentialGeneration },
          appId: "A2",
          botAccessToken: "xoxb-second",
          signingSecret: "official-secret",
        });
      },
    });
    await expect(
      staleWriter.configureToken(value.userId, value.first.id, { ...expected, signingSecret: "stale-secret" }),
    ).rejects.toMatchObject({ code: "SLACK_CONFIGURATION_CONFLICT" });
    expect(await readSlackConfigurationMaterial(value.database, value.cipher, value.first.id)).toMatchObject({
      appId: "A2",
      botAccessToken: "xoxb-second",
      signingSecret: "official-secret",
    });
  });

  it("derives recovery from current official Secret without storing provenance", async () => {
    const value = await fixture();
    await value.service.configureToken(value.userId, value.first.id, createInput());
    expect(
      (await value.service.view(value.userId, value.first.id, "https://opentag.example", "test-signing-secret"))
        .preferredRecovery,
    ).toBe("oauth");
    expect(
      (await value.service.view(value.userId, value.first.id, "https://opentag.example", "rotated-official-secret"))
        .preferredRecovery,
    ).toBe("credentials");
    expect((await value.service.view(value.userId, value.first.id, "https://opentag.example")).allowedIntent).toBe(
      "reauthorize",
    );
  });

  it("does not install for an Agent with no Computer", async () => {
    const value = await fixture();
    const unbound = await value.agentService.createForAccount(value.userId, {
      name: "unbound",
      displayName: "Unbound",
      runtimeProvider: "codex",
    });
    expect((await value.service.view(value.userId, unbound.id, "https://opentag.example")).blockedReason).toBe(
      "AGENT_COMPUTER_NOT_BOUND",
    );
    await expect(value.service.configureToken(value.userId, unbound.id, createInput())).rejects.toMatchObject({
      code: "AGENT_COMPUTER_NOT_BOUND",
    });
    expect(value.inspectInstallation).not.toHaveBeenCalled();
  });

  it("keeps new DTOs strict and requires exact binding/generation for partial updates", () => {
    expect(
      SaveSlackConfigurationRequestSchema.safeParse({ ...createInput(), configuration_method: "manual" }).success,
    ).toBe(false);
    expect(
      SaveSlackConfigurationRequestSchema.safeParse({ intent: "reauthorize", botAccessToken: "token" }).success,
    ).toBe(false);
    expect(
      SaveSlackConfigurationRequestSchema.safeParse({
        intent: "reauthorize",
        expectedMessaging: {
          kind: "bound",
          provider: "slack",
          bindingId: crypto.randomUUID(),
          credentialGeneration: 1,
        },
        botAccessToken: "",
        signingSecret: "",
      }).success,
    ).toBe(false);
  });
});
