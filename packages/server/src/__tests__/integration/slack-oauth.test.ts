import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings, slackOAuthNonces, workspaceComputers } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import {
  SlackConfigurationService,
  SlackOAuthService,
  SlackOAuthStateService,
} from "../../services/im-bindings/slack/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const now = new Date("2026-08-25T00:00:00.000Z");
const jwtSecret = "slack-oauth-integration-secret-at-least-32";
const slackApp = {
  clientId: "slack-client-id",
  clientSecret: "slack-client-secret",
  signingSecret: "first-party-signing-secret",
  redirectUrl: "https://opentag.example.com/api/v1/im-bindings/slack/oauth/callback",
};

let testDatabase: MigratedTestDatabase;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);

afterAll(async () => testDatabase.stop());

beforeEach(async () => testDatabase.reset());

async function fixture() {
  const client = createDatabaseClient(testDatabase.databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
    workspaceDisplayName: "Example",
    workspaceName: "example",
  });
  const [computer] = await client.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const [workspaceComputer] = await client.database
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
  const agentsService = new AgentService(client.database);
  const first = await agentsService.createForWorkspace(bootstrap.userId, bootstrap.workspaceId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const second = await agentsService.createForWorkspace(bootstrap.userId, bootstrap.workspaceId, {
    name: "reviewer",
    displayName: "Reviewer",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  await client.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, first.id));
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindingService = new ImBindingService(client.database, cipher);
  const api = {
    inspectInstallation: vi.fn().mockResolvedValue({
      appId: "A_OPENTAG",
      teamId: "T_TEAM",
      enterpriseId: null,
      botUserId: "U_BOT",
      botId: "B_BOT",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
    }),
    oauthAccess: vi.fn().mockResolvedValue({
      appId: "A_OPENTAG",
      teamId: "T_TEAM",
      enterpriseId: null,
      botUserId: "U_BOT",
      botAccessToken: "xoxb-distributed",
    }),
  };
  const slack = new SlackConfigurationService({
    api: api as never,
    database: client.database,
    distributedOAuthAvailable: true,
    imBindings: imBindingService,
    publicOrigin: "https://opentag.example.com",
    now: () => now,
  });
  const oauth = new SlackOAuthService({
    api: api as never,
    app: slackApp,
    authenticateUser: async () => ({ userId: bootstrap.userId }),
    database: client.database,
    now: () => now,
    slack,
    state: new SlackOAuthStateService(jwtSecret, { now: () => now }),
  });
  return { ...client, api, bootstrap, first, oauth, second, slack };
}

describe("Slack distributed OAuth adapter", () => {
  it("activates one first-party installation through the existing Slack configuration boundary", async () => {
    const value = await fixture();
    try {
      await value.database.insert(slackOAuthNonces).values({
        nonceHash: "expired-nonce-hash",
        userId: value.bootstrap.userId,
        agentId: value.first.id,
        intent: "create",
        sessionBindingHash: "expired-session-binding-hash",
        createdAt: new Date(now.getTime() - 20 * 60 * 1000),
        expiresAt: new Date(now.getTime() - 10 * 60 * 1000),
      });
      const configuration = await value.slack.get(value.bootstrap.userId, value.first.id);
      expect(configuration.distributedOAuthAvailable).toBe(true);
      const started = await value.oauth.start(value.bootstrap.userId, value.first.id, "create");
      expect(started.authorizationUrl).toContain("client_id=slack-client-id");
      expect(started.authorizationUrl).toContain("state=");
      expect(started.authorizationUrl).not.toContain(slackApp.clientSecret);
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("OAuth start did not return state");
      const [nonce] = await value.database.select().from(slackOAuthNonces);
      expect(nonce).toMatchObject({ userId: value.bootstrap.userId, agentId: value.first.id, intent: "create" });
      expect(nonce?.nonceHash).not.toContain(state);
      expect(
        await value.database
          .select()
          .from(slackOAuthNonces)
          .where(eq(slackOAuthNonces.nonceHash, "expired-nonce-hash")),
      ).toHaveLength(0);

      const completed = await value.oauth.callback({
        accessToken: "browser-access",
        code: "slack-oauth-code",
        sessionBinding: started.sessionBinding,
        state,
      });
      expect(completed.result).toMatchObject({
        agentId: value.first.id,
        appId: "A_OPENTAG",
        teamId: "T_TEAM",
        botUserId: "U_BOT",
        credentialGeneration: 1,
        bindingState: "active",
      });
      expect(value.api.oauthAccess).toHaveBeenCalledWith({
        clientId: slackApp.clientId,
        clientSecret: slackApp.clientSecret,
        code: "slack-oauth-code",
        redirectUri: slackApp.redirectUrl,
      });
      const [binding] = await value.database.select().from(imBindings);
      expect(binding).toMatchObject({
        provider: "slack",
        status: "active",
        externalAppId: "A_OPENTAG",
        externalTeamId: "T_TEAM",
        encryptedSetupContext: null,
      });
      expect(binding?.encryptedCredential).not.toContain("xoxb-distributed");
      expect(binding?.encryptedCredential).not.toContain(slackApp.signingSecret);

      await expect(
        value.oauth.callback({
          accessToken: "browser-access",
          code: "slack-oauth-code",
          sessionBinding: started.sessionBinding,
          state,
        }),
      ).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED" });
    } finally {
      await value.sql.end();
    }
  });

  it("returns an explicit conflict when the same Slack workspace is already bound to another Agent", async () => {
    const value = await fixture();
    try {
      await value.slack.configure(value.bootstrap.userId, value.first.id, {
        intent: "create",
        expectedBinding: null,
        appId: "A_OPENTAG",
        botAccessToken: "xoxb-first",
        signingSecret: slackApp.signingSecret,
      });
      const started = await value.oauth.start(value.bootstrap.userId, value.second.id, "create");
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("OAuth start did not return state");
      await expect(
        value.oauth.callback({
          accessToken: "browser-access",
          code: "slack-oauth-code",
          sessionBinding: started.sessionBinding,
          state,
        }),
      ).rejects.toMatchObject({ code: "SLACK_APP_TEAM_ALREADY_BOUND", statusCode: 409 });
      const rows = await value.database.select().from(imBindings);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ agentId: value.first.id, status: "active", credentialGeneration: 1 });
    } finally {
      await value.sql.end();
    }
  });
});
