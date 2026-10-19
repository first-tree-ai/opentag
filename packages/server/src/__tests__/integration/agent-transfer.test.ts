import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transferAgent } from "../../admin/transfer-agent.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/agent-service.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { disableImBindingInTransaction, ImBindingService } from "../../services/im-bindings/index.js";
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
  it("keeps an accepted unreported Turn blocking transfer after messaging is unbound", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      const source = await createAccount(client, "custody-source");
      const target = await createAccount(client, "custody-target");
      const [computer] = await client.database
        .insert(computers)
        .values({
          ownerAccountId: source,
          currentInstallationId: crypto.randomUUID(),
          displayName: "custody workstation",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.2",
        })
        .returning();
      if (!computer) throw new Error("Computer fixture was not created");

      const agentsService = new AgentService(client.database);
      const created = await agentsService.createForAccount(source, {
        computerId: computer.id,
        displayName: "Custody bot",
        name: "custody-bot",
        runtimeProvider: "codex",
      });

      const [binding] = await client.database
        .insert(imBindings)
        .values({
          agentId: created.id,
          provider: "feishu",
          status: "active",
          externalAppId: "cli-custody",
          externalBotId: "feishu-bot",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "sealed",
          activatedAt: new Date(),
        })
        .returning();
      if (!binding) throw new Error("IM binding fixture was not created");
      const [session] = await client.database
        .insert(sessions)
        .values({
          imBindingId: binding.id,
          channelId: "channel-custody",
          conversationKind: "channel",
          kind: "channel",
          threadKey: null,
        })
        .returning();
      if (!session) throw new Error("Session fixture was not created");
      await client.database
        .insert(sessionPlacements)
        .values({ sessionId: session.id, computerId: computer.id, generation: 1 });
      const [message] = await client.database
        .insert(imMessages)
        .values({
          imBindingId: binding.id,
          channelId: "channel-custody",
          externalMessageId: "message-custody",
          providerRevisionKey: "1",
          operation: "created",
          direction: "inbound",
          authorKind: "human",
          authorExternalId: "human-custody",
          content: {
            version: 1,
            fallbackText: "Accepted",
            blocks: [{ type: "text", text: "Accepted" }],
            truncated: false,
          },
          providerContext: { provider: "feishu", chatType: "group" },
          occurredAt: new Date(),
        })
        .returning();
      if (!message) throw new Error("Message fixture was not created");
      await client.database.insert(imMessageDeliveries).values({
        messageId: message.id,
        sessionId: session.id,
        attention: "direct",
        state: "accepted",
        placementGeneration: 1,
        inputHash: crypto.randomUUID(),
        turnId: `turn-${crypto.randomUUID()}`,
        reportOwnerInstanceId: crypto.randomUUID(),
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await agentsService.suspendById(source, created.id);

      await expect(
        transferAgent(client.database, { agentId: created.id, targetAccountId: target }),
      ).rejects.toMatchObject({ reason: "sessions_blocked" });

      const imBindingService = new ImBindingService(client.database, new ApplicationCipher(Buffer.alloc(32, 7)));
      await agentsService.reactivateById(source, created.id);
      await imBindingService.unbindForAgent(source, created.id, { provider: "feishu", bindingId: binding.id });
      await agentsService.suspendById(source, created.id);

      await expect(
        transferAgent(client.database, { agentId: created.id, targetAccountId: target }),
      ).rejects.toMatchObject({ reason: "sessions_blocked" });
      const [unmoved] = await client.database.select().from(agents).where(eq(agents.id, created.id));
      expect(unmoved).toMatchObject({ createdByUserId: source, computerId: computer.id, status: "suspended" });
    } finally {
      await client.sql.end();
    }
  });

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

  it("refuses the transfer after an unbind ends the Session holding an unreported Turn", async () => {
    const client = createDatabaseClient(databaseUrl);
    try {
      const source = await createAccount(client, "custody-source");
      const target = await createAccount(client, "custody-target");
      const [computer] = await client.database
        .insert(computers)
        .values({
          ownerAccountId: source,
          currentInstallationId: crypto.randomUUID(),
          displayName: "custody workstation",
          platform: "linux",
          arch: "x64",
          clientVersion: "0.0.2",
        })
        .returning();
      if (!computer) throw new Error("Computer fixture was not created");

      const agentsService = new AgentService(client.database);
      const created = await agentsService.createForAccount(source, {
        computerId: computer.id,
        displayName: "Custody bot",
        name: "custody-bot",
        runtimeProvider: "codex",
      });
      await agentsService.suspendById(source, created.id);

      const [binding] = await client.database
        .insert(imBindings)
        .values({
          agentId: created.id,
          provider: "feishu",
          status: "active",
          externalAppId: `cli-${crypto.randomUUID().slice(0, 8)}`,
          externalBotId: "feishu-bot",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "sealed",
          activatedAt: new Date(),
        })
        .returning();
      if (!binding) throw new Error("IM binding fixture was not created");
      const [session] = await client.database
        .insert(sessions)
        .values({
          imBindingId: binding.id,
          channelId: "channel-custody",
          conversationKind: "channel",
          kind: "channel",
          threadKey: null,
        })
        .returning();
      if (!session) throw new Error("Session fixture was not created");
      await client.database
        .insert(sessionPlacements)
        .values({ sessionId: session.id, computerId: computer.id, generation: 1 });
      const [message] = await client.database
        .insert(imMessages)
        .values({
          imBindingId: binding.id,
          channelId: "channel-custody",
          externalMessageId: "message-custody",
          providerRevisionKey: "1",
          operation: "created",
          direction: "inbound",
          authorKind: "human",
          authorExternalId: "human-fixture",
          content: {
            version: 1,
            fallbackText: "Unreported",
            blocks: [{ type: "text", text: "Unreported" }],
            truncated: false,
          },
          providerContext: { provider: "feishu", chatType: "group" },
          occurredAt: new Date(),
        })
        .returning();
      if (!message) throw new Error("Message fixture was not created");
      /** Accepted with `reportedAt = null`: the Computer owns this Turn and never reported it. */
      await client.database.insert(imMessageDeliveries).values({
        messageId: message.id,
        sessionId: session.id,
        attention: "direct",
        state: "accepted",
        placementGeneration: 1,
        inputHash: crypto.randomUUID(),
        turnId: `turn-${crypto.randomUUID()}`,
        reportOwnerInstanceId: crypto.randomUUID(),
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
      });

      await expect(
        transferAgent(client.database, { agentId: created.id, targetAccountId: target }),
      ).rejects.toMatchObject({ reason: "sessions_blocked" });

      await client.database.transaction((transaction) =>
        disableImBindingInTransaction(transaction, binding.id, new Date()),
      );
      const [unbound] = await client.database.select().from(imBindings).where(eq(imBindings.id, binding.id));
      expect(unbound).toMatchObject({ status: "disabled" });
      expect(
        await client.database
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.imBindingId, binding.id), isNull(sessions.endedAt))),
      ).toEqual([]);

      // The Session ended, the custody question did not: the transfer must still refuse.
      await expect(
        transferAgent(client.database, { agentId: created.id, targetAccountId: target }),
      ).rejects.toMatchObject({ reason: "sessions_blocked" });
      const [unchanged] = await client.database.select().from(agents).where(eq(agents.id, created.id));
      expect(unchanged).toMatchObject({ createdByUserId: source, computerId: computer.id, status: "suspended" });
    } finally {
      await client.sql.end();
    }
  });
});
