import { SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  sessions,
  slackInstallations,
  users,
  workspaceAdminGrants,
  workspaceComputers,
  workspaces,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const now = new Date("2026-08-27T00:00:00.000Z");
const scopes = [...SLACK_REQUIRED_BOT_SCOPES];

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
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindingsService = new ImBindingService(client.database, cipher, { now: () => now });
  return { ...client, bootstrap, computer, first, imBindingsService, second };
}

async function activate(
  service: ImBindingService,
  agentId: string,
  intent: "create" | "reauthorize",
  overrides: Partial<{
    appId: string;
    teamId: string;
    botUserId: string;
    botId: string;
    token: string;
    signingSecret: string;
  }> = {},
) {
  return service.activateSlack(
    {
      intent,
      agentId,
      appId: overrides.appId ?? "A_OPENTAG",
      teamId: overrides.teamId ?? "T_TEAM",
      botUserId: overrides.botUserId ?? "U_BOT",
      grantedBotScopes: scopes,
      botAccessToken: overrides.token ?? "xoxb-secret",
      signingSecret: overrides.signingSecret ?? "signing-secret",
      installedAt: now,
    },
    overrides.botId ?? "B_BOT",
  );
}

describe("Slack workspace installation routing", () => {
  it("atomically transfers the one current workspace route to the selected Agent", async () => {
    const value = await fixture();
    try {
      const first = await activate(value.imBindingsService, value.first.id, "create");
      const [firstSession] = await value.database
        .insert(sessions)
        .values({
          imBindingId: first.imBindingId,
          channelId: "C_FIRST_ROUTE",
          conversationKind: "channel",
          kind: "channel",
        })
        .returning();
      if (!firstSession) throw new Error("First route Session fixture was not created");
      const second = await activate(value.imBindingsService, value.second.id, "create", { token: "xoxb-second" });
      expect(second.credentialGeneration).toBe(2);
      const installations = await value.database.select().from(slackInstallations);
      expect(installations).toHaveLength(1);
      expect(installations[0]).toMatchObject({
        workspaceId: value.bootstrap.workspaceId,
        credentialGeneration: 2,
        status: "active",
      });
      expect(installations[0]?.encryptedCredential).not.toContain("xoxb-secret");
      expect(installations[0]?.encryptedCredential).not.toContain("signing-secret");
      const routes = await value.database.select().from(imBindings);
      expect(routes.every((row) => row.encryptedCredential === null)).toBe(true);
      expect(routes.find((row) => row.agentId === value.first.id)).toMatchObject({
        status: "disabled",
        replacementImBindingId: second.imBindingId,
      });
      expect(routes.find((row) => row.agentId === value.second.id)).toMatchObject({
        status: "active",
        slackRouteKind: "default",
      });
      expect(routes.filter((row) => row.status !== "disabled")).toHaveLength(1);
      const [endedSession] = await value.database.select().from(sessions).where(eq(sessions.id, firstSession.id));
      expect(endedSession).toMatchObject({ endedAt: now, revision: 2 });
      await expect(
        value.imBindingsService.getForAgent(value.bootstrap.userId, value.first.id),
      ).resolves.toBeUndefined();
      await expect(
        value.imBindingsService.getHandoffForAgent(value.bootstrap.userId, value.first.id),
      ).resolves.toBeUndefined();
      await expect(value.imBindingsService.findSlackIngressBinding("A_OPENTAG", "T_TEAM")).resolves.toMatchObject({
        imBindingId: second.imBindingId,
        installationId: installations[0]?.id,
        generation: 2,
      });
      await expect(value.imBindingsService.resolveSlackDefaultRoute(installations[0]?.id as string)).resolves.toEqual({
        imBindingId: second.imBindingId,
        agentId: value.second.id,
        installationId: installations[0]?.id,
        generation: 2,
        routeKind: "default",
      });
      expect(first.imBindingId).not.toBe(second.imBindingId);
    } finally {
      await value.sql.end();
    }
  });

  it("fails closed for unconfigured, cross-workspace, and deleted default Agents", async () => {
    const value = await fixture();
    try {
      await expect(
        value.imBindingsService.findSlackInstallationIngress("A_OPENTAG", "T_TEAM"),
      ).resolves.toBeUndefined();
      await activate(value.imBindingsService, value.first.id, "create");
      const [installation] = await value.database.select().from(slackInstallations);
      if (!installation) throw new Error("Installation fixture was not created");

      const [otherUser] = await value.database
        .insert(users)
        .values({ email: "other@example.com", displayName: "Other Admin" })
        .returning();
      const [otherWorkspace] = await value.database
        .insert(workspaces)
        .values({ name: "other", displayName: "Other" })
        .returning();
      if (!otherUser || !otherWorkspace) throw new Error("Cross-workspace fixture was not created");
      await value.database.insert(workspaceAdminGrants).values({
        workspaceId: otherWorkspace.id,
        userId: otherUser.id,
        grantedByUserId: otherUser.id,
      });
      const [otherComputer] = await value.database.insert(computers).values({ id: crypto.randomUUID() }).returning();
      if (!otherComputer) throw new Error("Other computer fixture was not created");
      await value.database.insert(workspaceComputers).values({
        workspaceId: otherWorkspace.id,
        computerId: otherComputer.id,
        displayName: "other-workstation",
        platform: "linux",
        arch: "x64",
        clientVersion: "0.0.1",
        enrolledByUserId: otherUser.id,
      });
      const outsider = await new AgentService(value.database).createForWorkspace(otherUser.id, otherWorkspace.id, {
        name: "outsider",
        displayName: "Outsider",
        runtimeProvider: "codex",
        computerId: otherComputer.id,
      });
      await expect(
        activate(value.imBindingsService, outsider.id, "create", { token: "xoxb-outsider" }),
      ).rejects.toMatchObject({ code: "SLACK_APP_TEAM_ALREADY_BOUND", statusCode: 409 });
      expect(await value.database.select().from(slackInstallations)).toHaveLength(1);

      await value.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, value.first.id));
      await expect(value.imBindingsService.resolveSlackDefaultRoute(installation.id)).resolves.toBeUndefined();
      await expect(value.imBindingsService.findSlackIngressBinding("A_OPENTAG", "T_TEAM")).resolves.toBeUndefined();
      await expect(value.imBindingsService.findSlackInstallationIngress("A_OPENTAG", "T_TEAM")).resolves.toMatchObject({
        installationId: installation.id,
      });

      await activate(value.imBindingsService, value.second.id, "create", { token: "xoxb-second" });
      await value.imBindingsService.disable(
        value.bootstrap.userId,
        (await value.database.select().from(imBindings)).find((row) => row.agentId === value.second.id)?.id as string,
      );
      await expect(value.imBindingsService.resolveSlackDefaultRoute(installation.id)).resolves.toBeUndefined();
      const remaining = await value.database.select().from(slackInstallations);
      expect(remaining[0]).toMatchObject({ status: "disabled", id: installation.id, encryptedCredential: null });
    } finally {
      await value.sql.end();
    }
  });

  it("fences stale generations and provider lifecycle on the installation", async () => {
    const value = await fixture();
    try {
      const created = await activate(value.imBindingsService, value.first.id, "create");
      const [installation] = await value.database.select().from(slackInstallations);
      if (!installation) throw new Error("Installation fixture was not created");
      await expect(value.imBindingsService.recordSlackInstallationIdentityClosure(installation.id, 99)).resolves.toBe(
        false,
      );
      await expect(
        value.imBindingsService.requireSlackInstallationReauthorization(installation.id, 99, "SLACK_TOKEN_REVOKED"),
      ).resolves.toBe(false);
      await expect(value.imBindingsService.disableSlackInstallationFromProvider(installation.id, 99)).resolves.toBe(
        false,
      );

      const reauthorized = await activate(value.imBindingsService, value.first.id, "reauthorize", {
        token: "xoxb-reauth",
      });
      expect(reauthorized).toMatchObject({ imBindingId: created.imBindingId, credentialGeneration: 2 });
      await expect(value.imBindingsService.recordSlackInstallationObservation(installation.id, 1)).resolves.toBe(false);
      await expect(value.imBindingsService.recordSlackInstallationIdentityClosure(installation.id, 2)).resolves.toBe(
        true,
      );
      await expect(
        value.imBindingsService.requireSlackInstallationReauthorization(installation.id, 2, "SLACK_TOKEN_REVOKED"),
      ).resolves.toBe(true);
      const [revoked] = await value.database
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.id, installation.id));
      expect(revoked).toMatchObject({ status: "reauthorization_required", lastErrorCode: "SLACK_TOKEN_REVOKED" });
      await expect(value.imBindingsService.disableSlackInstallationFromProvider(installation.id, 2)).resolves.toBe(
        true,
      );
      const [disabledInstallation] = await value.database
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.id, installation.id));
      expect(disabledInstallation).toMatchObject({ status: "disabled", encryptedCredential: null });
      const [disabledRoute] = await value.database
        .select()
        .from(imBindings)
        .where(eq(imBindings.id, created.imBindingId));
      expect(disabledRoute).toMatchObject({ status: "disabled", encryptedCredential: null });
    } finally {
      await value.sql.end();
    }
  });

  it("atomically replaces a migrated Slack installation and ends every old route Session", async () => {
    const value = await fixture();
    try {
      const migrated = await activate(value.imBindingsService, value.first.id, "create", {
        appId: "A_CUSTOMER",
        teamId: "T_CUSTOMER",
        botUserId: "U_CUSTOMER",
        botId: "B_CUSTOMER",
        token: "xoxb-customer",
      });
      const [migratedInstallation] = await value.database.select().from(slackInstallations);
      if (!migratedInstallation) throw new Error("Migrated installation fixture was not created");
      const [session] = await value.database
        .insert(sessions)
        .values({
          imBindingId: migrated.imBindingId,
          channelId: "C_MIGRATED",
          conversationKind: "channel",
          kind: "channel",
        })
        .returning();
      if (!session) throw new Error("Migrated Session fixture was not created");

      const replacement = await activate(value.imBindingsService, value.first.id, "reauthorize", {
        appId: "A_OPENTAG",
        teamId: "T_OPENTAG",
        botUserId: "U_OPENTAG",
        botId: "B_OPENTAG",
        token: "xoxb-opentag",
      });
      expect(replacement).toMatchObject({ credentialGeneration: 1, agentId: value.first.id });
      expect(replacement.imBindingId).not.toBe(migrated.imBindingId);

      const installations = await value.database.select().from(slackInstallations);
      const disabledInstallation = installations.find((row) => row.id === migratedInstallation.id);
      const currentInstallation = installations.find((row) => row.id !== migratedInstallation.id);
      expect(disabledInstallation).toMatchObject({
        status: "disabled",
        encryptedCredential: null,
        replacementSlackInstallationId: currentInstallation?.id,
      });
      expect(currentInstallation).toMatchObject({
        status: "active",
        externalAppId: "A_OPENTAG",
        externalTeamId: "T_OPENTAG",
        externalBotId: "U_OPENTAG",
      });

      const routes = await value.database.select().from(imBindings);
      expect(routes.find((row) => row.id === migrated.imBindingId)).toMatchObject({
        status: "disabled",
        replacementImBindingId: replacement.imBindingId,
      });
      expect(routes.find((row) => row.id === replacement.imBindingId)).toMatchObject({
        status: "active",
        slackRouteKind: "default",
        slackInstallationId: currentInstallation?.id,
      });
      const [endedSession] = await value.database.select().from(sessions).where(eq(sessions.id, session.id));
      expect(endedSession).toMatchObject({ endedAt: now, revision: 2 });
    } finally {
      await value.sql.end();
    }
  });

  it("releases the installation on last-route disconnect so a different Slack workspace can be installed", async () => {
    const value = await fixture();
    try {
      const created = await activate(value.imBindingsService, value.first.id, "create");
      const [originalInstallation] = await value.database.select().from(slackInstallations);
      if (!originalInstallation) throw new Error("Original installation fixture was not created");

      await value.imBindingsService.disable(value.bootstrap.userId, created.imBindingId);
      const [disabledInstallation] = await value.database
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.id, originalInstallation.id));
      expect(disabledInstallation).toMatchObject({ status: "disabled", encryptedCredential: null, disabledAt: now });

      const reinstalled = await activate(value.imBindingsService, value.first.id, "create", {
        appId: "A_OPENTAG_NEW",
        teamId: "T_TEAM_NEW",
        botUserId: "U_BOT_NEW",
        botId: "B_BOT_NEW",
        token: "xoxb-new",
      });
      expect(reinstalled).toMatchObject({ credentialGeneration: 1, agentId: value.first.id });
      const currentInstallations = (await value.database.select().from(slackInstallations)).filter(
        (row) => row.status !== "disabled",
      );
      expect(currentInstallations).toEqual([
        expect.objectContaining({
          externalAppId: "A_OPENTAG_NEW",
          externalTeamId: "T_TEAM_NEW",
          externalBotId: "U_BOT_NEW",
        }),
      ]);
    } finally {
      await value.sql.end();
    }
  });

  it("cuts over a stranded installation that has no current route", async () => {
    const value = await fixture();
    try {
      const [stranded] = await value.database
        .insert(slackInstallations)
        .values({
          workspaceId: value.bootstrap.workspaceId,
          status: "active",
          externalAppId: "A_STRANDED",
          externalTeamId: "T_STRANDED",
          externalBotId: "U_STRANDED",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "encrypted-stranded",
          grantedCapabilities: scopes,
          activatedAt: now,
        })
        .returning();
      if (!stranded) throw new Error("Stranded installation fixture was not created");

      await activate(value.imBindingsService, value.first.id, "create", {
        appId: "A_OPENTAG",
        teamId: "T_TEAM",
      });
      const installations = await value.database.select().from(slackInstallations);
      const replacement = installations.find((row) => row.status === "active");
      expect(installations.find((row) => row.id === stranded.id)).toMatchObject({
        status: "disabled",
        encryptedCredential: null,
        replacementSlackInstallationId: replacement?.id,
      });
      expect(replacement).toMatchObject({ externalAppId: "A_OPENTAG", externalTeamId: "T_TEAM" });
    } finally {
      await value.sql.end();
    }
  });

  it("projects outbound Bot tokens from the workspace installation without the signing secret", async () => {
    const value = await fixture();
    try {
      const created = await activate(value.imBindingsService, value.first.id, "create");
      await value.imBindingsService.recordSlackIdentityClosure(created.imBindingId, 1);
      const material = await value.imBindingsService.getSlackConnectionMaterial(created.imBindingId);
      expect(material).toMatchObject({
        imBindingId: created.imBindingId,
        generation: 1,
        botAccessToken: "xoxb-secret",
      });
      expect(JSON.stringify(material)).not.toContain("signing-secret");
      await activate(value.imBindingsService, value.second.id, "create", { token: "xoxb-second" });
      const secondRoute = (await value.database.select().from(imBindings)).find(
        (row) => row.agentId === value.second.id,
      );
      if (!secondRoute) throw new Error("Second route was not created");
      await value.imBindingsService.recordSlackIdentityClosure(secondRoute.id, 2);
      const secondMaterial = await value.imBindingsService.getSlackConnectionMaterial(secondRoute.id);
      expect(secondMaterial).toMatchObject({ generation: 2, botAccessToken: "xoxb-second" });
      expect(secondMaterial?.installationId).toBe(material?.installationId);
    } finally {
      await value.sql.end();
    }
  });
});
