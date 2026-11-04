import postgres, { type Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { DatabaseQueryTimeoutError } from "../db/query-deadline.js";
import { instrumentDatabaseSql, summarizeSqlQuery } from "../db/query-performance.js";
import { createPerformanceLogger } from "../observability/performance-logger.js";

class FakeQuery extends Promise<unknown> {
  executed = false;
  strings: readonly string[] = [];
  args: readonly unknown[] = [];
  options?: { no_pipeline?: boolean; query_timeout?: number };
  resolve!: (value: unknown) => void;
  reject!: (error: unknown) => void;
  #executeImpl!: () => Promise<unknown>;

  static override get [Symbol.species]() {
    return Promise;
  }

  static create(
    strings: readonly string[],
    args: readonly unknown[],
    executeImpl: () => Promise<unknown>,
    options?: { no_pipeline?: boolean },
  ): FakeQuery {
    let resolveOuter!: (value: unknown) => void;
    let rejectOuter!: (error: unknown) => void;
    const query = new FakeQuery((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
    query.strings = strings;
    query.args = args;
    query.options = options;
    query.resolve = resolveOuter;
    query.reject = rejectOuter;
    query.#executeImpl = executeImpl;
    return query;
  }

  async handle(): Promise<void> {
    if (this.executed) return;
    this.executed = true;
    try {
      const result = await this.#executeImpl();
      this.resolve(result);
    } catch (error) {
      this.reject(error);
    }
  }

  values(): this {
    return this;
  }

  // biome-ignore lint/suspicious/noThenProperty: postgres.js Query subclasses Promise and overrides then
  override then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    void this.handle();
    return super.then(onfulfilled, onrejected);
  }
}

function createFakeQuery(
  strings: readonly string[],
  args: readonly unknown[],
  executeImpl: () => Promise<unknown>,
  options?: { no_pipeline?: boolean },
): FakeQuery {
  return FakeQuery.create(strings, args, executeImpl, options);
}

function createFakeSql(handler: (sqlText: string, args: readonly unknown[]) => Promise<unknown>): Sql {
  const fn = ((strings: TemplateStringsArray, ...args: unknown[]) =>
    createFakeQuery(strings, args, () => handler(strings.join("$"), args))) as unknown as Sql;

  Object.assign(fn, {
    unsafe: (query: string, args: unknown[] = [], options?: { no_pipeline?: boolean }) =>
      createFakeQuery([query], args, () => handler(query, args), options),
    begin: async (callback: (tx: Sql) => Promise<unknown>) => {
      const tx = createFakeSql(handler);
      Object.assign(tx, {
        savepoint: async (spCallback: (sp: Sql) => Promise<unknown>) => spCallback(createFakeSql(handler)),
      });
      return callback(tx);
    },
    reserve: async () => createFakeSql(handler),
  });
  return fn;
}

describe("database query performance logging", () => {
  it("extracts safe SQL command, target table, and parameter count without exposing literals or params", () => {
    expect(
      summarizeSqlQuery(
        ['select "id", "email" from "accounts" where "email" = $1 and "password_hash" = $2'],
        ["victim@example.com", "secret-hash"],
      ),
    ).toEqual({
      sqlCommand: "SELECT",
      dbTarget: "accounts",
      paramCount: 2,
    });

    expect(
      summarizeSqlQuery(['/* comment */\nINSERT INTO "im_messages" ("id", "content") VALUES ($1, $2)'], ["1", "hello"]),
    ).toEqual({
      sqlCommand: "INSERT",
      dbTarget: "im_messages",
      paramCount: 2,
    });

    expect(summarizeSqlQuery(['UPDATE "agents" SET "status" = $1 WHERE "id" = $2'], ["active", "a-1"])).toEqual({
      sqlCommand: "UPDATE",
      dbTarget: "agents",
      paramCount: 2,
    });

    for (const literalSql of [
      "select 'from REVIEW_PRIVATE_LITERAL_BODY'::integer",
      "select 'it''s from REVIEW_PRIVATE_LITERAL_BODY'::text",
      "select E'it\\'s from REVIEW_PRIVATE_LITERAL_BODY'::text",
      "select E'a\\', from REVIEW_PRIVATE_LITERAL_BODY'",
      "select 'a\\', 'from REVIEW_PRIVATE_LITERAL_BODY'",
      "select 'C:\\' as p, 'x from REVIEW_PRIVATE_LITERAL_BODY'",
      "select $$from REVIEW_PRIVATE_LITERAL_BODY$$::integer",
      "select $tag$from REVIEW_PRIVATE_LITERAL_BODY$tag$::integer",
      "select $中$x from REVIEW_LITERAL_AFTER_UNICODE$中$::integer",
      "select '/* open' as a, 'close */ from REVIEW_PRIVATE_LITERAL_BODY' as b",
      "select 'from REVIEW_PRIVATE_LITERAL_BODY",
      "select $$from REVIEW_PRIVATE_LITERAL_BODY",
      'select "from REVIEW_PRIVATE_LITERAL_BODY"',
    ]) {
      const summary = summarizeSqlQuery([literalSql], []);
      expect(summary).toEqual({
        sqlCommand: "SELECT",
        paramCount: 0,
      });
      expect(summary.dbTarget).toBeUndefined();
    }

    expect(summarizeSqlQuery(["select 'from REVIEW_PRIVATE_LITERAL_BODY' as label from \"accounts\""], [])).toEqual({
      sqlCommand: "SELECT",
      dbTarget: "accounts",
      paramCount: 0,
    });

    expect(
      summarizeSqlQuery(["SELECT * FROM im_message_deliveries WHERE state = $1 FOR UPDATE SKIP LOCKED"], ["pending"]),
    ).toEqual({
      sqlCommand: "SELECT",
      dbTarget: "im_message_deliveries",
      paramCount: 1,
    });

    expect(
      summarizeSqlQuery(
        ["SELECT w.id FROM slack_working_messages w WHERE w.due_at <= now() FOR UPDATE OF w SKIP LOCKED"],
        [],
      ),
    ).toEqual({
      sqlCommand: "SELECT",
      dbTarget: "slack_working_messages",
      paramCount: 0,
    });

    expect(summarizeSqlQuery(["SELECT * FROM runtime_approvals WHERE id = $1 FOR UPDATE NOWAIT"], ["app-1"])).toEqual({
      sqlCommand: "SELECT",
      dbTarget: "runtime_approvals",
      paramCount: 1,
    });

    expect(
      summarizeSqlQuery(["SELECT * FROM sandboxes WHERE status = $1 FOR NO KEY UPDATE SKIP LOCKED"], ["idle"]),
    ).toEqual({
      sqlCommand: "SELECT",
      dbTarget: "sandboxes",
      paramCount: 1,
    });

    expect(
      summarizeSqlQuery(
        [
          "WITH claimed AS (SELECT id FROM im_message_deliveries WHERE state = 'pending' FOR UPDATE SKIP LOCKED) UPDATE im_message_deliveries SET state = 'claimed' FROM claimed WHERE im_message_deliveries.id = claimed.id",
        ],
        [],
      ),
    ).toEqual({
      sqlCommand: "WITH",
      dbTarget: "im_message_deliveries",
      paramCount: 0,
    });

    expect(
      summarizeSqlQuery(
        [
          "WITH due AS (SELECT id FROM agent_schedules WHERE next_run_at <= now() FOR UPDATE SKIP LOCKED) SELECT * FROM due",
        ],
        [],
      ),
    ).toEqual({
      sqlCommand: "WITH",
      dbTarget: "agent_schedules",
      paramCount: 0,
    });

    expect(
      summarizeSqlQuery(
        ["INSERT INTO agents (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET updated_at = now()"],
        ["agent-1"],
      ),
    ).toEqual({
      sqlCommand: "INSERT",
      dbTarget: "agents",
      paramCount: 1,
    });
  });

  it("never leaks single-quoted or dollar-quoted SQL literal bodies into dbTarget on success or 22P02 warn failure", async () => {
    const literalQueries = [
      "select 'from REVIEW_PRIVATE_LITERAL_BODY'::integer",
      "select $$from REVIEW_PRIVATE_LITERAL_BODY$$::integer",
      "select $tag$from REVIEW_PRIVATE_LITERAL_BODY$tag$::integer",
      "select $中$x from REVIEW_LITERAL_AFTER_UNICODE$中$::integer",
      "select E'it\\'s from REVIEW_PRIVATE_LITERAL_BODY'::integer",
      "select E'a\\', from REVIEW_PRIVATE_LITERAL_BODY'::integer",
      "select 'a\\', 'from REVIEW_PRIVATE_LITERAL_BODY'",
      "select 'C:\\' as p, 'x from REVIEW_PRIVATE_LITERAL_BODY'",
    ];

    const debugRecords: Array<{ level: string; payload: Record<string, unknown>; message: string }> = [];
    const debugPerfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          debug: (payload: Record<string, unknown>, message: string) =>
            debugRecords.push({ level: "debug", payload, message }),
          info: (payload: Record<string, unknown>, message: string) =>
            debugRecords.push({ level: "info", payload, message }),
          warn: (payload: Record<string, unknown>, message: string) =>
            debugRecords.push({ level: "warn", payload, message }),
        }) as never,
    );

    const successSql = instrumentDatabaseSql(
      createFakeSql(async () => [{ value: 1 }]),
      debugPerfLogger,
    );
    for (const queryText of literalQueries) {
      await successSql.unsafe(queryText);
    }

    expect(debugRecords).toHaveLength(literalQueries.length * 2);
    for (const record of debugRecords) {
      expect(record.payload.sqlCommand).toBe("SELECT");
      expect(record.payload.dbTarget).toBeUndefined();
      expect("dbTarget" in record.payload).toBe(false);
    }
    expect(JSON.stringify(debugRecords)).not.toContain("REVIEW_PRIVATE_LITERAL_BODY");
    expect(JSON.stringify(debugRecords)).not.toContain("REVIEW_LITERAL_AFTER_UNICODE");

    const chunks: string[] = [];
    const app = createApp({
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
      performanceLogging: { enabled: false },
    });
    try {
      const warnPerfLogger = createPerformanceLogger(() => app.log, {
        enabled: true,
        level: "debug",
      });
      const failingSql = instrumentDatabaseSql(
        createFakeSql(async (queryText) => {
          throw Object.assign(new Error(`invalid input syntax for type integer: ${queryText}`), {
            code: "22P02",
          });
        }),
        warnPerfLogger,
      );

      for (const queryText of literalQueries) {
        await expect(failingSql.unsafe(queryText)).rejects.toThrow();
      }
    } finally {
      await app.close();
    }

    const emittedWarnRecords = chunks
      .flatMap((chunk) => chunk.trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failedQueryRecords = emittedWarnRecords.filter(
      (record) => record.operation === "db.query" && record.outcome === "failed",
    );
    expect(failedQueryRecords).toHaveLength(literalQueries.length);
    for (const record of failedQueryRecords) {
      expect(record).toMatchObject({
        module: "database",
        perfCategory: "db",
        operation: "db.query",
        sqlCommand: "SELECT",
        sqlState: "22P02",
        code: "DATABASE_QUERY_FAILED",
        errorCode: "DATABASE_QUERY_FAILED",
        outcome: "failed",
      });
      expect(record.dbTarget).toBeUndefined();
      expect("dbTarget" in record).toBe(false);
    }
    expect(chunks.join("")).not.toContain("REVIEW_PRIVATE_LITERAL_BODY");
    expect(chunks.join("")).not.toContain("REVIEW_LITERAL_AFTER_UNICODE");
  });

  it("emits started and completed logs for tagged-template, unsafe, and transactional queries", async () => {
    const logs: Array<{ level: string; payload: Record<string, unknown>; message: string }> = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          debug: (payload: Record<string, unknown>, message: string) => logs.push({ level: "debug", payload, message }),
          info: (payload: Record<string, unknown>, message: string) => logs.push({ level: "info", payload, message }),
          warn: (payload: Record<string, unknown>, message: string) => logs.push({ level: "warn", payload, message }),
        }) as never,
    );

    const rawSql = createFakeSql(async () => [{ id: "1" }, { id: "2" }]);
    const sql = instrumentDatabaseSql(rawSql, perfLogger);

    const secretParam = "NEVER_LOG_THIS_PARAMETER_SECRET";
    const rows = await sql.unsafe('select * from "agents" where "secret" = $1', [secretParam]);
    expect(rows).toHaveLength(2);

    await sql.begin(async (tx) => {
      await tx`update "computers" set "status" = ${"online"} where "id" = ${secretParam}`;
    });

    const queryStarts = logs.filter((l) => l.payload.operation === "db.query" && l.payload.outcome === "started");
    const queryEnds = logs.filter((l) => l.payload.operation === "db.query" && l.payload.outcome === "completed");
    const txStarts = logs.filter((l) => l.payload.operation === "db.transaction" && l.payload.outcome === "started");
    const txEnds = logs.filter((l) => l.payload.operation === "db.transaction" && l.payload.outcome === "completed");

    expect(queryStarts).toHaveLength(2);
    expect(queryEnds).toHaveLength(2);
    expect(txStarts).toHaveLength(1);
    expect(txEnds).toHaveLength(1);

    expect(queryStarts[0]?.payload).toMatchObject({
      module: "database",
      perfCategory: "db",
      operation: "db.query",
      sqlCommand: "SELECT",
      dbTarget: "agents",
      paramCount: 1,
      outcome: "started",
    });
    expect(queryEnds[0]?.payload).toMatchObject({
      callId: queryStarts[0]?.payload.callId,
      startedAt: queryStarts[0]?.payload.startedAt,
      rowCount: 2,
      outcome: "completed",
    });
    expect(queryEnds[0]?.payload.durationMs).toBeGreaterThanOrEqual(0);

    // Transactional query carries inTransaction=true and links to the parent transaction callId
    expect(queryStarts[1]?.payload).toMatchObject({
      sqlCommand: "UPDATE",
      dbTarget: "computers",
      inTransaction: true,
      parentCallId: txStarts[0]?.payload.callId,
      callerOperation: "db.transaction",
    });

    expect(JSON.stringify(logs)).not.toContain(secretParam);
  });

  it("does not emit logs for lazy queries that are never awaited or for readiness no_pipeline probes, and leaves sql unproxied when disabled", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          debug: (payload: Record<string, unknown>) => logs.push(payload),
          info: (payload: Record<string, unknown>) => logs.push(payload),
          warn: (payload: Record<string, unknown>) => logs.push(payload),
        }) as never,
    );
    const disabledPerf = createPerformanceLogger(() => undefined, { enabled: false });

    const realSql = postgres("postgresql://unused/unused");
    try {
      expect(instrumentDatabaseSql(realSql, disabledPerf)).toBe(realSql);
      const instrumented = instrumentDatabaseSql(realSql, perfLogger);
      const lazy = instrumented.unsafe('select * from "users"').values();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((lazy as unknown as { executed: boolean }).executed).toBe(false);
      expect(logs).toEqual([]);
    } finally {
      await realSql.end({ timeout: 0 });
    }

    const fakeSql = instrumentDatabaseSql(
      createFakeSql(async () => [{ "?column?": 1 }]),
      perfLogger,
    );
    await fakeSql.unsafe("select 1", [], { no_pipeline: true });
    expect(logs).toEqual([]);
  });

  it("records SQLSTATE and timeout error codes on failed queries", async () => {
    const logs: Array<{ level: string; payload: Record<string, unknown> }> = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          debug: (payload: Record<string, unknown>) => logs.push({ level: "debug", payload }),
          info: (payload: Record<string, unknown>) => logs.push({ level: "info", payload }),
          warn: (payload: Record<string, unknown>) => logs.push({ level: "warn", payload }),
        }) as never,
    );

    let mode: "sqlstate" | "timeout" = "sqlstate";
    const sql = instrumentDatabaseSql(
      createFakeSql(async () => {
        if (mode === "sqlstate") {
          throw Object.assign(new Error("unique violation detail secret"), { code: "23505" });
        }
        throw new DatabaseQueryTimeoutError(35_000);
      }),
      perfLogger,
    );

    await expect(sql.unsafe('insert into "accounts" values ($1)', ["secret"])).rejects.toThrow();
    mode = "timeout";
    await expect(sql.unsafe('select * from "accounts"')).rejects.toThrow(DatabaseQueryTimeoutError);

    const failed = logs.filter((l) => l.payload.outcome === "failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]?.payload).toMatchObject({
      sqlCommand: "INSERT",
      dbTarget: "accounts",
      sqlState: "23505",
      code: "DATABASE_QUERY_FAILED",
      errorCode: "DATABASE_QUERY_FAILED",
    });
    expect(failed[1]?.payload).toMatchObject({
      sqlCommand: "SELECT",
      dbTarget: "accounts",
      code: "DATABASE_QUERY_TIMEOUT",
      errorCode: "DATABASE_QUERY_TIMEOUT",
    });
    expect(JSON.stringify(logs)).not.toContain("unique violation detail secret");
  });
});
