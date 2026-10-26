/**
 * Cancellation-read benchmark: orchestration coverage without Docker, a database, or a network.
 *
 * The benchmark is the evidence behind the cancellation read change, so these tests pin the parts that
 * make its output trustworthy: the fixture contract (every table at the audit row count, one stop
 * outcome per eligible delivery, all `no_connection`), the before/after measurement accounting, and the
 * cleanup that must survive setup failures. The database itself is a model of the fixture's contract -
 * it answers the harness's statements the way the real seed does - because a unit test must not start
 * a container.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertStopOutcomes,
  assertTableRowCounts,
  type BenchmarkAdminPort,
  type BenchmarkReport,
  type BenchmarkSeam,
  CASE_SIZES,
  type CancelBenchmarkDeps,
  type CancelOwnerPort,
  isExplainable,
  MINIMUM_TABLE_ROWS,
  ownerSourceOrThrow,
  parseSeedStatements,
  planSql,
  preChangeOwnerClass,
  type QueryRecord,
  resetDeliveriesSql,
  resolveResultsTarget,
  runCancelBenchmark,
  SAMPLES,
  SEED_FIXTURE_PATH,
  summarizeSamples,
  TRACKED_RESULTS_PATH,
} from "../cancel-benchmark.js";
import {
  defaultCancelBenchmarkDeps,
  explainPlan,
  openAdmin,
  openSeam,
  ownerOptions,
  startDatabaseContainer,
  waitForDatabase,
} from "../cancel-benchmark-runtime.js";

const CONTAINER = "opentag-cancel-benchmark-w49-test";
const SESSION = "00000007-0000-4000-8000-000000000001";
const SANDBOX_SQL = 'select "id", "session_id" from "sandboxes" where "session_id" = $1 limit 1';
const DELIVERIES_SQL = 'select "id" from "im_message_deliveries" where "session_id" = $1 and "state" = $2';

type FixtureOptions = {
  /** Rows reported for every business table; below the minimum models a broken seed. */
  tableRows?: number;
  /** Tables the fixture reports; two are enough to prove the per-table verification loop. */
  tables?: { schema: string; name: string }[];
};

/**
 * A model of the seeded database's contract: it keeps one accepted-unreported delivery per UUID, and
 * the case reset flips exactly the requested number of them.
 */
function fixtureDatabase(options: FixtureOptions = {}) {
  const tables = options.tables ?? [
    { name: "im_message_deliveries", schema: "public" },
    { name: "sandboxes", schema: "public" },
  ];
  const statements: string[] = [];
  const mutations: { sql: string; params?: readonly unknown[] }[] = [];
  let unreported = 0;
  /** The fixture's answers, in the order the harness asks them. */
  const answers: { matches: (sql: string) => boolean; rows: (sql: string) => unknown[] }[] = [
    { matches: (sql) => sql.startsWith("insert into "), rows: () => [] },
    { matches: (sql) => sql.startsWith("analyze"), rows: () => [] },
    { matches: (sql) => sql.startsWith("select n.nspname as schema"), rows: () => tables },
    {
      matches: (sql) => /^select count\(\*\)::int as n from "[a-z_]+"\."[a-z_]+"$/.test(sql),
      rows: () => [{ n: options.tableRows ?? MINIMUM_TABLE_ROWS }],
    },
    {
      matches: (sql) => sql.startsWith("update im_message_deliveries set reported_at"),
      rows: (sql) => {
        unreported = Number(/limit (\d+)/.exec(sql)?.[1]);
        return [];
      },
    },
    {
      matches: (sql) => sql.startsWith("select count(*)::int as n from im_message_deliveries"),
      rows: () => [{ n: unreported }],
    },
    { matches: (sql) => sql.startsWith("select version() as version"), rows: () => [{ version: "PostgreSQL 17" }] },
    {
      matches: (sql) => sql.startsWith("select count(*)::int as n from drizzle.__drizzle_migrations"),
      rows: () => [{ n: 69 }],
    },
    { matches: (sql) => sql.startsWith("select pg_database_size"), rows: () => [{ bytes: "1262592527" }] },
  ];
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    // Seed statements keep the whitespace around their `--> statement-breakpoint` split.
    const statement = sql.trim();
    statements.push(statement);
    const answer = answers.find((entry) => entry.matches(statement));
    if (!answer) throw new Error(`unexpected fixture statement: ${statement}`);
    if (statement.startsWith("update im_message_deliveries")) mutations.push({ params, sql: statement });
    return answer.rows(statement);
  });
  return {
    /** The deliveries the fixture currently exposes as accepted and unreported. */
    eligible: () => unreported,
    mutations,
    port: { end: vi.fn(async () => undefined), query } as unknown as BenchmarkAdminPort & {
      query: typeof query;
    },
    statements,
  };
}

/**
 * A model of one owner's statement usage: the pre-change implementation re-reads the shared Sandbox
 * row for every delivery, the current one reads it once for the whole backlog.
 */
function owner(journal: { current: QueryRecord[] }, eligible: () => number, sandboxReads: (count: number) => number) {
  return {
    async cancelSessionDeliveries() {
      const count = eligible();
      journal.current.push({ params: [SESSION, "accepted"], query: DELIVERIES_SQL });
      for (let index = 0; index < sandboxReads(count); index += 1) {
        journal.current.push({ params: [SESSION], query: SANDBOX_SQL });
      }
      return Array.from({ length: count }, (_, index) => ({
        deliveryId: `delivery-${index}`,
        status: "no_connection",
      }));
    },
  } satisfies CancelOwnerPort;
}

function fixtureSeam(eligible: () => number, plans: { params: readonly unknown[]; sql: string }[] = []) {
  const journal = { current: [] as QueryRecord[] };
  // The pre-change loop re-reads the Sandbox per delivery; the current one reads it once for a
  // nonempty backlog and not at all for an empty one.
  const before = owner(journal, eligible, (count) => count);
  const after = owner(journal, eligible, (count) => (count === 0 ? 0 : 1));
  const seam: BenchmarkSeam = {
    after,
    before,
    close: vi.fn(async () => undefined),
    explain: vi.fn(async (sql: string, params: readonly unknown[]) => {
      plans.push({ params, sql });
      return [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "im_message_deliveries" } }];
    }),
    journal: () => journal.current,
    resetJournal: () => {
      journal.current = [];
    },
    timeouts: { statement: 30_000 },
  };
  return { after, before, plans, seam };
}

type Recorded = { file: string; value: string }[];

function benchmarkDeps(overrides: Partial<CancelBenchmarkDeps> & { fixture?: FixtureOptions } = {}): {
  deps: CancelBenchmarkDeps;
  dockerCalls: (readonly string[])[];
  eligible: () => number;
  reports: Recorded;
  files: Map<string, string>;
  logs: string[];
  removed: string[];
  seams: ReturnType<typeof fixtureSeam>[];
} {
  const fixture = fixtureDatabase(overrides.fixture);
  const dockerCalls: (readonly string[])[] = [];
  const reports: Recorded = [];
  const files = new Map<string, string>();
  const logs: string[] = [];
  const removed: string[] = [];
  const seams: ReturnType<typeof fixtureSeam>[] = [];
  let elapsed = 0;
  const deps: CancelBenchmarkDeps = {
    clock: {
      elapsedMs: () => {
        elapsed += 1;
        return elapsed;
      },
      nowIso: () => "2026-10-26T10:58:35.120Z",
    },
    containerName: CONTAINER,
    docker: (args) => {
      dockerCalls.push(args);
      if (args[0] === "inspect") return "sha256:unit-image";
      if (args[0] === "info") return '{"cpus":18,"memoryBytes":16816521216}';
      return "";
    },
    env: {},
    file: {
      ensureDirectory: vi.fn(),
      read: (path) => files.get(path) ?? "",
      remove: (path) => {
        removed.push(path);
        files.delete(path);
      },
      write: (path, value) => {
        files.set(path, value);
        if (path.endsWith(".json")) reports.push({ file: path, value });
      },
    },
    git: () => "0eeaf917761a1ae33e99857bc0f0734c7bd83d95\n",
    log: (line) => logs.push(line),
    migrate: async () => undefined,
    openAdmin: async () => fixture.port,
    openSeam: async () => {
      const seam = fixtureSeam(fixture.eligible);
      seams.push(seam);
      return seam.seam;
    },
    paths: {
      beforeModuleFile: "/tmp/.benchmark-before-1.ts",
      migrationsFolder: "/tmp/drizzle",
      seedFile: "/tmp/seed.sql",
      trackedResultsFile: "/repo/testing/performance/cancel-deliveries/results.json",
    },
    sessionId: SESSION,
    startDatabaseContainer: () => "postgres://postgres:local@127.0.0.1:5432/opentag_benchmark",
    ...overrides,
  };
  files.set(
    deps.paths.seedFile,
    "insert into users(id) select 1;--> statement-breakpoint\ninsert into sandboxes(id) select 1;",
  );
  return { deps, dockerCalls, eligible: fixture.eligible, files, logs, removed, reports, seams };
}

function parsedReports(reports: Recorded): BenchmarkReport[] {
  return reports.map((entry) => JSON.parse(entry.value) as BenchmarkReport);
}

/** Run a throwing call and return what it threw, so the test can assert on the error itself. */
function catcher(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function catcherAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("cancellation benchmark orchestration", () => {
  it("measures every case with both owners and records the statement counts and plans", async () => {
    const { deps, logs, removed, reports, seams } = benchmarkDeps();
    await runCancelBenchmark(deps);

    const final = parsedReports(reports).at(-1) as BenchmarkReport;
    expect(final.cases.map((entry) => entry.name)).toEqual(
      CASE_SIZES.map((count) => `cloud.cancel.${count}-unreported`),
    );
    // The pre-change owner re-reads the Sandbox once per delivery; the current one reads it once.
    expect(final.cases.map((entry) => entry.before.statementCounts[0])).toEqual([1, 2, 11, 101]);
    expect(final.cases.map((entry) => entry.after.statementCounts[0])).toEqual([1, 2, 2, 2]);
    expect(final.cases.every((entry) => entry.before.statementCounts.length === SAMPLES)).toBe(true);
    // The empty backlog produces no outcome at all; every nonempty case must stay no_connection.
    expect(final.cases.map((entry) => entry.after.outcomeStatuses)).toEqual([
      [],
      ["no_connection"],
      ["no_connection"],
      ["no_connection"],
    ]);
    expect(final.cases.map((entry) => entry.eligibleDeliveries)).toEqual([...CASE_SIZES]);

    // Only the deliveries SELECT can be planned; the plan of the Sandbox read is captured once because
    // the distinct statement appears once in the last sample of the after case.
    const last = final.cases.at(-1) as BenchmarkReport["cases"][number];
    expect(last.after.selectCount).toBe(2);
    expect(last.after.statements.map((entry) => entry.occurrences)).toEqual([1, 1]);
    expect(last.after.statements.every((entry) => entry.plan !== undefined)).toBe(true);
    // Only the two service statements are ever planned, and both plans were captured.
    expect(new Set(seams[0]?.plans.map((entry) => entry.sql))).toEqual(new Set([DELIVERIES_SQL, SANDBOX_SQL]));

    // One log line per case, and the generated module never survives the run.
    expect(logs.filter((line) => line.includes("cloud.cancel."))).toHaveLength(CASE_SIZES.length);
    expect(removed).toContain(deps.paths.beforeModuleFile);
    expect(final.runInterval).toEqual({
      finishedAt: "2026-10-26T10:58:35.120Z",
      startedAt: "2026-10-26T10:58:35.120Z",
    });
    expect(final.containerRemoved).toBe(true);
  });

  it("seeds and verifies every business table before it measures anything", async () => {
    const { deps, reports, seams } = benchmarkDeps();
    await runCancelBenchmark(deps);

    const final = parsedReports(reports).at(-1) as BenchmarkReport;
    expect(final.rowCounts).toEqual([
      { rows: MINIMUM_TABLE_ROWS, table: "public.im_message_deliveries" },
      { rows: MINIMUM_TABLE_ROWS, table: "public.sandboxes" },
    ]);
    expect(final.seedTimings?.map((entry) => entry.table)).toEqual(["users", "sandboxes"]);
    expect(final.environment).toMatchObject({
      beforeRef: "d2fc9e8aa045dc1a214ab3f0a953cbdcde088c92",
      migrationCount: 69,
      resultsPath: TRACKED_RESULTS_PATH,
      resultsPathOverridden: false,
      seedFixture: SEED_FIXTURE_PATH,
      tableCount: 2,
      workingTreeCommit: "0eeaf917761a1ae33e99857bc0f0734c7bd83d95",
    });
    // The owners are only opened after the fixture verification succeeded.
    expect(seams).toHaveLength(1);
  });

  it("fails on an under-seeded table instead of publishing a comparison", async () => {
    const { deps, dockerCalls, removed, reports, seams } = benchmarkDeps({ fixture: { tableRows: 99_999 } });
    await expect(runCancelBenchmark(deps)).rejects.toThrow(/public\.im_message_deliveries is below 100000/);

    expect(seams).toHaveLength(0);
    const failed = parsedReports(reports).at(-1) as BenchmarkReport;
    expect(failed.cases).toEqual([]);
    expect(failed.environment).toBeUndefined();
    expect(removed).toContain(deps.paths.beforeModuleFile);
    expect(dockerCalls).toContainEqual(["rm", "--force", "--volumes", CONTAINER]);
  });

  it("fails when the fixture no longer models a backlog of unreachable deliveries", async () => {
    const { deps, eligible } = benchmarkDeps();
    const seam = fixtureSeam(eligible).seam;
    // A live Runner answers `cancelled` for the deliveries it owns, which means the case no longer
    // models a cancellation backlog and its comparison must not be published.
    seam.after = {
      async cancelSessionDeliveries() {
        return Array.from({ length: eligible() }, (_, index) => ({
          deliveryId: `delivery-${index}`,
          status: "cancelled",
        }));
      },
    };
    deps.openSeam = async () => seam;
    await expect(runCancelBenchmark(deps)).rejects.toThrow(/every stop outcome is no_connection: received cancelled/);
  });

  it("keeps the pre-change module and container cleanup on the failure path", async () => {
    const { deps, dockerCalls, reports, removed } = benchmarkDeps({
      openAdmin: async () => {
        throw new Error("container did not accept connections");
      },
    });
    await expect(runCancelBenchmark(deps)).rejects.toThrow(/did not accept connections/);
    // A container this run started is removed even when the connection never succeeded.
    expect(dockerCalls).toContainEqual(["rm", "--force", "--volumes", CONTAINER]);
    expect(removed).toContain(deps.paths.beforeModuleFile);
    // The report of a failed setup is still written, so the failure is diagnosable.
    const final = parsedReports(reports).at(-1) as BenchmarkReport;
    expect(final.containerRemoved).toBe(true);
    expect(final.cases).toEqual([]);
  });

  it("never removes a container it did not start and still cleans the generated module", async () => {
    const { deps, dockerCalls, removed } = benchmarkDeps({
      startDatabaseContainer: () => {
        throw new Error("docker is not available");
      },
    });
    await expect(runCancelBenchmark(deps)).rejects.toThrow(/docker is not available/);
    expect(dockerCalls.filter((args) => args[0] === "rm")).toEqual([]);
    expect(removed).toContain(deps.paths.beforeModuleFile);
  });

  it("fails fast on an unreachable pre-change ref without starting a container", async () => {
    const { deps, dockerCalls, removed } = benchmarkDeps({
      git: () => {
        throw new Error("fatal: bad object");
      },
    });
    await expect(runCancelBenchmark(deps)).rejects.toThrow(
      /use full history or set OPENTAG_BENCHMARK_BEFORE_REF to a reachable commit/,
    );
    expect(deps.startDatabaseContainer).toBeDefined();
    expect(dockerCalls).toEqual([]);
    expect(removed).toContain(deps.paths.beforeModuleFile);
  });

  it("records an override run as overridden and writes only to the override path", async () => {
    const { deps, reports } = benchmarkDeps();
    deps.env = { OPENTAG_BENCHMARK_OUTPUT: "/tmp/cancel-benchmark/results.json" };
    await runCancelBenchmark(deps);

    const final = parsedReports(reports).at(-1) as BenchmarkReport;
    expect(final.environment).toMatchObject({
      resultsPath: "<overridden>",
      resultsPathOverridden: true,
    });
    expect(reports.every((entry) => entry.file === "/tmp/cancel-benchmark/results.json")).toBe(true);
    // Committed evidence must never carry the machine path of the run.
    expect(JSON.stringify(final)).not.toContain("/tmp/cancel-benchmark");
  });
});

describe("cancellation benchmark fixture rules", () => {
  it("splits the tracked seed fixture and names the table of each insert", () => {
    const statements = parseSeedStatements(
      "create schema if not exists benchmark;--> statement-breakpoint\ninsert into public.users(id) select 1;--> statement-breakpoint\nanalyze users;",
    );
    expect(statements.map((entry) => entry.table)).toEqual([undefined, "public.users", undefined]);
    expect(statements).toHaveLength(3);
  });

  it("requires the audit row count in every table and names the failing one", () => {
    expect(() =>
      assertTableRowCounts([
        { rows: MINIMUM_TABLE_ROWS, table: "public.users" },
        { rows: 100_001, table: "public.sessions" },
      ]),
    ).not.toThrow();
    expect(() => assertTableRowCounts([{ rows: MINIMUM_TABLE_ROWS - 1, table: "public.users" }])).toThrow(
      /public\.users is below 100000 rows \(found 99999\)/,
    );
    expect(() => assertTableRowCounts([{ rows: Number.NaN, table: "public.users" }])).toThrow(/found none/);
  });

  it("takes the middle sample and keeps the recorded samples in order", () => {
    expect(summarizeSamples([9, 3, 5, 1, 7])).toEqual({ medianMs: 5, samplesMs: [9, 3, 5, 1, 7] });
    expect(summarizeSamples([4, 1, 3, 2]).medianMs).toBe(3);
    expect(summarizeSamples([]).medianMs).toBeNaN();
  });

  it("plans statements only, with the analyzed JSON wrapper of the evidence", () => {
    expect(isExplainable('select "id" from "sandboxes"')).toBe(true);
    expect(isExplainable("  with closure as (select 1) select * from closure")).toBe(true);
    expect(isExplainable("analyze im_message_deliveries")).toBe(false);
    expect(isExplainable("insert into im_message_deliveries(id) values (1)")).toBe(false);
    expect(planSql(DELIVERIES_SQL)).toBe(`explain (analyze, buffers, settings, format json) ${DELIVERIES_SQL}`);
  });

  it("resets exactly the requested deliveries of the measured Session", () => {
    expect(resetDeliveriesSql(100)).toContain("where session_id = $1 order by id limit 100");
    expect(resetDeliveriesSql(1)).toContain("limit 1");
  });

  it("refuses a non-no_connection outcome and a missing one", () => {
    expect(() => assertStopOutcomes([{ deliveryId: "a", status: "no_connection" }], 1)).not.toThrow();
    expect(() => assertStopOutcomes([], 1)).toThrow(/unexpected outcome count for 1 deliveries: received 0/);
    expect(() =>
      assertStopOutcomes(
        [
          { deliveryId: "a", status: "cancelled" },
          { deliveryId: "b", status: "send_failed" },
        ],
        2,
      ),
    ).toThrow(/every stop outcome is no_connection: received cancelled, send_failed/);
  });

  it("keeps the tracked results path as the recorded label unless the run overrides it", () => {
    expect(resolveResultsTarget({}, "/repo/testing/performance/cancel-deliveries/results.json")).toEqual({
      label: TRACKED_RESULTS_PATH,
      outputPath: "/repo/testing/performance/cancel-deliveries/results.json",
    });
    const overridden = resolveResultsTarget(
      { OPENTAG_BENCHMARK_OUTPUT: "/tmp/cancel-benchmark/results.json" },
      "/repo/testing/performance/cancel-deliveries/results.json",
    );
    expect(overridden.label).toBe("<overridden>");
    expect(overridden.outputPath).toBe("/tmp/cancel-benchmark/results.json");
  });

  it("reports a missing pre-change ref with the two ways to fix it", () => {
    expect(() =>
      ownerSourceOrThrow(() => {
        throw new Error("fatal: invalid object name 'abc123'");
      }, "abc123"),
    ).toThrow(
      /cannot read packages\/server\/src\/services\/sandboxes\/cloud-delivery-owner\.ts at abc123; use full history or set OPENTAG_BENCHMARK_BEFORE_REF/,
    );
    expect(ownerSourceOrThrow(() => "source", "abc123")).toBe("source");
  });

  it("rejects a generated pre-change module without the owner export", () => {
    const Owner = class {
      async cancelSessionDeliveries() {
        return [];
      }
    };
    expect(preChangeOwnerClass({ CloudDeliveryOwner: Owner })).toBe(Owner);
    expect(() => preChangeOwnerClass({})).toThrow(/does not export CloudDeliveryOwner/);
    expect(() => preChangeOwnerClass({ CloudDeliveryOwner: "not-a-class" })).toThrow(/\(string\)/);
    expect(() => preChangeOwnerClass(undefined)).toThrow(/\(undefined\)/);
  });
});

describe("cancellation benchmark production ports", () => {
  it("starts an owned loopback-only container and rejects an unexpected one", () => {
    const calls: (readonly string[])[] = [];
    const docker = (args: readonly string[]) => {
      calls.push(args);
      if (args[0] === "inspect") return "cancel-deliveries";
      if (args[0] === "port") return "127.0.0.1:54321";
      return "";
    };
    const url = startDatabaseContainer(docker, CONTAINER);
    expect(url).toBe("postgres://postgres:benchmark-local-only@127.0.0.1:54321/opentag_benchmark");
    expect(calls[0]).toContain(CONTAINER);
    expect(calls[0]).toContain("opentag.benchmark=cancel-deliveries");
    expect(calls[0]).toContain("--publish");

    expect(() =>
      startDatabaseContainer((args) => (args[0] === "inspect" ? "other-benchmark" : "127.0.0.1:1"), CONTAINER),
    ).toThrow(/unexpected container label: other-benchmark/);
    expect(() =>
      startDatabaseContainer((args) => (args[0] === "inspect" ? "cancel-deliveries" : "0.0.0.0:5432"), CONTAINER),
    ).toThrow(/unexpected container port binding: 0\.0\.0\.0:5432/);
  });

  it("removes the container it started when inspect or port validation fails", () => {
    const calls: (readonly string[])[] = [];
    const docker =
      (afterRun: (args: readonly string[]) => string) =>
      (args: readonly string[]): string => {
        calls.push(args);
        if (args[0] === "run") return "";
        if (args[0] === "rm") return "";
        return afterRun(args);
      };

    // A failing inspect command: the container exists, so it is removed before the error propagates.
    calls.length = 0;
    expect(() =>
      startDatabaseContainer(
        docker((args) => {
          if (args[0] === "inspect") throw new Error("Error response from daemon: no such object");
          return "127.0.0.1:54321";
        }),
        CONTAINER,
      ),
    ).toThrow(/no such object/);
    expect(calls.map((args) => args[0])).toEqual(["run", "inspect", "rm"]);
    expect(calls.at(-1)).toEqual(["rm", "--force", "--volumes", CONTAINER]);

    // An unexpected label: same removal, and the label is still the reported cause.
    calls.length = 0;
    expect(() =>
      startDatabaseContainer(
        docker((args) => (args[0] === "inspect" ? "another-benchmark" : "127.0.0.1:54321")),
        CONTAINER,
      ),
    ).toThrow(/unexpected container label: another-benchmark/);
    expect(calls.map((args) => args[0])).toEqual(["run", "inspect", "rm"]);

    // A failing port command and a non-loopback binding both remove the container too.
    for (const port of [
      () => {
        throw new Error("Error: No public port '5432/tcp' published");
      },
      () => "0.0.0.0:5432",
      () => "127.0.0.1:not-a-port",
    ]) {
      calls.length = 0;
      expect(() =>
        startDatabaseContainer(
          docker((args) => (args[0] === "inspect" ? "cancel-deliveries" : port())),
          CONTAINER,
        ),
      ).toThrow(/No public port|unexpected container port binding/);
      expect(calls.map((args) => args[0])).toEqual(["run", "inspect", "port", "rm"]);
    }
  });

  it("never removes a container when docker run itself fails", () => {
    const calls: (readonly string[])[] = [];
    expect(() =>
      startDatabaseContainer((args) => {
        calls.push(args);
        throw new Error("docker: Cannot connect to the Docker daemon");
      }, CONTAINER),
    ).toThrow(/Cannot connect to the Docker daemon/);
    // A failed `docker run` may not have created the container, so no removal is attempted for that name.
    expect(calls.map((args) => args[0])).toEqual(["run"]);
  });

  it("surfaces the acquisition error and a failing cleanup removal together", () => {
    const calls: (readonly string[])[] = [];
    const failure = catcher(() =>
      startDatabaseContainer((args) => {
        calls.push(args);
        if (args[0] === "inspect") throw new Error("inspect failed");
        if (args[0] === "rm") throw new Error("cannot remove a running container");
        return "";
      }, CONTAINER),
    );
    expect(calls.map((args) => args[0])).toEqual(["run", "inspect", "rm"]);
    // Both causes survive: the acquisition failure stays first, the cleanup failure is not swallowed.
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe("benchmark container acquisition failed and its removal also failed");
    expect((aggregate.errors[0] as Error).message).toBe("inspect failed");
    expect((aggregate.errors[1] as Error).message).toBe("cannot remove a running container");
  });

  it("throws the bare acquisition error when the cleanup removal succeeds", () => {
    const calls: (readonly string[])[] = [];
    const failure = catcher(() =>
      startDatabaseContainer((args) => {
        calls.push(args);
        if (args[0] === "inspect") throw new Error("inspect failed");
        return "";
      }, CONTAINER),
    );
    expect(calls.map((args) => args[0])).toEqual(["run", "inspect", "rm"]);
    // A successful cleanup must not wrap a single real cause in an AggregateError.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toBe("inspect failed");
  });

  it("closes the administrative driver when readiness polling exhausts", async () => {
    const probes: string[] = [];
    const end = vi.fn(async () => undefined);
    await expect(
      openAdmin(
        "postgres://unit",
        () => ({
          end,
          probe: async () => {
            probes.push("probe");
            throw new Error("the database system is starting up");
          },
          query: async () => [],
        }),
        async () => undefined,
      ),
    ).rejects.toThrow(/the database system is starting up/);
    // Attempt bound 30 means 31 probes, and the created driver is closed exactly once.
    expect(probes).toHaveLength(31);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("surfaces the readiness error and a failing driver close together", async () => {
    const failure = await catcherAsync(() =>
      openAdmin(
        "postgres://unit",
        () => ({
          end: async () => {
            throw new Error("socket already closed");
          },
          probe: async () => {
            throw new Error("connection refused");
          },
          query: async () => [],
        }),
        async () => undefined,
      ),
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe("administrative driver readiness failed and closing it also failed");
    expect((aggregate.errors[0] as Error).message).toBe("connection refused");
    expect((aggregate.errors[1] as Error).message).toBe("socket already closed");
  });

  it("leaves a ready driver open and does not close it on the success path", async () => {
    const end = vi.fn(async () => undefined);
    const admin = await openAdmin(
      "postgres://unit",
      () => ({ end, probe: async () => [], query: async () => [] }),
      async () => undefined,
    );
    expect(end).not.toHaveBeenCalled();
    await admin.end();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("waits for a container that answers late and gives up after the attempt bound", async () => {
    let attempts = 0;
    await waitForDatabase(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("not ready");
      },
      async () => undefined,
    );
    expect(attempts).toBe(3);

    let bounded = 0;
    await expect(
      waitForDatabase(
        async () => {
          bounded += 1;
          throw new Error("never ready");
        },
        async () => undefined,
        2,
      ),
    ).rejects.toThrow(/never ready/);
    expect(bounded).toBe(3);
  });

  it("builds the owner options without a fence entry or a custody store", () => {
    const database = { marker: "drizzle" };
    expect(ownerOptions(database)).toMatchObject({
      custody: {},
      database,
      fence: { connectionForSandbox: expect.any(Function) },
      hub: {},
    });
    const options = ownerOptions(database) as unknown as { fence: { connectionForSandbox: () => undefined } };
    expect(options.fence.connectionForSandbox()).toBeUndefined();
  });

  it("wraps the plan statement and returns the QUERY PLAN node", async () => {
    const calls: { params: readonly unknown[]; sql: string }[] = [];
    const plan = await explainPlan(
      async (sql, params) => {
        calls.push({ params, sql });
        return [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan" } }] }];
      },
      SANDBOX_SQL,
      [SESSION],
    );
    expect(calls).toEqual([{ params: [SESSION], sql: planSql(SANDBOX_SQL) }]);
    expect(plan).toEqual([{ Plan: { "Node Type": "Seq Scan" } }]);
    expect(await explainPlan(async () => [], SANDBOX_SQL, [])).toBeUndefined();
  });

  it("opens the administrative port through an injected driver and waits for it", async () => {
    const probes: string[] = [];
    const queries: { params: readonly unknown[]; sql: string }[] = [];
    const end = vi.fn(async () => undefined);
    const admin = await openAdmin(
      "postgres://unit",
      (url) => {
        probes.push(url);
        return {
          end,
          probe: async () => {
            probes.push("probe");
            return [];
          },
          query: async (sql, params) => {
            queries.push({ params, sql });
            return [{ n: 7 }];
          },
        };
      },
      async () => undefined,
    );
    expect(probes).toEqual(["postgres://unit", "probe"]);
    expect(await admin.query<{ n: number }>("select $1::int as n", [7])).toEqual([{ n: 7 }]);
    expect(await admin.query("select 1")).toEqual([{ n: 7 }]);
    expect(queries).toEqual([
      { params: [7], sql: "select $1::int as n" },
      { params: [], sql: "select 1" },
    ]);
    await admin.end();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("opens the measurement seam over an injected client, journal and pre-change module", async () => {
    const journalSink: { logQuery?: (query: string, params: unknown[]) => void } = {};
    const unsafe = vi.fn(async (sql: string) => [{ "QUERY PLAN": [{ Plan: { "Node Type": sql.slice(0, 8) } }] }]);
    const end = vi.fn(async () => undefined);
    const loaded: string[] = [];
    const seam = await openSeam("postgres://unit", "/tmp/.benchmark-before-1.ts", {
      createClient: () => ({ sql: { end, unsafe }, timeouts: { statement: 30_000 } }),
      createDatabase: (_sql, logger) => {
        journalSink.logQuery = logger.logQuery;
        return { marker: "database" };
      },
      loadModule: async (file) => {
        loaded.push(file);
        return {
          CloudDeliveryOwner: class {
            async cancelSessionDeliveries() {
              return [];
            }
          },
        };
      },
    });

    expect(loaded).toEqual(["/tmp/.benchmark-before-1.ts"]);
    expect(seam.timeouts).toEqual({ statement: 30_000 });
    // The journal is the drizzle logger, and resetting it starts a fresh sample.
    journalSink.logQuery?.(SANDBOX_SQL, [SESSION]);
    expect(seam.journal()).toEqual([{ params: [SESSION], query: SANDBOX_SQL }]);
    seam.resetJournal();
    expect(seam.journal()).toEqual([]);
    // Both owners are constructed; only the current one is the working-tree implementation.
    expect(seam.after.constructor.name).toBe("CloudDeliveryOwner");
    expect(seam.before).not.toBe(seam.after);
    expect(await seam.before.cancelSessionDeliveries(SESSION)).toEqual([]);
    expect(await seam.explain(SANDBOX_SQL, [SESSION])).toEqual([{ Plan: { "Node Type": "explain " } }]);
    expect(unsafe).toHaveBeenCalledWith(planSql(SANDBOX_SQL), [SESSION]);
    await seam.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("refuses a generated module that does not export the pre-change owner", async () => {
    await expect(
      openSeam("postgres://unit", "/tmp/.benchmark-before-1.ts", {
        createClient: () => ({ sql: { end: async () => undefined, unsafe: async () => [] }, timeouts: {} }),
        createDatabase: () => ({}),
        loadModule: async () => ({}),
      }),
    ).rejects.toThrow(/does not export CloudDeliveryOwner/);
  });

  it("keeps the production file, clock and log ports usable on a local path", () => {
    const deps = defaultCancelBenchmarkDeps({});
    const directory = mkdtempSync(join(tmpdir(), "opentag-cancel-benchmark-"));
    const file = join(directory, "results.json");
    try {
      deps.file.ensureDirectory(directory);
      deps.file.write(file, "{}\n");
      expect(deps.file.read(file)).toBe("{}\n");
      deps.file.remove(file);
      expect(existsSync(file)).toBe(false);
      // Removing an already absent file is a no-op: the cleanup path never fails on a fresh run.
      deps.file.remove(file);
      expect(deps.clock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(deps.clock.elapsedMs()).toBeGreaterThanOrEqual(0);
      expect(deps.clock.elapsedMs()).toBeGreaterThan(0);
      const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
      deps.log("benchmark line");
      expect(logged).toHaveBeenCalledWith("benchmark line");
      logged.mockRestore();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("wires the production ports to the tracked fixture and evidence without running anything", () => {
    const deps = defaultCancelBenchmarkDeps({ OPENTAG_BENCHMARK_BEFORE_REF: "abc123" });
    expect(deps.env.OPENTAG_BENCHMARK_BEFORE_REF).toBe("abc123");
    expect(deps.sessionId).toBe(SESSION);
    expect(deps.containerName).toMatch(/^opentag-cancel-benchmark-w49-\d+$/);
    // A fresh checkout must resolve the tracked fixture and the tracked evidence file.
    expect(deps.paths.seedFile.endsWith(SEED_FIXTURE_PATH)).toBe(true);
    expect(existsSync(deps.paths.seedFile)).toBe(true);
    expect(deps.paths.trackedResultsFile.endsWith(TRACKED_RESULTS_PATH)).toBe(true);
    expect(existsSync(deps.paths.trackedResultsFile)).toBe(true);
    expect(deps.paths.migrationsFolder.endsWith("packages/server/drizzle/")).toBe(true);
    expect(deps.paths.beforeModuleFile).toContain("src/services/sandboxes/.benchmark-before-");
    expect(deps.paths.beforeModuleFile).toMatch(/\.ts$/);
  });
});
