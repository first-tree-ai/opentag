/**
 * An in-process PostgreSQL for unit tests.
 *
 * The services in `src/services` and `src/runtime` speak Drizzle against a real PostgreSQL dialect:
 * CTEs, `on conflict`, partial indexes, `for update`, transaction rollback. Faking that surface with
 * hand-rolled query-builder stubs tests the stub rather than the service, so these suites run against
 * PGlite instead — the genuine PostgreSQL engine compiled to WebAssembly, embedded in the test
 * process. It needs no Docker daemon, no listening port, and no external service, which keeps unit
 * tests inside the constraint that they must not depend on a running PostgreSQL instance.
 *
 * The checked-in Drizzle migrations are the schema source of truth here, exactly as in production, so
 * a migration that has not been generated fails these tests instead of silently diverging.
 *
 * Booting an instance and replaying every migration costs a few seconds, so a suite should create one
 * database in `beforeAll` and call `reset()` between tests rather than creating one per test.
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { DatabaseClient } from "../../db/client.js";
import * as schema from "../../db/schema/index.js";

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export interface UnitDatabase {
  /**
   * A Drizzle client over the embedded engine, presented as the `postgres-js` client services accept.
   *
   * The query builders match, but the two drivers disagree on one thing: `postgres-js` resolves
   * `execute()` to the rows themselves, while PGlite resolves it to a `{ rows, fields, command, ... }`
   * envelope. A service that reads the result directly would therefore need a shape check that is dead
   * code in production, so the difference is absorbed here instead - see `asPostgresJsClient`.
   */
  readonly database: DatabaseClient;
  /** The raw engine, for the rare assertion that needs SQL the query builder cannot express. */
  readonly engine: PGlite;
  /** Truncates every application table and restarts identity sequences. Keeps the migration ledger. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createUnitDatabase(): Promise<UnitDatabase> {
  const engine = new PGlite();
  const database = drizzle(engine, { schema });

  try {
    await migrate(database, { migrationsFolder });
  } catch (error) {
    await engine.close();
    throw error;
  }

  return {
    close: () => engine.close(),
    database: asPostgresJsClient(database),
    engine,
    reset: () => truncateApplicationTables(engine),
  };
}

/**
 * Presents a PGlite Drizzle client with `postgres-js` result semantics.
 *
 * `postgres-js` resolves `execute()` to an array of rows; PGlite resolves it to an envelope holding
 * those rows under `rows`. Production code is written against the former, and the driver difference is
 * an artifact of the test harness, so it is unwrapped here. The alternative - a shape check inside each
 * service - adds a production branch that only ever runs under test, and silently returning `[]` from
 * such a check would turn an unexpected driver result into an empty page instead of a failure.
 *
 * Transactions get the same treatment: the object handed to a `transaction()` callback is a session in
 * its own right and carries its own `execute()`.
 */
function asPostgresJsClient<T extends object>(client: T): DatabaseClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);

      if (property === "execute" && typeof value === "function") {
        return async (...args: unknown[]) => unwrapRows(await value.apply(target, args));
      }

      if (property === "transaction" && typeof value === "function") {
        return (callback: (transaction: unknown) => unknown, ...rest: unknown[]) =>
          value.call(target, (transaction: object) => callback(asPostgresJsClient(transaction)), ...rest);
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as DatabaseClient;
}

function unwrapRows(result: unknown): unknown {
  if (
    result &&
    !Array.isArray(result) &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: unknown[] }).rows;
  }
  return result;
}

/**
 * `drizzle.__drizzle_migrations` lives outside `public`, so truncating `public` alone leaves the
 * ledger intact and the database stays migrated across resets.
 */
async function truncateApplicationTables(engine: PGlite): Promise<void> {
  await engine.exec(`
    do $$
    declare
      table_list text;
    begin
      select string_agg(format('%I.%I', schemaname, tablename), ', ')
      into table_list
      from pg_tables
      where schemaname = 'public';

      if table_list is not null then
        execute 'truncate table ' || table_list || ' restart identity cascade';
      end if;
    end $$;
  `);
}
