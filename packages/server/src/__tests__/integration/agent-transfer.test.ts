import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transferAgent } from "../../admin/transfer-agent.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());
beforeEach(async () => testDatabase.reset());

async function createAccount(client: ReturnType<typeof createDatabaseClient>, label: string) {
  const [user] = await client.database
    .insert(users)
    .values({ email: `${label}@example.test`, displayName: label })
    .returning({ id: users.id });
  if (!user) throw new Error("Account fixture was not created");
  return user.id;
}

describe("Agent transfer against PostgreSQL", () => {
  it("moves a suspended Agent and keeps its Slack installation serving the new owner", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      const source = await createAccount(client, "transfer-source");
      const target = await createAccount(client, "transfer-target");
      const [computer] = await client.database
        .insert(computers)
        .values({
          ownerAccountId: source,
          currentInstallationId: crypto.randomUUID(),
          displayName: "source workstation",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.2",
        })
        .returning();
      if (!computer) throw new Error("Computer fixture was not created");

      const agentsService = new AgentService(client.database);
      const created = await agentsService.createForAccount(source, {
        computerId: computer.id,
        displayName: "Release bot",
        name: "release-bot",
        runtimeProvider: "codex",
      });
      await agentsService.suspendById(source, created.id);

      const [installation] = await client.database
        .insert(slackInstallations)
        .values({
          agentId: created.id,
          status: "active",
          externalAppId: "A1",
          externalTeamId: "T1",
          externalBotId: "B1",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "sealed",
          activatedAt: new Date(),
        })
        .returning();
      if (!installation) throw new Error("Slack installation fixture was not created");
      const [binding] = await client.database
        .insert(imBindings)
        .values({
          agentId: created.id,
          provider: "slack",
          status: "active",
          externalAppId: "A1",
          externalTeamId: "T1",
          externalBotId: "B1",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          slackInstallationId: installation.id,
          slackRouteKind: "default",
          activatedAt: new Date(),
        })
        .returning();
      if (!binding) throw new Error("IM binding fixture was not created");
      const [session] = await client.database
        .insert(sessions)
        .values({
          imBindingId: binding.id,
          channelId: "channel-transfer",
          conversationKind: "channel",
          kind: "channel",
          threadKey: null,
        })
        .returning();
      if (!session) throw new Error("Session fixture was not created");
      await client.database
        .insert(sessionPlacements)
        .values({ sessionId: session.id, computerId: computer.id, generation: 1 });
      // `agent_schedules_disabled_next_null` is the constraint the pause must satisfy in one write.
      await client.database.insert(agentSchedules).values({
        agentId: created.id,
        targetSessionId: session.id,
        name: "daily-digest",
        prompt: "Summarize the day",
        schedule: { kind: "cron", expression: "0 9 * * *" },
        timezone: "UTC",
        nextTriggerAt: new Date(Date.now() - 60_000),
      });

      await expect(
        transferAgent(client.database, { agentId: created.id, targetAccountId: target, slack: "keep" }),
      ).resolves.toMatchObject({
        agentId: created.id,
        imBinding: "kept",
        previousComputerId: computer.id,
        schedulesPaused: 1,
        sourceAccountId: source,
        targetAccountId: target,
      });

      const [moved] = await client.database.select().from(agents).where(eq(agents.id, created.id));
      expect(moved).toMatchObject({ createdByUserId: target, computerId: null, status: "suspended" });
      const [keptBinding] = await client.database.select().from(imBindings).where(eq(imBindings.agentId, created.id));
      expect(keptBinding).toMatchObject({ status: "active", slackInstallationId: installation.id });
      const [pausedSchedule] = await client.database
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.agentId, created.id));
      expect(pausedSchedule).toMatchObject({ enabled: false, nextTriggerAt: null, name: "daily-digest" });

      // The unique (account, lower(name)) index still covers the target Account after the move.
      await expect(
        agentsService.createForAccount(target, {
          displayName: "Duplicate",
          name: "release-bot",
          runtimeProvider: "codex",
        }),
      ).rejects.toMatchObject({ code: "AGENT_NAME_CONFLICT" });
    } finally {
      await client.sql.end();
    }
  });
});
