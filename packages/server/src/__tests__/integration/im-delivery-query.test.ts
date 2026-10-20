import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { ImDeliverySelector, lockEligibleDelivery } from "../../runtime/im-delivery-selector.js";
import {
  cloudPendingHeadQuery,
  deliveryCandidatePage,
  deliveryCustodyQuery,
} from "../../runtime/im-delivery-work-query.js";
import { deliveryTestId, seedDeliveryQuery } from "../support/im-delivery-query-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
const dialect = new PgDialect();
const migrationUrl = new URL("../../../drizzle/0063_im_delivery_active_work.sql", import.meta.url);
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase("postgres:16-alpine");
  client = createDatabaseClient(testDatabase.databaseUrl);
  // Plan assertions must depend on fixture statistics, never background auto-analyze timing.
  await client.sql.unsafe("alter table im_messages set (autovacuum_enabled = false)");
  await client.sql.unsafe("alter table im_message_deliveries set (autovacuum_enabled = false)");
}, 120_000);
beforeEach(async () => {
  await testDatabase.reset();
  // Deliberately leave stale empty-table statistics before loading the next large fixture.
  await client.sql.unsafe("analyze im_messages");
});
afterAll(async () => {
  await client?.sql.end();
  await testDatabase?.stop();
});

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  Plans?: PlanNode[];
}
interface Plan {
  Plan: PlanNode;
  "Execution Time": number;
}
function flatten(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(flatten)];
}
function literal(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`unexpected fixture parameter ${typeof value}`);
}
async function explain(query: { sql: string; params: unknown[] }, generic: boolean): Promise<Plan> {
  const connection = await client.sql.reserve();
  try {
    await connection.unsafe(`set plan_cache_mode = ${generic ? "force_generic_plan" : "force_custom_plan"}`);
    await connection.unsafe(`prepare delivery_plan as ${query.sql}`);
    const args = query.params.length ? `(${query.params.map(literal).join(",")})` : "";
    const [row] = await connection.unsafe<{ "QUERY PLAN": Plan[] }[]>(
      `explain (analyze, buffers, format json) execute delivery_plan${args}`,
    );
    const plan = row?.["QUERY PLAN"][0];
    if (!plan) throw new Error("missing query plan");
    return plan;
  } finally {
    await connection.unsafe("deallocate all");
    await connection.unsafe("reset plan_cache_mode");
    connection.release();
  }
}
function expectActiveIndex(plan: Plan) {
  const nodes = flatten(plan.Plan);
  // Reject BitmapOr plans that combine the work index with indexes containing historical rows.
  expect(nodes.map((node) => node["Index Name"]).filter(Boolean)).toEqual(["im_delivery_work_idx"]);
  expect(
    nodes.filter((node) => node["Relation Name"] === "im_message_deliveries").map((node) => node["Node Type"]),
  ).not.toContain("Seq Scan");
}
async function selectAndLock(selector: ImDeliverySelector, expectedId: string) {
  for (let round = 0; round < 8; round++) {
    const candidate = (await selector.candidates(new Date()).next()).value;
    if (!candidate) continue;
    expect(candidate.row.id).toBe(expectedId);
    const claimed = await client.database.transaction((tx) =>
      lockEligibleDelivery(tx, candidate.row.id, candidate.context.agentId, new Date()),
    );
    expect(claimed?.row.id).toBe(expectedId);
    return;
  }
  throw new Error("independent Agent starved behind blocked inputs");
}

describe("delivery query plans on PostgreSQL 16", { timeout: 60_000 }, () => {
  it.each([424, 4240])("bounds historical work with 80k reported rows and %i blocked inputs", async (blocked) => {
    const fixture = await seedDeliveryQuery(client.database, 80_000, blocked);
    const candidate = deliveryCandidatePage(client.database, new Date()).toSQL();
    const custody = dialect.sqlToQuery(deliveryCustodyQuery());
    const metrics = [];
    for (const generic of [false, true]) {
      const candidatePlan = await explain(candidate, generic);
      const custodyPlan = await explain(custody, generic);
      expectActiveIndex(candidatePlan);
      expectActiveIndex(custodyPlan);
      const workScan = flatten(custodyPlan.Plan).find((node) => node["Relation Name"] === "im_message_deliveries");
      expect(workScan?.["Actual Rows"]).toBe(blocked + 2);
      metrics.push({ generic, candidateMs: candidatePlan["Execution Time"], custodyMs: custodyPlan["Execution Time"] });
    }
    const selector = new ImDeliverySelector(client.database);
    const timings = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      await selectAndLock(selector, fixture.deliveryId);
      timings.push(performance.now() - start);
    }
    console.info(JSON.stringify({ history: 80_000, blocked, plans: metrics, selectAndLockMs: timings }));
  });

  it("does not revisit cancelled history when checking custody or a long Cloud queue", async () => {
    await seedDeliveryQuery(client.database, 80_000, 4240);
    const [messageStats] = await client.sql<{ reltuples: number }[]>`
      select reltuples from pg_class where oid = 'im_messages'::regclass
    `;
    expect(
      messageStats?.reltuples,
      "the fixture must refresh message statistics after loading history",
    ).toBeGreaterThan(80_000);
    // Keep dead index entries in place: no VACUUM between cancellation and the plan checks.
    await client.database.execute(sql`update im_message_deliveries set state='expired', reason='cancelled',
      input_hash=null, turn_id=null, report_owner_instance_id=null, accepted_at=null, reported_at=null,
      turn_report=null, result_hash=null where reported_at is not null`);
    await client.database.execute(sql`update im_message_deliveries set session_id=${deliveryTestId("session", 1)}
      where id=${deliveryTestId("delivery", 84_242)}`);
    await client.database.execute(sql`analyze im_message_deliveries`);
    for (const generic of [false, true]) {
      const custody = await explain(dialect.sqlToQuery(deliveryCustodyQuery()), generic);
      const head = await explain(dialect.sqlToQuery(cloudPendingHeadQuery(deliveryTestId("session", 1))), generic);
      expectActiveIndex(custody);
      const headNodes = flatten(head.Plan);
      expect(
        headNodes.map((node) => node["Index Name"]),
        JSON.stringify(head.Plan),
      ).toContain("im_messages_pkey");
      expect(headNodes.find((node) => node["Relation Name"] === "im_messages")?.["Actual Loops"]).toBe(4241);
      expect(
        headNodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "im_messages"),
      ).toBe(false);
      console.info(
        JSON.stringify({
          cancelled: 80_000,
          pending: 4241,
          generic,
          custodyMs: custody["Execution Time"],
          cloudHeadMs: head["Execution Time"],
        }),
      );
    }
  });

  it("accepts an index prebuilt concurrently and refuses an invalid leftover", async () => {
    await seedDeliveryQuery(client.database, 0, 1);
    const migration = await readFile(migrationUrl, "utf8");
    const statements = migration.split("--> statement-breakpoint");
    const create = statements[0];
    if (!create) throw new Error("missing index DDL");
    await client.sql.unsafe("drop index im_delivery_work_idx");
    await client.sql.unsafe(create.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX CONCURRENTLY"));
    for (const statement of statements) await client.sql.unsafe(statement);
    await client.sql.unsafe("drop index im_delivery_work_idx");
    await expect(
      client.sql.unsafe("create unique index concurrently im_delivery_work_idx on im_message_deliveries ((1))"),
    ).rejects.toThrow();
    try {
      await expect(
        client.sql.begin(async (tx) => {
          for (const statement of statements) await tx.unsafe(statement);
        }),
      ).rejects.toThrow("im_delivery_work_idx is not ready and valid");
    } finally {
      await client.sql.unsafe("drop index im_delivery_work_idx");
      for (const statement of statements) await client.sql.unsafe(statement);
    }
  });
});
