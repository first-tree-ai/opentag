/**
 * Client-side deadline for postgres.js queries.
 *
 * Invariant: every executed Query created through `unsafe` on a wrapped Sql (the root pool, a
 * transaction, or a savepoint scope) settles within `timeoutMs` of its creation, pool queue time
 * included. Server-side `statement_timeout` stays the primary bound. This deadline is the backstop
 * for a connection whose peer stopped answering after the query was sent: TCP keepalive does not
 * probe while data is unacknowledged, and Node cannot set TCP_USER_TIMEOUT.
 *
 * Boundary: drizzle's postgres-js session issues every query through `unsafe`, `begin`, and
 * `savepoint`. postgres.js sends `begin` and `commit`/`rollback` and `savepoint <name>` as tagged
 * templates on the scope Sql, which no wrapper can intercept, and it sends `SAVEPOINT <name>` before
 * it enters a nested callback. `begin` and `savepoint` are therefore bounded as a whole too: the
 * scope gets `timeoutMs` until the callback starts, and then again for the `commit`/`rollback` phase
 * after it settles. A callback that already failed on a query deadline rejects at once instead of
 * waiting for a rollback that the wedged connection cannot answer, and a scope whose pre-callback
 * deadline fired never enters its callback, even if the connection recovers afterwards.
 *
 * Depends on postgres.js 3.4.x internals: a Query instance has writable `resolve`/`reject` fields,
 * an `executed` flag, and `cancel()`. `assertQueryDeadlineSupport` fails fast when an upgrade
 * removes them, so the deadline is never lost silently.
 */
import type { Sql } from "postgres";

export class DatabaseQueryTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Database query exceeded the ${timeoutMs}ms client deadline`);
    this.name = "DatabaseQueryTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface QueryDeadlineOptions {
  timeoutMs: number;
  /** Receives no SQL text or parameters; callers log only the bound that fired. */
  onTimeout?: (event: { timeoutMs: number }) => void;
}

type DeadlineQuery = {
  resolve: (value: unknown) => unknown;
  reject: (reason: unknown) => unknown;
  cancel: () => Promise<void> | undefined | null | false;
  executed: boolean;
};

type UnsafeFunction = (...args: unknown[]) => DeadlineQuery;
type ScopeCallback = (sql: unknown) => unknown;
type WrappableSql = {
  unsafe: UnsafeFunction;
  begin?: (...args: unknown[]) => unknown;
  savepoint?: (...args: unknown[]) => unknown;
};

/** Result of the caller's transaction callback; `error` is set when it rejected or threw. */
type CallbackOutcome = { error?: unknown };
/**
 * `entered` resolves when postgres.js calls the callback; `settled` when it finishes. Both are absent
 * when the call carries no callback, so there is no phase boundary to watch.
 */
type TrackedCallback = {
  args: unknown[];
  entered?: Promise<void>;
  settled?: Promise<CallbackOutcome>;
};

const wrapped = new WeakSet<object>();

export function assertQueryDeadlineSupport(sql: Sql): void {
  const unsafe = (sql as unknown as Partial<WrappableSql>).unsafe;
  // Building a Query does not execute it; it only runs once awaited.
  const probe = (typeof unsafe === "function" ? unsafe("select 1") : {}) as Partial<DeadlineQuery>;
  if (
    typeof probe.resolve !== "function" ||
    typeof probe.reject !== "function" ||
    typeof probe.cancel !== "function" ||
    typeof probe.executed !== "boolean"
  ) {
    throw new Error(
      "postgres.js Query no longer exposes resolve/reject/cancel/executed; the query deadline needs updating",
    );
  }
}

/** Mutates `sql` in place so postgres.js's internal `sql.unsafe('begin …')` is also bounded. */
export function applyQueryDeadline<T extends Sql>(sql: T, options: QueryDeadlineOptions): T {
  wrapScope(sql as unknown as WrappableSql, options);
  return sql;
}

function wrapScope(scope: WrappableSql, options: QueryDeadlineOptions): void {
  if (wrapped.has(scope)) return;
  wrapped.add(scope);

  const unsafe = scope.unsafe;
  scope.unsafe = (...args: unknown[]) => withDeadline(unsafe(...args), options);

  const begin = scope.begin;
  if (begin) {
    scope.begin = (...args: unknown[]) => boundScopeCall(begin, args, options);
  }
  const savepoint = scope.savepoint;
  if (savepoint) {
    scope.savepoint = (...args: unknown[]) => boundScopeCall(savepoint, args, options);
  }
}

/**
 * Shared between the scope deadline and the callback wrapper: set when the pre-entry deadline fired.
 * A connection that heals before TCP gives up resumes `savepoint <name>` and would then enter a
 * callback whose caller was already rejected and whose statements autocommit outside the rolled-back
 * transaction. The wrapper refuses to run user code once this is set.
 */
type ScopeExpiry = { expired: boolean };

function boundScopeCall(
  call: (...args: unknown[]) => unknown,
  args: unknown[],
  options: QueryDeadlineOptions,
): unknown {
  const expiry: ScopeExpiry = { expired: false };
  const callback = trackCallback(args, expiry, options);
  const pending = call(...callback.args);
  if (!callback.settled || !callback.entered) return pending;
  return withScopeDeadline(
    pending as Promise<unknown>,
    { entered: callback.entered, settled: callback.settled },
    expiry,
    options,
  );
}

// begin(fn) / begin(mode, fn) / savepoint(fn) / savepoint(name, fn): the callback is always last.
function trackCallback(args: unknown[], expiry: ScopeExpiry, options: QueryDeadlineOptions): TrackedCallback {
  const last = args.at(-1);
  if (typeof last !== "function") return { args };
  const callback = last as ScopeCallback;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let settle!: (outcome: CallbackOutcome) => void;
  const settled = new Promise<CallbackOutcome>((resolve) => {
    settle = resolve;
  });
  return {
    args: [
      ...args.slice(0, -1),
      (inner: unknown) => {
        enter();
        // postgres.js resumes this scope after a healed connection, long after the caller gave up.
        // Throwing here makes it send `rollback`/`rollback to <name>` and rethrow to its caller.
        if (expiry.expired) throw new DatabaseQueryTimeoutError(options.timeoutMs);
        if (inner && typeof inner === "function") wrapScope(inner as unknown as WrappableSql, options);
        let result: unknown;
        try {
          result = callback(inner);
        } catch (error) {
          settle({ error });
          throw error;
        }
        // Observe settlement without changing the value postgres.js awaits; it awaits an array as Promise.all.
        void Promise.resolve(Array.isArray(result) ? Promise.all(result) : result).then(
          () => settle({}),
          (error: unknown) => settle({ error }),
        );
        return result;
      },
    ],
    entered,
    settled,
  };
}

const CAUSE_CHAIN_LIMIT = 8;

/** Drizzle wraps driver errors, so the deadline error can sit behind one or more `cause` links. */
function isQueryDeadline(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < CAUSE_CHAIN_LIMIT && current && typeof current === "object"; depth += 1) {
    if (current instanceof DatabaseQueryTimeoutError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Bounds both scope phases the wrapped `unsafe` cannot see: the statement postgres.js sends before it
 * calls the callback (`BEGIN`, `SAVEPOINT <name>`), and the `commit`/`rollback` it sends after.
 *
 * Invariant: the pre-entry phase marks `expiry` before it rejects, so a connection that heals later
 * cannot enter the callback of a scope whose caller already gave up.
 *
 * Boundary: rejecting here unblocks the caller; it cannot free the connection, which stays busy
 * until TCP gives up, exactly like the `shortcut:` below.
 */
function withScopeDeadline<T>(
  pending: Promise<T>,
  { entered, settled }: { entered: Promise<void>; settled: Promise<CallbackOutcome> },
  expiry: ScopeExpiry,
  options: QueryDeadlineOptions,
): Promise<T> {
  const { timeoutMs } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reject!: (error: unknown) => void;
  let done = false;
  const clearTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const armTimer = (phase: "before-callback" | "after-callback") => {
    timer = setTimeout(() => {
      if (phase === "before-callback") expiry.expired = true;
      options.onTimeout?.({ timeoutMs });
      reject(new DatabaseQueryTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  };
  const deadline = new Promise<never>((_resolve, onReject) => {
    reject = onReject;
    // Phase one: postgres.js sends `SAVEPOINT <name>` before it enters a nested callback. If the
    // connection goes silent there, the callback never runs and no other bound exists.
    armTimer("before-callback");
    void entered.then(() => {
      if (!done) clearTimer();
    });
    void settled.then(({ error }) => {
      if (done) return;
      if (isQueryDeadline(error)) {
        reject(error);
        return;
      }
      // Phase two: the commit or rollback that follows the callback.
      armTimer("after-callback");
    });
  });
  return Promise.race([pending, deadline]).finally(() => {
    done = true;
    clearTimer();
  });
}

function withDeadline(query: DeadlineQuery, options: QueryDeadlineOptions): DeadlineQuery {
  const { timeoutMs } = options;
  let timedOut = false;
  const resolve = query.resolve;
  const reject = query.reject;
  const timer = setTimeout(() => {
    // A Query that nobody awaited never ran; rejecting it would only raise an unhandled rejection.
    if (!query.executed) return;
    timedOut = true;
    // cancel() must run before reject(): it reads `active` to decide whether to send a CancelRequest.
    try {
      const cancelled = query.cancel();
      if (cancelled) cancelled.catch(() => undefined);
    } catch {
      // Best effort. The rejection below unblocks the caller either way.
    }
    query.reject(new DatabaseQueryTimeoutError(timeoutMs));
    options.onTimeout?.({ timeoutMs });
  }, timeoutMs);
  timer.unref?.();

  query.resolve = (value) => {
    clearTimeout(timer);
    return resolve(value);
  };
  // A queued Query that cancel() removes is rejected with 57014; report the deadline instead.
  query.reject = (reason) => {
    clearTimeout(timer);
    return reject(timedOut ? new DatabaseQueryTimeoutError(timeoutMs) : reason);
  };
  // shortcut: after the deadline a black-holed connection stays busy until TCP gives up, and one that recovers instead stays reserved inside the open transaction until idle_in_transaction_session_timeout ends it, because postgres.js has no public per-connection destroy; replace with a native per-query timeout or socket destroy when postgres.js offers one.
  return query;
}
