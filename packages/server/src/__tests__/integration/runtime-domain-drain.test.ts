import { computeDirectInputHash } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imMessageDeliveries } from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { deferred } from "../support/deferred.js";
import { createFixture } from "./im-recovery-locks-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: MigratedTestDatabase;
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120000);
beforeEach(async () => pg.reset());
afterAll(async () => pg?.stop());

it.each(["pending", "starting"] as const)("joins %s custody SQL before disposing the pool", async (phase) => {
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const observer = createDatabaseClient(pg.databaseUrl, { max: 2 });
  const fixture = await createFixture(observer.database);
  const [connection] = await client.sql`select pg_backend_pid() as pid`;
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const entered = deferred(),
    resume = deferred(),
    sent = deferred();
  const begin = custody.beginDeliveryDispatch.bind(custody);
  vi.spyOn(custody, "beginDeliveryDispatch").mockImplementation(async (...args) => {
    const result = await begin(...args);
    if (phase === "starting") {
      entered.resolve();
      await resume.promise;
    }
    return result;
  });
  const release = custody.releaseDeliveryDispatch.bind(custody);
  const releasing = vi.spyOn(custody, "releaseDeliveryDispatch").mockImplementation(async (...args) => {
    if (phase === "pending") {
      entered.resolve();
      await resume.promise;
    }
    return release(...args);
  });
  const send = vi.fn(async () => {
    sent.resolve();
  });
  const owner = new RuntimeDomainOwner(
    {
      currentInstanceId: () => fixture.context.instanceId,
      currentConnectionId: () => undefined,
      assertSnapshotCompatible: () => undefined,
      send,
    } as never,
    custody,
  );
  const result = owner
    .requestDelivery(fixture.context.computerId, fixture.context.instanceId, fixture.rootRequest)
    .then(
      () => "unexpected result",
      (error: unknown) => error,
    );
  try {
    await (phase === "pending" ? sent.promise : entered.promise);
    let drained = false;
    const closing = owner.close().then(() => {
      drained = true;
    });
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    resume.resolve();
    await closing;
    expect(await result).toMatchObject({ code: "stopped" });
    expect(releasing).toHaveBeenCalledTimes(1);
    const [row] = await observer.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
    expect(row).toMatchObject({
      state: "pending",
      dispatchRequestId: phase === "pending" ? fixture.rootRequest.requestId : null,
      dispatchInputHash: phase === "pending" ? computeDirectInputHash(fixture.rootRequest) : null,
    });
    expect(send).toHaveBeenCalledTimes(phase === "pending" ? 1 : 0);
    await client.sql.end({ timeout: 1 });
    await expect
      .poll(
        async () =>
          (await observer.sql`select count(*)::int as n from pg_stat_activity where pid = ${connection?.pid}`)[0]?.n,
      )
      .toBe(0);
  } finally {
    resume.resolve();
    await owner.close();
    await result;
    await Promise.all([client.sql.end({ timeout: 1 }), observer.sql.end({ timeout: 1 })]);
  }
});
