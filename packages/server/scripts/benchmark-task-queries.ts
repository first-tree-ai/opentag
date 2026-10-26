/**
 * Task-scoped benchmark for the Task read paths: the list page, the legacy complete detail, and the
 * bounded detail sections. It owns one disposable loopback PostgreSQL container, never reads
 * DATABASE_URL or any .env file, applies the real migrations, replays the Task fixture
 * (`task-queries-fixture.sql`, every business table at 100000 rows), and keeps constraints and
 * indexes enabled. The service client uses its default query deadlines.
 *
 * The fixture and the harness are tracked so a fresh checkout can reproduce the measurement. The
 * output path is overridable, so a verification run does not rewrite the committed evidence:
 *
 *   pnpm exec tsx packages/server/scripts/benchmark-task-queries.ts --phase after
 *   pnpm exec tsx packages/server/scripts/benchmark-task-queries.ts --phase verify --output /tmp/task-queries
 *
 * Results land in `<output>/results-<phase>.json` and `<output>/explain/<phase>/*.json`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskSummary } from "@opentag/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDatabaseClient } from "../src/db/client.js";
import { migrateDatabase } from "../src/db/migrate.js";
import * as schema from "../src/db/schema/index.js";
import { TaskService } from "../src/services/tasks/index.js";

const phase = (() => {
  const index = process.argv.indexOf("--phase");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  assert.ok(value && /^[a-z0-9-]+$/.test(value), "Pass --phase <label>");
  return value;
})();
const defaultOutput = fileURLToPath(new URL("../../../testing/performance/task-queries/", import.meta.url));
const output = (() => {
  const index = process.argv.indexOf("--output");
  if (index < 0) return defaultOutput;
  const value = process.argv[index + 1];
  assert.ok(value && value.trim().length > 0, "Pass a directory after --output");
  return resolve(value);
})();
const explainDir = `${output}/explain/${phase}`;
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const container = `opentag-task-bench-${process.pid}`;
const label = "opentag.benchmark";
const labelValue = `task-queries-${phase}`;
const now = () => new Date("2026-10-26T08:00:00Z");
const id = (kind: number, number: number) =>
  `${String(kind).padStart(8, "0")}-0000-4000-8000-${String(number).padStart(12, "0")}`;

mkdirSync(explainDir, { recursive: true });
docker(
  "run",
  "--detach",
  "--name",
  container,
  "--label",
  `${label}=${labelValue}`,
  "--publish",
  "127.0.0.1::5432",
  "--env",
  "POSTGRES_PASSWORD=benchmark-local-only",
  "--env",
  "POSTGRES_DB=opentag_benchmark",
  "postgres:17-alpine",
);
assert.equal(docker("inspect", "--format", `{{index .Config.Labels "${label}"}}`, container), labelValue);
const binding = docker("port", container, "5432/tcp");
assert.match(binding, /^127\.0\.0\.1:\d+$/);
const url = `postgres://postgres:benchmark-local-only@${binding}/opentag_benchmark`;
const admin = postgres(url, { max: 1, onnotice: () => undefined });
const results: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { phase, results };
const save = () => writeFileSync(`${output}/results-${phase}.json`, `${JSON.stringify(report, null, 2)}\n`);
let closeClient: (() => Promise<void>) | undefined;

interface Statement {
  query: string;
  params: unknown[];
}

const errorInfo = (error: unknown): unknown =>
  error instanceof Error
    ? {
        name: error.name,
        message: error.message.slice(0, 2000),
        code: "code" in error ? error.code : undefined,
        cause: "cause" in error ? errorInfo(error.cause) : undefined,
      }
    : String(error);

try {
  for (let attempt = 0; ; attempt++) {
    try {
      await admin`select 1`;
      break;
    } catch (error) {
      if (attempt >= 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const migratedAt = performance.now();
  await migrateDatabase(url, fileURLToPath(new URL("../drizzle/", import.meta.url)));
  const migrationMs = performance.now() - migratedAt;
  report.environment = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dockerImage: docker("inspect", "--format", "{{.Image}}", container),
    dockerResources: JSON.parse(docker("info", "--format", '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}')),
    postgres: (
      await admin`select version(), current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem, current_setting('max_connections') as max_connections`
    )[0],
    migrationCount: (await admin`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]?.n,
    migrationMs,
    startedAt: new Date().toISOString(),
    method:
      "One warm-up and five sequential samples per case. Single sequential local Docker microbenchmark, not production capacity. Default service query deadlines and connection pool. SQL counts come from the service query logger. EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) runs once per distinct SELECT outside the timed samples. Values include Node mapping and loopback transport; responseBytes exclude HTTP encoding. No external providers.",
  };
  const seedTimings: { table: string; elapsedMs: number }[] = [];
  for (const statement of readFileSync(new URL("./task-queries-fixture.sql", import.meta.url), "utf8").split(
    "--> statement-breakpoint",
  )) {
    if (!statement.trim()) continue;
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
  let queries: Statement[] = [];
  const database = drizzle(client.sql, {
    schema,
    logger: {
      logQuery(query, params) {
        queries.push({ query, params });
      },
    },
  });
  const tasks = new TaskService(database, { now });

  async function explain(caseName: string, representative: Statement[]) {
    const unique = [...new Map(representative.map((query) => [query.query, query])).values()];
    const summaries = [];
    for (const [index, statement] of unique.entries()) {
      const summary: Record<string, unknown> = {
        sql: statement.query,
        sqlLength: statement.query.length,
        parameterCount: statement.params.length,
        occurrences: representative.filter((query) => query.query === statement.query).length,
      };
      if (!/^\s*(select|with)\b/i.test(statement.query) || statement.params.length >= 60000) {
        summaries.push(summary);
        continue;
      }
      try {
        const plan = await client.sql.unsafe(
          `explain (analyze,buffers,settings,format json) ${statement.query}`,
          statement.params as never[],
        );
        const tree = plan[0]?.["QUERY PLAN"];
        const file = `${explainDir}/${caseName}-${index + 1}.json`;
        writeFileSync(file, `${JSON.stringify({ sql: statement.query, plan: tree }, null, 2)}\n`);
        summary.explainFile = file.slice(output.length);
        const root = Array.isArray(tree) ? tree[0] : undefined;
        summary.executionTimeMs = root?.["Execution Time"];
        summary.topNode = root?.Plan?.["Node Type"];
        summary.planRows = root?.Plan?.["Actual Rows"];
      } catch (caught) {
        summary.explainError = errorInfo(caught);
      }
      summaries.push(summary);
    }
    return summaries;
  }

  async function measure<T>(name: string, operation: () => Promise<T>, samples = 5): Promise<T | undefined> {
    const times: number[] = [];
    const counts: number[] = [];
    let last: T | undefined;
    let error: unknown;
    let representative: Statement[] = [];
    for (let sample = -1; sample < samples; sample++) {
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
    const statements = await explain(name, representative);
    const sorted = [...times].sort((a, b) => a - b);
    const record = {
      name,
      samplesMs: times,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      maxMs: sorted.at(-1),
      queryCounts: counts,
      responseBytes: last === undefined ? undefined : Buffer.byteLength(JSON.stringify(last)),
      error,
      statements,
    };
    results.push(record);
    save();
    console.log(JSON.stringify({ ...record, statements: undefined }));
    return last;
  }

  const hotDm = await measure("tasks.list.hot-dm.limit20", () => tasks.list(id(1, 1), { limit: 20 }));
  if (hotDm?.nextCursor)
    await measure("tasks.list.hot-dm.page2", () =>
      tasks.list(id(1, 1), { limit: 20, cursor: hotDm.nextCursor ?? undefined }),
    );
  const channelPage = await measure("tasks.list.10-agents.25000-messages.limit20", () =>
    tasks.list(id(1, 2), { limit: 20 }),
  );
  if (channelPage?.nextCursor)
    await measure("tasks.list.10-agents.page2", () =>
      tasks.list(id(1, 2), { limit: 20, cursor: channelPage.nextCursor ?? undefined }),
    );
  const hotTask = hotDm?.tasks[0];
  assert.ok(hotTask, "The hot DM fixture must produce a task");
  await measure("tasks.detail.legacy.hot-dm.limit20", () => tasks.get(id(1, 1), hotTask.id, { limit: 20 }), 1);
  await measure("tasks.replies.hot-dm.limit20", () => tasks.listReplies(id(1, 1), hotTask.id, { limit: 20 }));

  // The bounded contract only exists after the change; the same harness measures both phases.
  const bounded = (
    tasks as unknown as {
      detail?: (accountId: string, taskId: string, options: { limit: number }) => Promise<TaskDetailLike>;
      listInternalSessions?: (
        accountId: string,
        taskId: string,
        options: { limit: number; cursor?: string },
      ) => Promise<PageLike>;
      listCollaborationMessages?: (
        accountId: string,
        taskId: string,
        options: { limit: number; cursor?: string },
      ) => Promise<PageLike>;
    }
  ).detail;
  if (bounded) {
    const page = await measure("tasks.detail.bounded.hot-dm.limit20", () =>
      bounded.call(tasks, id(1, 1), hotTask.id, { limit: 20 }),
    );
    const internalCursor = page?.internalSessions.nextCursor;
    if (internalCursor)
      await measure("tasks.detail.bounded.hot-dm.internal-sessions.page2", () =>
        (
          tasks as unknown as {
            listInternalSessions: (
              accountId: string,
              taskId: string,
              options: { limit: number; cursor?: string },
            ) => Promise<PageLike>;
          }
        ).listInternalSessions(id(1, 1), hotTask.id, { limit: 20, cursor: internalCursor }),
      );
    const collaborationCursor = page?.collaborationMessages.nextCursor;
    if (collaborationCursor)
      await measure("tasks.detail.bounded.hot-dm.collaboration-messages.page2", () =>
        (
          tasks as unknown as {
            listCollaborationMessages: (
              accountId: string,
              taskId: string,
              options: { limit: number; cursor?: string },
            ) => Promise<PageLike>;
          }
        ).listCollaborationMessages(id(1, 1), hotTask.id, { limit: 20, cursor: collaborationCursor }),
      );
    const turnCursor = page?.turns.nextCursor;
    if (turnCursor)
      await measure("tasks.detail.bounded.hot-dm.turns.page2", () =>
        (
          tasks as unknown as {
            listTurns: (
              accountId: string,
              taskId: string,
              options: { limit: number; cursor?: string },
            ) => Promise<PageLike>;
          }
        ).listTurns(id(1, 1), hotTask.id, { limit: 20, cursor: turnCursor }),
      );
  }
  const channelTask = channelPage?.tasks[0] as TaskSummary | undefined;
  assert.ok(channelTask, "The ten-Agent fixture must produce a task");
  await measure("tasks.detail.legacy.10-agents.limit20", () => tasks.get(id(1, 2), channelTask.id, { limit: 20 }));
  if (bounded)
    await measure("tasks.detail.bounded.10-agents.limit20", () =>
      bounded.call(tasks, id(1, 2), channelTask.id, { limit: 20 }),
    );

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

interface PageLike {
  items: unknown[];
  nextCursor: string | null;
}

interface TaskDetailLike {
  task: TaskSummary;
  turns: PageLike;
  internalSessions: PageLike;
  collaborationMessages: PageLike;
}
