/**
 * Task-scoped query benchmark: the Task list, the legacy complete detail, and the bounded detail
 * sections, measured on the tracked 100,000-rows-per-table fixture.
 *
 * This file is the composition root only — arguments, Docker, PostgreSQL, migrations and the service.
 * The measurement and container logic live in `src/benchmark/`, where unit tests drive them through
 * injected ports; importing that code never starts a container, and importing this file is never done
 * by a test.
 *
 * It owns one disposable loopback container, never reads `DATABASE_URL` or a `.env` file, applies the
 * real migrations, keeps constraints and indexes enabled, and uses the service client's default query
 * deadlines.
 *
 *   pnpm exec tsx packages/server/scripts/benchmark-task-queries.ts --phase after
 *   pnpm exec tsx packages/server/scripts/benchmark-task-queries.ts --phase verify --output /tmp/task-queries
 *
 * Results land in `<output>/results-<phase>.json` and `<output>/explain/<phase>/*.json`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { startBenchmarkContainer, waitForDatabase } from "../src/benchmark/benchmark-container.js";
import {
  type BenchmarkReport,
  runTaskQueriesBenchmark,
  type Statement,
  seedDatabase,
  splitSeed,
  verifyRowCounts,
} from "../src/benchmark/benchmark-task-queries.js";
import { createDatabaseClient } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import * as schema from "../src/db/schema/index.js";
import { TaskService } from "../src/services/tasks/index.js";

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback ?? "";
}

const phase = argument("--phase");
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error("Pass --phase <label>");
const output = resolve(
  argument("--output", fileURLToPath(new URL("../../../testing/performance/task-queries/", import.meta.url))),
);
const explainDir = join(output, "explain", phase);
const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

mkdirSync(explainDir, { recursive: true });
const container = startBenchmarkContainer({
  docker,
  name: `opentag-task-bench-${process.pid}`,
  labelKey: "opentag.benchmark",
  labelValue: `task-queries-${phase}`,
  log: (line) => console.log(line),
});
const report: BenchmarkReport = { phase, results: [] };
const resultsPath = join(output, `results-${phase}.json`);
const save = () => writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
const admin = postgres(container.url, { max: 1, onnotice: () => undefined });
let client: ReturnType<typeof createDatabaseClient> | undefined;
try {
  await waitForDatabase(() => admin`select 1`);
  const migratedAt = performance.now();
  await migrateDatabase(container.url, fileURLToPath(new URL("../drizzle/", import.meta.url)));
  report.environment = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    // Source cleanliness only: the evidence directory is not a code change, so verifying a committed
    // tree records `dirty: false` however often the run repeats.
    dirty:
      execFileSync("git", ["status", "--porcelain", "--", ".", ":!testing/performance"], {
        encoding: "utf8",
      }).trim() !== "",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ...container.environment,
    postgres: (
      await admin`select version(), current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem, current_setting('max_connections') as max_connections`
    )[0],
    migrationCount: (await admin`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]?.n,
    migrationMs: performance.now() - migratedAt,
    startedAt: new Date().toISOString(),
    method:
      "One warm-up and five sequential samples per case unless stated. Single sequential local Docker microbenchmark, not production capacity. Default service query deadlines and connection pool. SQL counts come from the service query logger. EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) runs once per distinct SELECT outside the timed samples. Values include Node mapping and loopback transport; responseBytes exclude HTTP encoding. No external providers.",
  };
  const adminPort = { unsafe: (query: string, params?: readonly unknown[]) => admin.unsafe(query, params as never[]) };
  report.seedTimings = await seedDatabase(
    adminPort,
    splitSeed(readFileSync(new URL("./task-queries-fixture.sql", import.meta.url), "utf8")),
    () => performance.now(),
    (line) => console.log(line),
  );
  await admin`analyze`;
  report.rowCounts = await verifyRowCounts(adminPort);
  report.databaseBytes = (await admin`select pg_database_size(current_database())::text as bytes`)[0]?.bytes;

  client = createDatabaseClient(container.url);
  report.timeouts = client.timeouts;
  let statements: Statement[] = [];
  const database = drizzle(client.sql, {
    schema,
    logger: {
      logQuery(query, params) {
        statements.push({ query, params });
      },
    },
  });
  const now = () => new Date("2026-10-26T08:00:00Z");
  const id = (kind: number, number: number) =>
    `${String(kind).padStart(8, "0")}-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const explainSql = postgres(container.url, { max: 1, onnotice: () => undefined });
  try {
    await runTaskQueriesBenchmark(
      {
        admin: adminPort,
        explainSql: { unsafe: (query, params) => explainSql.unsafe(query, params as never[]) },
        service: new TaskService(database, { now }),
        sink: {
          take: () => statements,
          reset: () => {
            statements = [];
          },
        },
        output: { dir: explainDir, mkdir: mkdirSync, write: writeFileSync },
        report,
        clock: () => performance.now(),
        log: (line) => console.log(line),
        save,
      },
      { hotAccountId: id(1, 1), tenAgentAccountId: id(1, 2) },
    );
    report.finishedAt = new Date().toISOString();
  } finally {
    await explainSql.end();
  }
} finally {
  try {
    await client?.sql.end();
  } finally {
    try {
      await admin.end();
    } finally {
      container.stop();
      report.containerRemoved = true;
      save();
    }
  }
}
