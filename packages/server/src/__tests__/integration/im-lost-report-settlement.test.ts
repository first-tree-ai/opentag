import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { computeTurnResultHash } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { settleLostReportOrDefer } from "../../runtime/im-delivery-failure.js";
import { ACCEPTED_REPORT_WINDOW_MS } from "../../runtime/im-delivery-retry.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { createSlackWorkingFixture } from "../support/slack-working-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 120_000);
beforeEach(async () => {
  await pg.reset();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.sql.end()));
});
afterAll(async () => {
  await pg?.stop();
});
function actor() {
  const client = createDatabaseClient(pg.databaseUrl, { max: 2 });
  clients.push(client);
  return client;
}

/** Accepted custody owned by the fixture's instance, on a Computer now answered for by `responder`. */
async function lostReport(client: ReturnType<typeof actor>, responder: string) {
  const h = await createSlackWorkingFixture(
    client.database,
    new ApplicationCipher(Buffer.alloc(32, 11)),
    () => new Date(),
  );
  const { request } = await h.delivery();
  const turnId = randomUUID();
  await client.database
    .update(computers)
    .set({ currentInstanceId: responder, currentInstallationId: h.context.installationId })
    .where(eq(computers.id, h.context.computerId));
  await client.database
    .update(imMessageDeliveries)
    .set({
      state: "accepted",
      turnId,
      reportOwnerInstanceId: h.context.instanceId,
      acceptedAt: new Date(Date.now() - ACCEPTED_REPORT_WINDOW_MS - 60_000),
    })
    .where(eq(imMessageDeliveries.id, request.deliveryId));
  const read = async () => {
    const [row] = await client.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, request.deliveryId));
    assert(row);
    return row;
  };
  const delivery = await read();
  const [scope] = await client.database
    .select({ session: sessions, placement: sessionPlacements, agent: agents, computer: computers })
    .from(sessions)
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
    .where(eq(sessions.id, request.sessionId));
  assert(scope);
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const settle = () =>
    settleLostReportOrDefer(
      {
        custody,
        database: client.database,
        now: () => Date.now(),
        onDiagnostic: () => undefined,
        onMetric: () => undefined,
      } as never,
      { ...scope, delivery },
      { deliveryId: request.deliveryId } as never,
      delivery.attemptCount,
      {
        type: "session:reconcile:result",
        requestId: randomUUID(),
        sessionId: request.sessionId,
        placementGeneration: request.placementGeneration,
        status: "stopped",
      },
      responder,
      Date.now(),
    );
  return { h, request, turnId, read, custody, settle };
}

it("settles a lost report while the instance that answered is still current", async () => {
  const client = actor();
  const { read, settle } = await lostReport(client, randomUUID());
  await settle();
  expect((await read()).reportedAt).not.toBeNull();
  expect((await read()).turnReport).toMatchObject({ outcome: "unknown" });
});

it("leaves the report to an owner whose registration wins the race with the settlement", async () => {
  const client = actor();
  const registrar = actor();
  const { h, request, turnId, read, custody, settle } = await lostReport(client, randomUUID());
  let settled = false;
  let settling: Promise<void> | undefined;
  await registrar.sql.begin(async (tx) => {
    // The owner re-registers: the same write `ComputerService.register` makes, not yet committed.
    await tx`update computers set current_instance_id = ${h.context.instanceId} where id = ${h.context.computerId}`;
    settling = settle().then(() => {
      settled = true;
    });
    // The settlement has to wait for this registration at the Computer lock.
    await expect
      .poll(
        async () =>
          (
            await client.sql`select count(*)::int as waiting from pg_stat_activity
              where wait_event_type = 'Lock' and datname = current_database()`
          )[0]?.waiting,
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
    expect(settled).toBe(false);
  });
  await settling;
  const deferred = await read();
  expect(deferred.reportedAt).toBeNull();
  expect(deferred.lastErrorCode).toBe("IM_DELIVERY_RECOVERY_AWAITING_REPORT");
  // The genuine report still lands.
  const body = {
    type: "turn:report" as const,
    requestId: randomUUID(),
    deliveryId: request.deliveryId,
    turnId,
    sessionId: request.sessionId,
    agentId: request.agentId,
    placementGeneration: request.placementGeneration,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  expect(await custody.recordTurn({ ...body, resultHash: computeTurnResultHash(body) }, h.context)).toBe("recorded");
});
