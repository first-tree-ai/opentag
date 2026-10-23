import postgres, { type Sql } from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyQueryDeadline, assertQueryDeadlineSupport, DatabaseQueryTimeoutError } from "../db/query-deadline.js";

/** Copies the postgres.js 3.4 Query surface the deadline relies on: lazy execution and instance resolve/reject. */
class FakeQuery extends Promise<unknown> {
  resolve!: (value: unknown) => void;
  reject!: (reason: unknown) => void;
  executed = false;
  options: { values?: boolean } = {};
  readonly cancel = vi.fn(() => Promise.resolve());

  static override get [Symbol.species]() {
    return Promise;
  }

  constructor(readonly text: string) {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    super((a, b) => {
      resolve = a;
      reject = b;
    });
    this.resolve = resolve;
    this.reject = reject;
  }

  values() {
    if (this.executed) throw new Error("values() after execution");
    this.options.values = true;
    return this;
  }

  // biome-ignore lint/suspicious/noThenProperty: mirrors postgres.js Query, which executes on then().
  override then<A = unknown, B = never>(
    onFulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.executed = true;
    return super.then(onFulfilled, onRejected);
  }
}

/** Mirrors postgres.js `begin`: run the callback, then `commit` on success or `rollback` on failure. */
type ScopePhase = () => Promise<unknown>;

function fakeSql(phases: { commit?: ScopePhase; rollback?: ScopePhase; openSavepoint?: ScopePhase } = {}) {
  const created: FakeQuery[] = [];
  const unsafe = (text: string) => {
    const query = new FakeQuery(text);
    created.push(query);
    return query;
  };
  const run = async (callback: (inner: unknown) => unknown, commit: ScopePhase, rollback: ScopePhase) => {
    try {
      const result = await callback(makeScope());
      await commit();
      return result;
    } catch (error) {
      await rollback();
      throw error;
    }
  };
  const makeScope = (): Record<string, unknown> => {
    const scope = Object.assign(() => undefined, { unsafe }) as unknown as Record<string, unknown>;
    // postgres.js sends `savepoint <name>` before it calls the nested callback.
    scope.savepoint = async (...args: unknown[]) => {
      await (phases.openSavepoint ?? (async () => undefined))();
      return run(
        args.at(-1) as (inner: unknown) => unknown,
        async () => undefined,
        phases.rollback ?? (async () => undefined),
      );
    };
    return scope;
  };
  const root = makeScope();
  root.begin = (...args: unknown[]) =>
    run(
      args.at(-1) as (tx: unknown) => unknown,
      phases.commit ?? (async () => undefined),
      phases.rollback ?? (async () => undefined),
    );
  return { root: root as unknown as Sql, created };
}

/** A wrapped `begin`/`savepoint`: it runs the callback and returns the transaction phase's promise. */
type ScopeCall = (callback: (scope: Record<string, unknown>) => unknown) => Promise<unknown>;

const asBegin = (root: Sql) => root.begin as unknown as ScopeCall;

afterEach(() => {
  vi.useRealTimers();
});

describe("applyQueryDeadline", () => {
  it("rejects an executed query with DatabaseQueryTimeoutError and asks the server to cancel", async () => {
    vi.useFakeTimers();
    const { root, created } = fakeSql();
    const onTimeout = vi.fn();
    applyQueryDeadline(root, { timeoutMs: 1_000, onTimeout });

    const pending = root.unsafe("select pg_sleep(60)");
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await outcome;
    expect(error).toBeInstanceOf(DatabaseQueryTimeoutError);
    expect((error as DatabaseQueryTimeoutError).timeoutMs).toBe(1_000);
    expect(created[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({ timeoutMs: 1_000 });
    expect(JSON.stringify(onTimeout.mock.calls)).not.toContain("pg_sleep");
  });

  it("reports the deadline even when cancel() rejects a queued query with its own error", async () => {
    vi.useFakeTimers();
    const { root, created } = fakeSql();
    applyQueryDeadline(root, { timeoutMs: 500 });

    const outcome = root.unsafe("select 1").then(
      () => "resolved",
      (error: unknown) => error,
    );
    const query = created[0];
    if (!query) throw new Error("query was not created");
    query.cancel.mockImplementation(() => {
      query.reject(Object.assign(new Error("canceling statement due to user request"), { code: "57014" }));
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(await outcome).toBeInstanceOf(DatabaseQueryTimeoutError);
  });

  it("clears the deadline when the query settles in time", async () => {
    vi.useFakeTimers();
    const { root, created } = fakeSql();
    const onTimeout = vi.fn();
    applyQueryDeadline(root, { timeoutMs: 1_000, onTimeout });

    const pending = root.unsafe("select 1");
    created[0]?.resolve([{ value: 1 }]);
    await expect(pending).resolves.toEqual([{ value: 1 }]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(created[0]?.cancel).not.toHaveBeenCalled();
  });

  it("keeps the query lazy so drizzle can still call values() before execution", () => {
    const { root, created } = fakeSql();
    applyQueryDeadline(root, { timeoutMs: 1_000 });

    const query = root.unsafe("select 1") as unknown as FakeQuery;

    expect(query.executed).toBe(false);
    expect(query.values().options.values).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("does not reject a query that was never awaited", async () => {
    vi.useFakeTimers();
    const { root, created } = fakeSql();
    const onTimeout = vi.fn();
    applyQueryDeadline(root, { timeoutMs: 1_000, onTimeout });

    root.unsafe("select 1");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onTimeout).not.toHaveBeenCalled();
    expect(created[0]?.cancel).not.toHaveBeenCalled();
  });

  it("bounds queries inside transactions and savepoints", async () => {
    vi.useFakeTimers();
    const { root } = fakeSql();
    applyQueryDeadline(root, { timeoutMs: 1_000 });

    const outcomes: Promise<unknown>[] = [];
    (root.begin as unknown as (mode: string, fn: (tx: Sql) => unknown) => unknown)(
      "isolation level serializable",
      (tx) => {
        outcomes.push(tx.unsafe("select 1").then(undefined, (error: unknown) => error));
        ((tx as unknown as { savepoint: unknown }).savepoint as (fn: (inner: Sql) => unknown) => unknown)((inner) => {
          outcomes.push(inner.unsafe("select 2").then(undefined, (error: unknown) => error));
        });
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);

    const errors = await Promise.all(outcomes);
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error instanceof DatabaseQueryTimeoutError)).toBe(true);
  });

  it("rejects at once when the callback already hit a query deadline", async () => {
    const deadline = new DatabaseQueryTimeoutError(1_000);
    const rollback = vi.fn(() => new Promise<never>(() => undefined));
    const { root } = fakeSql({ rollback });
    applyQueryDeadline(root, { timeoutMs: 1_000 });

    const outcome = asBegin(root)(async () => {
      throw deadline;
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );

    // No timer at all: the caller learns the outcome without waiting for the wedged rollback.
    expect(await outcome).toBe(deadline);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("bounds a commit that never settles", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { root } = fakeSql({ commit: () => new Promise<never>(() => undefined) });
    applyQueryDeadline(root, { timeoutMs: 1_000, onTimeout });

    const outcome = asBegin(root)(async () => "done").then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toBeInstanceOf(DatabaseQueryTimeoutError);
    expect(onTimeout).toHaveBeenCalledWith({ timeoutMs: 1_000 });
  });

  it("bounds a savepoint rollback that never settles", async () => {
    vi.useFakeTimers();
    const { root } = fakeSql({ rollback: () => new Promise<never>(() => undefined) });
    applyQueryDeadline(root, { timeoutMs: 1_000 });

    const outcomes: Promise<unknown>[] = [];
    asBegin(root)((scope) => {
      const savepoint = scope.savepoint as ScopeCall;
      outcomes.push(
        savepoint(async () => {
          throw new Error("inner failure");
        }).then(
          () => "resolved",
          (error: unknown) => error,
        ),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcomes[0]).toBeInstanceOf(DatabaseQueryTimeoutError);
  });

  it("bounds a savepoint whose opening statement never returns", async () => {
    vi.useFakeTimers();
    const { root } = fakeSql({ openSavepoint: () => new Promise<never>(() => undefined) });
    applyQueryDeadline(root, { timeoutMs: 1_000 });

    const outcomes: Promise<unknown>[] = [];
    asBegin(root)((scope) => {
      outcomes.push(
        (scope.savepoint as ScopeCall)(async () => "inner").then(
          () => "resolved",
          (error: unknown) => error,
        ),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcomes[0]).toBeInstanceOf(DatabaseQueryTimeoutError);
  });

  it("leaves the callback uncalled when the connection heals after the savepoint deadline", async () => {
    vi.useFakeTimers();
    let heal!: () => void;
    const opening = new Promise<void>((resolve) => {
      heal = resolve;
    });
    const { root } = fakeSql({ openSavepoint: () => opening });
    applyQueryDeadline(root, { timeoutMs: 1_000 });

    const inner = vi.fn(async () => "inner");
    const outcomes: Promise<unknown>[] = [];
    asBegin(root)((scope) => {
      outcomes.push(
        (scope.savepoint as ScopeCall)(inner).then(
          () => "resolved",
          (error: unknown) => error,
        ),
      );
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcomes[0]).toBeInstanceOf(DatabaseQueryTimeoutError);

    // The network heals: postgres.js resumes `savepoint s0` and would now enter the callback.
    heal();
    await vi.advanceTimersByTimeAsync(0);

    expect(inner).not.toHaveBeenCalled();
  });

  it("wraps a scope only once", () => {
    const { root } = fakeSql();
    applyQueryDeadline(root, { timeoutMs: 1_000 });
    const unsafe = root.unsafe;

    applyQueryDeadline(root, { timeoutMs: 1_000 });

    expect(root.unsafe).toBe(unsafe);
  });
});

describe("assertQueryDeadlineSupport", () => {
  it("accepts the installed postgres.js without opening a connection", async () => {
    const sql = postgres("postgres://user:pass@127.0.0.1:1/none", { max: 1, connect_timeout: 1 });
    try {
      expect(() => assertQueryDeadlineSupport(sql)).not.toThrow();
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it("fails fast when a Query no longer exposes the internals", () => {
    const sql = { unsafe: () => Promise.resolve([]) } as unknown as Sql;

    expect(() => assertQueryDeadlineSupport(sql)).toThrow(/query deadline needs updating/);
  });
});
