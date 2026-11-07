import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseClient, type DatabaseTransaction } from "../../db/client.js";
import { imMessageDeliveries } from "../../db/schema/index.js";
import { ImDeliveryReadyWakeup } from "../../runtime/im-delivery-ready-wakeup.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { deferred } from "../support/deferred.js";
import { pausedTableRead } from "../support/paused-binding-read.js";
import { createFixture } from "./im-recovery-locks-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => pg?.stop());

it.each(["claim", "abandoned"] as const)("joins actual IM %s work before pool disposal", async (phase) => {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const fixture = await createFixture(observer.database);
  const entered = deferred(),
    resume = deferred();
  const diagnostic = vi.fn();
  const hold = async () => {
    await client.sql`select 1`;
    entered.resolve();
    await resume.promise;
  };
  const domain = { requestReconcile: vi.fn(), requestDelivery: vi.fn() };
  const worker = new ImDeliveryWorker({
    database: client.database,
    domain: domain as never,
    assembler: {
      assembleForSession: vi.fn(async () => {
        if (phase === "abandoned") await hold();
        return fixture.runtime;
      }),
    },
    registry: {
      canReceiveSnapshot: () => true,
      currentInstanceId: () => fixture.dispatchContext.instanceId,
      supportsCapability: () => false,
      capabilityVersion: () => 2,
    } as never,
    afterClaimRowLocked: async () => {
      if (phase === "claim") await hold();
    },
    operationTimeoutMs: 20,
    onDiagnostic: diagnostic,
  });
  let drained = false;
  const [backend] = await client.sql`select pg_backend_pid() as pid`;
  let running: Promise<void> | undefined;
  try {
    running = worker.runOnce();
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Worker never reached SQL gate");
      }),
    ]);
    if (phase === "abandoned") {
      await running;
      expect(diagnostic.mock.calls.some(([code]) => code === "IM_DELIVERY_OPERATION_ABANDONED")).toBe(true);
    }
    const closing = worker.stop().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    resume.resolve();
    await running;
    await closing;
    expect(domain.requestDelivery).not.toHaveBeenCalled();
    expect(domain.requestReconcile).not.toHaveBeenCalled();
    const [row] = await observer.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
    expect(row?.state).toBe("pending");
    expect(row?.turnId).toBeNull();
    expect((await client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
    await client.sql.end({ timeout: 1 });
    await expect
      .poll(
        async () =>
          (await observer.sql`select count(*)::int as n from pg_stat_activity where pid = ${backend?.pid}`)[0]?.n,
      )
      .toBe(0);
  } finally {
    resume.resolve();
    await running;
    await worker.stop();
    await client.sql.end({ timeout: 1 });
    await observer.sql.end({ timeout: 1 });
  }
});

function holdFirstExecute(database: DatabaseClient, hold: () => Promise<void>): DatabaseClient {
  let held = false;
  const wrap = <T extends DatabaseClient | DatabaseTransaction>(database: T): T =>
    new Proxy(database, {
      get(target, key) {
        const method = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        if (key === "transaction")
          return (read: (tx: DatabaseTransaction) => Promise<unknown>, ...options: unknown[]) =>
            Reflect.apply(method, target, [(tx: DatabaseTransaction) => read(wrap(tx)), ...options]);
        if (key !== "execute") return method.bind(target);
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(method, target, args);
          if (!held) {
            held = true;
            await hold();
          }
          return result;
        };
      },
    });
  return wrap(database);
}

it.each(["manual", "expiry", "retention"] as const)("joins actual IM %s maintenance SQL", async (phase) => {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const entered = deferred(),
    resume = deferred();
  const database = holdFirstExecute(client.database, async () => {
    entered.resolve();
    await resume.promise;
  });
  const worker = new ImDeliveryWorker({
    database,
    domain: {} as never,
    assembler: { assembleForSession: vi.fn() },
    registry: { currentInstanceId: () => undefined } as never,
    intervalMs: 60_000,
    janitorIntervalMs: phase === "expiry" ? 20 : 60_000,
    retentionIntervalMs: phase === "retention" ? 20 : 60_000,
  });
  let drained = false;
  let running: Promise<void> | undefined;
  try {
    if (phase === "manual") running = worker.runJanitorOnce();
    else worker.start();
    await entered.promise;
    const closing = worker.stop().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    resume.resolve();
    await running;
    await closing;
    await worker.runJanitorOnce();
    expect((await client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
  } finally {
    resume.resolve();
    await running;
    await worker.stop();
    await client.sql.end({ timeout: 1 });
  }
});

it("joins a detached ready recheck after its actual SQL read", async () => {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const fixture = await createFixture(client.database);
  const paused = pausedTableRead(client.database, imMessageDeliveries);
  const readyAllocation = vi.fn();
  const wakeup = new ImDeliveryReadyWakeup({
    database: paused.database,
    allocation: { readyAllocation } as never,
    now: () => new Date(),
    runSession: vi.fn(),
    onDiagnostic: vi.fn(),
  });
  let drained = false;
  try {
    paused.arm();
    wakeup.recheck(fixture.rootDeliveryId);
    await paused.captured;
    const closing = wakeup.stop().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    paused.release();
    await closing;
    expect(readyAllocation).not.toHaveBeenCalled();
    expect((await client.sql`select 1 as healthy`)[0]?.healthy).toBe(1);
  } finally {
    paused.release();
    await wakeup.stop();
    await client.sql.end({ timeout: 1 });
  }
});
