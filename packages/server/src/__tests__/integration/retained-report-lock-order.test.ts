import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { computeDirectInputHash, computeTurnResultHash, type SessionReconcileRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { imMessageDeliveries, sessionPlacements, sessions } from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { deferred } from "../support/deferred.js";
import { acceptAndSteer, createFixture, turnReport } from "./im-recovery-locks-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 180_000);
beforeEach(async () => pg.reset());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.sql.end({ timeout: 1 })));
});
afterAll(async () => pg?.stop());
function client() {
  const c = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(c);
  return c;
}
function request(f: Awaited<ReturnType<typeof createFixture>>, sessionId = f.sessionId): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    installationId: f.context.installationId,
    sessionId,
    agentId: f.agentId,
    placementGeneration: 1,
    desired: "stopped",
  };
}
function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error) => ({ status: "rejected" as const, error }),
  );
}

it.each([0, 1])(
  "settles a retained manifest of length %i alongside an actual failed report without deadlock",
  async (length) => {
    const reporter = client(),
      claimant = client(),
      observer = client();
    const entered = deferred<void>(),
      release = deferred<void>();
    const pending: Promise<unknown>[] = [];
    try {
      const f = await createFixture(observer.database);
      await acceptAndSteer(f, new PostgresRuntimeCustodyStore(observer.database));
      const [reportPid] = await reporter.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const [claimPid] = await claimant.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      assert(reportPid && claimPid);
      const reportRequest = turnReport(f, "failed", "turn_timeout");
      let reportDone = false;
      const report = settle(
        new PostgresRuntimeCustodyStore(pauseAfterFirstSelectLock(reporter.database, entered, release)).recordTurn(
          reportRequest,
          f.context,
        ),
      ).finally(() => {
        reportDone = true;
      });
      pending.push(report);
      await entered.promise;
      let claimDone = false;
      const claims = settle(
        new PostgresRuntimeCustodyStore(claimant.database).claimRetainedReports(
          request(f),
          length
            ? [
                {
                  deliveryId: f.rootDeliveryId,
                  dispatchRequestId: f.rootRequest.requestId,
                  inputHash: computeDirectInputHash(f.rootRequest),
                  turnId: f.rootTurnId,
                  placementGeneration: 1,
                  resultHash: computeTurnResultHash(reportRequest),
                },
              ]
            : [],
          f.context,
        ),
      ).finally(() => {
        claimDone = true;
      });
      pending.push(claims);
      if (length === 0) {
        await vi.waitFor(() => expect(claimDone).toBe(true), { timeout: 2_000 });
        expect(reportDone).toBe(false);
      } else {
        await expect
          .poll(
            async () => {
              const [row] = await observer.sql<
                { blockers: number[] }[]
              >`select pg_blocking_pids(${claimPid.pid}) as blockers`;
              return row?.blockers;
            },
            { timeout: 2_000, interval: 10 },
          )
          .toContain(reportPid.pid);
        await observer.database.transaction(async (transaction) => {
          const rows = await transaction
            .select({ id: sessionPlacements.sessionId })
            .from(sessionPlacements)
            .where(eq(sessionPlacements.sessionId, f.sessionId))
            .for("update", { noWait: true });
          expect(rows).toHaveLength(1);
        });
      }
      release.resolve();
      expect(await Promise.all([report, claims])).toMatchObject([{ status: "fulfilled" }, { status: "fulfilled" }]);
      const [stored] = await observer.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
      assert(stored);
      expect(stored.resultHash).toBe(computeTurnResultHash(reportRequest));
      expect(stored.turnReport).not.toBeNull();
      expect(await observer.sql`select 1 as healthy`).toEqual([{ healthy: 1 }]);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  },
);

it("ignores a foreign-Session manifest before waiting on its placement", async () => {
  const owner = client(),
    claimant = client(),
    locker = client();
  const f = await createFixture(owner.database);
  await acceptAndSteer(f, new PostgresRuntimeCustodyStore(owner.database));
  const [original] = await owner.database.select().from(sessions).where(eq(sessions.id, f.sessionId));
  assert(original);
  const [other] = await owner.database
    .insert(sessions)
    .values({
      imBindingId: original.imBindingId,
      channelId: randomUUID(),
      kind: "channel",
      conversationKind: "channel",
    })
    .returning();
  assert(other);
  await owner.database
    .insert(sessionPlacements)
    .values({ sessionId: other.id, computerId: f.context.computerId, generation: 1 });
  const entered = deferred<void>(),
    release = deferred<void>();
  const holding = locker.database.transaction(async (transaction) => {
    await transaction
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, f.sessionId))
      .for("update");
    entered.resolve();
    await release.promise;
  });
  let claiming: ReturnType<PostgresRuntimeCustodyStore["claimRetainedReports"]> | undefined;
  try {
    await entered.promise;
    let done = false;
    claiming = new PostgresRuntimeCustodyStore(claimant.database)
      .claimRetainedReports(
        request(f, other.id),
        [
          {
            deliveryId: f.rootDeliveryId,
            dispatchRequestId: f.rootRequest.requestId,
            inputHash: computeDirectInputHash(f.rootRequest),
            turnId: f.rootTurnId,
            placementGeneration: 1,
            resultHash: "foreign-report",
          },
        ],
        f.context,
      )
      .finally(() => {
        done = true;
      });
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 2_000 });
    await expect(claiming).resolves.toEqual([]);
    const [row] = await owner.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
    expect(row?.resultHash).toBeNull();
  } finally {
    release.resolve();
    await holding;
    await claiming;
  }
});

function pauseAfterFirstSelectLock(
  database: ReturnType<typeof createDatabaseClient>["database"],
  reached: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
  matches: (statement: string) => boolean = (statement) =>
    statement.includes('from "sessions"') && statement.includes("for no key update"),
) {
  let paused = false;
  const wrap = (query: object): object =>
    new Proxy(query, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then" && typeof value === "function") {
          return (fulfilled: (rows: unknown) => unknown, rejected: (error: unknown) => unknown) => {
            const toSQL = Reflect.get(target, "toSQL");
            const statement =
              typeof toSQL === "function" ? (Reflect.apply(toSQL, target, []) as { sql: string }) : undefined;
            return Promise.resolve(Reflect.apply(value, target, []))
              .then(async (rows) => {
                if (!paused && statement !== undefined && matches(statement.sql)) {
                  paused = true;
                  reached.resolve();
                  await release.promise;
                }
                return rows;
              })
              .then(fulfilled, rejected);
          };
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          return result && typeof result === "object" ? wrap(result) : result;
        };
      },
    });
  return new Proxy(database, {
    get(target, key) {
      if (key === "transaction")
        return (operation: (transaction: unknown) => Promise<unknown>) =>
          target.transaction((transaction) =>
            operation(
              new Proxy(transaction, {
                get(value, property) {
                  if (property === "select")
                    return (...args: unknown[]) => wrap(Reflect.apply(value.select, value, args));
                  const method = Reflect.get(value, property);
                  return typeof method === "function" ? method.bind(value) : method;
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
