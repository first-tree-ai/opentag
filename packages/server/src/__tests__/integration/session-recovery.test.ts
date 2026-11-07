import { randomUUID } from "node:crypto";
import { computeDirectInputHash, type SessionReconcileRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { agents, computers, imMessageDeliveries, sessionPlacements, sessions } from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { SessionRecoveryService } from "../../runtime/session-recovery.js";
import { createFixture, turnReport } from "./im-recovery-locks-fixture.js";
import { startMigratedTestDatabase } from "./migrated-test-database.js";

let pg: Awaited<ReturnType<typeof startMigratedTestDatabase>>;
const clients: ReturnType<typeof createDatabaseClient>[] = [];
beforeAll(async () => {
  pg = await startMigratedTestDatabase();
}, 180_000);
beforeEach(async () => pg.reset());
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.sql.end({ timeout: 5 })));
});
afterAll(async () => pg?.stop());

/** An accepted, unreported IM Turn whose Client then restarted under a new connection instance. */
async function restarted(capable = { current: true }) {
  const client = createDatabaseClient(pg.databaseUrl, { max: 2 });
  clients.push(client);
  const f = await createFixture(client.database);
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const inputHash = computeDirectInputHash(f.rootRequest);
  expect(await custody.beginDeliveryDispatch(f.rootRequest, inputHash, f.dispatchContext)).toBe("dispatched");
  expect(await custody.acceptDelivery(f.rootRequest, inputHash, f.rootTurnId, f.context)).toBe("accepted");
  const instanceId = randomUUID();
  await client.database
    .update(computers)
    .set({ currentInstanceId: instanceId })
    .where(eq(computers.id, f.context.computerId));
  const context = { ...f.context, instanceId };
  const requestReconcile = vi.fn(
    async (_computerId: string, _instanceId: string, request: SessionReconcileRequest, _admission?: unknown) => ({
      type: "session:reconcile:result" as const,
      requestId: request.requestId,
      sessionId: request.sessionId,
      placementGeneration: request.placementGeneration,
      status: "ready" as const,
    }),
  );
  const assembler = { assembleForSession: vi.fn(async () => f.runtime) };
  const service = new SessionRecoveryService({
    assembler,
    database: client.database,
    registry: { canReceiveSnapshot: () => true, supportsCapability: () => capable.current },
    requestReconcile,
  });
  const frame = {
    type: "session:recover" as const,
    requestId: randomUUID(),
    sessionId: f.sessionId,
    agentId: f.agentId,
    placementGeneration: 1,
    deliveryId: f.rootDeliveryId,
    turnId: f.rootTurnId,
  };
  const owner = async () => {
    const [row] = await client.database
      .select({ owner: imMessageDeliveries.reportOwnerInstanceId })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
    return row?.owner;
  };
  return { client, custody, f, context, service, frame, requestReconcile, assembler, owner };
}

/** A second accepted Turn of the same Agent, in its own Session, frozen on a newer Agent revision. */
async function acceptNewerTurn(h: Awaited<ReturnType<typeof restarted>>) {
  const sessionId = randomUUID();
  await h.client.database.insert(sessions).values({
    id: sessionId,
    imBindingId: h.f.bindingId,
    channelId: "channel-newer",
    conversationKind: "channel",
    kind: "channel",
  });
  await h.client.database
    .insert(sessionPlacements)
    .values({ sessionId, computerId: h.context.computerId, generation: 1 });
  const [follow] = h.f.steerRequests;
  await h.client.database
    .update(imMessageDeliveries)
    .set({ sessionId })
    .where(eq(imMessageDeliveries.id, follow.deliveryId));
  const request = {
    ...h.f.rootRequest,
    requestId: randomUUID(),
    deliveryId: follow.deliveryId,
    imMessageId: follow.imMessageId,
    sessionId,
    runtime: {
      ...h.f.runtime,
      revision: { ...h.f.runtime.revision, agent: { sequence: 2, id: "agent-revision-2" } },
    },
  };
  const hash = computeDirectInputHash(request);
  expect(await h.custody.beginDeliveryDispatch(request, hash, h.f.dispatchContext)).toBe("dispatched");
  expect(await h.custody.acceptDelivery(request, hash, "turn-newer", h.f.context)).toBe("accepted");
  return {
    ...h.frame,
    requestId: randomUUID(),
    sessionId,
    deliveryId: follow.deliveryId,
    turnId: "turn-newer",
  };
}

it("recovers Turns oldest configuration first on a Client without per-Session configuration", async () => {
  const capable = { current: false };
  const h = await restarted(capable);
  const newer = await acceptNewerTurn(h);
  // Newer first would have that Client refuse the older Turn's recovery as stale.
  expect(await h.service.recover(newer, h.context)).toEqual({
    status: "retry",
    reason: "older_configuration_recovering",
  });
  expect(h.requestReconcile).not.toHaveBeenCalled();
  // The older Turn goes first, then the newer one once the older has reported.
  expect(await h.service.recover(h.frame, h.context)).toEqual({ status: "scheduled" });
  await h.service.settled();
  expect(h.requestReconcile).toHaveBeenCalledOnce();
  expect(await h.service.recover(newer, h.context)).toEqual({
    status: "retry",
    reason: "older_configuration_recovering",
  });
  expect(await h.custody.recordTurn(turnReport(h.f, "completed"), h.context)).toBe("recorded");
  expect(await h.service.recover(newer, h.context)).toEqual({ status: "scheduled" });
  await h.service.settled();
  expect(h.requestReconcile.mock.calls.at(-1)?.[2]).toMatchObject({ sessionId: newer.sessionId });
});

it("recovers in any order on a Client with per-Session configuration", async () => {
  const h = await restarted();
  const newer = await acceptNewerTurn(h);
  expect(await h.service.recover(newer, h.context)).toEqual({ status: "scheduled" });
  expect(await h.service.recover(h.frame, h.context)).toEqual({ status: "scheduled" });
  await h.service.settled();
  expect(h.requestReconcile).toHaveBeenCalledTimes(2);
});

it("moves the accepted Turn to the new connection and prepares the Session with the frozen snapshot", async () => {
  const h = await restarted();
  // Before recovery the restarted connection cannot report the Turn it is about to retry.
  expect(await h.owner()).toBe(h.f.context.instanceId);
  expect(await h.service.recover(h.frame, h.context)).toEqual({ status: "scheduled" });
  await h.service.settled();
  expect(await h.owner()).toBe(h.context.instanceId);
  expect(h.assembler.assembleForSession).not.toHaveBeenCalled();
  expect(h.requestReconcile).toHaveBeenCalledExactlyOnceWith(
    h.context.computerId,
    h.context.instanceId,
    expect.objectContaining({
      type: "session:reconcile",
      sessionId: h.f.sessionId,
      agentId: h.f.agentId,
      placementGeneration: 1,
      desired: "ready",
      runtime: h.f.rootRequest.runtime,
    }),
    expect.any(Function),
  );
  expect(h.requestReconcile.mock.calls[0]?.[2]).not.toHaveProperty("sessionKind");
  // The retry's report settles the original delivery through the ordinary report path.
  const report = turnReport(h.f, "completed");
  expect(await h.custody.recordTurn(report, h.context)).toBe("recorded");
});

it("takes the same accepted Turn over again after another restart, and accepts its report", async () => {
  const h = await restarted();
  expect(await h.service.recover(h.frame, h.context)).toEqual({ status: "scheduled" });
  await h.service.settled();
  expect(await h.owner()).toBe(h.context.instanceId);

  // The resumed Turn was interrupted too: another restart recovers it under a newer connection.
  const instanceId = randomUUID();
  await h.client.database
    .update(computers)
    .set({ currentInstanceId: instanceId })
    .where(eq(computers.id, h.context.computerId));
  const context = { ...h.context, instanceId };
  expect(await h.service.recover({ ...h.frame, requestId: randomUUID() }, context)).toEqual({ status: "scheduled" });
  await h.service.settled();
  expect(await h.owner()).toBe(instanceId);
  expect(h.requestReconcile).toHaveBeenCalledTimes(2);
  expect(await h.custody.recordTurn(turnReport(h.f, "completed"), context)).toBe("recorded");
});

it.each(["turn", "generation", "agent", "ended", "suspended-placement"] as const)(
  "refuses recovery with a mismatched %s and leaves custody untouched",
  async (mismatch) => {
    const h = await restarted();
    const frame = { ...h.frame };
    if (mismatch === "turn") frame.turnId = randomUUID();
    if (mismatch === "generation") frame.placementGeneration = 2;
    if (mismatch === "agent") frame.agentId = randomUUID();
    if (mismatch === "ended") {
      await h.client.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, h.f.sessionId));
    }
    if (mismatch === "suspended-placement") {
      await h.client.database
        .update(sessionPlacements)
        .set({ generation: 2 })
        .where(eq(sessionPlacements.sessionId, h.f.sessionId));
    }
    const expected = {
      turn: "turn_not_recoverable",
      generation: "placement_stale",
      agent: "agent_mismatch",
      ended: "session_ended",
      "suspended-placement": "placement_stale",
    }[mismatch];
    expect(await h.service.recover(frame, h.context)).toEqual({ status: "rejected", reason: expected });
    expect(await h.owner()).toBe(h.f.context.instanceId);
    expect(h.requestReconcile).not.toHaveBeenCalled();
  },
);

it("prepares an internal Session with its creator and the current snapshot", async () => {
  const h = await restarted();
  const childId = randomUUID();
  await h.client.database.insert(sessions).values({
    id: childId,
    imBindingId: h.f.bindingId,
    channelId: "channel",
    conversationKind: "channel",
    kind: "internal",
    createdBySessionId: h.f.sessionId,
  });
  await h.client.database
    .insert(sessionPlacements)
    .values({ sessionId: childId, computerId: h.context.computerId, generation: 1 });
  const frame = {
    type: "session:recover" as const,
    requestId: randomUUID(),
    sessionId: childId,
    agentId: h.f.agentId,
    placementGeneration: 1,
  };
  // An internal Session never names an IM Turn.
  expect(
    await h.service.recover({ ...frame, deliveryId: h.f.rootDeliveryId, turnId: h.f.rootTurnId }, h.context),
  ).toEqual({ status: "rejected", reason: "session_kind_mismatch" });
  expect(await h.service.recover(frame, h.context)).toEqual({ status: "scheduled" });
  await h.service.settled();
  expect(h.assembler.assembleForSession).toHaveBeenCalledWith(childId);
  expect(h.requestReconcile).toHaveBeenCalledWith(
    h.context.computerId,
    h.context.instanceId,
    expect.objectContaining({ sessionId: childId, sessionKind: "internal", creatorSessionId: h.f.sessionId }),
    expect.any(Function),
  );
  expect(await h.owner()).toBe(h.f.context.instanceId);
});

it.each([
  ["ends the Session", "session_ended"],
  ["moves the placement", "placement_stale"],
  ["reconnects the Computer", "stale_connection"],
  ["suspends the Agent", "agent_not_active"],
] as const)("a concurrent writer that %s before the takeover commits wins: %s", async (change, reason) => {
  const h = await restarted();
  const holder = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(holder, observer);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let changed!: () => void;
  const applied = new Promise<void>((resolve) => {
    changed = resolve;
  });
  const writer = holder.sql.begin(async (tx) => {
    if (change === "ends the Session") await tx`update sessions set ended_at = now() where id = ${h.f.sessionId}`;
    if (change === "moves the placement")
      await tx`update session_placements set generation = generation + 1 where session_id = ${h.f.sessionId}`;
    if (change === "reconnects the Computer")
      await tx`update computers set current_instance_id = ${randomUUID()} where id = ${h.context.computerId}`;
    if (change === "suspends the Agent") await tx`update agents set status = 'suspended' where id = ${h.f.agentId}`;
    changed();
    await gate;
  });
  await applied;
  const recovery = h.service.recover(h.frame, h.context);
  try {
    // The takeover must wait for the writer instead of deciding on the pre-commit facts.
    await vi.waitFor(
      async () => {
        const [row] = await observer.sql<{ waiting: boolean }[]>`
          select exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock') as waiting`;
        expect(row?.waiting).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
  } finally {
    release();
    await writer;
  }
  expect(await recovery).toEqual({ status: "rejected", reason });
  expect(await h.owner()).toBe(h.f.context.instanceId);
  expect(h.requestReconcile).not.toHaveBeenCalled();
});

it.each(["active", "suspended", "ended"] as const)(
  "admits the ready reconcile at its send boundary only while the authority still holds (%s)",
  async (state) => {
    const h = await restarted();
    expect(await h.service.recover(h.frame, h.context)).toEqual({ status: "scheduled" });
    await h.service.settled();
    const admission = h.requestReconcile.mock.calls[0]?.[3] as (
      operation: (onDispatched: () => void) => Promise<unknown>,
    ) => Promise<{ admitted: boolean; result?: Promise<unknown> }>;
    // A stop committed after the takeover but before the frame is enqueued must win.
    if (state === "suspended") {
      await h.client.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, h.f.agentId));
    }
    if (state === "ended") {
      await h.client.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, h.f.sessionId));
    }
    const operation = vi.fn(async (onDispatched: () => void) => {
      onDispatched();
      return "sent";
    });
    const decision = await admission(operation);
    expect(decision.admitted).toBe(state === "active");
    expect(operation).toHaveBeenCalledTimes(state === "active" ? 1 : 0);
    if (decision.admitted) await expect(decision.result).resolves.toBe("sent");
  },
);

it("holds a concurrent Agent stop behind an admitted ready reconcile until it is enqueued", async () => {
  const h = await restarted();
  await h.service.recover(h.frame, h.context);
  await h.service.settled();
  const admission = h.requestReconcile.mock.calls[0]?.[3] as (
    operation: (onDispatched: () => void) => Promise<unknown>,
  ) => Promise<{ admitted: boolean }>;
  const observer = createDatabaseClient(pg.databaseUrl, { max: 1 });
  const stopper = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(observer, stopper);
  let enqueue: (() => void) | undefined;
  let suspended = false;
  const admitted = admission(
    (onDispatched) =>
      new Promise((resolve) => {
        enqueue = () => {
          onDispatched();
          resolve("sent");
        };
      }),
  );
  await vi.waitFor(() => expect(enqueue).toBeDefined());
  const stop = stopper.sql`update agents set status = 'suspended' where id = ${h.f.agentId}`.then(() => {
    suspended = true;
  });
  await vi.waitFor(
    async () => {
      const [row] = await observer.sql<{ waiting: boolean }[]>`
        select exists(select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock') as waiting`;
      expect(row?.waiting).toBe(true);
    },
    { timeout: 10_000, interval: 50 },
  );
  expect(suspended).toBe(false);
  enqueue?.();
  expect((await admitted).admitted).toBe(true);
  await stop;
  expect(suspended).toBe(true);
});
