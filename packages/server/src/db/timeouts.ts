/**
 * Default bounds for the Server's PostgreSQL pool.
 *
 * Invariant: DEFAULT_QUERY_TIMEOUT_MS > DEFAULT_STATEMENT_TIMEOUT_MS, so in the normal case the server
 * cancels a slow statement first and the client-side deadline only fires when the server cannot answer.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 35_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
export const DATABASE_KEEP_ALIVE_SECONDS = 10;
export const DATABASE_CONNECT_TIMEOUT_SECONDS = 10;

export interface DatabaseTimeouts {
  statementTimeoutMs: number;
  queryTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

export const DEFAULT_DATABASE_TIMEOUTS: DatabaseTimeouts = {
  statementTimeoutMs: DEFAULT_STATEMENT_TIMEOUT_MS,
  queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
  idleInTransactionTimeoutMs: DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
};
