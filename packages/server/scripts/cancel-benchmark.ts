/**
 * Orchestration of the cancellation-read benchmark for `CloudDeliveryOwner.cancelSessionDeliveries`.
 *
 * It measures the same call on the SAME seeded data with two owners: the pre-change implementation
 * (one Sandbox SELECT per delivery) and the working-tree implementation (one Sandbox SELECT per
 * backlog). Pairing both runs removes data and cache differences from the comparison.
 *
 * Invariants of this module:
 * - Every side effect (docker, git, files, clock, database, the compared implementations) is an
 *   injected port, so the orchestration is unit-testable without Docker, a database, or a network.
 *   The production ports live in `cancel-benchmark-runtime.ts`; nothing here starts anything on import.
 * - The fixture has no live Runner connection by construction, so every stop outcome must be
 *   `no_connection`. A `cancelled` outcome means the measurement no longer models a backlog, and the
 *   run fails instead of publishing a wrong comparison.
 * - Committed evidence must stay machine-independent: the report records the repository-relative
 *   tracked results path, or `<overridden>`, never the absolute output path.
 */
import { dirname, resolve } from "node:path";

export const TRACKED_RESULTS_PATH = "testing/performance/cancel-deliveries/results.json";
export const SEED_FIXTURE_PATH = "packages/server/scripts/database-performance-seed.sql";
export const MINIMUM_TABLE_ROWS = 100_000;
export const CASE_SIZES = [0, 1, 10, 100] as const;
export const SAMPLES = 5;
const DEFAULT_BEFORE_REF = "d2fc9e8aa045dc1a214ab3f0a953cbdcde088c92";
const OWNER_SOURCE = "packages/server/src/services/sandboxes/cloud-delivery-owner.ts";
const TABLES_SQL =
  "select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname in ('public', 'billing') order by 1, 2";
const ELIGIBLE_DELIVERIES_SQL =
  "select count(*)::int as n from im_message_deliveries where session_id = $1 and state = 'accepted' and reported_at is null";
const ANALYZE_DELIVERIES_SQL = "analyze im_message_deliveries";

export type QueryRecord = { query: string; params: unknown[] };
export type CancelOutcome = { deliveryId: string; status: string };
export type StatementEvidence = {
  occurrences: number;
  parameterCount: number;
  plan?: unknown;
  sql: string;
};
export type MeasureEvidence = {
  medianMs: number;
  outcomeStatuses: string[];
  samplesMs: number[];
  selectCount: number;
  statementCounts: number[];
  statements: StatementEvidence[];
};
export type CaseEvidence = {
  after: MeasureEvidence;
  before: MeasureEvidence;
  eligibleDeliveries: number;
  name: string;
};
export type BenchmarkReport = {
  cases: CaseEvidence[];
  containerRemoveError?: string;
  containerRemoved?: boolean;
  environment?: Record<string, unknown>;
  rowCounts?: { table: string; rows: number }[];
  runInterval?: { startedAt: string; finishedAt: string };
  seedTimings?: { table: string; elapsedMs: number }[];
  timeouts?: unknown;
};

/** One implementation under measurement, over the logged connection it shares with its twin. */
export interface CancelOwnerPort {
  cancelSessionDeliveries(sessionId: string): Promise<CancelOutcome[]>;
}

/** Administrative fixture access: seeding, ANALYZE, row counts, case preparation. */
export interface BenchmarkAdminPort {
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  end(): Promise<void>;
}

/** The measurement seam: both owners plus the statement journal and plan capture they share. */
export interface BenchmarkSeam {
  after: CancelOwnerPort;
  before: CancelOwnerPort;
  close(): Promise<void>;
  explain(sql: string, params: readonly unknown[]): Promise<unknown>;
  journal(): readonly QueryRecord[];
  resetJournal(): void;
  timeouts: unknown;
}

export interface CancelBenchmarkDeps {
  clock: { elapsedMs(): number; nowIso(): string };
  containerName: string;
  /** Repository-relative identifier recorded as the seed fixture in the evidence. */
  docker(args: readonly string[]): string;
  env: Record<string, string | undefined>;
  file: {
    ensureDirectory(path: string): void;
    read(path: string): string;
    remove(path: string): void;
    write(path: string, value: string): void;
  };
  git(args: readonly string[]): string;
  log(line: string): void;
  migrate(databaseUrl: string): Promise<void>;
  openAdmin(databaseUrl: string): Promise<BenchmarkAdminPort>;
  openSeam(databaseUrl: string, beforeModuleFile: string): Promise<BenchmarkSeam>;
  paths: { beforeModuleFile: string; migrationsFolder: string; seedFile: string; trackedResultsFile: string };
  sessionId: string;
  startDatabaseContainer(): string;
}

/**
 * The recorded location of a run. `label` is what the evidence may contain; `outputPath` is where the
 * run writes. An override run records only `<overridden>`, because a committed file must not carry a
 * machine path.
 */
export function resolveResultsTarget(
  env: Record<string, string | undefined>,
  trackedResultsFile: string,
): { label: string; outputPath: string } {
  const override = env.OPENTAG_BENCHMARK_OUTPUT;
  return override
    ? { label: "<overridden>", outputPath: resolve(override) }
    : { label: TRACKED_RESULTS_PATH, outputPath: trackedResultsFile };
}

/** Statements of the tracked seed fixture, each with the table it inserts into when it inserts rows. */
export function parseSeedStatements(source: string): { statement: string; table?: string }[] {
  return source.split("--> statement-breakpoint").map((statement) => ({
    statement,
    table: /insert into ([a-z_.]+)/i.exec(statement)?.[1],
  }));
}

/** Every business table of the fixture must reach the audit's row count before any measurement. */
export function assertTableRowCounts(rowCounts: readonly { table: string; rows: number }[]): void {
  for (const { table, rows } of rowCounts) {
    if (!Number.isFinite(rows) || rows < MINIMUM_TABLE_ROWS) {
      throw new Error(`${table} is below ${MINIMUM_TABLE_ROWS} rows (found ${Number.isFinite(rows) ? rows : "none"})`);
    }
  }
}

/** Median of the timed samples; an even count takes the upper middle, matching the recorded evidence. */
export function summarizeSamples(samplesMs: readonly number[]): { medianMs: number; samplesMs: number[] } {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return { medianMs: sorted[Math.floor(sorted.length / 2)] ?? Number.NaN, samplesMs: [...samplesMs] };
}

/** Only statements can be planned; the fixture seed and ANALYZE steps are not candidates. */
export function isExplainable(sql: string): boolean {
  return /^\s*(select|with)\b/i.test(sql);
}

/** The plan wrapper of the evidence: analyzed, buffered, and JSON so the tree stays inspectable. */
export function planSql(sql: string): string {
  return `explain (analyze, buffers, settings, format json) ${sql}`;
}

/** The fixture reset for one case: the first `count` deliveries of the Session become unreported. */
export function resetDeliveriesSql(count: number): string {
  return `update im_message_deliveries set reported_at = null, turn_report = null, result_hash = null, execution_origin = 'cloud' where id in (select id from im_message_deliveries where session_id = $1 order by id limit ${count})`;
}

/**
 * The pre-change module source. A shallow clone without the ref is a setup problem the operator can
 * fix, so it fails with the two ways to fix it instead of a bare git error.
 */
export function ownerSourceOrThrow(git: (args: readonly string[]) => string, ref: string): string {
  try {
    return git(["show", `${ref}:${OWNER_SOURCE}`]);
  } catch {
    throw new Error(
      `cannot read ${OWNER_SOURCE} at ${ref}; use full history or set OPENTAG_BENCHMARK_BEFORE_REF to a reachable commit`,
    );
  }
}

/** The pre-change owner class of a generated module, or an actionable error for a wrong module. */
export function preChangeOwnerClass(module: unknown): new (options: unknown) => CancelOwnerPort {
  const candidate = (module as { CloudDeliveryOwner?: unknown } | undefined)?.CloudDeliveryOwner;
  if (typeof candidate !== "function") {
    throw new Error(`the generated pre-change module does not export CloudDeliveryOwner (${typeof candidate})`);
  }
  return candidate as new (
    options: unknown,
  ) => CancelOwnerPort;
}

function beforeRef(env: Record<string, string | undefined>): string {
  return env.OPENTAG_BENCHMARK_BEFORE_REF ?? DEFAULT_BEFORE_REF;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function writeReport(deps: CancelBenchmarkDeps, report: BenchmarkReport, outputPath: string): void {
  deps.file.ensureDirectory(dirname(outputPath));
  deps.file.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function seedFixture(
  deps: CancelBenchmarkDeps,
  admin: BenchmarkAdminPort,
  report: BenchmarkReport,
): Promise<void> {
  const seedTimings: { table: string; elapsedMs: number }[] = [];
  for (const { statement, table } of parseSeedStatements(deps.file.read(deps.paths.seedFile))) {
    const startedAt = deps.clock.elapsedMs();
    await admin.query(statement);
    seedTimings.push({ table: table ?? "fixture functions", elapsedMs: deps.clock.elapsedMs() - startedAt });
  }
  await admin.query("analyze");
  const tables = await admin.query<{ schema: string; name: string }>(TABLES_SQL);
  const rowCounts = [];
  for (const table of tables) {
    const [row] = await admin.query<{ n: number }>(`select count(*)::int as n from "${table.schema}"."${table.name}"`);
    rowCounts.push({ table: `${table.schema}.${table.name}`, rows: row?.n as number });
  }
  assertTableRowCounts(rowCounts);
  report.rowCounts = rowCounts;
  report.seedTimings = seedTimings;
}

async function buildEnvironment(
  deps: CancelBenchmarkDeps,
  admin: BenchmarkAdminPort,
  report: BenchmarkReport,
  startedAt: string,
  resultsLabel: string,
): Promise<Record<string, unknown>> {
  const [postgresInfo] = await admin.query<Record<string, unknown>>(
    "select version() as version, current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem, current_setting('max_connections') as max_connections",
  );
  const [migrations] = await admin.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
  const [size] = await admin.query<{ bytes: string }>("select pg_database_size(current_database())::text as bytes");
  return {
    arch: process.arch,
    beforeRef: beforeRef(deps.env),
    databaseBytes: size?.bytes,
    dockerImage: deps.docker(["inspect", "--format", "{{.Image}}", deps.containerName]),
    dockerResources: JSON.parse(deps.docker(["info", "--format", '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}'])),
    method:
      "One warm-up and five sequential samples per case and owner, both owners measured on the same seeded database so the pair shares data and cache state. Statement counts come from the Drizzle query logger. Plans come from one additional untimed EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) per distinct statement of the last sample. The fixture has no live Runner connection, so every outcome is no_connection, exactly as in the audit. Local Docker microbenchmark with default service query deadlines; not production capacity.",
    migrationCount: migrations?.n,
    node: process.version,
    platform: process.platform,
    postgres: postgresInfo,
    resultsPath: resultsLabel,
    resultsPathOverridden: resultsLabel !== TRACKED_RESULTS_PATH,
    runStartedAt: startedAt,
    seedFixture: SEED_FIXTURE_PATH,
    tableCount: report.rowCounts?.length,
    workingTreeCommit: deps.git(["rev-parse", "HEAD"]).trim(),
  };
}

/** Every distinct statement of the last sample, with its occurrence count and analyzed plan. */
async function describeStatements(
  seam: BenchmarkSeam,
  representative: readonly QueryRecord[],
): Promise<StatementEvidence[]> {
  const unique = [...new Map(representative.map((entry) => [entry.query, entry])).values()];
  const statements: StatementEvidence[] = [];
  for (const statement of unique) {
    const evidence: StatementEvidence = {
      occurrences: representative.filter((entry) => entry.query === statement.query).length,
      parameterCount: statement.params.length,
      sql: statement.query,
    };
    if (isExplainable(statement.query)) {
      evidence.plan = await seam.explain(statement.query, statement.params);
    }
    statements.push(evidence);
  }
  return statements;
}

/**
 * A measurement is only a backlog measurement when the fixture produced one outcome per eligible
 * delivery and every one of them is `no_connection`.
 */
export function assertStopOutcomes(outcomes: readonly CancelOutcome[], expected: number): void {
  if (outcomes.length !== expected) {
    throw new Error(`unexpected outcome count for ${expected} deliveries: received ${outcomes.length}`);
  }
  const unexpected = outcomes.filter((outcome) => outcome.status !== "no_connection");
  if (unexpected.length > 0) {
    throw new Error(
      `the fixture has no live Runner connection, so every stop outcome is no_connection: ` +
        `received ${[...new Set(unexpected.map((outcome) => outcome.status))].join(", ")}`,
    );
  }
}

async function measure(
  deps: CancelBenchmarkDeps,
  seam: BenchmarkSeam,
  owner: CancelOwnerPort,
  expected: number,
): Promise<MeasureEvidence> {
  const samplesMs: number[] = [];
  const statementCounts: number[] = [];
  let outcomes: CancelOutcome[] = [];
  let representative: readonly QueryRecord[] = [];
  for (let sample = -1; sample < SAMPLES; sample += 1) {
    seam.resetJournal();
    const startedAt = deps.clock.elapsedMs();
    outcomes = await owner.cancelSessionDeliveries(deps.sessionId);
    const elapsed = deps.clock.elapsedMs() - startedAt;
    representative = [...seam.journal()];
    if (sample < 0) continue;
    samplesMs.push(elapsed);
    statementCounts.push(representative.length);
  }
  assertStopOutcomes(outcomes, expected);
  return {
    medianMs: summarizeSamples(samplesMs).medianMs,
    outcomeStatuses: [...new Set(outcomes.map((outcome) => outcome.status))],
    samplesMs,
    selectCount: representative.filter((entry) => isExplainable(entry.query)).length,
    statementCounts,
    statements: await describeStatements(seam, representative),
  };
}

async function runCase(
  deps: CancelBenchmarkDeps,
  admin: BenchmarkAdminPort,
  seam: BenchmarkSeam,
  count: number,
): Promise<CaseEvidence> {
  if (count > 0) await admin.query(resetDeliveriesSql(count), [deps.sessionId]);
  // Production autovacuum analyzes mutated rows; keep the plan evidence on current statistics.
  await admin.query(ANALYZE_DELIVERIES_SQL);
  const [eligible] = await admin.query<{ n: number }>(ELIGIBLE_DELIVERIES_SQL, [deps.sessionId]);
  if (eligible?.n !== count) {
    throw new Error(`the fixture must expose exactly ${count} eligible deliveries, found ${eligible?.n ?? "none"}`);
  }
  return {
    after: await measure(deps, seam, seam.after, count),
    before: await measure(deps, seam, seam.before, count),
    eligibleDeliveries: count,
    name: `cloud.cancel.${count}-unreported`,
  };
}

/** Cleanup step that must never replace the failure that is already unwinding. */
async function quietly(deps: CancelBenchmarkDeps, phase: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    deps.log(JSON.stringify({ message: messageOf(error), phase }));
  }
}

function removeContainer(deps: CancelBenchmarkDeps, report: BenchmarkReport): void {
  try {
    deps.docker(["rm", "--force", "--volumes", deps.containerName]);
    report.containerRemoved = true;
  } catch (error) {
    report.containerRemoveError = messageOf(error);
  }
}

/** Remove the generated pre-change module; a crash must never leave an untracked source behind. */
function removeBeforeModule(deps: CancelBenchmarkDeps, report: BenchmarkReport): void {
  try {
    deps.file.remove(deps.paths.beforeModuleFile);
  } catch (error) {
    report.containerRemoveError ??= `before module: ${messageOf(error)}`;
  }
}

export async function runCancelBenchmark(deps: CancelBenchmarkDeps): Promise<void> {
  const target = resolveResultsTarget(deps.env, deps.paths.trackedResultsFile);
  const startedAt = deps.clock.nowIso();
  const report: BenchmarkReport = { cases: [] };
  const save = () => writeReport(deps, report, target.outputPath);
  let containerStarted = false;
  let admin: BenchmarkAdminPort | undefined;
  let seam: BenchmarkSeam | undefined;
  try {
    // Preflight the compared implementation before a container exists, so a bad ref fails fast.
    deps.file.write(deps.paths.beforeModuleFile, ownerSourceOrThrow(deps.git, beforeRef(deps.env)));
    const databaseUrl = deps.startDatabaseContainer();
    containerStarted = true;
    await deps.migrate(databaseUrl);
    const fixture = await deps.openAdmin(databaseUrl);
    admin = fixture;
    await seedFixture(deps, fixture, report);
    report.environment = await buildEnvironment(deps, fixture, report, startedAt, target.label);
    save();
    const measurement = await deps.openSeam(databaseUrl, deps.paths.beforeModuleFile);
    seam = measurement;
    report.timeouts = measurement.timeouts;
    for (const count of CASE_SIZES) {
      const evidence = await runCase(deps, fixture, measurement, count);
      report.cases.push(evidence);
      save();
      deps.log(
        JSON.stringify({
          after: { medianMs: evidence.after.medianMs, statements: evidence.after.statementCounts },
          before: { medianMs: evidence.before.medianMs, statements: evidence.before.statementCounts },
          name: evidence.name,
        }),
      );
    }
    report.runInterval = { finishedAt: deps.clock.nowIso(), startedAt };
  } finally {
    removeBeforeModule(deps, report);
    const seamToClose = seam;
    const adminToClose = admin;
    if (seamToClose) await quietly(deps, "seam", () => seamToClose.close());
    if (adminToClose) await quietly(deps, "admin", () => adminToClose.end());
    if (containerStarted) removeContainer(deps, report);
    await quietly(deps, "save", async () => save());
  }
}
