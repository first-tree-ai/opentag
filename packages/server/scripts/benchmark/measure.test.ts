import { describe, expect, it, vi } from "vitest";
import type { TaskService } from "../../src/services/tasks/index.js";
import { startBenchmarkContainer, waitForDatabase } from "./container.js";
import {
  type BenchmarkDatabase,
  type BenchmarkPorts,
  type BenchmarkReport,
  errorInfo,
  measureCase,
  median,
  runTaskQueriesBenchmark,
  type Statement,
  seedDatabase,
  splitSeed,
  verifyRowCounts,
} from "./measure.js";
import { runBenchmark } from "./run.js";

/**
 * The benchmark is evidence, so its own arithmetic is tested rather than trusted: a wrong median, a
 * dropped statement or a misread row count would change what the committed report says without
 * failing anything. Docker and the service are ports, which is what makes that testable here.
 *
 * The suite lives beside the modules rather than under `src/__tests__`: the benchmark is tooling, and
 * the package's own test root already collects it.
 */

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const HOT_ACCOUNT = "10000000-0000-4000-8000-000000000001";
const TEN_AGENT_ACCOUNT = "10000000-0000-4000-8000-000000000002";

function sqlAdmin(responses: Record<string, Record<string, unknown>[]> = {}): BenchmarkDatabase & {
  queries: { query: string; params?: readonly unknown[] }[];
} {
  const queries: { query: string; params?: readonly unknown[] }[] = [];
  return {
    queries,
    async unsafe(query, params) {
      queries.push({ query, params });
      const key = Object.keys(responses).find((candidate) => query.includes(candidate));
      return key ? (responses[key] ?? []) : [];
    },
  };
}

function ports(overrides: Partial<BenchmarkPorts> = {}): BenchmarkPorts & {
  written: { path: string; contents: string }[];
  logs: string[];
  saves: { count: number };
  enqueue(statements: Statement[]): void;
} {
  const report: BenchmarkReport = { phase: "test", results: [] };
  const written: { path: string; contents: string }[] = [];
  const logs: string[] = [];
  // An object rather than a counter: `Object.assign` copies values, so a getter would freeze at 0.
  const saves = { count: 0 };
  let queue: Statement[] = [];
  const base: BenchmarkPorts = {
    admin: sqlAdmin(),
    explainSql: sqlAdmin(),
    service: {} as TaskService,
    sink: {
      take: () => queue,
      reset: () => {
        queue = [];
      },
    },
    output: {
      dir: "/evidence",
      mkdir: () => undefined,
      write: (path, contents) => written.push({ path, contents }),
    },
    report,
    clock: () => 0,
    log: (line) => logs.push(line),
    save: () => {
      saves.count += 1;
    },
    ...overrides,
  };
  return Object.assign(base, {
    written,
    logs,
    saves,
    /** Make the next call's SQL sink return these statements. */
    enqueue(statements: Statement[]) {
      queue = statements;
    },
  });
}

describe("benchmark fixture helpers", () => {
  it("splits the seed into statements and drops the separators and blank tails", () => {
    const seed =
      "insert into a values (1);\n--> statement-breakpoint\n\n insert into b values (2); \n--> statement-breakpoint\n  \n";
    expect(splitSeed(seed)).toEqual(["insert into a values (1);", "insert into b values (2);"]);
    expect(splitSeed("")).toEqual([]);
  });

  it("takes a measured middle sample without reordering the caller's array", () => {
    const samples = [9, 1, 5];
    expect(median(samples)).toBe(5);
    expect(samples).toEqual([9, 1, 5]);
    // An even count takes the lower middle, which is always a value that was measured.
    expect(median([4, 1, 3, 2])).toBe(2);
    expect(median([])).toBeUndefined();
  });

  it("describes an error without its parameters and bounds the cause chain", () => {
    const root = new Error("disk full");
    const wrapped = Object.assign(new Error("insert failed", { cause: root }), { code: "53100" });
    expect(errorInfo(wrapped)).toMatchObject({
      name: "Error",
      message: "insert failed",
      code: "53100",
      cause: { message: "disk full" },
    });
    expect(errorInfo("plain")).toBe("plain");
    let deep: Error = new Error("level 0");
    for (let level = 1; level < 10; level += 1) deep = new Error(`level ${level}`, { cause: deep });
    let cursor = errorInfo(deep) as Record<string, unknown> | undefined;
    for (let depth = 0; depth < 5; depth += 1) {
      expect(cursor).toBeDefined();
      const cause = cursor?.cause as Record<string, unknown> | undefined;
      if (typeof cause === "string") {
        expect(cause).toBe("truncated");
        break;
      }
      cursor = cause;
    }
  });

  it("fails a fixture that lost rows instead of measuring it", async () => {
    const tables = {
      "from pg_class": [
        { schema: "public", name: "im_messages" },
        { schema: "billing", name: "attempts" },
      ],
      'from "public"."im_messages"': [{ n: 100_000 }],
      'from "billing"."attempts"': [{ n: 99_999 }],
    };
    await expect(verifyRowCounts(sqlAdmin(tables))).rejects.toThrow("billing.attempts holds 99999, below 100000");
    const complete = { ...tables, 'from "billing"."attempts"': [{ n: 100_000 }] };
    await expect(verifyRowCounts(sqlAdmin(complete), 100_000)).resolves.toEqual([
      { table: "public.im_messages", rows: 100_000 },
      { table: "billing.attempts", rows: 100_000 },
    ]);
  });

  it("seeds statement by statement and reports each insert's own time", async () => {
    const ticks = [0, 10, 10, 25];
    const admin = sqlAdmin();
    const logs: string[] = [];
    const timings = await seedDatabase(
      admin,
      ["insert into public.a values (1);", "-- a comment\ncreate function f() returns int"],
      () => ticks.shift() ?? 0,
      (line) => logs.push(line),
    );
    expect(admin.queries.map((entry) => entry.query)).toHaveLength(2);
    expect(timings).toEqual([
      { table: "public.a", elapsedMs: 10 },
      { table: "fixture functions", elapsedMs: 15 },
    ]);
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({ phase: "seed", table: "public.a" });
  });
});

describe("benchmark measurement", () => {
  it("runs one warm-up and the requested samples, and records the SQL of the call", async () => {
    const evidence = ports();
    let calls = 0;
    const ticks = [0, 5, 5, 9, 9, 12, 12, 20, 20, 26];
    Object.assign(evidence, { clock: () => ticks.shift() ?? 0 });
    const operations = vi.fn(async () => {
      calls += 1;
      return { size: calls };
    });
    const result = await measureCase(evidence, "case", operations, 4);
    expect(result).toEqual({ size: 5 });
    // One warm-up plus four timed samples, each timed by its own pair of clock readings.
    expect(operations).toHaveBeenCalledTimes(5);
    expect(evidence.report.results[0]).toMatchObject({
      name: "case",
      samplesMs: [4, 3, 8, 6],
      medianMs: 4,
      maxMs: 8,
      queryCounts: [0, 0, 0, 0],
      responseBytes: Buffer.byteLength(JSON.stringify({ size: 5 })),
      error: undefined,
    });
    expect(evidence.saves.count).toBe(1);
    expect(evidence.logs).toHaveLength(1);
  });

  it("stops at the first failure and keeps the failure in the record", async () => {
    const evidence = ports();
    let calls = 0;
    const operations = vi.fn(async () => {
      calls += 1;
      if (calls > 2) throw new Error("canceling statement due to statement timeout");
      return { ok: true };
    });
    await measureCase(evidence, "timeout", operations, 5);
    expect(operations).toHaveBeenCalledTimes(3);
    const record = evidence.report.results[0];
    expect(record?.samplesMs).toHaveLength(2);
    expect(record?.error).toMatchObject({ message: "canceling statement due to statement timeout" });
  });

  it("explains each distinct statement once and records how often the call ran it", async () => {
    const explain = sqlAdmin({
      "select 1": [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result", "Actual Rows": 1 }, "Execution Time": 0.02 }] }],
    });
    const evidence = ports({ explainSql: explain });
    const statement: Statement = { query: "select 1", params: [] };
    let run = 0;
    Object.assign(evidence, {
      sink: {
        take: () => {
          run += 1;
          return [
            { query: "begin", params: [] },
            statement,
            { ...statement },
            { query: "select $1::int", params: new Array(60_001).fill(1) },
          ];
        },
        reset: () => undefined,
      },
    });
    await measureCase(evidence, "case", async () => ({ ok: run }), 0);
    const statements = evidence.report.results[0]?.statements ?? [];
    // `begin` is listed but never explained, the parameter-heavy select would exceed the driver
    // limit, and the two identical selects are one statement with two occurrences.
    expect(statements.map((summary) => summary.sql)).toEqual(["begin", "select 1", "select $1::int"]);
    expect(statements[0]?.explainFile).toBeUndefined();
    expect(statements[1]).toMatchObject({
      occurrences: 2,
      topNode: "Result",
      planRows: 1,
      explainFile: "case-2.json",
    });
    expect(statements[2]).toMatchObject({ occurrences: 1 });
    expect(statements[2]?.explainFile).toBeUndefined();
    expect(evidence.written[0]?.path).toBe("/evidence/case-2.json");
    expect(JSON.parse(evidence.written[0]?.contents ?? "{}")).toMatchObject({ sql: "select 1" });
  });

  it("keeps a refused explain visible instead of dropping the statement", async () => {
    const explain: BenchmarkDatabase = {
      async unsafe() {
        throw new Error("canceling statement due to statement timeout");
      },
    };
    const evidence = ports({ explainSql: explain });
    Object.assign(evidence, {
      sink: { take: () => [{ query: "select 1", params: [] }], reset: () => undefined },
    });
    await measureCase(evidence, "case", async () => ({ ok: true }), 0);
    const [summary] = evidence.report.results[0]?.statements ?? [];
    expect(summary).toMatchObject({ sql: expect.any(String) });
    expect(summary?.explainError).toMatchObject({ message: "canceling statement due to statement timeout" });
  });
});

describe("benchmark case list", () => {
  /** A Task service stand-in that records each call and answers with paged cursors. */
  function recordingService(options: { cursors: boolean }) {
    const calls: { method: string; args: unknown[] }[] = [];
    const page = (cursor: string | null) => ({ items: [], nextCursor: cursor });
    const service = {
      async list(accountId: string, input: Record<string, unknown>) {
        calls.push({ method: "list", args: [accountId, input] });
        return { tasks: [{ id: TASK_ID, title: "Task" }], nextCursor: options.cursors ? "page-2" : null };
      },
      async get(accountId: string, id: string, input: unknown) {
        calls.push({ method: "get", args: [accountId, id, input] });
        return { task: { id }, turns: [], internalSessions: [], collaborationMessages: [], nextCursor: null };
      },
      async listReplies(accountId: string, id: string, input: unknown) {
        calls.push({ method: "listReplies", args: [accountId, id, input] });
        return { items: [], nextCursor: null };
      },
      async detail(accountId: string, id: string, input: { sections?: string[] }) {
        calls.push({ method: "detail", args: [accountId, id, input] });
        const next = (cursor: string) => (options.cursors ? cursor : null);
        const wantsTurns = input.sections === undefined || input.sections.includes("turns");
        return {
          task: { id },
          ...(wantsTurns ? { turns: page(next("turn-2")) } : {}),
          ...(input.sections === undefined
            ? {
                internalSessions: page(next("internal-2")),
                collaborationMessages: page(next("collaboration-2")),
              }
            : {}),
        };
      },
      async listTurns(accountId: string, id: string, input: unknown) {
        calls.push({ method: "listTurns", args: [accountId, id, input] });
        return page(null);
      },
      async listInternalSessions(accountId: string, id: string, input: unknown) {
        calls.push({ method: "listInternalSessions", args: [accountId, id, input] });
        return page(null);
      },
      async listCollaborationMessages(accountId: string, id: string, input: unknown) {
        calls.push({ method: "listCollaborationMessages", args: [accountId, id, input] });
        return page(null);
      },
    } as unknown as TaskService;
    return { calls, service };
  }

  it("measures the bounded first page the Web reads with the Turns alone", async () => {
    const { calls, service } = recordingService({ cursors: false });
    const evidence = ports({ service });
    await runTaskQueriesBenchmark(evidence, { hotAccountId: HOT_ACCOUNT, tenAgentAccountId: TEN_AGENT_ACCOUNT });

    const names = evidence.report.results.map((record) => record.name);
    expect(names).toEqual([
      "tasks.list.hot-dm.limit20",
      "tasks.list.10-agents.25000-messages.limit20",
      "tasks.detail.legacy.hot-dm.limit20",
      "tasks.replies.hot-dm.limit20",
      "tasks.detail.hot-dm.turns-only.limit20",
      "tasks.detail.hot-dm.all-sections.limit20",
      "tasks.detail.legacy.10-agents.limit20",
      "tasks.detail.10-agents.turns-only.limit20",
      "tasks.detail.10-agents.all-sections.limit20",
    ]);
    // The conversation's first page never asks for the sections it discards; the full first page
    // names none, so the Server answers with every section. Each case repeats its call, so the
    // request shapes are compared once each.
    const detailRequests = [
      ...new Set(calls.filter((call) => call.method === "detail").map((call) => JSON.stringify(call.args[2]))),
    ];
    expect(detailRequests).toEqual([JSON.stringify({ limit: 20, sections: ["turns"] }), JSON.stringify({ limit: 20 })]);
    // No cursor, no continuation case.
    expect(names).not.toContain("tasks.detail.hot-dm.turns.page2");
  });

  it("continues every section from its own cursor when the fixture has more", async () => {
    const { calls, service } = recordingService({ cursors: true });
    const evidence = ports({ service });
    await runTaskQueriesBenchmark(evidence, { hotAccountId: HOT_ACCOUNT, tenAgentAccountId: TEN_AGENT_ACCOUNT });

    const names = evidence.report.results.map((record) => record.name);
    expect(names).toContain("tasks.list.hot-dm.page2");
    expect(names).toContain("tasks.list.10-agents.page2");
    expect(names).toContain("tasks.detail.hot-dm.turns.page2");
    expect(names).toContain("tasks.detail.hot-dm.internal-sessions.page2");
    expect(names).toContain("tasks.detail.hot-dm.collaboration-messages.page2");
    expect(calls.find((call) => call.method === "listInternalSessions")?.args[2]).toEqual({
      limit: 20,
      cursor: "internal-2",
    });
  });

  it("refuses to measure a fixture that produced no Task", async () => {
    const service = {
      async list() {
        return { tasks: [], nextCursor: null };
      },
    } as unknown as TaskService;
    const evidence = ports({ service });
    await expect(
      runTaskQueriesBenchmark(evidence, { hotAccountId: HOT_ACCOUNT, tenAgentAccountId: TEN_AGENT_ACCOUNT }),
    ).rejects.toThrow("The fixture produced no Task for the hot private chat");
  });
});

describe("benchmark container", () => {
  /** A docker CLI stand-in that answers the three commands this benchmark issues. */
  function fakeDocker(options: { label?: string; binding?: string } = {}) {
    const calls: string[][] = [];
    const docker = (args: string[]) => {
      calls.push(args);
      if (args[0] === "inspect" && args[2]?.includes(".Image")) return "sha256:image";
      if (args[0] === "inspect") return options.label ?? "task-queries";
      if (args[0] === "port") return options.binding ?? "127.0.0.1:54321";
      if (args[0] === "info") return '{"cpus":8,"memoryBytes":17179869184}';
      return "";
    };
    return { calls, docker };
  }

  it("starts an own, loopback-only container and reports what it found", () => {
    const { calls, docker } = fakeDocker();
    const logs: string[] = [];
    const container = startBenchmarkContainer({
      docker,
      name: "opentag-task-bench-123",
      labelKey: "opentag.benchmark",
      labelValue: "task-queries",
      log: (line) => logs.push(line),
    });
    expect(calls[0]?.slice(0, 4)).toEqual(["run", "--detach", "--name", "opentag-task-bench-123"]);
    expect(calls[0]).toContain("127.0.0.1::5432");
    expect(container.url).toBe("postgres://postgres:benchmark-local-only@127.0.0.1:54321/opentag_benchmark");
    expect(container.environment).toMatchObject({ dockerImage: "sha256:image", dockerResources: { cpus: 8 } });
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({ phase: "container", state: "started" });
    container.stop();
    expect(calls.at(-1)).toEqual(["rm", "--force", "--volumes", "opentag-task-bench-123"]);
  });

  it("refuses a container that is not this run's own", () => {
    const { docker } = fakeDocker({ label: "another-lane" });
    expect(() =>
      startBenchmarkContainer({
        docker,
        name: "opentag-task-bench-123",
        labelKey: "opentag.benchmark",
        labelValue: "task-queries",
        log: () => undefined,
      }),
    ).toThrow("The container is not this benchmark's own");
  });

  it("refuses a container that is not on a loopback port", () => {
    const { docker } = fakeDocker({ binding: "0.0.0.0:54321" });
    expect(() =>
      startBenchmarkContainer({
        docker,
        name: "opentag-task-bench-123",
        labelKey: "opentag.benchmark",
        labelValue: "task-queries",
        log: () => undefined,
      }),
    ).toThrow("The container is not on a loopback port");
  });

  it("waits for the database to accept a query and gives up after the last attempt", async () => {
    let attempts = 0;
    await waitForDatabase(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("connection refused");
        return undefined;
      },
      { sleep: async () => undefined },
    );
    expect(attempts).toBe(3);

    await expect(
      waitForDatabase(
        async () => {
          throw new Error("connection refused");
        },
        { attempts: 2, sleep: async () => undefined },
      ),
    ).rejects.toThrow("connection refused");
  });
});

/** The docker CLI answers the run needs, keyed by the command it asks for. */
function fakeDockerCommand(args: string[], closed: string[]): string {
  const answers: Record<string, string> = {
    port: "127.0.0.1:54321",
    info: '{"cpus":4,"memoryBytes":8}',
  };
  if (args[0] === "rm") closed.push("container");
  if (args[0] === "inspect") return args[2]?.includes(".Image") ? "sha256:image" : "task-queries-test";
  return answers[args[0] ?? ""] ?? "";
}

describe("benchmark run", () => {
  const TASK = { id: TASK_ID, title: "Task" };

  /** A wiring stub: every port answers without Docker, PostgreSQL or the filesystem. */
  function wiring(options: { failVerification?: boolean; failMeasurement?: boolean } = {}) {
    const writes: { path: string; contents: string }[] = [];
    const logs: string[] = [];
    const closed: string[] = [];
    const adminCalls: string[] = [];
    // A table rather than a branch chain: each statement the run issues, matched by a fragment.
    const adminResponses: [string, Record<string, unknown>[]][] = [
      ["from pg_class", [{ schema: "public", name: "im_messages" }]],
      ['from "public"."im_messages"', [{ n: options.failVerification ? 1 : 100_000 }]],
      ["select version()", [{ version: "PostgreSQL 17" }]],
      ["drizzle.__drizzle_migrations", [{ n: 69 }]],
      ["pg_database_size", [{ bytes: "1262" }]],
    ];
    const admin = {
      database: {
        async unsafe(query: string) {
          adminCalls.push(query);
          const match = adminResponses.find(([fragment]) => query.includes(fragment));
          return match?.[1] ?? [];
        },
      },
      end: async () => {
        closed.push("admin");
      },
    };
    const service = {
      async list() {
        if (options.failMeasurement) throw new Error("measurement failed");
        return { tasks: [TASK], nextCursor: null };
      },
      async get(_account: string, id: string) {
        return { task: { id }, turns: [], internalSessions: [], collaborationMessages: [], nextCursor: null };
      },
      async listReplies() {
        return { items: [], nextCursor: null };
      },
      async detail(_account: string, id: string, input: { sections?: string[] }) {
        return {
          task: { id },
          ...(input.sections === undefined
            ? {
                turns: { items: [], nextCursor: null },
                internalSessions: { items: [], nextCursor: null },
                collaborationMessages: { items: [], nextCursor: null },
              }
            : {}),
        };
      },
      async listTurns() {
        return { items: [], nextCursor: null };
      },
      async listInternalSessions() {
        return { items: [], nextCursor: null };
      },
      async listCollaborationMessages() {
        return { items: [], nextCursor: null };
      },
    };
    const ports = {
      phase: "test",
      output: "/evidence",
      docker: (args: string[]) => fakeDockerCommand(args, closed),
      containerName: "opentag-task-queries-test",
      labelValue: "task-queries-test",
      openAdmin: () => admin,
      openExplain: () => ({
        database: {
          unsafe: async () => [
            { "QUERY PLAN": [{ Plan: { "Node Type": "Result", "Actual Rows": 1 }, "Execution Time": 0.1 }] },
          ],
        },
        end: async () => {
          closed.push("explain");
        },
      }),
      openService: () => ({
        service: service as never,
        sink: { take: () => [], reset: () => undefined },
        timeouts: { statementTimeoutMs: 30_000 },
        end: async () => {
          closed.push("service");
        },
      }),
      migrate: async () => undefined,
      readSeed: () => "insert into public.a values (1);\n--> statement-breakpoint\ninsert into public.b values (2);",
      environment: () => ({ node: "v24", dockerImage: "sha256:image" }),
      mkdir: () => undefined,
      write: (path: string, contents: string) => writes.push({ path, contents }),
      gitHead: () => "abcdef0",
      gitDirty: () => false,
      clock: () => 0,
      log: (line: string) => logs.push(line),
      ids: { hotAccountId: HOT_ACCOUNT, tenAgentAccountId: TEN_AGENT_ACCOUNT },
    };
    return { ports, writes, logs, closed, adminCalls, service };
  }

  it("writes one evidence file per phase, describing the environment it measured", async () => {
    const fixture = wiring();
    const report = await runBenchmark(fixture.ports as never);
    expect(report.environment).toMatchObject({
      commit: "abcdef0",
      dirty: false,
      node: "v24",
      migrationCount: 69,
      postgres: { version: "PostgreSQL 17" },
      method: expect.stringContaining("microbenchmark"),
    });
    expect(report.rowCounts).toEqual([{ table: "public.im_messages", rows: 100_000 }]);
    expect(report.databaseBytes).toBe("1262");
    expect(report.seedTimings).toEqual([
      { table: "public.a", elapsedMs: 0 },
      { table: "public.b", elapsedMs: 0 },
    ]);
    expect(report.containerRemoved).toBe(true);
    // The results file is written as the run progresses and once at the end.
    expect(fixture.writes.at(-1)?.path).toBe("/evidence/results-test.json");
    expect(JSON.parse(fixture.writes.at(-1)?.contents ?? "{}")).toMatchObject({ phase: "test" });
    // Every client is closed and the container removed, in the order that keeps the container last.
    expect(fixture.closed).toEqual(["explain", "service", "admin", "container"]);
  });

  it("stops before measuring when the fixture lost rows, and still cleans up", async () => {
    const fixture = wiring({ failVerification: true });
    await expect(runBenchmark(fixture.ports as never)).rejects.toThrow("public.im_messages holds 1, below 100000");
    // The service is never opened: the fixture is checked first, so a broken seed costs no measurement.
    expect(fixture.closed).toEqual(["admin", "container"]);
    expect(fixture.writes.at(-1)?.path).toBe("/evidence/results-test.json");
  });

  it("records a failed case and stops when the failure leaves nothing to measure", async () => {
    const fixture = wiring({ failMeasurement: true });
    // A list case that fails leaves no Task id, so the detail cases cannot run: the run stops rather
    // than reporting numbers taken on a different code path.
    await expect(runBenchmark(fixture.ports as never)).rejects.toThrow(
      "The fixture produced no Task for the hot private chat",
    );
    const written = JSON.parse(fixture.writes.at(-1)?.contents ?? "{}") as {
      results: { name: string; error?: { message: string } }[];
      containerRemoved?: boolean;
    };
    expect(written.results).toHaveLength(2);
    expect(written.results[0]?.error).toMatchObject({ message: "measurement failed" });
    expect(written.containerRemoved).toBe(true);
    expect(fixture.closed).toEqual(["explain", "service", "admin", "container"]);
  });
});
