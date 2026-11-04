import type { PgTable } from "drizzle-orm/pg-core";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { imBindings } from "../../db/schema/index.js";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface ReadPauseOptions {
  // PGlite has one connection; release a captured read transaction before a concurrent fixture write.
  afterTransaction?: boolean;
}

/** Holds an actual SQL result after its snapshot was read, preserving transactions by default. */
export function pausedBindingRead(client: DatabaseClient, options: ReadPauseOptions = {}) {
  return pausedTableRead(client, imBindings, options);
}

export function pausedTableRead(client: DatabaseClient, targetTable: PgTable, options: ReadPauseOptions = {}) {
  const captured = deferred<void>();
  const released = deferred<void>();
  let armed = false;
  const pauseAfterRead = async (rows: unknown, boundary?: { captured: boolean }) => {
    if (!armed) return rows;
    armed = false;
    if (boundary) boundary.captured = true;
    else {
      captured.resolve();
      await released.promise;
    }
    return rows;
  };
  const wrap = <T extends DatabaseClient | DatabaseTransaction>(executor: T, boundary?: { captured: boolean }): T =>
    new Proxy(executor, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (property === "transaction") {
          return async (
            read: (transaction: DatabaseTransaction) => Promise<unknown>,
            ...transactionOptions: unknown[]
          ) => {
            const current = boundary ?? (options.afterTransaction ? { captured: false } : undefined);
            const result = await Reflect.apply(value, target, [
              (transaction: DatabaseTransaction) => read(wrap(transaction, current)),
              ...transactionOptions,
            ]);
            if (!boundary && current?.captured) {
              captured.resolve();
              await released.promise;
            }
            return result;
          };
        }
        if (property !== "select") return typeof value === "function" ? value.bind(target) : value;
        return (...selection: unknown[]) => {
          const builder: object = Reflect.apply(value, target, selection);
          return new Proxy(builder, {
            get(select, key) {
              const method = Reflect.get(select, key);
              if (key !== "from") return typeof method === "function" ? method.bind(select) : method;
              return (table: unknown) => {
                const query: object = Reflect.apply(method, select, [table]);
                if (table === targetTable) {
                  const then = Reflect.get(query, "then").bind(query);
                  // biome-ignore lint/suspicious/noThenProperty: Drizzle is already thenable; hold its actual SQL result.
                  Object.defineProperty(query, "then", {
                    configurable: true,
                    value: (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
                      then((rows: unknown) => pauseAfterRead(rows, boundary)).then(resolve, reject),
                  });
                }
                return query;
              };
            },
          });
        };
      },
    });
  return {
    database: wrap(client),
    captured: captured.promise,
    arm: () => {
      armed = true;
    },
    release: () => released.resolve(),
  };
}
