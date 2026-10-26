/**
 * Benchmark for the Agent usage read and the internal-Session active page.
 *
 * Derived from the database audit harness (audit commit 576ba67c): the same 100k-rows-per-table fixture,
 * the same own-container isolation, real migrations, constraints and service methods, and only the cases
 * this change owns. It never reads DATABASE_URL.
 *
 * Besides the post-change cases it measures the pre-change shapes in the same run: the old per-delivery
 * read with in-JavaScript aggregation, and the old page SQL against the legacy non-partial activity
 * indexes, which it creates for the measurement and drops afterwards.
 *
 * Run from the repository root with Docker available:
 *
 * ```bash
 * pnpm --filter @opentag/shared build
 * pnpm exec tsx packages/server/scripts/benchmark-agent-session.ts
 * ```
 *
 * Results are written to `testing/performance/agent-session/results.json`, or to the directory named by
 * `--out <dir>` / `OPENTAG_BENCHMARK_OUT` so a reviewer can keep the checkout clean. The script replaces
 * that one file and removes its container and volume in `finally`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDatabaseClient } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import * as schema from "../src/db/schema/index.js";
import { AgentService } from "../src/services/agents/agent-service.js";
import { addUsageTokenCounts, deliveryUsageTokenCounts } from "../src/services/agents/agent-usage.js";
import { markEndedDescendantsInactive } from "../src/services/sessions/session-closure.js";
import { SessionService } from "../src/services/sessions/session-service.js";

const outputArgument = process.argv.indexOf("--out");
const requestedOutput =
  outputArgument === -1
    ? (process.env.OPENTAG_BENCHMARK_OUT ??
      fileURLToPath(new URL("../../../testing/performance/agent-session/", import.meta.url)))
    : process.argv[outputArgument + 1];
if (!requestedOutput) throw new Error("--out requires a directory");
const output = resolve(requestedOutput);
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const container = `opentag-benchmark-agent-session-${process.pid}`;
const now = () => new Date("2026-10-26T08:00:00Z");
const id = (kind: number, number: number) =>
  `${String(kind).padStart(8, "0")}-0000-4000-8000-${String(number).padStart(12, "0")}`;
mkdirSync(output, { recursive: true });
docker(
  "run",
  "--detach",
  "--name",
  container,
  "--label",
  "opentag.benchmark=agent-session",
  "--publish",
  "127.0.0.1::5432",
  "--env",
  "POSTGRES_PASSWORD=benchmark-only",
  "--env",
  "POSTGRES_DB=opentag_benchmark",
  "postgres:17-alpine",
);
assert.equal(docker("inspect", "--format", '{{index .Config.Labels "opentag.benchmark"}}', container), "agent-session");
const binding = docker("port", container, "5432/tcp");
assert.match(binding, /^127\.0\.0\.1:\d+$/);
const url = `postgres://postgres:benchmark-only@${binding}/opentag_benchmark`;
const admin = postgres(url, { max: 1, onnotice: () => undefined });
const results: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { results };
const save = () => writeFileSync(`${output}/results.json`, `${JSON.stringify(report, null, 2)}\n`);
let closeClient: (() => Promise<void>) | undefined;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      await admin`select 1`;
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await migrateDatabase(url, fileURLToPath(new URL("../drizzle/", import.meta.url)));
  report.environment = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dockerImage: docker("inspect", "--format", "{{.Image}}", container),
    dockerResources: JSON.parse(docker("info", "--format", '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}')),
    postgres: (
      await admin`select version(), current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem, current_setting('max_connections') as max_connections`
    )[0],
    migrationCount: (await admin`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]?.n,
    startedAt: new Date().toISOString(),
    method:
      "One warm-up and five sequential samples per case. Local Docker microbenchmark, not production capacity. Default service query deadlines and connection pool. EXPLAIN uses one additional untimed call per distinct SELECT. Values include Node mapping and loopback transport. The `.before` cases reproduce the pre-change SQL and in-JavaScript aggregation in this process; for the page they also restore the two legacy non-partial activity indexes.",
  };
  const seedTimings = [];
  for (const statement of readFileSync(new URL("./agent-session-seed.sql", import.meta.url), "utf8").split(
    "--> statement-breakpoint",
  )) {
    const table = /insert into ([a-z_.]+)/i.exec(statement)?.[1];
    const start = performance.now();
    await admin.unsafe(statement);
    const timing = { table: table ?? "fixture functions", elapsedMs: performance.now() - start };
    seedTimings.push(timing);
    console.log(JSON.stringify({ phase: "seed", ...timing }));
  }
  report.seedTimings = seedTimings;
  await admin`analyze`;
  const tables = await admin<
    { schema: string; name: string }[]
  >`select n.nspname as schema,c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','billing') order by 1,2`;
  const rowCounts = [];
  for (const table of tables) {
    const [row] = await admin.unsafe(`select count(*)::int as n from "${table.schema}"."${table.name}"`);
    assert.ok(row && row.n >= 100000, `${table.schema}.${table.name} is below 100000`);
    rowCounts.push({ table: `${table.schema}.${table.name}`, rows: row?.n });
  }
  report.rowCounts = rowCounts;
  report.databaseBytes = (await admin`select pg_database_size(current_database())::text as bytes`)[0]?.bytes;
  const client = createDatabaseClient(url);
  closeClient = async () => {
    await client.sql.end();
  };
  report.timeouts = client.timeouts;
  let queries: { query: string; params: unknown[] }[] = [];
  const database = drizzle(client.sql, {
    schema,
    logger: {
      logQuery(query, params) {
        queries.push({ query, params });
      },
    },
  });
  const agents = new AgentService(database, { now });
  const sessions = new SessionService(database, { now });
  const errorInfo = (error: unknown): unknown =>
    error instanceof Error ? { name: error.name, message: error.message.slice(0, 2000) } : String(error);
  async function explainQueries(representative: typeof queries) {
    const unique = [...new Map(representative.map((query) => [query.query, query])).values()];
    const statements = [];
    for (const statement of unique) {
      const details: Record<string, unknown> = {
        sql: statement.query.slice(0, 30000),
        sqlLength: statement.query.length,
        parameterCount: statement.params.length,
        occurrences: representative.filter((query) => query.query === statement.query).length,
      };
      if (/^\s*(select|with)\b/i.test(statement.query) && statement.params.length < 60000) {
        try {
          const plan = await client.sql.unsafe(
            `explain (analyze,buffers,settings,format json) ${statement.query}`,
            statement.params as never[],
          );
          details.explain = plan[0]?.["QUERY PLAN"];
        } catch (caught) {
          details.explainError = errorInfo(caught);
        }
      }
      statements.push(details);
    }
    return statements;
  }
  async function measure<T>(
    name: string,
    operation: () => Promise<T>,
    extra: (value: T | undefined) => Record<string, unknown> = () => ({}),
  ): Promise<T | undefined> {
    const times: number[] = [];
    const counts: number[] = [];
    let last: T | undefined;
    let error: unknown;
    let representative: typeof queries = [];
    for (let sample = -1; sample < 5; sample++) {
      queries = [];
      const start = performance.now();
      try {
        last = await operation();
      } catch (caught) {
        error = errorInfo(caught);
      }
      const elapsed = performance.now() - start;
      representative = [...queries];
      if (sample >= 0 || error) {
        times.push(elapsed);
        counts.push(queries.length);
      }
      if (error) break;
    }
    const statements = await explainQueries(representative);
    const sorted = [...times].sort((a, b) => a - b);
    const record = {
      name,
      samplesMs: times,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      maxMs: sorted.at(-1),
      queryCounts: counts,
      responseBytes: last === undefined ? undefined : Buffer.byteLength(JSON.stringify(last)),
      ...extra(last),
      error,
      statements,
    };
    results.push(record);
    save();
    console.log(JSON.stringify({ ...record, statements: undefined }));
    return last;
  }

  await measure(
    "agents.list.1-agents",
    () => agents.listForAccount(id(1, 1)),
    (value) => ({
      bounded: { agents: value?.agents.length ?? 0 },
    }),
  );
  /*
   * A candidate index for the list's two unreported-accepted reads, measured and then dropped. With it the
   * hot list fits the 100 ms target, but PostgreSQL also starts using it inside the IM delivery work query,
   * whose plan test requires the dedicated active-work index alone. That query belongs to another owner, so
   * this run keeps the measurement as evidence instead of shipping the index. See the report.
   */
  const indexStartedAt = performance.now();
  await admin`
    create index "im_message_deliveries_unreported_accepted_candidate_idx"
    on "im_message_deliveries" ("accepted_at", "id", "session_id")
    where "state" = 'accepted' and "reported_at" is null
  `;
  await admin`analyze im_message_deliveries`;
  report.candidateIndex = {
    name: "im_message_deliveries_unreported_accepted_candidate_idx",
    decision: "measured, not adopted: PostgreSQL also chooses it in the IM delivery work query",
    buildMs: performance.now() - indexStartedAt,
    bytes: Number(
      (
        await admin`select pg_relation_size('im_message_deliveries_unreported_accepted_candidate_idx')::text as bytes`
      )[0]?.bytes,
    ),
  };
  await measure(
    "agents.list.1-agents.with-candidate-index",
    () => agents.listForAccount(id(1, 1)),
    (value) => ({
      bounded: { agents: value?.agents.length ?? 0 },
    }),
  );
  await admin`drop index "im_message_deliveries_unreported_accepted_candidate_idx"`;
  await admin`analyze im_message_deliveries`;
  await measure(
    "agents.usage.50000-deliveries",
    () => agents.getUsageById(id(1, 1), id(4, 1), 30),
    (value) => ({
      bounded: { dailyBuckets: value?.daily.length ?? 0 },
    }),
  );
  await measure(
    "sessions.internal.100000-active.limit20",
    () => sessions.listInternalSessions(id(7, 1), { limit: 20, recursive: true }),
    (value) => ({ bounded: { items: value?.items.length ?? 0 } }),
  );

  // The pre-change usage read, rebuilt exactly: every Delivery row in the window through Drizzle to Node.js,
  // aggregated in a loop with the same per-row parser.
  const legacyUsageStartedAt = new Date(now().getTime() - 30 * 24 * 60 * 60 * 1_000);
  const legacyUsageRead = async () => {
    const rows = await database
      .select({
        acceptedAt: schema.imMessageDeliveries.acceptedAt,
        executionOrigin: schema.imMessageDeliveries.executionOrigin,
        cachedInputTokens: sql<string | null>`${schema.imMessageDeliveries.turnReport} #>> '{usage,cachedInputTokens}'`,
        inputTokens: sql<string | null>`${schema.imMessageDeliveries.turnReport} #>> '{usage,inputTokens}'`,
        outcome: sql<string | null>`${schema.imMessageDeliveries.turnReport} ->> 'outcome'`,
        outputTokens: sql<string | null>`${schema.imMessageDeliveries.turnReport} #>> '{usage,outputTokens}'`,
      })
      .from(schema.imMessageDeliveries)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.imMessageDeliveries.sessionId))
      .innerJoin(schema.imBindings, eq(schema.imBindings.id, schema.sessions.imBindingId))
      .where(
        and(
          eq(schema.imBindings.agentId, id(4, 1)),
          gte(schema.imMessageDeliveries.acceptedAt, legacyUsageStartedAt),
          lte(schema.imMessageDeliveries.acceptedAt, now()),
        ),
      )
      .orderBy(asc(schema.imMessageDeliveries.acceptedAt), asc(schema.imMessageDeliveries.id));
    const totals = {
      tasks: 0,
      measuredTasks: 0,
      failed: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      tokens: 0,
    };
    for (const row of rows) {
      if (!row.acceptedAt) continue;
      totals.tasks += 1;
      if (row.outcome === "failed") totals.failed += 1;
      const counts =
        row.executionOrigin === "cloud"
          ? { measured: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, tokens: 0 }
          : deliveryUsageTokenCounts("codex", row.inputTokens, row.cachedInputTokens, row.outputTokens);
      if (counts.measured) totals.measuredTasks += 1;
      addUsageTokenCounts(totals, counts);
    }
    return { rows: rows.length, ...totals };
  };
  await measure("agents.usage.50000-deliveries.before", legacyUsageRead, (value) => ({
    bounded: { rowsRead: value?.rows ?? 0 },
  }));

  // End 90,000 descendants of the hot internal tree through the production closure write, so the
  // measurement sees exactly the state the lifecycle produces.
  const endStartedAt = performance.now();
  await admin`
    update sessions set ended_at = ${now().toISOString()}::timestamptz
    where id in (select benchmark.id(8, n) from generate_series(1, 90000) n)
  `;
  const sessionEndMs = performance.now() - endStartedAt;
  const closureStartedAt = performance.now();
  await markEndedDescendantsInactive(database, { imBindingId: id(6, 1) });
  const closureMs = performance.now() - closureStartedAt;
  report.lifecycleWrite = { sessionEndMs, closureMaintenanceMs: closureMs, endedDescendants: 90000 };
  const [flags] = await admin<
    { active: number; inactive: number }[]
  >`select count(*) filter (where descendant_active)::int as active, count(*) filter (where not descendant_active)::int as inactive from session_descendants`;
  const [divergence] = await admin<{ divergent: number }[]>`
    select count(*)::int as divergent
    from session_descendants link
    inner join sessions child on child.id = link.descendant_session_id
    where link.descendant_active is distinct from (child.ended_at is null)
  `;
  report.closure = { flags, divergence };
  assert.equal(divergence?.divergent, 0);
  await admin`analyze sessions`;
  await admin`analyze session_descendants`;

  await measure(
    "sessions.internal.90000-ended.limit20",
    () => sessions.listInternalSessions(id(7, 1), { limit: 20, recursive: true }),
    (value) => ({ bounded: { items: value?.items.length ?? 0 } }),
  );

  // Storage and index cost of the new closure shape, then the pre-change shape measured against the
  // legacy indexes this benchmark creates for the comparison and drops afterwards.
  const sizes = async () =>
    (
      await admin<{ name: string; bytes: string }[]>`
        select c.relname as name, pg_relation_size(c.oid)::text as bytes
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like 'session_descendants%'
        order by 2 desc
      `
    ).map((row) => ({ name: row.name, bytes: Number(row.bytes) }));
  const closureStorage: Record<string, unknown> = { active_shape: await sizes() };
  report.closureStorage = closureStorage;
  await admin`create index "session_descendants_ancestor_activity_idx" on "session_descendants" ("ancestor_session_id","last_message_created_at","last_message_id","descendant_session_id")`;
  await admin`create index "session_descendants_ancestor_depth_activity_idx" on "session_descendants" ("ancestor_session_id","depth","last_message_created_at","last_message_id","descendant_session_id")`;
  await admin`analyze session_descendants`;
  closureStorage.legacy_indexes_added = await sizes();

  const db = client.sql;
  const legacyPage = async () => {
    const rows = await db<
      {
        sessionId: string;
        parentSessionId: string | null;
        createdAt: Date;
        lastMessageAt: Date;
        lastMessageId: string;
        lastDeliveryOutcome: string;
        taskPreview: string;
      }[]
    >`
      select link.descendant_session_id as "sessionId",
             child.created_by_session_id as "parentSessionId",
             child.created_at as "createdAt",
             link.last_message_created_at as "lastMessageAt",
             link.last_message_id as "lastMessageId",
             link.last_delivery_outcome as "lastDeliveryOutcome",
             link.task_preview as "taskPreview"
      from session_descendants link
      inner join sessions child on child.id = link.descendant_session_id
      where link.ancestor_session_id = ${id(7, 1)}::uuid
        and child.ended_at is null
      order by link.last_message_created_at desc, link.last_message_id desc, link.descendant_session_id desc
      limit 21
    `;
    return { items: rows.slice(0, 20), nextCursor: rows.length > 20 ? "cursor" : undefined };
  };
  await measure("sessions.internal.90000-ended.limit20.before", legacyPage, (value) => ({
    bounded: { items: value?.items.length ?? 0 },
  }));
  await admin`drop index "session_descendants_ancestor_activity_idx"`;
  await admin`drop index "session_descendants_ancestor_depth_activity_idx"`;
  await admin`analyze session_descendants`;
  closureStorage.final = await sizes();
  report.finishedAt = new Date().toISOString();
} finally {
  try {
    await closeClient?.();
  } finally {
    try {
      await admin.end();
    } finally {
      docker("rm", "--force", "--volumes", container);
      report.containerRemoved = true;
      save();
    }
  }
}
