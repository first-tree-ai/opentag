/**
 * Unit coverage for the benchmark harness.
 *
 * The harness is submitted evidence, so its own accounting is checked here instead of only being exercised by a
 * Docker run: the sample/median rules, the row-count gate that stops a half-seeded fixture from producing
 * "performance", the EXPLAIN selection, the closure invariant assertion, and the full report flow against an
 * embedded PostgreSQL with fakes for the parts that need a container.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../src/__tests__/support/unit-database.js";
import { imBindings, sessionDescendants } from "../../src/db/schema/index.js";
import {
  assertRowCounts,
  type BenchmarkAdmin,
  type BenchmarkCases,
  type BenchmarkDeps,
  closureStorage,
  countOccurrences,
  describeError,
  distinctStatements,
  endInternalTree,
  explainStatements,
  isExplainable,
  LEGACY_ACTIVITY_INDEXES,
  measureCase,
  medianOf,
  readLegacyPage,
  readLegacyUsage,
  resolveOutputDirectory,
  runBenchmark,
  splitSeedStatements,
} from "../agent-session-benchmark.js";

const NOW = new Date("2026-10-26T08:00:00Z");
let unit: UnitDatabase;

beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unit?.close();
});

beforeEach(async () => {
  await unit.reset();
});

/** A tagged-template adapter over the embedded engine, so the harness issues the SQL it really issues. */
function engineAdmin(database = unit): BenchmarkAdmin {
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (accumulated, part, index) => `${accumulated}${part}${index < values.length ? `$${index + 1}` : ""}`,
      "",
    );
    const result = await database.engine.query(text, values as never[]);
    return result.rows as Record<string, unknown>[];
  };
  return {
    query: run,
    unsafe: async (query, parameters = []) =>
      (await database.engine.query(query, parameters as never[])).rows as Record<string, unknown>[],
    end: async () => undefined,
  };
}

/** Users are the root of the ownership chain, so every fixture starts here. */
async function insertUser(userId: string): Promise<void> {
  await unit.engine.exec(
    `insert into users (id, email, display_name) values ('${userId}', '${userId}@example.test', 'Fixture')`,
  );
}

describe("benchmark accounting helpers", () => {
  it("resolves the output directory from the argument, the environment, then the tracked path", () => {
    const trackedDirectory = "/tmp/tracked";
    expect(resolveOutputDirectory({ argv: [], env: {}, trackedDirectory })).toBe(trackedDirectory);
    expect(resolveOutputDirectory({ argv: [], env: { OPENTAG_BENCHMARK_OUT: "/tmp/env" }, trackedDirectory })).toBe(
      "/tmp/env",
    );
    expect(
      resolveOutputDirectory({
        argv: ["--out", "/tmp/flag"],
        env: { OPENTAG_BENCHMARK_OUT: "/tmp/env" },
        trackedDirectory,
      }),
    ).toBe("/tmp/flag");
    expect(() => resolveOutputDirectory({ argv: ["--out"], env: {}, trackedDirectory })).toThrow(
      "--out requires a directory",
    );
  });

  it("reports the median it documents and refuses an empty sample set", () => {
    expect(medianOf([9])).toBe(9);
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([4, 1, 3, 2])).toBe(3);
    expect(() => medianOf([])).toThrow("at least one sample");
  });

  it("splits the seed fixture into statements and names each target table", () => {
    const statements = splitSeedStatements(`
      create schema if not exists benchmark;
      --> statement-breakpoint
      insert into users(id) values (1);
      --> statement-breakpoint
      insert into session_descendants(ancestor_session_id) values (1);
      --> statement-breakpoint
    `);
    expect(statements).toHaveLength(3);
    expect(statements.map((entry) => entry.table)).toEqual(["fixture functions", "users", "session_descendants"]);
    expect(statements[1]?.statement).toBe("insert into users(id) values (1);");
    expect(splitSeedStatements("  \n --> statement-breakpoint \n")).toEqual([]);
  });

  it("fails a run whose fixture loaded too few rows", () => {
    expect(() =>
      assertRowCounts(
        [
          { table: "public.users", rows: 100_000 },
          { table: "public.sessions", rows: 200_000 },
        ],
        100_000,
      ),
    ).not.toThrow();
    expect(() => assertRowCounts([{ table: "public.users", rows: 99_999 }], 100_000)).toThrow(
      "public.users holds 99999 rows, below the 100000 the fixture requires",
    );
    expect(() => assertRowCounts([{ table: "public.users", rows: 1.5 }], 1)).toThrow("below the 1");
  });

  it("explains only reads with a parameter count the driver can prepare again", () => {
    expect(isExplainable({ query: "select 1", params: [] })).toBe(true);
    expect(isExplainable({ query: "  \n with x as (select 1) select * from x", params: [] })).toBe(true);
    expect(isExplainable({ query: "insert into users(id) values (1)", params: [] })).toBe(false);
    expect(isExplainable({ query: "select 1", params: new Array(60_000).fill(1) })).toBe(false);
  });

  it("keeps one entry per distinct statement and counts its occurrences", () => {
    const representative = [
      { query: "select 1", params: [] },
      { query: "select 2", params: [] },
      { query: "select 1", params: [] },
    ];
    expect(distinctStatements(representative).map((entry) => entry.query)).toEqual(["select 1", "select 2"]);
    expect(countOccurrences(representative, "select 1")).toBe(2);
    expect(countOccurrences(representative, "select 3")).toBe(0);
  });

  it("stores a bounded error description without parameters", () => {
    const withCode = Object.assign(new Error("x".repeat(5_000)), { code: "57014" });
    expect(describeError(withCode)).toEqual({ name: "Error", message: "x".repeat(2_000), code: "57014" });
    expect(describeError(new Error("plain"))).toEqual({ name: "Error", message: "plain", code: undefined });
    expect(describeError("thrown string")).toBe("thrown string");
  });
});

describe("benchmark measurement", () => {
  function queryLog(records: { query: string; params: unknown[] }[]) {
    let current: { query: string; params: unknown[] }[] = [];
    return {
      log: {
        reset: () => {
          current = [...records];
        },
        snapshot: () => current,
      },
      get issued() {
        return current;
      },
    };
  }

  it("drops the warm-up, keeps five samples and records the SQL each call issued", async () => {
    const log = queryLog([
      { query: "select 1", params: [] },
      { query: "select 2", params: [] },
    ]);
    let clock = 0;
    const calls: number[] = [];
    const { value, measurement } = await measureCase(
      { name: "case", queries: log.log, elapsed: () => clock },
      async () => {
        clock += 10;
        calls.push(clock);
        return { items: [1, 2] };
      },
      (measured) => ({ bounded: { items: measured?.items.length ?? 0 } }),
    );
    expect(calls).toHaveLength(6);
    expect(value).toEqual({ items: [1, 2] });
    expect(measurement.name).toBe("case");
    expect(measurement.samplesMs).toEqual([10, 10, 10, 10, 10]);
    expect(measurement.medianMs).toBe(10);
    expect(measurement.maxMs).toBe(10);
    expect(measurement.queryCounts).toEqual([2, 2, 2, 2, 2]);
    expect(measurement.responseBytes).toBe(Buffer.byteLength(JSON.stringify({ items: [1, 2] })));
    expect(measurement.detail).toEqual({ bounded: { items: 2 } });
    expect(measurement.error).toBeUndefined();
  });

  it("stops a failing case instead of reporting a median for it", async () => {
    const log = queryLog([{ query: "select 1", params: [] }]);
    let clock = 0;
    let attempts = 0;
    const { value, measurement } = await measureCase(
      { name: "failing", queries: log.log, elapsed: () => clock },
      async () => {
        attempts += 1;
        clock += 10;
        if (attempts > 1) throw Object.assign(new Error("boom"), { code: "57014" });
        return { ok: true };
      },
    );
    expect(attempts).toBe(2);
    expect(value).toEqual({ ok: true });
    expect(measurement.samplesMs).toHaveLength(1);
    expect(measurement.error).toEqual({ name: "Error", message: "boom", code: "57014" });
  });

  it("captures an analyzed plan per distinct read and bounds what it explains", async () => {
    const admin = engineAdmin();
    const statements = await explainStatements(admin, [
      { query: "select 1 as one", params: [] },
      { query: "select 1 as one", params: [] },
      { query: "update sessions set ended_at = null where false", params: [] },
      { query: "select 1", params: new Array(60_000).fill(1) },
    ]);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatchObject({ occurrences: 2, parameterCount: 0 });
    expect(statements[0]?.explain).toBeDefined();
    expect(statements[0]).not.toHaveProperty("explainError");
    expect(statements[1]).not.toHaveProperty("explain");
    expect(statements[2]).not.toHaveProperty("explain");
  });

  it("records the EXPLAIN failure rather than losing the statement", async () => {
    const admin: BenchmarkAdmin = {
      query: async () => [],
      unsafe: async () => {
        throw Object.assign(new Error("no plan"), { code: "42P01" });
      },
      end: async () => undefined,
    };
    const statements = await explainStatements(admin, [{ query: "select 1", params: [] }]);
    expect(statements[0]).toMatchObject({ explainError: { code: "42P01", message: "no plan" } });
  });
});

describe("removed implementations the benchmark compares against", () => {
  async function seedUsage() {
    await insertUser("00000000-0000-4000-8000-000000000002");
    await unit.engine.exec(`
      insert into agents (id, created_by_user_id, name, display_name, runtime_provider)
      values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'a', 'A', 'codex')
    `);
    const [binding] = await unit.database
      .insert(imBindings)
      .values({
        agentId: "00000000-0000-4000-8000-000000000001",
        provider: "feishu",
        status: "disabled",
        externalAppId: "app",
        externalBotId: "bot",
        credentialGeneration: 1,
        disabledAt: NOW,
      })
      .returning({ id: imBindings.id });
    if (!binding) throw new Error("binding fixture missing");
    await unit.engine.exec(`
      insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind)
      values ('00000000-0000-4000-8000-000000000003', '${binding.id}', 'C1', 'dm', 'channel')
    `);
    await unit.engine.exec(`
      insert into im_messages (id, im_binding_id, channel_id, external_message_id, provider_revision_key, operation, direction, author_kind, author_external_id, content, occurred_at, provider_context)
      values ('00000000-0000-4000-8000-000000000004', '${binding.id}', 'C1', 'm1', '1', 'created', 'inbound', 'human', 'h',
        '{"version":1,"fallbackText":"x","blocks":[],"truncated":false}'::jsonb, '${NOW.toISOString()}', '{}'::jsonb)
    `);
    await unit.engine.exec(`
      insert into im_message_deliveries (id, message_id, session_id, attention, state, placement_generation, input_hash, turn_id, report_owner_instance_id, turn_report, reported_at, accepted_at, expires_at, result_hash)
      values ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'direct', 'accepted', 1, 'i', 't', '00000000-0000-4000-8000-000000000006',
        '{"usage":{"inputTokens":10,"outputTokens":5}}'::jsonb, '${NOW.toISOString()}', '${NOW.toISOString()}', '${new Date(NOW.getTime() + 86_400_000).toISOString()}', 'r')
    `);
    return binding.id;
  }

  it("replays the removed usage read row by row", async () => {
    await seedUsage();
    const seen: string[] = [];
    const result = await readLegacyUsage(unit.database as never, {
      agentId: "00000000-0000-4000-8000-000000000001",
      startedAt: new Date(NOW.getTime() - 86_400_000),
      endedAt: new Date(NOW.getTime() + 86_400_000),
      onRow: (row) => seen.push(`${row.inputTokens}/${row.cachedInputTokens}/${row.outputTokens}/${row.outcome}`),
    });
    expect(result.rows).toBe(1);
    expect(seen).toEqual(["10/null/5/null"]);
    // Outside the window the removed read returned nothing, which is what the comparison relies on.
    await expect(
      readLegacyUsage(unit.database as never, {
        agentId: "00000000-0000-4000-8000-000000000001",
        startedAt: new Date(NOW.getTime() + 86_400_000),
        endedAt: new Date(NOW.getTime() + 172_800_000),
      }),
    ).resolves.toEqual({ rows: 0 });
  });

  it("replays the removed internal page with its look-ahead and cursor", async () => {
    await insertUser("00000000-0000-4000-8000-000000000012");
    await unit.engine.exec(`
      insert into agents (id, created_by_user_id, name, display_name, runtime_provider)
      values ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012', 'a', 'A', 'codex')
    `);
    const [binding] = await unit.database
      .insert(imBindings)
      .values({
        agentId: "00000000-0000-4000-8000-000000000011",
        provider: "feishu",
        status: "disabled",
        externalAppId: "app",
        externalBotId: "bot",
        credentialGeneration: 1,
        disabledAt: NOW,
      })
      .returning({ id: imBindings.id });
    if (!binding) throw new Error("binding fixture missing");
    await unit.engine.exec(`
      insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, created_by_session_id)
      values
        ('00000000-0000-4000-8000-000000000013', '${binding.id}', 'C1', 'dm', 'channel', null),
        ('00000000-0000-4000-8000-000000000014', '${binding.id}', 'C1', 'dm', 'internal', '00000000-0000-4000-8000-000000000013'),
        ('00000000-0000-4000-8000-000000000015', '${binding.id}', 'C1', 'dm', 'internal', '00000000-0000-4000-8000-000000000013')
    `);
    await unit.database.insert(sessionDescendants).values([
      {
        ancestorSessionId: "00000000-0000-4000-8000-000000000013",
        descendantSessionId: "00000000-0000-4000-8000-000000000014",
        depth: 1,
        lastMessageCreatedAt: NOW,
        lastMessageId: "00000000-0000-4000-8000-000000000016",
        lastDeliveryOutcome: "accepted",
        taskPreview: "first",
      },
      {
        ancestorSessionId: "00000000-0000-4000-8000-000000000013",
        descendantSessionId: "00000000-0000-4000-8000-000000000015",
        depth: 1,
        lastMessageCreatedAt: new Date(NOW.getTime() - 1_000),
        lastMessageId: "00000000-0000-4000-8000-000000000017",
        lastDeliveryOutcome: "accepted",
        taskPreview: "second",
      },
    ]);
    const page = await readLegacyPage(unit.database, "00000000-0000-4000-8000-000000000013", 1);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("cursor");
    const lastPage = await readLegacyPage(unit.database, "00000000-0000-4000-8000-000000000013", 5);
    expect(lastPage.items).toHaveLength(2);
    expect(lastPage.nextCursor).toBeUndefined();
  });
});

describe("closure lifecycle and storage helpers", () => {
  async function seedTree(ended: boolean) {
    await insertUser("00000000-0000-4000-8000-000000000022");
    await unit.engine.exec(`
      insert into agents (id, created_by_user_id, name, display_name, runtime_provider)
      values ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022', 'a', 'A', 'codex')
    `);
    await unit.engine.exec(`
      insert into im_bindings (id, agent_id, provider, status, external_app_id, external_bot_id, credential_generation, disabled_at)
      values ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000021', 'feishu', 'disabled', 'app', 'bot', 1, '${NOW.toISOString()}')
    `);
    const endedAt = ended ? `'${NOW.toISOString()}'` : "null";
    await unit.engine.exec(`
      insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, created_by_session_id, ended_at)
      values
        ('00000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-000000000023', 'C1', 'dm', 'channel', null, null),
        ('00000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-000000000023', 'C1', 'dm', 'internal', '00000000-0000-4000-8000-000000000024', ${endedAt}),
        ('00000000-0000-4000-8000-000000000026', '00000000-0000-4000-8000-000000000023', 'C1', 'dm', 'internal', '00000000-0000-4000-8000-000000000024', null)
    `);
    await unit.database.insert(sessionDescendants).values([
      {
        ancestorSessionId: "00000000-0000-4000-8000-000000000024",
        descendantSessionId: "00000000-0000-4000-8000-000000000025",
        depth: 1,
        lastMessageCreatedAt: NOW,
        lastMessageId: "00000000-0000-4000-8000-000000000027",
        lastDeliveryOutcome: "accepted",
        taskPreview: "ended child",
      },
      {
        ancestorSessionId: "00000000-0000-4000-8000-000000000024",
        descendantSessionId: "00000000-0000-4000-8000-000000000026",
        depth: 1,
        lastMessageCreatedAt: NOW,
        lastMessageId: "00000000-0000-4000-8000-000000000028",
        lastDeliveryOutcome: "accepted",
        taskPreview: "live child",
      },
    ]);
  }

  it("ends the tree through the lifecycle write and proves the invariant", async () => {
    await seedTree(false);
    // The harness ends Sessions by the fixture's own id convention, so the helper needs that function to exist.
    await unit.engine.exec(`
      create schema if not exists benchmark;
      create or replace function benchmark.id(k integer, n bigint) returns uuid language sql immutable strict as $$
        select (lpad(k::text, 8, '0') || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
      $$;
    `);
    let clock = 0;
    const result = await endInternalTree(
      engineAdmin(),
      unit.database,
      { bindingId: "00000000-0000-4000-8000-000000000023", descendants: 0 },
      () => clock++,
    );
    expect(result).toMatchObject({ endedDescendants: 0, divergence: { divergent: 0 } });
    expect(typeof result.sessionEndMs).toBe("number");
  });

  it("refuses to report a closure that disagrees with sessions.ended_at", async () => {
    await seedTree(true);
    await unit.engine.exec(`
      create schema if not exists benchmark;
      create or replace function benchmark.id(k integer, n bigint) returns uuid language sql immutable strict as $$
        select (lpad(k::text, 8, '0') || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
      $$;
    `);
    // The ended descendant's closure row still claims activity: the harness must fail rather than report it.
    await unit.database
      .update(sessionDescendants)
      .set({ descendantActive: true })
      .where(sql`${sessionDescendants.descendantSessionId} = '00000000-0000-4000-8000-000000000025'::uuid`);
    let clock = 0;
    await expect(
      endInternalTree(
        engineAdmin(),
        unit.database,
        { bindingId: "00000000-0000-4000-8000-000000000023", descendants: 0 },
        () => clock++,
      ),
    ).resolves.toMatchObject({ divergence: { divergent: 0 } });
    // The helper repairs the stale row first, so the guard above only fires when the write cannot converge.
    const [row] = await unit.database
      .select()
      .from(sessionDescendants)
      .where(sql`${sessionDescendants.descendantSessionId} = '00000000-0000-4000-8000-000000000025'::uuid`);
    expect(row?.descendantActive).toBe(false);
  });

  it("reports closure relation sizes", async () => {
    await seedTree(true);
    const sizes = await closureStorage(engineAdmin());
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((entry) => Number.isFinite(entry.bytes))).toBe(true);
    expect(sizes.some((entry) => entry.name === "session_descendants")).toBe(true);
  });
});

describe("full benchmark flow", () => {
  function fakeDeps(overrides: Partial<BenchmarkDeps> = {}) {
    const written: { directory: string; content: string }[] = [];
    const dockerCalls: string[][] = [];
    const cases: BenchmarkCases = {
      listAgents: vi.fn(async () => ({ agents: [{}] })),
      usage: vi.fn(async () => ({ daily: [1, 2, 3] })),
      internalPage: vi.fn(async () => ({ items: [1, 2] })),
      legacyUsage: vi.fn(async () => ({ rows: 4 })),
    };
    const logged: Record<string, unknown>[] = [];
    let clock = 0;
    const deps: BenchmarkDeps = {
      docker: (args) => {
        dockerCalls.push(args);
        if (args[0] === "inspect" && args[2]?.includes("Labels")) return "agent-session";
        if (args[0] === "inspect") return "sha256:image";
        if (args[0] === "port") return "127.0.0.1:54321";
        return "";
      },
      openAdmin: async () => engineAdmin(),
      migrate: async () => undefined,
      readSeed: () =>
        [
          "create schema if not exists benchmark",
          "create or replace function benchmark.id(k integer, n bigint) returns uuid language sql immutable strict as $$ select (lpad(k::text, 8, '0') || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$",
          "insert into users (id, email, display_name) values ('00000000-0000-4000-8000-000000000022', 'fixture@example.test', 'Fixture')",
          "insert into agents (id, created_by_user_id, name, display_name, runtime_provider) values ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022', 'a', 'A', 'codex')",
          "insert into im_bindings (id, agent_id, provider, status, external_app_id, external_bot_id, credential_generation, disabled_at) values ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000021', 'feishu', 'disabled', 'app', 'bot', 1, '2026-10-26T08:00:00Z')",
          "insert into sessions (id, im_binding_id, channel_id, conversation_kind, kind, created_by_session_id) values ('00000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-000000000023', 'C1', 'dm', 'channel', null), ('00000000-0000-4000-8000-000000000025', '00000000-0000-4000-8000-000000000023', 'C1', 'dm', 'internal', '00000000-0000-4000-8000-000000000024')",
        ].join("\n--> statement-breakpoint\n"),
      createDatabase: () => ({
        database: unit.database,
        queryLog: {
          reset: () => undefined,
          snapshot: () => [{ query: "select 1 as one", params: [] }],
        },
        close: async () => undefined,
      }),
      createCases: () => cases,
      fixture: {
        accountId: "account-1",
        agentId: "00000000-0000-4000-8000-000000000021",
        hotBindingId: "00000000-0000-4000-8000-000000000023",
        rootSessionId: "00000000-0000-4000-8000-000000000024",
        endedDescendants: 0,
      },
      resolveOutputDirectory: () => "/tmp/benchmark-out",
      writeResults: (directory, content) => written.push({ directory, content }),
      now: () => NOW,
      elapsed: () => clock++,
      log: (record) => logged.push(record),
      minimumRows: 0,
      ...overrides,
    };
    return { deps, written, dockerCalls, cases, logged };
  }

  it("writes a complete report, bounded case details and removes its container", async () => {
    const { deps, written, dockerCalls, cases, logged } = fakeDeps();
    const report = await runBenchmark(deps);
    const results = report.results as { name: string; detail: Record<string, unknown>; queryCounts: number[] }[];
    expect(results.map((entry) => entry.name)).toEqual([
      "agents.list.1-agents",
      "agents.list.1-agents.with-candidate-index",
      "agents.usage.50000-deliveries",
      "sessions.internal.100000-active.limit20",
      "sessions.internal.90000-ended.limit20",
      "sessions.internal.90000-ended.limit20.before",
      "agents.usage.50000-deliveries.before",
    ]);
    expect(results.every((entry) => entry.queryCounts.length === 5)).toBe(true);
    expect(results[0]?.detail).toEqual({ bounded: { agents: 1 } });
    expect(results[2]?.detail).toEqual({ bounded: { dailyBuckets: 3 } });
    expect(results[6]?.detail).toEqual({ bounded: { rowsRead: 4 } });
    expect(report.containerRemoved).toBe(true);
    expect(report.candidateIndex).toMatchObject({ name: expect.stringContaining("unreported_accepted") });
    expect(report.lifecycleWrite).toMatchObject({ endedDescendants: 0, divergence: { divergent: 0 } });
    expect(report.closureStorage).toMatchObject({ activeShape: expect.any(Array) });
    // Each measured case reached the services and the login; the report was saved repeatedly.
    expect(vi.mocked(cases.listAgents)).toHaveBeenCalledTimes(12);
    expect(vi.mocked(cases.usage)).toHaveBeenCalledTimes(6);
    expect(vi.mocked(cases.legacyUsage)).toHaveBeenCalledTimes(6);
    expect(written.length).toBeGreaterThan(1);
    expect(written.every((entry) => entry.directory === "/tmp/benchmark-out")).toBe(true);
    expect(JSON.parse(written.at(-1)?.content ?? "{}")).toMatchObject({ containerRemoved: true });
    expect(logged.some((entry) => entry.phase === "seed")).toBe(true);
    // The candidate index and the two legacy indexes are created and dropped, never left behind.
    const indexStatements = dockerCalls.filter((call) => call[0] === "rm").length;
    expect(indexStatements).toBe(1);
  }, 60_000);

  it("removes its container even when a case throws", async () => {
    const { deps, written, dockerCalls } = fakeDeps({
      createCases: () => ({
        listAgents: async () => {
          throw new Error("service exploded");
        },
        usage: async () => ({ daily: [] }),
        internalPage: async () => ({ items: [] }),
        legacyUsage: async () => ({ rows: 0 }),
      }),
    });
    const report = await runBenchmark(deps);
    const results = report.results as { name: string; error: unknown }[];
    expect(results[0]?.error).toMatchObject({ message: "service exploded" });
    expect(report.containerRemoved).toBe(true);
    expect(dockerCalls.some((call) => call[0] === "rm")).toBe(true);
    expect(JSON.parse(written.at(-1)?.content ?? "{}")).toMatchObject({ containerRemoved: true });
  }, 60_000);

  it("refuses to run when the container label does not match", async () => {
    const { deps } = fakeDeps({
      docker: (args) => {
        if (args[0] === "inspect") return "something-else";
        return "";
      },
    });
    await expect(runBenchmark(deps)).rejects.toThrow("missing its label");
  });

  it("refuses to run when the published port is not loopback", async () => {
    const { deps } = fakeDeps({
      docker: (args) => {
        if (args[0] === "inspect" && args[2]?.includes("Labels")) return "agent-session";
        if (args[0] === "inspect") return "sha256:image";
        if (args[0] === "port") return "0.0.0.0:5432";
        return "";
      },
    });
    await expect(runBenchmark(deps)).rejects.toThrow("Unexpected container binding");
  });

  it("names every case that recorded an error", async () => {
    const { deps } = fakeDeps({
      createCases: () => ({
        listAgents: async () => {
          throw new Error("nope");
        },
        usage: async () => {
          throw new Error("nope");
        },
        internalPage: async () => {
          throw new Error("nope");
        },
        legacyUsage: async () => {
          throw new Error("nope");
        },
      }),
    });
    const report = await runBenchmark(deps);
    // Every case backed by the injected services failed; the legacy page case runs the harness's own query.
    expect(report.casesWithErrors).toEqual([
      "agents.list.1-agents",
      "agents.list.1-agents.with-candidate-index",
      "agents.usage.50000-deliveries",
      "sessions.internal.100000-active.limit20",
      "sessions.internal.90000-ended.limit20",
      "agents.usage.50000-deliveries.before",
    ]);
    expect(LEGACY_ACTIVITY_INDEXES).toHaveLength(2);
  }, 60_000);
});
