import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { computeTurnResultHash } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabaseClient, type DatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
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
import { AgentService } from "../../services/agents/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { deferred } from "../support/deferred.js";
import { createSlackWorkingFixture } from "../support/slack-working-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

function pauseAfterLock(
  database: DatabaseClient,
  table: "computers" | "session_placements",
  pause: () => Promise<void>,
) {
  let armed = true;
  const wrapQuery = (query: object): object =>
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
                if (armed && statement?.sql.includes(`from "${table}"`) && statement.sql.includes(" for ")) {
                  armed = false;
                  await pause();
                }
                return rows;
              })
              .then(fulfilled, rejected);
          };
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          return result && typeof result === "object" ? wrapQuery(result) : result;
        };
      },
    });
  const wrapExecutor = (executor: object): object =>
    new Proxy(executor, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "select") return (...args: unknown[]) => wrapQuery(Reflect.apply(value, target, args));
        if (key === "transaction")
          return (run: (transaction: unknown) => Promise<unknown>) =>
            Reflect.apply(value, target, [(transaction: object) => run(wrapExecutor(transaction))]);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrapExecutor(database) as DatabaseClient;
}

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

it("defers without waiting while the owner's registration is uncommitted, and leaves the report to it", async () => {
  const client = actor();
  const registrar = actor();
  const { h, request, turnId, read, custody, settle } = await lostReport(client, randomUUID());
  await registrar.sql.begin(async (tx) => {
    // The owner re-registers: the same write `ComputerService.register` makes, not yet committed.
    await tx`update computers set current_instance_id = ${h.context.instanceId} where id = ${h.context.computerId}`;
    await settle();
    expect((await read()).reportedAt).toBeNull();
  });
  // Committed: the responder is no longer current, so a later attempt defers too.
  await settle();
  const later = await read();
  expect(later.reportedAt).toBeNull();
  expect(later.lastErrorCode).toBe("IM_DELIVERY_RECOVERY_AWAITING_REPORT");
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

it("does not deadlock with a rebind that holds the Computer and wants the placement", async () => {
  const client = actor();
  const rebinder = actor();
  const responder = randomUUID();
  const { h, request, read, settle } = await lostReport(client, responder);
  const [agent] = await client.database.select().from(agents).where(eq(agents.id, request.agentId));
  assert(agent);
  await client.database
    .insert(agentRuntimeConfigs)
    .values({ agentId: agent.id, instructions: "" })
    .onConflictDoNothing();
  const computerHeld = deferred();
  const resume = deferred();
  const service = new AgentService(
    pauseAfterLock(rebinder.database, "computers", async () => {
      computerHeld.resolve();
      await resume.promise;
    }),
  );
  const rebind = service.rebindById(agent.createdByUserId, agent.id, h.context.computerId);
  await computerHeld.promise;
  // Takes the Session, placement and delivery locks, then finds the Computer held, and backs out.
  await settle();
  expect((await read()).reportedAt).toBeNull();
  resume.resolve();
  await expect(rebind).resolves.toBeDefined();
  // With the Computer free again the next attempt settles.
  await settle();
  expect((await read()).turnReport).toMatchObject({ outcome: "unknown" });
});
