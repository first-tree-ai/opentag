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
      expect(definition?.indexdef).toContain("(session_id, accepted_at, id)");
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

  it("reads the queued count from the listed Agents' live Sessions, in one statement", async () => {
    const client = createDatabaseClient(testDatabase.databaseUrl);
    const queries: { query: string; params: unknown[] }[] = [];
    try {
      const database = drizzle(client.sql, {
        schema,
        logger: { logQuery: (query, params) => queries.push({ query, params }) },
      });
      // Another Account's Agent with a deep queue and many unreported Turns: neither may change this Account's count.
      const [neighbour] = await database
        .insert(users)
        .values({ email: `neighbour-${randomUUID()}@example.test`, displayName: "Neighbour", setupCompletedAt: NOW })
        .returning({ id: users.id });
      if (!neighbour) throw new Error("Neighbour fixture missing");
      const noisy = await activityFixture(database, "noisy", neighbour.id);
      // Spread over many Sessions, as real work is, so the per-Session statistics the planner reads are realistic.
      await client.sql.unsafe(
        `
        with neighbour_sessions as (
          insert into sessions(im_binding_id,channel_id,conversation_kind,kind,thread_key)
          select s.im_binding_id,s.channel_id,'channel','thread','noise-'||n
          from sessions s, generate_series(1, ${NOISY_BACKLOG * 2}) n where s.id = $1
          returning id, im_binding_id, channel_id, thread_key
        ),
        noise as (
          insert into im_messages(im_binding_id,provider_event_id,channel_id,external_message_id,provider_revision_key,
            operation,direction,thread_key,author_kind,author_external_id,content,provider_context,occurred_at)
          select im_binding_id,'noise-event-'||thread_key,channel_id,thread_key,'1','created','inbound',thread_key,'human','human',
            '{"version":1,"fallbackText":"noise","blocks":[],"truncated":false}'::jsonb,'{"provider":"feishu"}'::jsonb,$2
          from neighbour_sessions
          returning id, thread_key
        ),
        numbered as (
          select noise.id as message_id, neighbour_sessions.id as session_id,
            row_number() over (order by noise.thread_key) as n
          from noise inner join neighbour_sessions on neighbour_sessions.thread_key = noise.thread_key
        )
        insert into im_message_deliveries(message_id,session_id,attention,state,placement_generation,input_hash,turn_id,
          report_owner_instance_id,accepted_at,expires_at)
        select message_id,session_id,'direct',
          (case when n % 2 = 0 then 'accepted' else 'pending' end)::im_delivery_state,1,
          case when n % 2 = 0 then 'input' end,
          case when n % 2 = 0 then 'turn-'||session_id end,
          case when n % 2 = 0 then $3::uuid end,
          case when n % 2 = 0 then $2::timestamptz end,
          $4
        from numbered
        `,
        [noisy.session.id, NOW.toISOString(), REPORT_OWNER, new Date(NOW.getTime() + 86_400_000).toISOString()],
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
      // Many long-lived idle conversations, historical reported Turns on a hot live Session, and the Internal
      // Sessions a busy binding piles up.
      await client.sql.unsafe(
        `
        insert into sessions(im_binding_id,channel_id,conversation_kind,kind,thread_key)
        select s.im_binding_id,'idle-channel','channel','thread','idle-'||n
        from sessions s, generate_series(1, ${IDLE_SESSIONS}) n where s.id = $1
        `,
        [session.id],
      );
      await client.sql.unsafe(
        `
        with hot_session as (
          select id, im_binding_id from sessions
          where im_binding_id = (select im_binding_id from sessions where id = $1)
            and kind = 'thread' and thread_key = 'idle-1'
        ),
        historical_messages as (
          insert into im_messages(im_binding_id,provider_event_id,channel_id,external_message_id,provider_revision_key,
            operation,direction,thread_key,author_kind,author_external_id,content,provider_context,occurred_at)
          select hot_session.im_binding_id,'hist-event-'||n,'idle-channel','hist-msg-'||n,'1','created','inbound','idle-1','human','human',
            '{"version":1,"fallbackText":"done","blocks":[],"truncated":false}'::jsonb,'{"provider":"feishu"}'::jsonb,$2
          from hot_session, generate_series(1, ${REPORTED_TURNS_IN_HOT_SESSION}) n
          returning id
        )
        insert into im_message_deliveries(message_id,session_id,attention,state,placement_generation,input_hash,turn_id,
          report_owner_instance_id,accepted_at,reported_at,turn_report,result_hash,expires_at)
        select historical_messages.id,hot_session.id,'direct','accepted',1,'hist-input-'||historical_messages.id,
          'hist-turn-'||historical_messages.id,$3::uuid,$2::timestamptz,$2::timestamptz,'{"status":"completed"}'::jsonb,
          'hist-result-'||historical_messages.id,$4
        from historical_messages cross join hot_session
        `,
        [session.id, NOW.toISOString(), REPORT_OWNER, new Date(NOW.getTime() + 86_400_000).toISOString()],
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

      // Warm connection/statement state once, then measure and inspect the list's activity reads at 5,000 live Sessions.
      await agents.listForAccount(owner.userId);
      queries.length = 0;
      const startedAtMs = performance.now();
      const listed = await agents.listForAccount(owner.userId);
      const elapsedMs = performance.now() - startedAtMs;
      expect(elapsedMs).toBeLessThan(500);
      expect(listed.agents.find((entry) => entry.id === agent.id)?.activity).toEqual({
        state: "idle",
        queuedTaskCount: 1,
      });

      const unreportedReads = queries.filter((entry) => entry.query.includes('"reported_at" is null'));
      expect(unreportedReads).toHaveLength(2);
      for (const unreportedRead of unreportedReads) {
        const [explainedUnreported] = await client.sql.unsafe(
          `explain (analyze, format json) ${unreportedRead.query}`,
          unreportedRead.params as never[],
        );
        const unreportedPlan = explainedUnreported?.["QUERY PLAN"];
        expect(rowsRead(unreportedPlan?.[0]?.Plan as PlanNode, "sessions")).toBeLessThan(IDLE_SESSIONS + 10);
        expect(JSON.stringify(unreportedPlan)).toContain("sessions_active_channel_unique");
        expect(JSON.stringify(unreportedPlan)).toContain("sessions_active_thread_unique");
        expect(JSON.stringify(unreportedPlan)).toContain("im_message_deliveries_unreported_accepted_idx");
        // Neither other Accounts' unreported Turns nor the hot Session's reported Turns are scanned.
        expect(rowsRead(unreportedPlan?.[0]?.Plan as PlanNode, "im_message_deliveries")).toBeLessThan(10);
      }

      const queuedReads = queries.filter((entry) => entry.query.includes("waiting as materialized"));
      expect(queuedReads).toHaveLength(1);

      // Under the default planner the read reaches the live Sessions through their partial indexes and reads
      // no Internal Session.
      const [queuedRead] = queuedReads;
      if (!queuedRead) throw new Error("Queued read missing");
      const [explained] = await client.sql.unsafe(
        `explain (analyze, format json) ${queuedRead.query}`,
        queuedRead.params as never[],
      );
      const plan = explained?.["QUERY PLAN"];
      // The listed Account's other fixture Agents add at most a few live Sessions.
      expect(rowsRead(plan?.[0]?.Plan as PlanNode, "sessions")).toBeLessThan(IDLE_SESSIONS + 10);
      expect(JSON.stringify(plan)).toContain("sessions_active_channel_unique");
      expect(JSON.stringify(plan)).toContain("sessions_active_thread_unique");
      // Every delivery probe starts from one of this Account's Sessions, so the other Account's pending deliveries and
      // unreported Turns are never read, under the default planner on this small a table too.
      expect(JSON.stringify(plan)).not.toContain("im_message_deliveries_unreported_accepted_idx");
      expect(rowsRead(plan?.[0]?.Plan as PlanNode, "im_message_deliveries")).toBeLessThan(100);

      // The neighbour's own count is correct too: one Task for each of its 2,000 waiting Sessions and 2,000 running Sessions.
      expect((await noisy.agents.listForAccount(neighbour.id)).agents[0]?.activity).toMatchObject({
        state: "working",
        runningTaskCount: NOISY_BACKLOG,
        queuedTaskCount: NOISY_BACKLOG,
      });
    } finally {
      await client.sql.end();
    }
  }, 60_000);
});

const NOISY_BACKLOG = 2_000;
const IDLE_SESSIONS = 5_000;
const REPORTED_TURNS_IN_HOT_SESSION = 2_000;
const INTERNAL_SESSIONS = 80_000;

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
