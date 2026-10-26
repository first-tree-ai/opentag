import type { DatabaseClient } from "../../db/client.js";
import { imBindings } from "../../db/schema/index.js";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Holds an actual SQL result after its snapshot was read, without holding a transaction open. */
export function pausedBindingRead(client: DatabaseClient) {
  const captured = deferred<void>();
  const released = deferred<void>();
  let armed = false;
  const database = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== "select") return typeof value === "function" ? value.bind(target) : value;
      return (...selection: unknown[]) => {
        const builder: object = Reflect.apply(value, target, selection);
        return new Proxy(builder, {
          get(select, key) {
            const method = Reflect.get(select, key);
            if (key !== "from") return typeof method === "function" ? method.bind(select) : method;
            return (table: unknown) => {
              const query: object = Reflect.apply(method, select, [table]);
              if (table === imBindings) {
                const then = Reflect.get(query, "then").bind(query);
                // biome-ignore lint/suspicious/noThenProperty: Drizzle is already thenable; hold its actual SQL result.
                Object.defineProperty(query, "then", {
                  configurable: true,
                  value: (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
                    then(async (rows: unknown) => {
                      if (armed) {
                        armed = false;
                        captured.resolve();
                        await released.promise;
                      }
                      return rows;
                    }).then(resolve, reject),
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
    database,
    captured: captured.promise,
    arm: () => {
      armed = true;
    },
    release: () => released.resolve(),
  };
}
