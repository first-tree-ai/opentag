/**
 * The bounded correction walk must not repeat or skip a row at a batch boundary.
 *
 * `readAgentUsageDaily` sums canonical values in SQL and recomputes every other report row by row, in bounded
 * keyset batches. The cursor is the exact UTC text PostgreSQL printed, because a `timestamptz` carries
 * microseconds and a JavaScript `Date` truncates to milliseconds: a truncated cursor would re-read every row in
 * the current millisecond — double-counting it — or skip rows that share it.
 *
 * This suite builds the case that exposes that: 1,205 valid non-canonical reports where the first 1,200 all sit
 * inside one millisecond (900 at distinct microseconds, then 300 sharing one timestamp, so ID order decides) and
 * the 1,000-row batch boundary falls in the middle of the tied group. Exact totals are the assertion.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imBindings, sessionPlacements, sessions } from "../../db/schema/index.js";
import { AgentService } from "../../services/agents/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const ENDED_AT = new Date("2026-08-21T00:00:00.000Z");
const DISTINCT_MICROSECOND_ROWS = 900;
const TIED_TIMESTAMP_ROWS = 300;
const LATER_ROWS = 5;
const TOTAL_REPORTS = DISTINCT_MICROSECOND_ROWS + TIED_TIMESTAMP_ROWS + LATER_ROWS;
const TOKENS_PER_REPORT = 1_000;

let testDatabase: MigratedTestDatabase;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("usage correction batch boundaries", () => {
  it("sums every non-canonical report exactly once across batches that split a tied timestamp", async () => {
    const client = createDatabaseClient(testDatabase.databaseUrl);
    try {
      const owner = await bootstrapInitialAdmin(client.database, {
        displayName: "Owner",
        email: "boundary@example.test",
      });
      const [computer] = await client.database
        .insert(computers)
        .values({
          ownerAccountId: owner.userId,
          currentInstallationId: randomUUID(),
          currentInstanceId: randomUUID(),
          displayName: "box",
          platform: "linux",
          arch: "x64",
          clientVersion: "1",
          createdAt: ENDED_AT,
          updatedAt: ENDED_AT,
        })
        .returning({ id: computers.id });
      if (!computer) throw new Error("Computer fixture missing");
      const agents = new AgentService(client.database, { now: () => ENDED_AT });
      const agent = await agents.createForAccount(owner.userId, {
        computerId: computer.id,
        runtimeProvider: "pi",
        name: "boundary",
        displayName: "Boundary",
      });
      const [binding] = await client.database
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
          activatedAt: ENDED_AT,
          createdAt: ENDED_AT,
          updatedAt: ENDED_AT,
        })
        .returning({ id: imBindings.id });
      if (!binding) throw new Error("IM binding fixture missing");
      const [session] = await client.database
        .insert(sessions)
        .values({
          imBindingId: binding.id,
          channelId: "C1",
          conversationKind: "dm",
          kind: "channel",
          createdAt: ENDED_AT,
        })
        .returning({ id: sessions.id });
      if (!session) throw new Error("Session fixture missing");
      await client.database
        .insert(sessionPlacements)
        .values({ sessionId: session.id, computerId: computer.id, generation: 1 });

      /*
       * Rows 1..900:   base + i microseconds, so each is a distinct instants inside one millisecond.
       * Rows 901..1200: all exactly base + 900 microseconds, so only their IDs separate them.
       * Rows 1201..:   later instant, after the tied group.
       * Ordered by (accepted_at, id), the first 1,000-row batch ends 100 rows into the tied group.
       */
      await client.sql.unsafe(`
        with generated as (
          select i,
                 gen_random_uuid() as message_id,
                 gen_random_uuid() as delivery_id,
                 case
                   when i <= ${DISTINCT_MICROSECOND_ROWS}
                     then timestamptz '2026-08-20T00:00:00+00' + (i || ' microseconds')::interval
                   when i <= ${DISTINCT_MICROSECOND_ROWS + TIED_TIMESTAMP_ROWS}
                     then timestamptz '2026-08-20T00:00:00.000900+00'
                   else timestamptz '2026-08-20T00:00:00.000900+00' + (i || ' microseconds')::interval
                 end as accepted_at
          from generate_series(1, ${TOTAL_REPORTS}) i
        ),
        messages as (
          insert into im_messages (
            id, im_binding_id, channel_id, external_message_id, provider_revision_key, operation, direction,
            author_kind, author_external_id, content, occurred_at, provider_context
          )
          select message_id, '${binding.id}', 'C1', 'boundary-' || i, '1', 'created', 'inbound', 'human', 'human',
            '{"version":1,"fallbackText":"boundary","blocks":[],"truncated":false}'::jsonb, accepted_at, '{}'::jsonb
          from generated
          returning id
        )
        insert into im_message_deliveries (
          id, message_id, session_id, attention, state, placement_generation, execution_origin, input_hash,
          turn_id, report_owner_instance_id, turn_report, reported_at, accepted_at, expires_at, result_hash
        )
        select delivery_id, message_id, '${session.id}', 'direct', 'accepted', 1, 'local',
          'input-' || delivery_id, 'turn-' || delivery_id, '11111111-1111-4111-8111-111111111111',
          '{"outcome":"completed","usage":{"inputTokens":"1000.00","outputTokens":"0.00"}}'::jsonb,
          accepted_at, accepted_at, accepted_at + interval '1 day', repeat('a', 64)
        from generated
      `);

      const usage = await agents.getUsageById(owner.userId, agent.id, 30);
      // A cursor truncated to milliseconds would re-read rows from the split millisecond and inflate every total.
      expect(usage).toMatchObject({
        tasks: TOTAL_REPORTS,
        measuredTasks: TOTAL_REPORTS,
        failed: 0,
        inputTokens: TOTAL_REPORTS * TOKENS_PER_REPORT,
        cachedInputTokens: 0,
        outputTokens: 0,
        tokens: TOTAL_REPORTS * TOKENS_PER_REPORT,
      });
      const day = usage.daily.find((point) => point.date === "2026-08-20");
      expect(day).toMatchObject({
        tasks: TOTAL_REPORTS,
        measuredTasks: TOTAL_REPORTS,
        inputTokens: TOTAL_REPORTS * TOKENS_PER_REPORT,
      });
      // Every other day in the window stays a zero bucket.
      expect(usage.daily.filter((point) => point.tasks > 0)).toHaveLength(1);
    } finally {
      await client.sql.end();
    }
  }, 120_000);
});
