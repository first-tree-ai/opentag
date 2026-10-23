import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { applyQueryDeadline, assertQueryDeadlineSupport } from "./query-deadline.js";
import * as schema from "./schema/index.js";
import {
  DATABASE_CONNECT_TIMEOUT_SECONDS,
  DATABASE_KEEP_ALIVE_SECONDS,
  type DatabaseTimeouts,
  DEFAULT_DATABASE_TIMEOUTS,
} from "./timeouts.js";

export interface DatabaseClientOptions extends Partial<DatabaseTimeouts> {
  max?: number;
  onQueryTimeout?: (event: { timeoutMs: number }) => void;
}

export function createDatabaseClient(databaseUrl: string, options: DatabaseClientOptions = {}) {
  const timeouts: DatabaseTimeouts = {
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_DATABASE_TIMEOUTS.statementTimeoutMs,
    queryTimeoutMs: options.queryTimeoutMs ?? DEFAULT_DATABASE_TIMEOUTS.queryTimeoutMs,
    idleInTransactionTimeoutMs:
      options.idleInTransactionTimeoutMs ?? DEFAULT_DATABASE_TIMEOUTS.idleInTransactionTimeoutMs,
  };
  const sql = postgres(databaseUrl, {
    max: options.max ?? 10,
    connect_timeout: DATABASE_CONNECT_TIMEOUT_SECONDS,
    keep_alive: DATABASE_KEEP_ALIVE_SECONDS,
    connection: {
      statement_timeout: timeouts.statementTimeoutMs,
      idle_in_transaction_session_timeout: timeouts.idleInTransactionTimeoutMs,
    },
    onnotice: () => undefined,
  });
  assertQueryDeadlineSupport(sql);
  applyQueryDeadline(sql, {
    timeoutMs: timeouts.queryTimeoutMs,
    ...(options.onQueryTimeout ? { onTimeout: options.onQueryTimeout } : {}),
  });
  const database = drizzle(sql, { schema });
  return { database, sql, timeouts };
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>["database"];
export type DatabaseTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];
