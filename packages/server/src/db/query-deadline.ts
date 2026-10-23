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
 * `savepoint`. postgres.js's own `begin`/`commit`/`rollback` statements use its internal Sql and
 * tagged templates, so only the `begin` statement (sent through the root `unsafe`) is covered.
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
    scope.begin = (...args: unknown[]) => begin(...wrapCallbackArgument(args, options));
  }
  const savepoint = scope.savepoint;
  if (savepoint) {
    scope.savepoint = (...args: unknown[]) => savepoint(...wrapCallbackArgument(args, options));
  }
}

// begin(fn) / begin(mode, fn) / savepoint(fn) / savepoint(name, fn): the callback is always last.
function wrapCallbackArgument(args: unknown[], options: QueryDeadlineOptions): unknown[] {
  const last = args.at(-1);
  if (typeof last !== "function") return args;
  const callback = last as ScopeCallback;
  return [
    ...args.slice(0, -1),
    (inner: unknown) => {
      if (inner && typeof inner === "function") wrapScope(inner as unknown as WrappableSql, options);
      return callback(inner);
    },
  ];
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
  // shortcut: after the deadline a black-holed connection stays busy until TCP gives up, because postgres.js has no public per-connection destroy; replace with a native per-query timeout or socket destroy when postgres.js offers one.
  return query;
}
