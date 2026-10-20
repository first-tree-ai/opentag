import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imMessageDeliveries } from "../../db/schema/index.js";
import { runImDeliverySteerRecovery } from "../../runtime/im-delivery-janitor.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { SessionService } from "../../services/sessions/session-service.js";
import { deferred } from "../support/deferred.js";
import { acceptAndSteer, createFixture, deliveryRows, turnReport } from "./im-recovery-locks-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let database: MigratedTestDatabase;
beforeAll(async () => {
  database = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => database.reset());
afterAll(async () => database.stop());

async function connections() {
  const gate = createDatabaseClient(database.databaseUrl, { max: 1 });
  const first = createDatabaseClient(database.databaseUrl, { max: 1 });
  const second = createDatabaseClient(database.databaseUrl, { max: 1 });
  const observer = createDatabaseClient(database.databaseUrl, { max: 1 });
  const clients = [gate, first, second, observer];
  return {
    gate,
    first,
    second,
    observer,
    close: () => Promise.all(clients.map((client) => client.sql.end())),
  };
}

async function backend(client: ReturnType<typeof createDatabaseClient>) {
  const [row] = await client.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
  assert(row);
  return row.pid;
}

async function waitBlocked(observer: ReturnType<typeof createDatabaseClient>, waiter: number, blocker: number) {
  await expect
    .poll(
      async () => {
        const [row] = await observer.sql<{ blockers: number[] }[]>`select pg_blocking_pids(${waiter}) as blockers`;
        return row?.blockers ?? [];
      },
      { timeout: 5_000, interval: 10 },
    )
    .toContain(blocker);
}

function settled<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error) => ({ status: "rejected" as const, error }),
  );
}

it.each(["failed", "cancelled", "unknown"] as const)(
  "commits a %s report and concurrent collaboration without a lock cycle",
  async (outcome) => {
    const c = await connections();
    const release = deferred();
    const reached = deferred();
    const running: Promise<unknown>[] = [];
    try {
      const f = await createFixture(c.observer.database);
      await acceptAndSteer(f, new PostgresRuntimeCustodyStore(c.observer.database));
      const [computer] = await c.observer.database
        .select()
        .from(computers)
        .where(eq(computers.id, f.context.computerId));
      assert(computer);
      const child = await new SessionService(c.observer.database).createInternalSessionWithMessage({
        creatorSessionId: f.sessionId,
        creatorInstallationId: computer.currentInstallationId,
        creatorConnectionInstanceId: f.context.instanceId,
        creatorComputerId: computer.id,
        creatorPlacementGeneration: 1,
        messageId: randomUUID(),
        initialMessage: "Concurrent child",
      });
      const [gatePid, firstPid, secondPid] = await Promise.all([backend(c.gate), backend(c.first), backend(c.second)]);
      const gate = c.gate.sql.begin(async (sql) => {
        await sql`select id from im_message_deliveries where id = ${f.rootDeliveryId} for update`;
        reached.resolve();
        await release.promise;
      });
      running.push(gate);
      await reached.promise;
      const report = settled(
        new PostgresRuntimeCustodyStore(c.first.database, { now: () => f.now }).recordTurn(
          turnReport(
            f,
            outcome,
            outcome === "failed" ? "turn_timeout" : outcome === "cancelled" ? "client_shutdown" : "turn_state_unknown",
          ),
          f.context,
        ),
      );
      running.push(report);
      await waitBlocked(c.observer, firstPid, gatePid);
      const send = settled(
        new SessionService(c.second.database).authorizeAndRecordMessage({
          sourceSessionId: child.session.id,
          sourceInstallationId: computer.currentInstallationId,
          sourceConnectionInstanceId: f.context.instanceId,
          sourceComputerId: computer.id,
          sourcePlacementGeneration: 1,
          targetSessionId: f.sessionId,
          messageId: randomUUID(),
          content: "Child result",
        }),
      );
      running.push(send);
      await waitBlocked(c.observer, secondPid, firstPid);
      release.resolve();
      await gate;
      const results = await Promise.all([report, send]);
      expect(results).toEqual([
        expect.objectContaining({ status: "fulfilled", value: "recorded" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      const rows = await deliveryRows(c.observer.database, f);
      expect(rows.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "pending", attemptCount: 1, steerTargetDeliveryId: null }),
        ]),
      );
    } finally {
      release.resolve();
      await Promise.allSettled(running);
      await c.close();
    }
  },
  20_000,
);

it("skips a busy Session before taking janitor target locks", async () => {
  const c = await connections();
  const release = deferred();
  const reached = deferred();
  const running: Promise<unknown>[] = [];
  try {
    const f = await createFixture(c.observer.database);
    await acceptAndSteer(f, new PostgresRuntimeCustodyStore(c.observer.database));
    const report = turnReport(f, "cancelled", "client_shutdown");
    await c.observer.database
      .update(imMessageDeliveries)
      .set({
        dispatchPayload: null,
        turnReport: report,
        resultHash: report.resultHash,
        reportedAt: f.now,
      })
      .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
    const gate = c.gate.sql.begin(async (sql) => {
      await sql`select id from sessions where id = ${f.sessionId} for no key update`;
      reached.resolve();
      await release.promise;
    });
    running.push(gate);
    await reached.promise;
    let finished = false;
    const janitor = settled(
      runImDeliverySteerRecovery(c.first.database, { clock: () => f.now, expiryBatchSize: 100 }),
    ).finally(() => {
      finished = true;
    });
    running.push(janitor);
    await expect.poll(() => finished, { timeout: 2_000 }).toBe(true);
    expect(await janitor).toEqual({ status: "fulfilled", value: undefined });
    await c.first.sql.begin(async (sql) => {
      await sql`select id from im_message_deliveries where id = ${f.rootDeliveryId} for update nowait`;
    });
    expect((await deliveryRows(c.observer.database, f)).children.every((row) => row.state === "steered")).toBe(true);
    release.resolve();
    await gate;
    const replay = new PostgresRuntimeCustodyStore(c.second.database).recordTurn(report, f.context);
    const recovery = runImDeliverySteerRecovery(c.first.database, { clock: () => f.now, expiryBatchSize: 100 });
    running.push(replay, recovery);
    expect(await replay).toBe("already_recorded");
    await recovery;
    // A competing reporter can own the Session during the first scan; a later scan converges.
    await runImDeliverySteerRecovery(c.first.database, { clock: () => f.now, expiryBatchSize: 100 });
    expect(
      (await deliveryRows(c.observer.database, f)).children.every(
        (row) => row.state === "pending" && row.attemptCount === 1,
      ),
    ).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled(running);
    await c.close();
  }
}, 20_000);

it("rolls back the report with child recovery and retries the original identity once", async () => {
  const c = await connections();
  try {
    const f = await createFixture(c.observer.database);
    const custody = new PostgresRuntimeCustodyStore(c.first.database, { now: () => f.now });
    await acceptAndSteer(f, custody);
    const original = await deliveryRows(c.observer.database, f);
    const report = turnReport(f, "failed", "turn_timeout");
    await c.observer.sql.unsafe(`create function fail_child_recovery() returns trigger language plpgsql as $$
      begin
        if old.state = 'steered' and new.state = 'pending' then
          raise exception 'synthetic recovery failure' using errcode = '40001';
        end if;
        return new;
      end $$`);
    await c.observer.sql.unsafe(
      "create trigger fail_child_recovery before update on im_message_deliveries for each row execute function fail_child_recovery()",
    );
    try {
      await expect(custody.recordTurn(report, f.context)).rejects.toMatchObject({ cause: { code: "40001" } });
      expect(await deliveryRows(c.observer.database, f)).toEqual(original);
    } finally {
      await c.observer.sql.unsafe("drop trigger fail_child_recovery on im_message_deliveries");
      await c.observer.sql.unsafe("drop function fail_child_recovery()");
    }
    expect(await custody.recordTurn(report, f.context)).toBe("recorded");
    const recovered = await deliveryRows(c.observer.database, f);
    expect(recovered.children.every((row) => row.state === "pending" && row.attemptCount === 1)).toBe(true);
    expect(await custody.recordTurn({ ...report, requestId: randomUUID() }, f.context)).toBe("already_recorded");
    expect(await deliveryRows(c.observer.database, f)).toEqual(recovered);
  } finally {
    await c.close();
  }
});

it("keeps completed reports independent of the recovery Session lock", async () => {
  const c = await connections();
  const release = deferred();
  const reached = deferred();
  const running: Promise<unknown>[] = [];
  try {
    const f = await createFixture(c.observer.database);
    await acceptAndSteer(f, new PostgresRuntimeCustodyStore(c.observer.database));
    const gate = c.gate.sql.begin(async (sql) => {
      await sql`select id from sessions where id = ${f.sessionId} for no key update`;
      reached.resolve();
      await release.promise;
    });
    running.push(gate);
    await reached.promise;
    let finished = false;
    const report = settled(
      new PostgresRuntimeCustodyStore(c.first.database).recordTurn(turnReport(f, "completed"), f.context),
    ).finally(() => {
      finished = true;
    });
    running.push(report);
    await expect.poll(() => finished, { timeout: 2_000 }).toBe(true);
    expect(await report).toEqual({ status: "fulfilled", value: "recorded" });
    expect((await deliveryRows(c.observer.database, f)).children.every((row) => row.state === "steered")).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled(running);
    await c.close();
  }
}, 20_000);
