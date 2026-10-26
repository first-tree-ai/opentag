/**
 * The Agent usage and internal-Session page benchmark, as a library.
 *
 * `benchmark-agent-session.ts` is the runnable entry: it wires Docker, PostgreSQL and the real services and
 * calls `runBenchmark`. Keeping the wiring and the logic apart is what makes this harness testable — importing
 * this module has no side effects, so a unit test can drive the whole measurement flow against an embedded
 * PostgreSQL and fakes instead of existing only as code nobody executes before a Docker run.
 *
 * The measured facts are the ones the change is judged by: bounded result sizes, per-call SQL counts, medians
 * over one warm-up plus five samples, and the analyzed plans of the statements the service actually issued.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DatabaseClient } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { markEndedDescendantsInactive } from "../src/services/sessions/session-closure.js";

/** Rows per business table a run requires before it reports anything. */
export const MINIMUM_TABLE_ROWS = 100_000;
/** Timed samples per case, after one warm-up. */
export const SAMPLES_PER_CASE = 5;
export const BENCHMARK_LABEL = "agent-session";
export const CANDIDATE_INDEX = "im_message_deliveries_unreported_accepted_candidate_idx";
export const LEGACY_ACTIVITY_INDEXES = [
  "session_descendants_ancestor_activity_idx",
  "session_descendants_ancestor_depth_activity_idx",
] as const;

export interface QueryRecord {
  query: string;
  params: unknown[];
}

export interface QueryLog {
  reset(): void;
  snapshot(): QueryRecord[];
}

export interface BenchmarkAdmin {
  query(strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  unsafe(query: string, parameters?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

/** The fixture's stable identities, so the flow does not depend on the seed's literal values. */
export interface BenchmarkFixture {
  accountId: string;
  agentId: string;
  hotBindingId: string;
  rootSessionId: string;
  /** Descendants of the hot internal tree that the run ends to model 90,000 ended Sessions. */
  endedDescendants: number;
}

/** The measured service reads plus the removed usage implementation they are compared with. */
export interface BenchmarkCases {
  listAgents(accountId: string): Promise<{ agents: unknown[] }>;
  usage(accountId: string, agentId: string, windowDays: number): Promise<{ daily: unknown[] }>;
  internalPage(rootSessionId: string): Promise<{ items: unknown[] }>;
  legacyUsage(): Promise<{ rows: number }>;
}

export interface BenchmarkDeps {
  docker(args: string[]): string;
  openAdmin(databaseUrl: string): Promise<BenchmarkAdmin>;
  migrate(databaseUrl: string): Promise<void>;
  readSeed(): string;
  createDatabase(databaseUrl: string): { database: DatabaseClient; queryLog: QueryLog; close(): Promise<void> };
  createCases(database: DatabaseClient, now: Date): BenchmarkCases;
  fixture: BenchmarkFixture;
  resolveOutputDirectory(): string;
  writeResults(directory: string, content: string): void;
  now(): Date;
  elapsed(): number;
  log(record: Record<string, unknown>): void;
  minimumRows?: number;
}

export interface SeedStatement {
  table: string;
  statement: string;
}

export interface RowCount {
  table: string;
  rows: number;
}

/**
 * Resolves where a run writes its result.
 *
 * `--out <dir>` wins over `OPENTAG_BENCHMARK_OUT`, which wins over the tracked results directory, so a
 * reviewer can keep the checkout clean with the same script CI records evidence with.
 */
export function resolveOutputDirectory(input: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  trackedDirectory: string;
}): string {
  const argumentIndex = input.argv.indexOf("--out");
  const fromArgument = argumentIndex === -1 ? undefined : input.argv[argumentIndex + 1];
  if (argumentIndex !== -1 && !fromArgument) throw new Error("--out requires a directory");
  return fromArgument ?? input.env.OPENTAG_BENCHMARK_OUT ?? input.trackedDirectory;
}

/** The median of a sample set, as the report quotes it. An empty set has no median and is a wiring bug. */
export function medianOf(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error("A benchmark case needs at least one sample");
  return value;
}

/** Splits the seed fixture into executable statements and names the table each one inserts into. */
export function splitSeedStatements(seedText: string): SeedStatement[] {
  return seedText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => ({ table: /insert into ([a-z_.]+)/i.exec(statement)?.[1] ?? "fixture functions", statement }));
}

/**
 * Fails the run when any business table holds fewer rows than the fixture promises.
 *
 * A seed that silently loaded nothing would otherwise still produce timings, and those timings would read as a
 * performance result for data that was never there.
 */
export function assertRowCounts(rows: readonly RowCount[], minimum = MINIMUM_TABLE_ROWS): void {
  for (const row of rows) {
    if (!Number.isInteger(row.rows) || row.rows < minimum) {
      throw new Error(`${row.table} holds ${row.rows} rows, below the ${minimum} the fixture requires`);
    }
  }
}

/**
 * Whether a captured statement may be re-run under `EXPLAIN`.
 *
 * Only reads are explained: re-running a write outside its transaction can change the fixture, and a
 * statement with more parameters than the driver will send cannot be prepared again at all.
 */
export function isExplainable(statement: QueryRecord): boolean {
  return /^\s*(select|with)\b/i.test(statement.query) && statement.params.length < 60_000;
}

/** Distinct statements of a representative call, in first-seen order. */
export function distinctStatements(representative: readonly QueryRecord[]): QueryRecord[] {
  return [...new Map(representative.map((record) => [record.query, record])).values()];
}

export function countOccurrences(representative: readonly QueryRecord[], query: string): number {
  return representative.filter((record) => record.query === query).length;
}

/** A bounded error description for the result file: no parameters, no SQL, no credentials. */
export function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  return {
    name: error.name,
    message: error.message.slice(0, 2_000),
    code: "code" in error ? String(error.code) : undefined,
  };
}

export interface MeasuredCase {
  name: string;
  samplesMs: number[];
  medianMs: number;
  maxMs: number | undefined;
  queryCounts: number[];
  responseBytes: number | undefined;
  error: unknown;
  statements: Record<string, unknown>[];
  detail: Record<string, unknown>;
}

/**
 * One warm-up plus `samples` timed calls, recording the SQL issued per call.
 *
 * The warm-up is excluded from the samples, and the first failure stops the case: repeating a failing call
 * would report a median for a path that never worked.
 */
export async function measureCase<T>(
  input: { name: string; samples?: number; queries: QueryLog; elapsed(): number },
  operation: () => Promise<T>,
  detail: (value: T | undefined) => Record<string, unknown> = () => ({}),
): Promise<{ value: T | undefined; measurement: MeasuredCase }> {
  const samples = input.samples ?? SAMPLES_PER_CASE;
  const times: number[] = [];
  const queryCounts: number[] = [];
  let value: T | undefined;
  let error: unknown;
  for (let sample = -1; sample < samples; sample++) {
    input.queries.reset();
    const started = input.elapsed();
    try {
      value = await operation();
    } catch (caught) {
      error = caught;
    }
    const elapsed = input.elapsed() - started;
    const issued = input.queries.snapshot().length;
    if (sample >= 0 || error) {
      times.push(elapsed);
      queryCounts.push(issued);
    }
    if (error) break;
  }
  const sorted = [...times].sort((left, right) => left - right);
  return {
    value,
    measurement: {
      name: input.name,
      samplesMs: times,
      medianMs: medianOf(times),
      maxMs: sorted.at(-1),
      queryCounts,
      responseBytes: value === undefined ? undefined : Buffer.byteLength(JSON.stringify(value)),
      error: error === undefined ? undefined : describeError(error),
      statements: [],
      detail: detail(value),
    },
  };
}

/**
 * Re-runs each distinct read under `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)`.
 *
 * Plans are evidence about the statements the service issued, so they are captured from the call the case
 * already made rather than from a hand-written approximation of it.
 */
export async function explainStatements(
  admin: BenchmarkAdmin,
  representative: readonly QueryRecord[],
): Promise<Record<string, unknown>[]> {
  const statements: Record<string, unknown>[] = [];
  for (const statement of distinctStatements(representative)) {
    const details: Record<string, unknown> = {
      sql: statement.query.slice(0, 30_000),
      sqlLength: statement.query.length,
      parameterCount: statement.params.length,
      occurrences: countOccurrences(representative, statement.query),
    };
    if (isExplainable(statement)) {
      try {
        const plan = await admin.unsafe(
          `explain (analyze,buffers,settings,format json) ${statement.query}`,
          statement.params,
        );
        details.explain = plan[0]?.["QUERY PLAN"];
      } catch (error) {
        details.explainError = describeError(error);
      }
    }
    statements.push(details);
  }
  return statements;
}

export interface LegacyUsageRow {
  acceptedAt: Date | null;
  cachedInputTokens: string | null;
  executionOrigin: "local" | "cloud" | null;
  inputTokens: string | null;
  outcome: string | null;
  outputTokens: string | null;
}

/**
 * The removed usage read: every Delivery row of the window to Node.js, aggregated by the same per-row parser.
 * It is rebuilt here so a run compares the submitted read with the implementation it replaces on one fixture
 * and one machine, instead of with a number from another run.
 */
export async function readLegacyUsage(
  database: PostgresJsDatabase<typeof schema>,
  input: { agentId: string; startedAt: Date; endedAt: Date; onRow?(row: LegacyUsageRow): void },
): Promise<{ rows: number }> {
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
        eq(schema.imBindings.agentId, input.agentId),
        gte(schema.imMessageDeliveries.acceptedAt, input.startedAt),
        lte(schema.imMessageDeliveries.acceptedAt, input.endedAt),
      ),
    )
    .orderBy(asc(schema.imMessageDeliveries.acceptedAt), asc(schema.imMessageDeliveries.id));
  for (const row of rows) input.onRow?.(row);
  return { rows: rows.length };
}

/** The removed internal-Session page: the activity index, then `sessions` for every candidate it walked. */
export async function readLegacyPage(
  database: DatabaseClient,
  rootSessionId: string,
  limit = 20,
): Promise<{ items: unknown[]; nextCursor?: string }> {
  const rows = (await database.execute(sql`
    select link.descendant_session_id as "sessionId",
           child.created_by_session_id as "parentSessionId",
           child.created_at as "createdAt",
           link.last_message_created_at as "lastMessageAt",
           link.last_message_id as "lastMessageId",
           link.last_delivery_outcome as "lastDeliveryOutcome",
           link.task_preview as "taskPreview"
    from session_descendants link
    inner join sessions child on child.id = link.descendant_session_id
    where link.ancestor_session_id = ${rootSessionId}::uuid
      and child.ended_at is null
    order by link.last_message_created_at desc, link.last_message_id desc, link.descendant_session_id desc
    limit ${limit + 1}
  `)) as unknown as unknown[];
  return { items: rows.slice(0, limit), ...(rows.length > limit ? { nextCursor: "cursor" } : {}) };
}

/** Ends the hot internal tree's descendants the way the lifecycle does, then proves the closure invariant. */
export async function endInternalTree(
  admin: BenchmarkAdmin,
  database: DatabaseClient,
  input: { bindingId: string; descendants: number },
  elapsed: () => number,
): Promise<Record<string, unknown>> {
  const endedAt = "2026-10-26T08:00:00.000Z";
  const startedUpdate = elapsed();
  await admin.unsafe(
    `update sessions set ended_at = '${endedAt}'::timestamptz
     where id in (select benchmark.id(8, n) from generate_series(1, ${input.descendants}) n)`,
  );
  const sessionEndMs = elapsed() - startedUpdate;
  const startedClosure = elapsed();
  await markEndedDescendantsInactive(database, { imBindingId: input.bindingId });
  const closureMaintenanceMs = elapsed() - startedClosure;
  const [flags] = await admin.query`
    select count(*) filter (where descendant_active)::int as active,
           count(*) filter (where not descendant_active)::int as inactive
    from session_descendants`;
  const [divergence] = await admin.query`
    select count(*)::int as divergent
    from session_descendants link
    inner join sessions child on child.id = link.descendant_session_id
    where link.descendant_active is distinct from (child.ended_at is null)`;
  if (Number(divergence?.divergent) !== 0) {
    throw new Error(`The closure disagrees with sessions.ended_at for ${String(divergence?.divergent)} rows`);
  }
  return { sessionEndMs, closureMaintenanceMs, endedDescendants: input.descendants, flags, divergence };
}

/** Relation sizes of the closure table and its indexes, for the storage half of the report. */
export async function closureStorage(admin: BenchmarkAdmin): Promise<{ name: string; bytes: number }[]> {
  const rows = await admin.query`
    select c.relname as name, pg_relation_size(c.oid)::text as bytes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'session_descendants%'
    order by 2 desc`;
  return rows.map((row) => ({ name: String(row.name), bytes: Number(row.bytes) }));
}

/**
 * Runs the whole benchmark against the injected environment and returns the report it wrote.
 *
 * Cleanup is part of the contract: the container and volume are removed even when a case throws, because a
 * failed run must not leave resources another lane could mistake for its own.
 */
export async function runBenchmark(deps: BenchmarkDeps): Promise<Record<string, unknown>> {
  const now = deps.now();
  const outputDirectory = deps.resolveOutputDirectory();
  const results: MeasuredCase[] = [];
  const report: Record<string, unknown> = { results };
  const save = () => deps.writeResults(outputDirectory, `${JSON.stringify(report, null, 2)}\n`);
  const container = `opentag-benchmark-agent-session-${process.pid}`;
  deps.docker([
    "run",
    "--detach",
    "--name",
    container,
    "--label",
    `opentag.benchmark=${BENCHMARK_LABEL}`,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_PASSWORD=benchmark-only",
    "--env",
    "POSTGRES_DB=opentag_benchmark",
    "postgres:17-alpine",
  ]);
  const label = deps.docker(["inspect", "--format", '{{index .Config.Labels "opentag.benchmark"}}', container]);
  if (label !== BENCHMARK_LABEL) throw new Error("The benchmark container is missing its label");
  const binding = deps.docker(["port", container, "5432/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error(`Unexpected container binding ${binding}`);
  const databaseUrl = `postgres://postgres:${"benchmark-only"}@${binding}/opentag_benchmark`;
  const admin = await deps.openAdmin(databaseUrl);
  let closeDatabase: (() => Promise<void>) | undefined;
  try {
    await deps.migrate(databaseUrl);
    const database = deps.createDatabase(databaseUrl);
    closeDatabase = database.close;
    const cases = deps.createCases(database.database, now);
    report.environment = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      dockerImage: deps.docker(["inspect", "--format", "{{.Image}}", container]),
      startedAt: new Date().toISOString(),
      method:
        "One warm-up and five sequential samples per case. Local Docker microbenchmark, not production capacity. Default service query deadlines and connection pool. EXPLAIN uses one additional untimed call per distinct SELECT. Values include Node mapping and loopback transport. The `.before` cases reproduce the removed implementations in this process.",
    };
    const seedTimings: Record<string, unknown>[] = [];
    for (const seed of splitSeedStatements(deps.readSeed())) {
      const started = deps.elapsed();
      await admin.unsafe(seed.statement);
      const timing = { table: seed.table, elapsedMs: deps.elapsed() - started };
      seedTimings.push(timing);
      deps.log({ phase: "seed", ...timing });
    }
    report.seedTimings = seedTimings;
    await admin.query`analyze`;
    const tables = (await admin.query`
      select n.nspname as schema, c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'billing')
      order by 1, 2`) as unknown as { schema: string; name: string }[];
    const rowCounts: RowCount[] = [];
    for (const table of tables) {
      const [row] = await admin.unsafe(`select count(*)::int as n from "${table.schema}"."${table.name}"`);
      rowCounts.push({ table: `${table.schema}.${table.name}`, rows: Number(row?.n ?? -1) });
    }
    assertRowCounts(rowCounts, deps.minimumRows ?? MINIMUM_TABLE_ROWS);
    report.rowCounts = rowCounts;
    report.databaseBytes = (await admin.query`select pg_database_size(current_database())::text as bytes`)[0]?.bytes;

    const measure = async <T>(
      name: string,
      operation: () => Promise<T>,
      detail?: (value: T | undefined) => Record<string, unknown>,
    ): Promise<T | undefined> => {
      const { value, measurement } = await measureCase(
        { name, queries: database.queryLog, elapsed: deps.elapsed },
        operation,
        detail,
      );
      measurement.statements = await explainStatements(admin, database.queryLog.snapshot());
      results.push(measurement);
      save();
      deps.log({ ...measurement, statements: undefined });
      return value;
    };

    await measure(
      "agents.list.1-agents",
      () => cases.listAgents(deps.fixture.accountId),
      (value) => ({
        bounded: { agents: value?.agents.length ?? 0 },
      }),
    );
    /*
     * A candidate index for the list's two unreported-accepted reads, measured and then dropped. With it the
     * hot list fits the 100 ms target, but PostgreSQL also starts using it inside the IM delivery work query,
     * whose plan test requires the dedicated active-work index alone. That query belongs to another owner, so
     * this run keeps the measurement as evidence instead of shipping the index.
     */
    const indexStartedAt = deps.elapsed();
    await admin.unsafe(`
      create index "${CANDIDATE_INDEX}" on "im_message_deliveries" ("accepted_at", "id", "session_id")
      where "state" = 'accepted' and "reported_at" is null`);
    await admin.query`analyze im_message_deliveries`;
    report.candidateIndex = {
      name: CANDIDATE_INDEX,
      decision: "measured, not adopted: PostgreSQL also chooses it in the IM delivery work query",
      buildMs: deps.elapsed() - indexStartedAt,
      bytes: Number(
        (await admin.unsafe(`select pg_relation_size('${CANDIDATE_INDEX}')::text as bytes`))[0]?.bytes ?? 0,
      ),
    };
    await measure(
      "agents.list.1-agents.with-candidate-index",
      () => cases.listAgents(deps.fixture.accountId),
      (value) => ({
        bounded: { agents: value?.agents.length ?? 0 },
      }),
    );
    await admin.unsafe(`drop index "${CANDIDATE_INDEX}"`);
    await admin.query`analyze im_message_deliveries`;

    await measure(
      "agents.usage.50000-deliveries",
      () => cases.usage(deps.fixture.accountId, deps.fixture.agentId, 30),
      (value) => ({ bounded: { dailyBuckets: value?.daily.length ?? 0 } }),
    );
    await measure(
      "sessions.internal.100000-active.limit20",
      () => cases.internalPage(deps.fixture.rootSessionId),
      (value) => ({ bounded: { items: value?.items.length ?? 0 } }),
    );
    report.lifecycleWrite = await endInternalTree(
      admin,
      database.database,
      { bindingId: deps.fixture.hotBindingId, descendants: deps.fixture.endedDescendants },
      deps.elapsed,
    );
    await admin.query`analyze sessions`;
    await admin.query`analyze session_descendants`;
    await measure(
      "sessions.internal.90000-ended.limit20",
      () => cases.internalPage(deps.fixture.rootSessionId),
      (value) => ({ bounded: { items: value?.items.length ?? 0 } }),
    );
    const storage: Record<string, unknown> = { activeShape: await closureStorage(admin) };
    report.closureStorage = storage;
    for (const index of LEGACY_ACTIVITY_INDEXES) {
      await admin.unsafe(
        index === LEGACY_ACTIVITY_INDEXES[0]
          ? `create index "${index}" on "session_descendants" ("ancestor_session_id","last_message_created_at","last_message_id","descendant_session_id")`
          : `create index "${index}" on "session_descendants" ("ancestor_session_id","depth","last_message_created_at","last_message_id","descendant_session_id")`,
      );
    }
    await admin.query`analyze session_descendants`;
    storage.legacyIndexesAdded = await closureStorage(admin);
    await measure("sessions.internal.90000-ended.limit20.before", () =>
      readLegacyPage(database.database, deps.fixture.rootSessionId),
    );
    for (const index of LEGACY_ACTIVITY_INDEXES) await admin.unsafe(`drop index "${index}"`);
    await admin.query`analyze session_descendants`;
    storage.final = await closureStorage(admin);

    await measure(
      "agents.usage.50000-deliveries.before",
      () => cases.legacyUsage(),
      (value) => ({
        bounded: { rowsRead: value?.rows ?? 0 },
      }),
    );
    const httpFree = results.filter((measurement) => measurement.error !== undefined).map(({ name }) => name);
    if (httpFree.length > 0) report.casesWithErrors = httpFree;
    report.finishedAt = new Date().toISOString();
  } finally {
    try {
      await closeDatabase?.();
    } finally {
      try {
        await admin.end();
      } finally {
        deps.docker(["rm", "--force", "--volumes", container]);
        report.containerRemoved = true;
        save();
      }
    }
  }
  return report;
}
