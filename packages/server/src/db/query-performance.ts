import type { Sql } from "postgres";
import type { PerformanceLogger } from "../observability/performance-logger.js";
import { DatabaseQueryTimeoutError } from "./query-deadline.js";

interface PostgresQueryInternal {
  executed: boolean;
  strings: readonly string[];
  args: readonly unknown[];
  options?: { no_pipeline?: boolean; query_timeout?: number };
  handle: () => Promise<void>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const KNOWN_SQL_COMMANDS = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "WITH",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "SHOW",
  "SET",
  "LISTEN",
  "UNLISTEN",
  "NOTIFY",
  "LOCK",
  "TRUNCATE",
  "DO",
  "CREATE",
  "ALTER",
  "DROP",
]);

const IGNORED_TARGET_KEYWORDS = new Set([
  "select",
  "lateral",
  "unnest",
  "only",
  "values",
  "set",
  "where",
  "stdin",
  " dual",
]);

const TARGET_PATTERNS: readonly RegExp[] = [
  /\binto\s+"?([A-Za-z_][A-Za-z0-9_.]*)"?/i,
  /\bupdate\s+(?:only\s+)?"?([A-Za-z_][A-Za-z0-9_.]*)"?/i,
  /\bfrom\s+(?:only\s+)?"?([A-Za-z_][A-Za-z0-9_.]*)"?/i,
  /\btable\s+(?:if\s+exists\s+)?"?([A-Za-z_][A-Za-z0-9_.]*)"?/i,
];

function stripSqlComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTargetTable(cleanedSql: string): string | undefined {
  for (const pattern of TARGET_PATTERNS) {
    const match = pattern.exec(cleanedSql);
    const candidate = match?.[1]?.replaceAll('"', "");
    if (!candidate || candidate.length > 64) continue;
    if (IGNORED_TARGET_KEYWORDS.has(candidate.toLowerCase())) continue;
    return candidate;
  }
  return undefined;
}

export function summarizeSqlQuery(
  strings: readonly string[],
  args: readonly unknown[],
): {
  sqlCommand: string;
  dbTarget?: string;
  paramCount: number;
} {
  const skeleton = stripSqlComments(strings.slice(0, 64).join(" $param "));
  const firstToken = skeleton.split(/\s+/, 1)[0]?.toUpperCase() ?? "";
  const sqlCommand = KNOWN_SQL_COMMANDS.has(firstToken) ? firstToken : "OTHER";
  const dbTarget = extractTargetTable(skeleton);
  const paramCount = Array.isArray(args) ? args.length : 0;
  return {
    sqlCommand,
    ...(dbTarget ? { dbTarget } : {}),
    paramCount,
  };
}

function isPostgresQuery(candidate: unknown): candidate is PostgresQueryInternal {
  if (typeof candidate !== "object" || candidate === null) return false;
  const query = candidate as Partial<PostgresQueryInternal>;
  return (
    typeof query.handle === "function" &&
    typeof query.resolve === "function" &&
    typeof query.reject === "function" &&
    Array.isArray(query.strings)
  );
}

function extractRowCount(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) {
    const maybeCount = (result as unknown as { count?: unknown }).count;
    const count = typeof maybeCount === "number" ? maybeCount : result.length;
    return { rowCount: count };
  }
  if (typeof result === "object" && result !== null && typeof (result as { count?: unknown }).count === "number") {
    return { rowCount: (result as { count: number }).count };
  }
  return undefined;
}

function extractSqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth <= 3 && cursor && typeof cursor === "object"; depth += 1) {
    try {
      const code = (cursor as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      cursor = (cursor as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return undefined;
}

function extractErrorMeta(error: unknown): {
  attrs: Record<string, unknown> | undefined;
  fallbackCode: string;
} {
  const isTimeout =
    error instanceof DatabaseQueryTimeoutError ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "DatabaseQueryTimeoutError");
  const fallbackCode = isTimeout ? "DATABASE_QUERY_TIMEOUT" : "DATABASE_QUERY_FAILED";
  const sqlState = extractSqlState(error);
  return {
    attrs: sqlState ? { sqlState } : undefined,
    fallbackCode,
  };
}

const instrumentedObjects = new WeakMap<object, unknown>();

function instrumentQuery<T>(query: T, perfLogger: PerformanceLogger, inTransaction: boolean): T {
  if (!isPostgresQuery(query)) return query;
  if (query.options?.no_pipeline === true) return query;
  const existing = instrumentedObjects.get(query);
  if (existing) return existing as T;

  const originalHandle = query.handle;
  let started = false;
  query.handle = function instrumentedHandle(this: PostgresQueryInternal) {
    if (!this.executed && !started) {
      started = true;
      const summary = summarizeSqlQuery(this.strings, this.args);
      const handle = perfLogger.startOperation({
        module: "database",
        category: "db",
        operation: "db.query",
        attributes: {
          ...summary,
          ...(inTransaction ? { inTransaction: true } : {}),
        },
      });
      const originalResolve = this.resolve;
      const originalReject = this.reject;
      let settled = false;
      this.resolve = (value: unknown) => {
        if (!settled) {
          settled = true;
          handle.complete(extractRowCount(value));
        }
        originalResolve(value);
      };
      this.reject = (error: unknown) => {
        if (!settled) {
          settled = true;
          const { attrs, fallbackCode } = extractErrorMeta(error);
          handle.fail(error, attrs, fallbackCode);
        }
        originalReject(error);
      };
    }
    return originalHandle.apply(this);
  };

  instrumentedObjects.set(query, query);
  return query;
}

function wrapTransactionMethod(
  target: object,
  method: (...args: unknown[]) => Promise<unknown>,
  perfLogger: PerformanceLogger,
  operation: "db.transaction" | "db.savepoint",
  sqlCommand: "TRANSACTION" | "SAVEPOINT",
) {
  return (...args: unknown[]) => {
    const callbackIndex = args.length - 1;
    const callback = args[callbackIndex];
    if (typeof callback !== "function") {
      return Reflect.apply(method, target, args);
    }
    return perfLogger.traceAsync(
      {
        module: "database",
        category: "db",
        operation,
        attributes: { sqlCommand },
        startMessage: operation === "db.transaction" ? "Database transaction started" : "Database savepoint started",
        completeMessage:
          operation === "db.transaction" ? "Database transaction completed" : "Database savepoint completed",
        failMessage: operation === "db.transaction" ? "Database transaction failed" : "Database savepoint failed",
      },
      async () => {
        const nextArgs = [...args];
        nextArgs[callbackIndex] = (scopedSql: Sql) =>
          (callback as (sql: Sql) => unknown)(instrumentDatabaseSql(scopedSql, perfLogger, true));
        return await Reflect.apply(method, target, nextArgs);
      },
      {
        errorAttributes: (error) => extractErrorMeta(error).attrs,
        fallbackErrorCode: "DATABASE_TRANSACTION_FAILED",
      },
    );
  };
}

export function instrumentDatabaseSql<T extends Sql>(
  sql: T,
  perfLogger: PerformanceLogger | undefined,
  inTransaction = false,
): T {
  if (!perfLogger || typeof sql !== "function") return sql;
  const cached = instrumentedObjects.get(sql);
  if (cached) return cached as T;

  const proxy = new Proxy(sql, {
    apply(target, thisArg, argArray) {
      const result = Reflect.apply(target, thisArg, argArray);
      return instrumentQuery(result, perfLogger, inTransaction);
    },
    get(target, prop) {
      if (prop === "unsafe") {
        return (...args: unknown[]) =>
          instrumentQuery(Reflect.apply(target.unsafe, target, args), perfLogger, inTransaction);
      }
      if (prop === "begin" && typeof target.begin === "function") {
        return wrapTransactionMethod(
          target,
          target.begin as unknown as (...args: unknown[]) => Promise<unknown>,
          perfLogger,
          "db.transaction",
          "TRANSACTION",
        );
      }
      const candidateSavepoint = Reflect.get(target, "savepoint", target);
      if (prop === "savepoint" && typeof candidateSavepoint === "function") {
        return wrapTransactionMethod(
          target,
          candidateSavepoint as (...args: unknown[]) => Promise<unknown>,
          perfLogger,
          "db.savepoint",
          "SAVEPOINT",
        );
      }
      if (prop === "reserve" && typeof target.reserve === "function") {
        return (...args: unknown[]) =>
          Promise.resolve(Reflect.apply(target.reserve, target, args)).then((reserved) =>
            instrumentDatabaseSql(reserved as Sql, perfLogger, false),
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  instrumentedObjects.set(sql, proxy);
  return proxy;
}
