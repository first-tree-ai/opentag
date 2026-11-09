/**
 * Task-scoped query benchmark: the Task list, the legacy complete detail, and the bounded detail
 * first pages and section continuations, measured on the tracked 100,000-rows-per-table fixture.
 *
 * This file is only the wiring: arguments, Docker, PostgreSQL, migrations and file output. The run
 * itself, the measurement and the container checks live in `scripts/benchmark/`, beside this file,
 * where unit tests drive them through injected ports. Entry tests replace the run before importing
 * this file, so they verify wiring without starting a container.
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
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { createDatabaseClient } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import * as schema from "../src/db/schema/index.js";
import { TaskService } from "../src/services/tasks/index.js";
import { parseBenchmarkArgs } from "./benchmark/args.js";
import { runBenchmark } from "./benchmark/run.js";

const { phase, output } = parseBenchmarkArgs(process.argv, {
  defaultOutput: resolve(tmpdir(), "opentag-benchmarks/task-queries"),
  resolvePath: resolve,
});
const containerName = `opentag-task-bench-${process.pid}`;
const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();

/** One single-connection client, used for the fixture and for `EXPLAIN`. */
function openConnection(url: string) {
  const sql = createDatabaseClient(url, { max: 1 }).sql;
  return {
    database: { unsafe: (query: string, params?: readonly unknown[]) => sql.unsafe(query, params as never[]) },
    end: () => sql.end({ timeout: 5 }),
  };
}

await runBenchmark({
  phase,
  output,
  docker,
  containerName,
  labelValue: `task-queries-${phase}`,
  openAdmin: openConnection,
  openExplain: openConnection,
  openService(url) {
    const client = createDatabaseClient(url);
    const statements: { query: string; params: unknown[] }[] = [];
    const database = drizzle(client.sql, {
      schema,
      logger: {
        logQuery(query, params) {
          statements.push({ query, params });
        },
      },
    });
    const drain = () => statements.splice(0, statements.length);
    return {
      service: new TaskService(database, { now: () => new Date("2026-10-26T08:00:00Z") }),
      sink: { take: drain, reset: drain },
      timeouts: client.timeouts,
      end: () => client.sql.end({ timeout: 5 }),
    };
  },
  migrate: (url) => migrateDatabase(url, fileURLToPath(new URL("../drizzle/", import.meta.url))),
  readSeed: () => readFileSync(new URL("./task-queries-fixture.sql", import.meta.url), "utf8"),
  environment: () => ({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dockerImage: docker(["inspect", "--format", "{{.Image}}", containerName]),
    dockerResources: JSON.parse(docker(["info", "--format", '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}'])),
  }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  write: (path, contents) => writeFileSync(path, contents),
  gitHead: () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  gitDirty: () => execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
  clock: () => performance.now(),
  log: (line) => console.log(line),
  ids: {
    hotAccountId: "00000001-0000-4000-8000-000000000001",
    tenAgentAccountId: "00000001-0000-4000-8000-000000000002",
  },
});
