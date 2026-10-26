import type { TaskSummary } from "@opentag/shared";
import type { TaskService } from "../../src/services/tasks/index.js";

/**
 * The measurement half of the Task query benchmark, kept apart from the process that starts Docker.
 * It lives beside the entry point rather than in `src`: it is benchmark tooling, not product code,
 * and the package's unit measurement is not widened for it.
 *
 * Everything here talks to injected ports: SQL, the service, the clock, the output directory and the
 * result writer. That is what lets the committed benchmark be covered by unit tests without a Docker
 * daemon, and why importing this module has no side effect — the entry point in
 * `packages/server/scripts/benchmark-task-queries.ts` is the only thing that creates a container.
 *
 * A case is one warm-up call, then `samples` timed calls. Elapsed time comes from the injected clock,
 * SQL counts from the injected query sink, and response size from the serialized answer, so a run is
 * described by numbers the harness itself observed rather than by a claim.
 */

export interface Statement {
  query: string;
  params: unknown[];
}

/** The one SQL surface the runner needs: an untagged statement with optional parameters. */
export interface BenchmarkDatabase {
  unsafe(query: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

/** The service's query logger, drained per call so each measurement counts its own SQL. */
export interface BenchmarkSink {
  take(): Statement[];
  reset(): void;
}

export interface BenchmarkOutput {
  /** Directory holding `results-<phase>.json` and `explain/<phase>/`. */
  readonly dir: string;
  mkdir(path: string): void;
  write(path: string, contents: string): void;
}

export interface MeasurementRecord extends Record<string, unknown> {
  name: string;
  samplesMs: number[];
  medianMs: number | undefined;
  maxMs: number | undefined;
  queryCounts: number[];
  responseBytes: number | undefined;
  error: unknown;
  statements: Record<string, unknown>[];
}

export interface BenchmarkReport extends Record<string, unknown> {
  phase: string;
  results: MeasurementRecord[];
}

export interface BenchmarkPorts {
  admin: BenchmarkDatabase;
  /** A raw connection used only for `EXPLAIN`, so a case's own pool is untouched. */
  explainSql: BenchmarkDatabase;
  service: TaskService;
  sink: BenchmarkSink;
  output: BenchmarkOutput;
  report: BenchmarkReport;
  clock(): number;
  log(line: string): void;
  save(): void;
}

export const SEED_SEPARATOR = "--> statement-breakpoint";
/** Every business table must hold at least this many rows before a measurement means anything. */
export const MINIMUM_ROWS = 100_000;
/** A statement with more parameters than the driver accepts cannot be explained after the fact. */
const MAX_EXPLAIN_PARAMETERS = 60_000;

/** The fixture's statements, in file order, with the separators and blank tails dropped. */
export function splitSeed(seedText: string): string[] {
  return seedText
    .split(SEED_SEPARATOR)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The middle sample: for an even count the lower middle, which is always a measured value. */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * A structured error for the evidence file: message, driver code when there is one, and a bounded
 * cause chain. Parameters and credentials are never part of it.
 */
export function errorInfo(error: unknown, depth = 0): unknown {
  if (depth > 3) return "truncated";
  if (!(error instanceof Error)) return String(error).slice(0, 2000);
  return {
    name: error.name,
    message: error.message.slice(0, 2000),
    code: "code" in error ? (error as { code?: unknown }).code : undefined,
    cause: "cause" in error ? errorInfo((error as { cause?: unknown }).cause, depth + 1) : undefined,
  };
}

/**
 * Read every application table and fail when one is below the minimum: a fixture that lost rows
 * makes every timing taken on it meaningless, so the run stops instead of reporting them.
 */
export async function verifyRowCounts(
  admin: BenchmarkDatabase,
  minimumRows = MINIMUM_ROWS,
): Promise<{ table: string; rows: number }[]> {
  const tables = await admin.unsafe(
    `select n.nspname as schema, c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and n.nspname in ('public', 'billing') order by 1, 2`,
  );
  const counts: { table: string; rows: number }[] = [];
  for (const table of tables) {
    const [row] = await admin.unsafe(`select count(*)::int as n from "${table.schema}"."${table.name}"`);
    const rows = Number(row?.n ?? 0);
    if (rows < minimumRows) throw new Error(`${table.schema}.${table.name} holds ${rows}, below ${minimumRows}`);
    counts.push({ table: `${table.schema}.${table.name}`, rows });
  }
  return counts;
}

/** Replay the fixture statement by statement, reporting how long each insert took. */
export async function seedDatabase(
  admin: BenchmarkDatabase,
  statements: readonly string[],
  clock: () => number,
  log: (line: string) => void,
): Promise<{ table: string; elapsedMs: number }[]> {
  const timings: { table: string; elapsedMs: number }[] = [];
  for (const statement of statements) {
    const table = /insert into ([a-z_.]+)/i.exec(statement)?.[1] ?? "fixture functions";
    const startedAt = clock();
    await admin.unsafe(statement);
    const timing = { table, elapsedMs: clock() - startedAt };
    timings.push(timing);
    log(JSON.stringify({ phase: "seed", ...timing }));
  }
  return timings;
}

/**
 * The analyzed plan of one statement, written next to the results. A statement the planner refuses to
 * analyze records the refusal, so a timed-out statement keeps its SQL and its error rather than
 * disappearing from the evidence.
 */
export async function explainStatement(
  ports: Pick<BenchmarkPorts, "explainSql" | "output">,
  name: string,
  statement: Statement,
  index: number,
): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {
    sql: statement.query,
    sqlLength: statement.query.length,
    parameterCount: statement.params.length,
  };
  if (!/^\s*(select|with)\b/i.test(statement.query) || statement.params.length >= MAX_EXPLAIN_PARAMETERS) {
    return summary;
  }
  const file = `${name}-${index + 1}.json`;
  try {
    const plan = await ports.explainSql.unsafe(
      `explain (analyze,buffers,settings,format json) ${statement.query}`,
      statement.params,
    );
    const tree = plan[0]?.["QUERY PLAN"];
    // The output directory is the phase's explain directory, so the file name is the only path
    // fragment this module owns; the evidence root stays the caller's business.
    ports.output.write(
      `${ports.output.dir}/${file}`,
      `${JSON.stringify({ sql: statement.query, plan: tree }, null, 2)}\n`,
    );
    summary.explainFile = file;
    const root = Array.isArray(tree) ? (tree[0] as Record<string, unknown>) : undefined;
    const node = root?.Plan as Record<string, unknown> | undefined;
    summary.executionTimeMs = root?.["Execution Time"];
    summary.topNode = node?.["Node Type"];
    summary.planRows = node?.["Actual Rows"];
  } catch (caught) {
    summary.explainError = errorInfo(caught);
  }
  return summary;
}

/** One plan per distinct statement of the call, each recording how often the call ran it. */
export async function explainQueries(
  ports: Pick<BenchmarkPorts, "explainSql" | "output">,
  name: string,
  statements: readonly Statement[],
): Promise<Record<string, unknown>[]> {
  const unique = [...new Map(statements.map((statement) => [statement.query, statement])).values()];
  const summaries: Record<string, unknown>[] = [];
  for (const [index, statement] of unique.entries()) {
    const summary = await explainStatement(ports, name, statement, index);
    summary.occurrences = statements.filter((candidate) => candidate.query === statement.query).length;
    summaries.push(summary);
  }
  return summaries;
}

/**
 * One warm-up call, then `samples` timed calls whose SQL and elapsed time are recorded per call. A
 * failure ends the case at the failure: samples taken after it would describe a different code path.
 */
export async function measureCase<T>(
  ports: BenchmarkPorts,
  name: string,
  operation: () => Promise<T>,
  samples = 5,
): Promise<T | undefined> {
  const samplesMs: number[] = [];
  const queryCounts: number[] = [];
  let last: T | undefined;
  let error: unknown;
  let representative: Statement[] = [];
  for (let sample = -1; sample < samples; sample += 1) {
    ports.sink.reset();
    const startedAt = ports.clock();
    try {
      last = await operation();
    } catch (caught) {
      error = errorInfo(caught);
    }
    const elapsed = ports.clock() - startedAt;
    representative = ports.sink.take();
    if (sample >= 0 || error) {
      samplesMs.push(elapsed);
      queryCounts.push(representative.length);
    }
    if (error) break;
  }
  const record: MeasurementRecord = {
    name,
    samplesMs,
    medianMs: median(samplesMs),
    maxMs: samplesMs.length > 0 ? Math.max(...samplesMs) : undefined,
    queryCounts,
    responseBytes: last === undefined ? undefined : Buffer.byteLength(JSON.stringify(last)),
    error,
    statements: await explainQueries(ports, name, representative),
  };
  ports.report.results.push(record);
  ports.save();
  ports.log(JSON.stringify({ ...record, statements: undefined }));
  return last;
}

export interface BenchmarkIds {
  /** The account whose single private chat owns most of the fixture's history. */
  hotAccountId: string;
  /** The account whose ten Agents share 25,000 channel messages. */
  tenAgentAccountId: string;
}

function requireTask(page: { tasks: TaskSummary[] } | undefined, detail: string): TaskSummary {
  const task = page?.tasks[0];
  if (!task) throw new Error(`The fixture produced no Task for ${detail}`);
  return task;
}

/**
 * The Task read paths, measured in report order: the list and its next page, the legacy complete
 * detail, the captured replies, and every bounded first page and section continuation. The bounded
 * pages are measured twice — with the Turns alone, which is what the Web reads, and with every
 * section — so the report can state which of the two it is talking about.
 */
export async function runTaskQueriesBenchmark(ports: BenchmarkPorts, ids: BenchmarkIds): Promise<void> {
  const { service } = ports;
  const hotDm = await measureCase(ports, "tasks.list.hot-dm.limit20", () =>
    service.list(ids.hotAccountId, { limit: 20 }),
  );
  if (hotDm?.nextCursor) {
    await measureCase(ports, "tasks.list.hot-dm.page2", () =>
      service.list(ids.hotAccountId, { limit: 20, cursor: hotDm.nextCursor ?? undefined }),
    );
  }
  const channelPage = await measureCase(ports, "tasks.list.10-agents.25000-messages.limit20", () =>
    service.list(ids.tenAgentAccountId, { limit: 20 }),
  );
  if (channelPage?.nextCursor) {
    await measureCase(ports, "tasks.list.10-agents.page2", () =>
      service.list(ids.tenAgentAccountId, { limit: 20, cursor: channelPage.nextCursor ?? undefined }),
    );
  }
  const hotTask = requireTask(hotDm, "the hot private chat");
  await measureCase(
    ports,
    "tasks.detail.legacy.hot-dm.limit20",
    () => service.get(ids.hotAccountId, hotTask.id, { limit: 20 }),
    1,
  );
  await measureCase(ports, "tasks.replies.hot-dm.limit20", () =>
    service.listReplies(ids.hotAccountId, hotTask.id, { limit: 20 }),
  );

  await measureCase(ports, "tasks.detail.hot-dm.turns-only.limit20", () =>
    service.detail(ids.hotAccountId, hotTask.id, { limit: 20, sections: ["turns"] }),
  );
  const fullPage = await measureCase(ports, "tasks.detail.hot-dm.all-sections.limit20", () =>
    service.detail(ids.hotAccountId, hotTask.id, { limit: 20 }),
  );
  const turnCursor = fullPage?.turns?.nextCursor;
  if (turnCursor) {
    await measureCase(ports, "tasks.detail.hot-dm.turns.page2", () =>
      service.listTurns(ids.hotAccountId, hotTask.id, { limit: 20, cursor: turnCursor }),
    );
  }
  const internalCursor = fullPage?.internalSessions?.nextCursor;
  if (internalCursor) {
    await measureCase(ports, "tasks.detail.hot-dm.internal-sessions.page2", () =>
      service.listInternalSessions(ids.hotAccountId, hotTask.id, { limit: 20, cursor: internalCursor }),
    );
  }
  const collaborationCursor = fullPage?.collaborationMessages?.nextCursor;
  if (collaborationCursor) {
    await measureCase(ports, "tasks.detail.hot-dm.collaboration-messages.page2", () =>
      service.listCollaborationMessages(ids.hotAccountId, hotTask.id, { limit: 20, cursor: collaborationCursor }),
    );
  }

  const channelTask = requireTask(channelPage, "the ten-Agent account");
  await measureCase(ports, "tasks.detail.legacy.10-agents.limit20", () =>
    service.get(ids.tenAgentAccountId, channelTask.id, { limit: 20 }),
  );
  await measureCase(ports, "tasks.detail.10-agents.turns-only.limit20", () =>
    service.detail(ids.tenAgentAccountId, channelTask.id, { limit: 20, sections: ["turns"] }),
  );
  await measureCase(ports, "tasks.detail.10-agents.all-sections.limit20", () =>
    service.detail(ids.tenAgentAccountId, channelTask.id, { limit: 20 }),
  );
}
