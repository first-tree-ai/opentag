import type { Sql } from "postgres";

export class DatabaseQueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Database query exceeded the ${timeoutMs}ms client deadline`);
    this.name = "DatabaseQueryTimeoutError";
  }
}

export interface QueryDeadlineOptions {
  timeoutMs: number;
  onTimeout?: (event: { timeoutMs: number }) => void;
}

export function assertQueryDeadlineSupport(sql: Sql): void {
  if (typeof sql.setQueryDeadline !== "function") {
    throw new Error("postgres.js is missing the pinned query deadline and connection disposal extension");
  }
}

export function applyQueryDeadline<T extends Sql>(sql: T, options: QueryDeadlineOptions): T {
  assertQueryDeadlineSupport(sql);
  sql.setQueryDeadline(options.timeoutMs, (timeoutMs) => {
    const error = new DatabaseQueryTimeoutError(timeoutMs);
    try {
      options.onTimeout?.({ timeoutMs });
    } catch (cause) {
      error.cause = cause;
    }
    return error;
  });
  return sql;
}
