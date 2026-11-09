import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createDatabaseClient } from "../../db/client.js";
import { deferred } from "../support/deferred.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => pg?.stop());

it.each(["onRequest", "preHandler", "handler"] as const)(
  "joins disconnected %s SQL before disposing the pool",
  async (phase) => {
    const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
    const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
    const entered = deferred();
    const release = deferred();
    let poolClosed = false;
    let laterQueries = 0;
    let handlerCalls = 0;
    let stopped = false;
    const [backend] = await client.sql`select pg_backend_pid() as pid`;
    const app = createApp({
      closeResources: async () => {
        await client.sql.end({ timeout: 1 });
        poolClosed = true;
      },
    });
    const work = async () => {
      await client.sql`select 1`;
      entered.resolve();
      await release.promise;
      if (poolClosed) laterQueries++;
      await client.sql`select 2`;
    };
    await app.register(async (child) => {
      child.get(
        "/drain",
        {
          ...(phase === "onRequest" ? { onRequest: work } : {}),
          ...(phase === "preHandler" ? { preHandler: work } : {}),
        },
        async () => {
          handlerCalls++;
          if (phase === "handler") await work();
          return { ok: true };
        },
      );
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const response = fetch(`${address}/drain`, { signal: abort.signal }).then(
      () => undefined,
      (error: unknown) => error,
    );
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      abort.abort();
      expect(await response).toMatchObject({ name: "AbortError" });
      closing = app.close().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(stopped).toBe(false);
      expect(poolClosed).toBe(false);
      expect(await observer.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
      release.resolve();
      await closing;
      expect(laterQueries).toBe(0);
      expect(handlerCalls).toBe(phase === "handler" ? 1 : 0);
      const [activity] =
        await observer.sql`select count(*)::int as count from pg_stat_activity where pid = ${backend?.pid}`;
      expect(activity?.count).toBe(0);
    } finally {
      release.resolve();
      abort.abort();
      await response;
      await (closing ?? app.close());
      await Promise.all([client.sql.end({ timeout: 1 }), observer.sql.end({ timeout: 1 })]);
    }
  },
);
