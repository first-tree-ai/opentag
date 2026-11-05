/**
 * The Agent list's two unreported-accepted reads must use the partial index that exists for them, and
 * its queued-Task read must start from the listed Agents' live Sessions without reading Internal Sessions.
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
  users,
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
      const { owner, agents, session, message } = await activityFixture(database, "indexed");
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
      expect(listed.agents[0]?.activity).toEqual({
        state: "working",
        startedAt: NOW.toISOString(),
        runningTaskCount: 1,
      });

      // The queued read asks about the same deliveries Session by Session, so it is not one of these two.
      const unreported = queries.filter(
        (entry) => entry.query.includes('"reported_at" is null') && !entry.query.includes("= any("),
      );
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

  it("reads the queued count from the listed Agents' live Sessions, then their deliveries", async () => {
    const client = createDatabaseClient(testDatabase.databaseUrl);
    const queries: { query: string; params: unknown[] }[] = [];
    try {
      const database = drizzle(client.sql, {
        schema,
        logger: { logQuery: (query, params) => queries.push({ query, params }) },
      });
      // Another Account's Agent with a deep queue: it must not change this Account's count.
      const [neighbour] = await database
        .insert(users)
        .values({ email: `neighbour-${randomUUID()}@example.test`, displayName: "Neighbour", setupCompletedAt: NOW })
        .returning({ id: users.id });
      if (!neighbour) throw new Error("Neighbour fixture missing");
      const noisy = await activityFixture(database, "noisy", neighbour.id);
      await client.sql.unsafe(
        `
        with queued as (
          insert into im_messages(im_binding_id,provider_event_id,channel_id,external_message_id,provider_revision_key,
            operation,direction,author_kind,author_external_id,content,provider_context,occurred_at)
          select s.im_binding_id,'noise-event-'||n,s.channel_id,'noise-'||n,'1','created','inbound','human','human',
            '{"version":1,"fallbackText":"noise","blocks":[],"truncated":false}'::jsonb,'{"provider":"feishu"}'::jsonb,$2
          from sessions s, generate_series(1, ${NOISY_BACKLOG}) n
          where s.id = $1
          returning id
        )
        insert into im_message_deliveries(message_id,session_id,attention,state,placement_generation,next_attempt_at,expires_at)
        select id,$1,'direct','pending',1,$2,$3 from queued
        `,
        [noisy.session.id, NOW.toISOString(), new Date(NOW.getTime() + 86_400_000).toISOString()],
      );

      const { owner, agents, agent, session, message } = await activityFixture(database, "queued");
      await database.insert(imMessageDeliveries).values({
        messageId: message.id,
        sessionId: session.id,
        attention: "direct",
        state: "pending",
        placementGeneration: 1,
        nextAttemptAt: NOW,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
      });
      // Many long-lived idle conversations and the Internal Sessions a busy binding piles up.
      await client.sql.unsafe(
        `
        insert into sessions(im_binding_id,channel_id,conversation_kind,kind,thread_key)
        select s.im_binding_id,'C1','channel','thread','idle-'||n
        from sessions s, generate_series(1, ${IDLE_SESSIONS}) n where s.id = $1
        `,
        [session.id],
      );
      await client.sql.unsafe(
        `
        insert into sessions(im_binding_id,channel_id,conversation_kind,kind,created_by_session_id)
        select s.im_binding_id,'C1','dm','internal',s.id
        from sessions s, generate_series(1, ${INTERNAL_SESSIONS}) n where s.id = $1
        `,
        [session.id],
      );
      await client.sql.unsafe("analyze");

      queries.length = 0;
      const listed = await agents.listForAccount(owner.userId);
      expect(listed.agents.find((entry) => entry.id === agent.id)?.activity).toEqual({
        state: "idle",
        queuedTaskCount: 1,
      });
      const liveSessionReads = queries.filter((entry) => entry.query.includes(`"kind" = 'channel'`));
      const pendingReads = queries.filter((entry) => entry.query.includes("= any($1::uuid[])"));
      expect(liveSessionReads).toHaveLength(1);
      expect(pendingReads).toHaveLength(1);

      // Both steps run under the default planner. The first reads the live Sessions through their partial
      // indexes and no Internal Session; the array parameter carries every one of them to the second.
      const [liveRead] = liveSessionReads;
      if (!liveRead) throw new Error("Live Session read missing");
      const [explained] = await client.sql.unsafe(
        `explain (analyze, format json) ${liveRead.query}`,
        liveRead.params as never[],
      );
      const plan = explained?.["QUERY PLAN"];
      // The listed Account's other fixture Agents add at most a few live Sessions.
      expect(rowsRead(plan?.[0]?.Plan as PlanNode, "sessions")).toBeLessThan(IDLE_SESSIONS + 10);
      expect(JSON.stringify(plan)).toContain("sessions_active_channel_unique");
      expect(JSON.stringify(plan)).toContain("sessions_active_thread_unique");
      expect(String(pendingReads[0]?.params[0]).split(",").length).toBeGreaterThan(IDLE_SESSIONS);

      // The neighbour's backlog is one Session, so it is one queued Task however deep it is.
      expect((await noisy.agents.listForAccount(neighbour.id)).agents[0]?.activity).toEqual({
        state: "idle",
        queuedTaskCount: 1,
      });
    } finally {
      await client.sql.end();
    }
  }, 60_000);
});

const NOISY_BACKLOG = 2_000;
const IDLE_SESSIONS = 500;
const INTERNAL_SESSIONS = 20_000;

interface PlanNode {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

/** Rows a plan subtree read from one table: those its scans returned plus those their filters discarded. */
function rowsRead(node: PlanNode, relation: string): number {
  const loops = node["Actual Loops"] ?? 1;
  const own =
    node["Relation Name"] === relation
      ? ((node["Actual Rows"] ?? 0) +
          (node["Rows Removed by Filter"] ?? 0) +
          (node["Rows Removed by Index Recheck"] ?? 0)) *
        loops
      : 0;
  return own + (node.Plans ?? []).reduce((total, child) => total + rowsRead(child, relation), 0);
}

type ActivityDatabase = ReturnType<typeof drizzle<typeof schema>>;
let owner: Awaited<ReturnType<typeof bootstrapInitialAdmin>> | undefined;

/** One Agent with an active binding, one live Session, and one inbound message to deliver. */
async function activityFixture(database: ActivityDatabase, name: string, ownerUserId?: string) {
  // The database has one bootstrapped Account; every fixture Agent belongs to it unless named otherwise.
  owner ??= await bootstrapInitialAdmin(database, { displayName: "Owner", email: "index@example.test" });
  const accountId = ownerUserId ?? owner.userId;
  const [computer] = await database
    .insert(computers)
    .values({
      ownerAccountId: accountId,
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
  const agent = await agents.createForAccount(accountId, {
    computerId: computer.id,
    runtimeProvider: "codex",
    name,
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
  await database.insert(sessionPlacements).values({ sessionId: session.id, computerId: computer.id, generation: 1 });
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
  return { owner, agents, agent, session, message };
}
