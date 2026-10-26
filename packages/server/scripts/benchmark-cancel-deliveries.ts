/**
 * Scoped cancellation benchmark for `CloudDeliveryOwner.cancelSessionDeliveries`.
 *
 * It owns a disposable loopback PostgreSQL container, applies the checked-in migrations, seeds at
 * least 100000 rows into every public and billing table with all constraints and indexes enabled,
 * and then measures the same call on the SAME data with two owners: the pre-change implementation
 * taken from Git (one Sandbox SELECT per delivery) and the working-tree implementation (one Sandbox
 * SELECT per backlog). Pairing both runs removes data and cache differences from the comparison.
 *
 * Prerequisites, from the repository root:
 *   mkdir -p packages/server/scripts/.dispatch
 *   cp .dispatch/database-performance-seed.sql packages/server/scripts/.dispatch/
 *   pnpm exec tsx packages/server/scripts/benchmark-cancel-deliveries.ts
 *
 * It never reads DATABASE_URL and never targets an existing database. Results replace
 * testing/performance/cancel-deliveries/results.json; run `pnpm format` afterwards so the committed
 * artifact keeps the repository's JSON formatting.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDatabaseClient } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import * as schema from "../src/db/schema/index.js";
import { CloudDeliveryOwner as CloudDeliveryOwnerAfter } from "../src/services/sandboxes/cloud-delivery-owner.js";

/** The commit the audit measured: its cancellation loop re-read the Sandbox for every delivery. */
const BEFORE_REF = process.env.OPENTAG_BENCHMARK_BEFORE_REF ?? "d2fc9e8aa045dc1a214ab3f0a953cbdcde088c92";
const OWNER_SOURCE = "packages/server/src/services/sandboxes/cloud-delivery-owner.ts";
const SESSION = "00000007-0000-4000-8000-000000000001";
const SAMPLES = 5;
const startedAt = new Date().toISOString();
const output = fileURLToPath(new URL("../../../testing/performance/cancel-deliveries/results.json", import.meta.url));
const seedFile = fileURLToPath(new URL("./.dispatch/database-performance-seed.sql", import.meta.url));
const ownerDirectory = fileURLToPath(new URL("../src/services/sandboxes/", import.meta.url));
const beforeModule = `${ownerDirectory}.benchmark-before-${process.pid}.ts`;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const container = `opentag-cancel-benchmark-w49-${process.pid}`;

if (!existsSync(seedFile)) {
  throw new Error(`missing audit seed fixture at ${seedFile}; copy .dispatch/database-performance-seed.sql there`);
}
// The pre-change module is generated in its own directory so its relative imports resolve unchanged.
writeFileSync(beforeModule, execFileSync("git", ["show", `${BEFORE_REF}:${OWNER_SOURCE}`], { encoding: "utf8" }));
const { CloudDeliveryOwner: CloudDeliveryOwnerBefore } = (await import(pathToFileURL(beforeModule).href)) as {
  CloudDeliveryOwner: typeof CloudDeliveryOwnerAfter;
};

docker(
  "run",
  "--detach",
  "--name",
  container,
  "--label",
  "opentag.benchmark=cancel-deliveries",
  "--publish",
  "127.0.0.1::5432",
  "--env",
  "POSTGRES_PASSWORD=benchmark-local-only",
  "--env",
  "POSTGRES_DB=opentag_benchmark",
  "postgres:17-alpine",
);
assert.equal(
  docker("inspect", "--format", '{{index .Config.Labels "opentag.benchmark"}}', container),
  "cancel-deliveries",
);
const binding = docker("port", container, "5432/tcp");
assert.match(binding, /^127\.0\.0\.1:\d+$/);
const url = `postgres://postgres:benchmark-local-only@${binding}/opentag_benchmark`;
const admin = postgres(url, { max: 1, onnotice: () => undefined });
const report: Record<string, unknown> = { cases: [] };
const save = () => {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
};
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
  const seedTimings: { table: string; elapsedMs: number }[] = [];
  for (const statement of readFileSync(seedFile, "utf8").split("--> statement-breakpoint")) {
    const table = /insert into ([a-z_.]+)/i.exec(statement)?.[1];
    const start = performance.now();
    await admin.unsafe(statement);
    seedTimings.push({ table: table ?? "fixture functions", elapsedMs: performance.now() - start });
  }
  await admin`analyze`;
  const tables = await admin<
    { schema: string; name: string }[]
  >`select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname in ('public', 'billing') order by 1, 2`;
  const rowCounts: { table: string; rows: number }[] = [];
  for (const table of tables) {
    const [row] = await admin.unsafe(`select count(*)::int as n from "${table.schema}"."${table.name}"`);
    assert.ok(row && row.n >= 100000, `${table.schema}.${table.name} is below 100000`);
    rowCounts.push({ table: `${table.schema}.${table.name}`, rows: row?.n });
  }
  report.environment = {
    workingTreeCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    beforeRef: BEFORE_REF,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dockerImage: docker("inspect", "--format", "{{.Image}}", container),
    dockerResources: JSON.parse(docker("info", "--format", '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}')),
    postgres: (
      await admin`select version() as version, current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem, current_setting('max_connections') as max_connections`
    )[0],
    migrationCount: (await admin`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]?.n,
    tableCount: tables.length,
    databaseBytes: (await admin`select pg_database_size(current_database())::text as bytes`)[0]?.bytes,
    runStartedAt: startedAt,
    method:
      "One warm-up and five sequential samples per case and owner, both owners measured on the same seeded database so the pair shares data and cache state. Statement counts come from the Drizzle query logger. Plans come from one additional untimed EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) per distinct statement of the last sample. The fixture has no live Runner connection, so every outcome is no_connection, exactly as in the audit. Local Docker microbenchmark with default service query deadlines; not production capacity.",
  };
  report.seedTimings = seedTimings;
  report.rowCounts = rowCounts;
  save();

  const client = createDatabaseClient(url);
  closeClient = async () => {
    await client.sql.end();
  };
  report.timeouts = client.timeouts;
  let statements: { query: string; params: unknown[] }[] = [];
  const database = drizzle(client.sql, {
    schema,
    logger: {
      logQuery(query, params) {
        statements.push({ query, params });
      },
    },
  });
  const ownerOptions = () => ({
    custody: {} as never,
    database,
    fence: { connectionForSandbox: () => undefined } as never,
    hub: {} as never,
  });
  const owners = {
    before: new CloudDeliveryOwnerBefore(ownerOptions()),
    after: new CloudDeliveryOwnerAfter(ownerOptions()),
  };

  async function explain(representative: { query: string; params: unknown[] }[]) {
    const unique = [...new Map(representative.map((entry) => [entry.query, entry])).values()];
    const plans: Record<string, unknown>[] = [];
    for (const statement of unique) {
      const details: Record<string, unknown> = {
        sql: statement.query,
        parameterCount: statement.params.length,
        occurrences: representative.filter((entry) => entry.query === statement.query).length,
      };
      if (/^\s*(select|with)\b/i.test(statement.query)) {
        const plan = await client.sql.unsafe(
          `explain (analyze, buffers, settings, format json) ${statement.query}`,
          statement.params as never[],
        );
        details.plan = plan[0]?.["QUERY PLAN"];
      }
      plans.push(details);
    }
    return plans;
  }

  async function measure(owner: CloudDeliveryOwnerAfter, expected: number) {
    const elapsedMs: number[] = [];
    const statementCounts: number[] = [];
    let outcomes: { status: string }[] = [];
    let representative: typeof statements = [];
    for (let sample = -1; sample < SAMPLES; sample++) {
      statements = [];
      const start = performance.now();
      outcomes = await owner.cancelSessionDeliveries(SESSION);
      const elapsed = performance.now() - start;
      representative = [...statements];
      if (sample < 0) continue;
      elapsedMs.push(elapsed);
      statementCounts.push(statements.length);
    }
    assert.equal(outcomes.length, expected, `unexpected outcome count for ${expected} deliveries`);
    assert.ok(
      outcomes.every((outcome) => outcome.status === "no_connection"),
      "the fixture has no live Runner connection, so every stop outcome is no_connection",
    );
    const sorted = [...elapsedMs].sort((a, b) => a - b);
    return {
      medianMs: sorted[Math.floor(sorted.length / 2)],
      samplesMs: elapsedMs,
      statementCounts,
      selectCount: representative.filter((entry) => /^\s*(select|with)\b/i.test(entry.query)).length,
      outcomeStatuses: [...new Set(outcomes.map((outcome) => outcome.status))],
      statements: await explain(representative),
    };
  }

  for (const count of [0, 1, 10, 100]) {
    if (count > 0) {
      await admin.unsafe(
        `update im_message_deliveries set reported_at = null, turn_report = null, result_hash = null, execution_origin = 'cloud'
         where id in (select id from im_message_deliveries where session_id = $1 order by id limit ${count})`,
        [SESSION],
      );
    }
    // Production autovacuum analyzes mutated rows; keep the plan evidence on current statistics.
    await admin.unsafe("analyze im_message_deliveries");
    const eligible = (
      await admin`select count(*)::int as n from im_message_deliveries where session_id = ${SESSION} and state = 'accepted' and reported_at is null`
    )[0]?.n;
    assert.equal(eligible, count, `the fixture must expose exactly ${count} eligible deliveries`);
    const caseRecord = {
      name: `cloud.cancel.${count}-unreported`,
      eligibleDeliveries: eligible,
      before: await measure(owners.before, count),
      after: await measure(owners.after, count),
    };
    (report.cases as unknown[]).push(caseRecord);
    save();
    console.log(
      JSON.stringify({
        name: caseRecord.name,
        before: { medianMs: caseRecord.before.medianMs, statements: caseRecord.before.statementCounts },
        after: { medianMs: caseRecord.after.medianMs, statements: caseRecord.after.statementCounts },
      }),
    );
  }
  report.runInterval = { startedAt, finishedAt: new Date().toISOString() };
} finally {
  rmSync(beforeModule, { force: true });
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
