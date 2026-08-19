import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export function createDatabaseClient(databaseUrl: string, options: { max?: number } = {}) {
  const sql = postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: () => undefined,
  });
  const database = drizzle(sql, { schema });
  return { database, sql };
}

export type DatabaseClient = ReturnType<typeof createDatabaseClient>["database"];
export type DatabaseTransaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];
