import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  agents,
  computerCredentials,
  computers,
  imBindings,
  sessions,
  slackInstallations,
  slackOAuthNonces,
  workspaceComputers,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import {
  SlackConfigurationService,
  SlackOAuthService,
  SlackOAuthStateService,
} from "../../services/im-bindings/slack/index.js";
import { bootstrapTestAccount as bootstrapInitialAdmin } from "../test-account.js";
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
      clientVersion: "0.0.2",
      enrolledByUserId: bootstrap.userId,
    })
    .returning();
  if (!workspaceComputer) throw new Error("Workspace Computer fixture was not created");
  await client.database.insert(accountComputers).values({
    id: workspaceComputer.id,
    ownerAccountId: bootstrap.userId,
    currentInstallationId: computer.id,
    displayName: "workstation",
    platform: "linux",
    arch: "x64",
    clientVersion: "0.0.2",
  });
  await client.database.insert(computerCredentials).values({
    computerId: workspaceComputer.id,
    secretHash: `integration-slack-oauth-${computer.id}`,
    issuedByUserId: bootstrap.userId,
  });
  const agentsService = new AgentService(client.database);
  const first = await agentsService.createForAccount(bootstrap.userId, {
    name: "assistant",
    displayName: "Assistant",
    runtimeProvider: "codex",
    computerId: workspaceComputer.id,
  });
  const second = await agentsService.createForAccount(bootstrap.userId, {
    name: "reviewer",
    displayName: "Reviewer",
    runtimeProvider: "codex",
    computerId: workspaceComputer.id,
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
    imBindings: imBindingService,
    now: () => now,
  });
  const oauth = new SlackOAuthService({
    api: api as never,
    app: slackApp,
    database: client.database,
    now: () => now,
    slack,
    state: new SlackOAuthStateService(jwtSecret, { now: () => now }),
  });
  const unbound = await agentsService.createForAccount(bootstrap.userId, {
    name: "unbound",
    displayName: "Unbound",
    runtimeProvider: "codex",
  });
  return { ...client, api, bootstrap, first, imBindingService, oauth, second, slack, unbound };
}

describe("Slack distributed OAuth adapter", () => {
  it("rejects the removed Slack replace intent at the database boundary", async () => {
    const value = await fixture();
    try {
      await expect(
        value.database.insert(slackOAuthNonces).values({
          nonceHash: "removed-replace-nonce-hash",
          userId: value.bootstrap.userId,
          agentId: value.first.id,
          intent: "replace",
          sessionBindingHash: "removed-replace-session-binding-hash",
          createdAt: now,
          expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        }),
      ).rejects.toMatchObject({
        cause: { code: "23514", constraint_name: "slack_oauth_nonces_intent" },
      });
    } finally {
      await value.sql.end();
    }
  });

  it("refuses to start or finish a Slack install for an Agent that has no Computer", async () => {
    const value = await fixture();
    try {
      // Refused before the Account installs anything. Learning this only at activation would mean
      // asking someone to install a Slack App that could never have been bound to a route.
      await expect(value.oauth.start(value.bootstrap.userId, value.unbound.id, "create")).rejects.toMatchObject({
        code: "AGENT_COMPUTER_NOT_BOUND",
        statusCode: 409,
      });
      expect(await value.database.select().from(slackOAuthNonces)).toHaveLength(0);
      // And refused again at the commit, which is what covers an Agent unbound after start.
      await expect(
        value.slack.configure(value.bootstrap.userId, value.unbound.id, {
          intent: "create",
          expectedBinding: null,
          appId: "A_OPENTAG",
          botAccessToken: "xoxb-distributed",
          signingSecret: "signing-secret",
        }),
      ).rejects.toMatchObject({ code: "AGENT_COMPUTER_NOT_BOUND", statusCode: 409 });
    } finally {
      await value.sql.end();
    }
  });

  it("activates one first-party installation through the Slack installation boundary", async () => {
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
        authenticatedUserId: value.bootstrap.userId,
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
      expect(binding?.encryptedCredential).toBeNull();
      expect(binding?.slackRouteKind).toBe("default");
      expect(binding?.slackInstallationId).toEqual(expect.any(String));
      const [installation] = await value.database
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.id, binding?.slackInstallationId as string));
      expect(installation?.encryptedCredential).toEqual(expect.any(String));
      expect(installation?.encryptedCredential).not.toContain("xoxb-distributed");
      expect(installation?.encryptedCredential).not.toContain(slackApp.signingSecret);
      expect(installation?.agentId).toBe(value.first.id);

      await expect(
        value.oauth.callback({
          authenticatedUserId: value.bootstrap.userId,
          code: "slack-oauth-code",
          sessionBinding: started.sessionBinding,
          state,
        }),
      ).rejects.toMatchObject({ code: "SLACK_OAUTH_FAILED" });
    } finally {
      await value.sql.end();
    }
  });

  it("replaces a migrated customer-owned App with the first-party installation during reauthorization", async () => {
    const value = await fixture();
    try {
      const migrated = await value.imBindingService.activateSlack(
        {
          intent: "create",
          agentId: value.first.id,
          appId: "A_CUSTOMER",
          teamId: "T_CUSTOMER",
          botUserId: "U_CUSTOMER",
          grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
          botAccessToken: "xoxb-customer",
          signingSecret: "customer-signing-secret",
          installedAt: now,
        },
        "B_CUSTOMER",
      );
      const [migratedInstallation] = await value.database.select().from(slackInstallations);
      if (!migratedInstallation) throw new Error("Migrated installation fixture was not created");
      const [session] = await value.database
        .insert(sessions)
        .values({
          imBindingId: migrated.imBindingId,
          channelId: "C_MIGRATED_OAUTH",
          conversationKind: "channel",
          kind: "channel",
        })
        .returning();
      if (!session) throw new Error("Migrated Session fixture was not created");

      const started = await value.oauth.start(value.bootstrap.userId, value.first.id, "reauthorize");
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("OAuth start did not return state");
      const completed = await value.oauth.callback({
        authenticatedUserId: value.bootstrap.userId,
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
      });
      expect(completed.result.imBindingId).not.toBe(migrated.imBindingId);

      const installations = await value.database.select().from(slackInstallations);
      const replacement = installations.find((row) => row.status === "active");
      expect(installations.find((row) => row.id === migratedInstallation.id)).toMatchObject({
        status: "disabled",
        encryptedCredential: null,
        replacementSlackInstallationId: replacement?.id,
      });
      expect(replacement).toMatchObject({
        externalAppId: "A_OPENTAG",
        externalTeamId: "T_TEAM",
        externalBotId: "U_BOT",
        agentId: value.first.id,
      });
      const bindings = await value.database.select().from(imBindings);
      expect(bindings.find((row) => row.id === migrated.imBindingId)).toMatchObject({
        status: "disabled",
        replacementImBindingId: completed.result.imBindingId,
      });
      expect(bindings.find((row) => row.id === completed.result.imBindingId)).toMatchObject({
        status: "active",
        slackRouteKind: "default",
        slackInstallationId: replacement?.id,
      });
      const [endedSession] = await value.database.select().from(sessions).where(eq(sessions.id, session.id));
      expect(endedSession).toMatchObject({ endedAt: expect.any(Date), revision: 2 });
    } finally {
      await value.sql.end();
    }
  });

  it("rejects cross-Agent OAuth for a current installation without changing its owner or route", async () => {
    const value = await fixture();
    try {
      const firstConfigured = await value.slack.configure(value.bootstrap.userId, value.first.id, {
        intent: "create",
        expectedBinding: null,
        appId: "A_OPENTAG",
        botAccessToken: "xoxb-first",
        signingSecret: slackApp.signingSecret,
      });
      const [installationBefore] = await value.database.select().from(slackInstallations);
      if (!installationBefore) throw new Error("First installation fixture was not created");
      const started = await value.oauth.start(value.bootstrap.userId, value.second.id, "create");
      const state = new URL(started.authorizationUrl).searchParams.get("state");
      if (!state) throw new Error("OAuth start did not return state");
      await expect(
        value.oauth.callback({
          authenticatedUserId: value.bootstrap.userId,
          code: "slack-oauth-code",
          sessionBinding: started.sessionBinding,
          state,
        }),
      ).rejects.toMatchObject({ code: "SLACK_APP_TEAM_ALREADY_BOUND", statusCode: 409 });

      const rows = await value.database.select().from(imBindings);
      expect(rows).toEqual([
        expect.objectContaining({
          id: firstConfigured.imBindingId,
          agentId: value.first.id,
          status: "active",
          slackRouteKind: "default",
          slackInstallationId: installationBefore.id,
          credentialGeneration: 1,
          encryptedCredential: null,
        }),
      ]);
      const installations = await value.database.select().from(slackInstallations);
      expect(installations).toEqual([
        expect.objectContaining({
          id: installationBefore.id,
          workspaceId: value.bootstrap.workspaceId,
          credentialGeneration: 1,
          status: "active",
          agentId: value.first.id,
        }),
      ]);
    } finally {
      await value.sql.end();
    }
  });
});
