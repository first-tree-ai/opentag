/**
 * The Agent list's two unreported-accepted reads must use the partial index that exists for them.
 *
 * Without it, the reads join every Session of a binding to answer "which Turns are still unreported?", which
 * cost 100,001 probes for one hot Agent in the 100k-row benchmark. This suite runs the real service, captures
 * the statements it issued, and explains them, so the claim is about the query the list actually runs.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import * as schema from "../../db/schema/index.js";
import {
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const NOW = new Date("2026-06-01T09:00:00.000Z");
const REPORT_OWNER = "11111111-1111-4111-8111-111111111111";

let testDatabase: MigratedTestDatabase;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("Agent list unreported-accepted index", () => {
  it("exists with the exact partial predicate the reads need", async () => {
    const client = createDatabaseClient(testDatabase.databaseUrl);
    try {
      const [definition] = await client.sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'im_message_deliveries_unreported_accepted_idx'
      `;
      // PostgreSQL's rendering varies by version, so the assertion is on the parts that matter.
      expect(definition?.indexdef).toContain("accepted_at");
      expect(definition?.indexdef).toContain("session_id");
      expect(definition?.indexdef).toMatch(/WHERE .*state = 'accepted'.*reported_at IS NULL/);
    } finally {
      await client.sql.end();
    }
  }, 30_000);

  it("is the access path the list's unreported reads choose", async () => {
    const client = createDatabaseClient(testDatabase.databaseUrl);
    const queries: { query: string; params: unknown[] }[] = [];
    try {
      const database = drizzle(client.sql, {
        schema,
        logger: { logQuery: (query, params) => queries.push({ query, params }) },
      });
      const owner = await bootstrapInitialAdmin(database, { displayName: "Owner", email: "index@example.test" });
      const [computer] = await database
        .insert(computers)
        .values({
          ownerAccountId: owner.userId,
          currentInstallationId: randomUUID(),
          currentInstanceId: randomUUID(),
          displayName: "box",
          platform: "linux",
          arch: "x64",
          clientVersion: "1",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning({ id: computers.id });
      if (!computer) throw new Error("Computer fixture missing");
      const agents = new AgentService(database, { now: () => NOW });
      const agent = await agents.createForAccount(owner.userId, {
        computerId: computer.id,
        runtimeProvider: "codex",
        name: "indexed",
        displayName: "Indexed",
      });
      const [binding] = await database
        .insert(imBindings)
        .values({
          agentId: agent.id,
          provider: "feishu",
          status: "active",
          externalAppId: `app-${randomUUID()}`,
          externalBotId: "bot",
          credentialSchemaVersion: 1,
          credentialGeneration: 1,
          encryptedCredential: "sealed",
          activatedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning({ id: imBindings.id });
      if (!binding) throw new Error("IM binding fixture missing");
      const [session] = await database
        .insert(sessions)
        .values({ imBindingId: binding.id, channelId: "C1", conversationKind: "dm", kind: "channel", createdAt: NOW })
        .returning({ id: sessions.id });
      if (!session) throw new Error("Session fixture missing");
      await database
        .insert(sessionPlacements)
        .values({ sessionId: session.id, computerId: computer.id, generation: 1 });
      // One unreported accepted Turn: the fixture the two activity reads exist for.
      const [message] = await database
        .insert(imMessages)
        .values({
          imBindingId: binding.id,
          providerEventId: `event-${randomUUID()}`,
          channelId: "C1",
          externalMessageId: `message-${randomUUID()}`,
          providerRevisionKey: "1",
          operation: "created",
          direction: "inbound",
          authorKind: "human",
          authorExternalId: "human",
          content: { version: 1, fallbackText: "turn", blocks: [{ type: "text", text: "turn" }], truncated: false },
          providerContext: { provider: "feishu", chatType: "dm" },
          occurredAt: NOW,
        })
        .returning({ id: imMessages.id });
      if (!message) throw new Error("Message fixture missing");
      await database.insert(imMessageDeliveries).values({
        messageId: message.id,
        sessionId: session.id,
        attention: "direct",
        state: "accepted",
        placementGeneration: 1,
        inputHash: `input-${randomUUID()}`,
        turnId: `turn-${randomUUID()}`,
        reportOwnerInstanceId: REPORT_OWNER,
        acceptedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      });

      queries.length = 0;
      const listed = await agents.listForAccount(owner.userId);
      expect(listed.agents).toHaveLength(1);
      expect(listed.agents[0]?.activity).toEqual({ state: "working", startedAt: NOW.toISOString() });

      const unreported = queries.filter((entry) => entry.query.includes('"reported_at" is null'));
      expect(unreported.length).toBeGreaterThan(0);
      await client.sql.unsafe("set enable_seqscan = off");
      for (const statement of unreported) {
        const plan = await client.sql.unsafe(`explain (format json) ${statement.query}`, statement.params as never[]);
        expect(JSON.stringify(plan)).toContain("im_message_deliveries_unreported_accepted_idx");
      }
      await client.sql.unsafe("reset enable_seqscan");
    } finally {
      await client.sql.end();
    }
  }, 60_000);
});
