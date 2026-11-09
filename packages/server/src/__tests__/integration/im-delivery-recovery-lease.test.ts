import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { computeTurnResultHash, type SessionReconcileRequest, type TurnReportRequest } from "@opentag/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createDatabaseClient } from "../../db/client.js";
import {
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { deliveryTestId, seedDeliveryQuery } from "../support/im-delivery-query-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

let testDatabase: MigratedTestDatabase;
let client: ReturnType<typeof createDatabaseClient>;
let peer: ReturnType<typeof createDatabaseClient>;
const workers: ImDeliveryWorker[] = [];
beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  client = createDatabaseClient(testDatabase.databaseUrl);
  peer = createDatabaseClient(testDatabase.databaseUrl);
}, 120_000);
beforeEach(async () => {
  await testDatabase.reset();
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});
afterAll(async () => {
  await Promise.all([client?.sql.end(), peer?.sql.end()]);
  await testDatabase?.stop();
});

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const seeded = await seedDeliveryQuery(client.database);
  const instanceId = randomUUID();
  await client.database
    .update(computers)
    .set({ currentInstanceId: instanceId })
    .where(eq(computers.id, seeded.computerId));
  await client.database
    .update(imMessageDeliveries)
    .set({
      state: "accepted",
      inputHash: "original-input",
      turnId: "original-turn",
      reportOwnerInstanceId: instanceId,
      acceptedAt: new Date(),
      attemptCount: 24,
      nextAttemptAt: new Date(Date.now() - 1),
      lastErrorCode: null,
    })
    .where(eq(imMessageDeliveries.id, seeded.deliveryId));
  const registry = new ConnectionRegistry();
  await registry.register(
    {
      computerId: seeded.computerId,
      instanceId,
      installationId: randomUUID(),
      clientVersion: "test",
      lastHeartbeatAt: Date.now(),
      socket: { close: vi.fn(), terminate: vi.fn() } as never,
    },
    async () => undefined,
  );
  return { ...seeded, registry, instanceId, installationId: deliveryTestId("installation", 1) };
}
async function readDelivery(id: string) {
  const [row] = await client.database.select().from(imMessageDeliveries).where(eq(imMessageDeliveries.id, id));
  if (!row) throw new Error("missing fixture delivery");
  return row;
}
function worker(
  database: typeof client.database,
  registry: ConnectionRegistry,
  requestReconcile: ReturnType<typeof vi.fn>,
  options: Partial<ConstructorParameters<typeof ImDeliveryWorker>[0]> = {},
) {
  const created = new ImDeliveryWorker({
    database,
    registry,
    assembler: { assembleForSession: vi.fn() },
    domain: {
      requestReconcile,
      requestDelivery: vi.fn(() => {
        throw new Error("accepted input was redispatched");
      }),
      requestSteer: vi.fn(() => {
        throw new Error("accepted input was steered");
      }),
    } as never,
    ...options,
  });
  workers.push(created);
  return created;
}

async function wireFixture(f: Awaited<ReturnType<typeof fixture>>, onResult?: () => Promise<void>) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing WebSocket port");
  const connection = once(server, "connection");
  const remote = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const [socket] = (await connection) as [WebSocket];
  await once(remote, "open");
  const frames: SessionReconcileRequest[] = [];
  const replies: unknown[] = [];
  remote.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "session:reconcile") frames.push(frame);
    else replies.push(frame);
  });
  await f.registry.register(
    {
      clientVersion: "0.1.1",
      computerId: f.computerId,
      instanceId: f.instanceId,
      installationId: f.installationId,
      lastHeartbeatAt: Date.now(),
      socket,
      negotiatedCapabilities: { "runtime.sessionReconcile": 1 },
    },
    async () => undefined,
  );
  const custody = new PostgresRuntimeCustodyStore(client.database);
  const domain = new RuntimeDomainOwner(f.registry, custody, {
    requestTimeoutMs: 400,
    ...(onResult ? { prepareReconcile: async (_computerId, _instanceId, request) => ({ request, onResult }) } : {}),
  });
  const context = {
    computerId: f.computerId,
    instanceId: f.instanceId,
    installationId: f.installationId,
    signal: new AbortController().signal,
  };
  const errors: unknown[] = [];
  socket.on("message", (data) => {
    void domain
      .handle(JSON.parse(data.toString()), context)
      .then((reply) => {
        if (reply) socket.send(JSON.stringify(reply));
      })
      .catch((error: unknown) => errors.push(error));
  });
  socket.on("close", () => f.registry.remove(f.computerId, f.instanceId, socket));
  return {
    domain,
    frames,
    remote,
    replies,
    errors,
    close: async () => {
      await domain.close();
      remote.terminate();
      socket.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function assertLateReport(
  f: Awaited<ReturnType<typeof fixture>>,
  wire: Awaited<ReturnType<typeof wireFixture>>,
  owner: ImDeliveryWorker,
  request: SessionReconcileRequest,
) {
  // A late reconcile is ignored, while the authentic Turn report remains independently admissible.
  wire.remote.send(
    JSON.stringify({
      type: "session:reconcile:result",
      requestId: request.requestId,
      sessionId: request.sessionId,
      placementGeneration: request.placementGeneration,
      status: "busy",
      reason: "active_turn",
    }),
  );
  const body = {
    deliveryId: f.deliveryId,
    sessionId: f.sessionId,
    agentId: f.agentId,
    turnId: "original-turn",
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  const report: TurnReportRequest = {
    type: "turn:report",
    requestId: randomUUID(),
    ...body,
    resultHash: computeTurnResultHash(body),
  };
  wire.remote.send(JSON.stringify(report));
  await expect.poll(() => wire.replies.length).toBe(1);
  wire.remote.send(JSON.stringify(report));
  await expect.poll(() => wire.replies.length).toBe(2);
  expect(wire.replies).toEqual([
    expect.objectContaining({ status: "recorded" }),
    expect.objectContaining({ status: "already_recorded" }),
  ]);
  const terminal = await readDelivery(f.deliveryId);
  await owner.runOnce();
  expect(await readDelivery(f.deliveryId)).toEqual(terminal);
  expect(terminal.resultHash).toBe(report.resultHash);
  expect(wire.frames).toHaveLength(1);
}

async function retainedFixture() {
  const f = await fixture();
  const body = {
    deliveryId: f.deliveryId,
    sessionId: f.sessionId,
    agentId: f.agentId,
    turnId: "original-turn",
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  const report: TurnReportRequest = {
    type: "turn:report",
    requestId: randomUUID(),
    ...body,
    resultHash: computeTurnResultHash(body),
  };
  const dispatchRequestId = randomUUID();
  const inputHash = "a".repeat(64);
  await client.database
    .update(imMessageDeliveries)
    .set({
      dispatchRequestId,
      dispatchInputHash: inputHash,
      inputHash,
    })
    .where(eq(imMessageDeliveries.id, f.deliveryId));
  const claim = {
    deliveryId: f.deliveryId,
    dispatchRequestId,
    inputHash,
    turnId: body.turnId,
    placementGeneration: 1,
    resultHash: report.resultHash,
  };
  return { f, report, claim };
}

type Manifest =
  | "matching"
  | "absent"
  | "delivery"
  | "turn"
  | "dispatch"
  | "input"
  | "generation"
  | "hash"
  | "other-claimed";

async function prepareManifest({ f, report, claim }: Awaited<ReturnType<typeof retainedFixture>>, manifest: Manifest) {
  if (manifest === "delivery") claim.deliveryId = randomUUID();
  if (manifest === "turn") claim.turnId = "another-turn";
  if (manifest === "dispatch") claim.dispatchRequestId = randomUUID();
  if (manifest === "input") claim.inputHash = "b".repeat(64);
  if (manifest === "generation") claim.placementGeneration++;
  if (manifest === "hash") {
    await client.database
      .update(imMessageDeliveries)
      .set({ resultHash: report.resultHash })
      .where(eq(imMessageDeliveries.id, f.deliveryId));
    claim.resultHash = "b".repeat(64);
  }
  if (manifest === "other-claimed") {
    const original = await readDelivery(f.deliveryId);
    claim.deliveryId = randomUUID();
    claim.turnId = "another-turn";
    claim.dispatchRequestId = randomUUID();
    const [message] = await client.database.select().from(imMessages).where(eq(imMessages.id, original.messageId));
    if (!message) throw new Error("missing fixture message");
    const messageId = randomUUID();
    await client.database.insert(imMessages).values({ ...message, id: messageId, externalMessageId: messageId });
    await client.database.insert(imMessageDeliveries).values({
      ...original,
      id: claim.deliveryId,
      messageId,
      dispatchRequestId: claim.dispatchRequestId,
      turnId: claim.turnId,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
  }
}

describe("accepted recovery leases on independent PostgreSQL connections", () => {
  it.each(
    (["ready", "stopped"] as const).flatMap((status) =>
      (["report", "cancel", "failure"] as const).map((race) => ({ status, race })),
    ),
  )("preserves a $race after claiming a retained report with $status", async ({ status, race }) => {
    const { f, report, claim } = await retainedFixture();
    const entered = barrier();
    const finish = barrier();
    const wire = await wireFixture(f, async () => {
      entered.release();
      await finish.promise;
      if (race === "failure") throw new Error("reconcile completion failed");
    });
    const diagnostic = vi.fn();
    const owner = worker(client.database, f.registry, vi.fn(), { domain: wire.domain, onDiagnostic: diagnostic });
    const running = owner.runOnce();
    let stopping: Promise<void> | undefined;
    try {
      await expect.poll(() => wire.frames.length).toBe(1);
      const request = wire.frames[0];
      if (!request) throw new Error("missing reconcile request");
      wire.remote.send(
        JSON.stringify({
          type: "session:reconcile:result",
          requestId: request.requestId,
          sessionId: request.sessionId,
          placementGeneration: request.placementGeneration,
          status,
          retainedReports: [claim],
        }),
      );
      await entered.promise;
      expect(await readDelivery(f.deliveryId)).toMatchObject({ reportedAt: null, resultHash: report.resultHash });
      if (race === "report") {
        wire.remote.send(JSON.stringify(report));
        await expect.poll(() => wire.replies.length).toBe(1);
      } else if (race === "cancel") {
        stopping = owner.stop();
      }
      finish.release();
      await running;
      await stopping;
      expect((await readDelivery(f.deliveryId)).lastErrorCode).toBe(
        race === "failure" ? "IM_DELIVERY_RECOVERY_FAILED" : null,
      );
      expect(diagnostic).toHaveBeenCalledTimes(race === "failure" ? 1 : 0);
      if (race !== "report") {
        wire.remote.send(JSON.stringify(report));
        await expect.poll(() => wire.replies.length).toBe(1);
      }
      wire.remote.send(JSON.stringify(report));
      await expect.poll(() => wire.replies.length).toBe(2);
      expect(wire.replies).toEqual([
        expect.objectContaining({ status: "recorded" }),
        expect.objectContaining({ status: "already_recorded" }),
      ]);
      expect((await readDelivery(f.deliveryId)).reportedAt).not.toBeNull();
      expect(wire.frames).toHaveLength(1);
      expect(wire.errors).toEqual([]);
    } finally {
      finish.release();
      await owner.stop();
      await wire.close();
      await Promise.allSettled([running, stopping]);
    }
  });

  it.each(
    (["ready", "stopped"] as const).flatMap((status) =>
      (
        ["matching", "absent", "delivery", "turn", "dispatch", "input", "generation", "hash", "other-claimed"] as const
      ).map((manifest) => ({ status, manifest })),
    ),
  )(
    "classifies $status recovery with a $manifest retained manifest before the actual report",
    async ({ status, manifest }) => {
      const { f, report, claim } = await retainedFixture();
      await prepareManifest({ f, report, claim }, manifest);
      const wire = await wireFixture(f);
      const diagnostic = vi.fn();
      const sends = vi.spyOn(f.registry, "send");
      const now = new Date();
      const owner = worker(client.database, f.registry, vi.fn(), {
        domain: wire.domain,
        onDiagnostic: diagnostic,
        now: () => now,
      });
      const running = owner.runOnce();
      try {
        await expect.poll(() => wire.frames.length).toBe(1);
        const request = wire.frames[0];
        if (!request) throw new Error("missing reconcile request");
        wire.remote.send(
          JSON.stringify({
            type: "session:reconcile:result",
            requestId: request.requestId,
            sessionId: request.sessionId,
            placementGeneration: request.placementGeneration,
            status,
            retainedReports: manifest === "absent" ? [] : [claim],
            claimedRetainedReports: [claim],
          }),
        );
        await running;
        expect(await readDelivery(f.deliveryId)).toMatchObject({
          state: "accepted",
          reportedAt: null,
          turnReport: null,
          resultHash: ["matching", "hash"].includes(manifest) ? report.resultHash : null,
          reportOwnerInstanceId: f.instanceId,
          attemptCount: 25,
          nextAttemptAt: new Date(now.getTime() + 30_000),
          lastErrorCode:
            manifest === "matching" ? "IM_DELIVERY_RECOVERY_REPORTING" : "IM_DELIVERY_RECOVERY_AWAITING_REPORT",
        });
        expect(diagnostic).toHaveBeenCalledTimes(manifest === "matching" ? 0 : 1);
        if (manifest === "other-claimed") {
          expect(await readDelivery(claim.deliveryId)).toMatchObject({ resultHash: claim.resultHash });
        }
        wire.remote.send(JSON.stringify(report));
        await expect.poll(() => wire.replies.length).toBe(1);
        wire.remote.send(JSON.stringify(report));
        await expect.poll(() => wire.replies.length).toBe(2);
        expect(wire.replies).toEqual([
          expect.objectContaining({ status: "recorded" }),
          expect.objectContaining({ status: "already_recorded" }),
        ]);
        const terminal = await readDelivery(f.deliveryId);
        await owner.runOnce();
        expect(await readDelivery(f.deliveryId)).toEqual(terminal);
        expect(wire.frames).toHaveLength(1);
        for (const call of sends.mock.calls) expect(call[2]).toMatchObject({ type: "session:reconcile" });
        expect(wire.errors).toEqual([]);
      } finally {
        await owner.stop();
        await wire.close();
        await Promise.allSettled([running]);
      }
    },
  );

  it("keeps one recovery attempt through slow reconcile and competing scans", async () => {
    const f = await fixture();
    const entered = barrier();
    const finish = barrier();
    const reconcile = vi.fn(async () => {
      entered.release();
      await finish.promise;
      return { status: "busy" };
    });
    const metrics: Array<{ name: string; value: number }> = [];
    const diagnostic = vi.fn();
    const options = {
      claimLeaseMs: 300,
      claimRenewMs: 50,
      operationTimeoutMs: 10_000,
      onDiagnostic: diagnostic,
      onMetric: (metric: { name: string; value: number }) => metrics.push(metric),
    };
    const owner = worker(client.database, f.registry, reconcile, options);
    const competitor = worker(peer.database, f.registry, reconcile, options);
    const runs = [owner.runOnce()];
    try {
      await entered.promise;
      // Cross the old two-second retry and many renewed lease periods with actual SQL/timers.
      const until = Date.now() + 2_500;
      while (Date.now() < until) {
        runs.push(owner.runOnce(), competitor.runOnce());
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await readDelivery(f.deliveryId)).attemptCount).toBe(25);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(metrics.filter((metric) => metric.name === "queued_tasks").every((metric) => metric.value === 0)).toBe(
        true,
      );
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      finish.release();
      await Promise.all(runs);
      await Promise.all([owner.stop(), competitor.stop()]);
    }
    expect(await readDelivery(f.deliveryId)).toMatchObject({
      state: "accepted",
      attemptCount: 25,
      inputHash: "original-input",
      turnId: "original-turn",
      reportedAt: null,
      lastErrorCode: "IM_DELIVERY_RECOVERY_BUSY",
    });
  }, 15_000);

  it("renews before enqueue and while globally queued, then drops queued recovery on close", async () => {
    const f = await fixture();
    const claimed = barrier();
    const enqueue = barrier();
    const entered = barrier();
    const reconcile = vi.fn(async (...args: unknown[]) => {
      entered.release();
      const signal = args[5] as AbortSignal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    let claims = 0;
    const diagnostic = vi.fn();
    const owner = worker(client.database, f.registry, reconcile, {
      maxConcurrent: 1,
      claimLeaseMs: 300,
      claimRenewMs: 30,
      onDiagnostic: diagnostic,
      afterClaimRowLocked: async () => {
        if (++claims === 1) {
          claimed.release();
          await enqueue.promise;
        }
      },
    });
    const competitor = worker(peer.database, f.registry, reconcile);
    const first = owner.runOnce();
    const runs = [first];
    try {
      await claimed.promise;
      const originalLease = (await readDelivery(f.deliveryId)).nextAttemptAt;
      await expect
        .poll(async () => (await readDelivery(f.deliveryId)).nextAttemptAt.getTime())
        .toBeGreaterThan(originalLease.getTime());
      enqueue.release();
      await entered.promise;
      await client.database
        .update(imMessageDeliveries)
        .set({
          state: "accepted",
          inputHash: "queued-input",
          turnId: "queued-turn",
          reportOwnerInstanceId: randomUUID(),
          acceptedAt: new Date(),
          nextAttemptAt: new Date(Date.now() - 1),
          lastErrorCode: null,
        })
        .where(eq(imMessageDeliveries.id, f.occupantId));
      runs.push(owner.runOnce());
      await expect.poll(async () => (await readDelivery(f.occupantId)).attemptCount).toBe(1);
      const queuedLease = (await readDelivery(f.occupantId)).nextAttemptAt;
      await expect
        .poll(async () => (await readDelivery(f.occupantId)).nextAttemptAt.getTime())
        .toBeGreaterThan(queuedLease.getTime() + 300);
      await competitor.runOnce();
      expect((await readDelivery(f.occupantId)).attemptCount).toBe(1);
      await owner.stop();
      await Promise.all(runs);
      const stopped = await readDelivery(f.occupantId);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect((await readDelivery(f.occupantId)).nextAttemptAt).toEqual(stopped.nextAttemptAt);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      enqueue.release();
      await owner.stop();
      await Promise.all(runs);
    }
  });

  it("settles cooperative deadline cancellation once without recovery-failed or late-settle", async () => {
    const f = await fixture();
    const diagnostic = vi.fn();
    const metrics: Array<{ name: string; value: number }> = [];
    const reconcile = vi.fn(async (...args: unknown[]) => {
      const signal = args[5] as AbortSignal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("transport cancelled")), { once: true }),
      );
    });
    const owner = worker(client.database, f.registry, reconcile, {
      operationTimeoutMs: 150,
      claimLeaseMs: 100,
      claimRenewMs: 20,
      onDiagnostic: diagnostic,
      onMetric: (metric) => metrics.push(metric),
    });
    await owner.runOnce();
    expect(await readDelivery(f.deliveryId)).toMatchObject({
      state: "accepted",
      attemptCount: 25,
      turnId: "original-turn",
      inputHash: "original-input",
      reportedAt: null,
      resultHash: null,
      lastErrorCode: "IM_DELIVERY_OPERATION_TIMEOUT",
    });
    expect(diagnostic.mock.calls.map(([code]) => code)).toEqual(["IM_DELIVERY_OPERATION_TIMEOUT"]);
    expect(metrics.filter((metric) => metric.name === "retry")).toHaveLength(1);
    expect(metrics.filter((metric) => metric.name === "late_settle")).toHaveLength(0);
  });

  it("joins cancelled reconcile cleanup on shutdown without scheduling a failure", async () => {
    const f = await fixture();
    const entered = barrier();
    const cancelled = barrier();
    const cleanup = barrier();
    const diagnostic = vi.fn();
    const reconcile = vi.fn(async (...args: unknown[]) => {
      entered.release();
      const signal = args[5] as AbortSignal;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled.release();
            resolve();
          },
          { once: true },
        ),
      );
      await cleanup.promise;
      throw signal.reason;
    });
    const owner = worker(client.database, f.registry, reconcile, {
      claimLeaseMs: 300,
      claimRenewMs: 30,
      onDiagnostic: diagnostic,
    });
    const run = owner.runOnce();
    try {
      await entered.promise;
      let closed = false;
      const closing = owner.stop().then(() => {
        closed = true;
      });
      await cancelled.promise;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closed).toBe(false);
      cleanup.release();
      await Promise.all([run, closing]);
      expect(await readDelivery(f.deliveryId)).toMatchObject({
        state: "accepted",
        attemptCount: 25,
        lastErrorCode: null,
        reportedAt: null,
      });
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      cleanup.release();
      await run;
    }
  });

  it.each(["reported", "newer-attempt"] as const)("does not renew or reschedule over a %s winner", async (race) => {
    const f = await fixture();
    const entered = barrier();
    const finish = barrier();
    const diagnostic = vi.fn();
    const reconcile = vi.fn(async (...args: unknown[]) => {
      entered.release();
      await finish.promise;
      // Deliberately ignore cancellation: a stale response cannot overwrite the winner.
      expect((args[5] as AbortSignal).aborted).toBe(true);
      return { status: "ready" };
    });
    const owner = worker(client.database, f.registry, reconcile, {
      claimLeaseMs: 300,
      claimRenewMs: 20,
      onDiagnostic: diagnostic,
    });
    const run = owner.runOnce();
    try {
      await entered.promise;
      const nextAttemptAt = new Date(Date.now() + 60_000);
      await peer.database
        .update(imMessageDeliveries)
        .set({
          ...(race === "reported"
            ? { reportedAt: new Date(), resultHash: "winner-hash", turnReport: {} as never }
            : { attemptCount: 26 }),
          lastErrorCode: "winner",
          nextAttemptAt,
        })
        .where(eq(imMessageDeliveries.id, f.deliveryId));
      await new Promise((resolve) => setTimeout(resolve, 80));
      finish.release();
      await run;
      expect(await readDelivery(f.deliveryId)).toMatchObject({
        nextAttemptAt,
        lastErrorCode: "winner",
        ...(race === "reported" ? { resultHash: "winner-hash" } : { attemptCount: 26 }),
      });
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      finish.release();
      await run;
    }
  });

  it.each([false, true])(
    "holds the lease until an uncooperative timed-out operation actually settles (abandoned=%s)",
    async (abandoned) => {
      const f = await fixture();
      const entered = barrier();
      const finish = barrier();
      const diagnostic = vi.fn();
      const reconcile = vi.fn(async () => {
        entered.release();
        await finish.promise;
        return { status: "busy" };
      });
      const options = { claimLeaseMs: 300, claimRenewMs: 30, operationTimeoutMs: 150, onDiagnostic: diagnostic };
      const owner = worker(client.database, f.registry, reconcile, options);
      const competitor = worker(peer.database, f.registry, reconcile, options);
      const run = owner.runOnce();
      try {
        await entered.promise;
        if (abandoned) {
          await run;
          expect(diagnostic.mock.calls.map(([code]) => code)).toEqual(["IM_DELIVERY_OPERATION_ABANDONED"]);
        } else await new Promise((resolve) => setTimeout(resolve, 200));
        await Promise.all([owner.runOnce(), competitor.runOnce()]);
        expect((await readDelivery(f.deliveryId)).attemptCount).toBe(25);
        expect((await readDelivery(f.deliveryId)).nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        finish.release();
        await run;
        await owner.stop();
        expect(await readDelivery(f.deliveryId)).toMatchObject({
          state: "accepted",
          lastErrorCode: "IM_DELIVERY_OPERATION_TIMEOUT",
          attemptCount: 25,
        });
        expect(diagnostic.mock.calls.map(([code]) => code)).toEqual(
          abandoned
            ? ["IM_DELIVERY_OPERATION_ABANDONED", "IM_DELIVERY_OPERATION_TIMEOUT"]
            : ["IM_DELIVERY_OPERATION_TIMEOUT", "IM_DELIVERY_OPERATION_LATE_SETTLE"],
        );
        expect(reconcile).toHaveBeenCalledTimes(1);
      } finally {
        finish.release();
        await run;
      }
    },
  );

  it("records a disconnected transport once and allows the next due recovery without redispatch", async () => {
    const f = await fixture();
    const diagnostic = vi.fn();
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket disconnected"))
      .mockResolvedValue({ status: "reporting" });
    const owner = worker(client.database, f.registry, reconcile, { onDiagnostic: diagnostic });
    await owner.runOnce();
    expect((await readDelivery(f.deliveryId)).lastErrorCode).toBe("IM_DELIVERY_RECOVERY_FAILED");
    await client.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1) })
      .where(eq(imMessageDeliveries.id, f.deliveryId));
    await owner.runOnce();
    expect(await readDelivery(f.deliveryId)).toMatchObject({
      state: "accepted",
      attemptCount: 26,
      turnId: "original-turn",
      inputHash: "original-input",
      lastErrorCode: "IM_DELIVERY_RECOVERY_REPORTING",
      reportedAt: null,
    });
    expect(diagnostic.mock.calls.map(([code]) => code)).toEqual(["IM_DELIVERY_RECOVERY_FAILED"]);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it.each(["busy", "timeout", "disconnect", "stop"] as const)(
    "settles %s through the real Runtime owner and loopback WebSocket",
    async (outcome) => {
      const f = await fixture();
      const wire = await wireFixture(f);
      const diagnostic = vi.fn();
      const owner = worker(client.database, f.registry, vi.fn(), {
        domain: wire.domain,
        operationTimeoutMs: outcome === "timeout" ? 150 : 2_000,
        claimLeaseMs: 300,
        claimRenewMs: 30,
        onDiagnostic: diagnostic,
      });
      const run = owner.runOnce();
      try {
        await expect.poll(() => wire.frames.length).toBe(1);
        const request = wire.frames[0];
        if (!request) throw new Error("missing reconcile frame");
        const result = {
          type: "session:reconcile:result",
          requestId: request.requestId,
          sessionId: request.sessionId,
          placementGeneration: request.placementGeneration,
          status: "busy",
          reason: "active_turn",
        };
        if (outcome === "busy") wire.remote.send(JSON.stringify(result));
        if (outcome === "disconnect") wire.remote.terminate();
        if (outcome === "stop") await owner.stop();
        await run;
        expect(wire.frames).toHaveLength(1);
        const expected = {
          busy: "IM_DELIVERY_RECOVERY_BUSY",
          timeout: "IM_DELIVERY_OPERATION_TIMEOUT",
          disconnect: "IM_DELIVERY_RECOVERY_FAILED",
          stop: null,
        }[outcome];
        expect(await readDelivery(f.deliveryId)).toMatchObject({
          state: "accepted",
          attemptCount: 25,
          inputHash: "original-input",
          turnId: "original-turn",
          reportedAt: null,
          lastErrorCode: expected,
        });
        expect(diagnostic.mock.calls.map(([code]) => code)).toEqual(
          ["timeout", "disconnect"].includes(outcome) ? [expected] : [],
        );
        if (outcome === "timeout") await assertLateReport(f, wire, owner, request);
        expect(wire.errors).toEqual([]);
      } finally {
        await owner.stop();
        await wire.close();
        await run;
      }
    },
  );

  it("cancels recovery when a real PostgreSQL renewal connection dies, then admits a fresh owner", async () => {
    const f = await fixture();
    const fault = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const [backend] = await fault.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    if (!backend) throw new Error("missing worker backend");
    const entered = barrier();
    const locked = barrier();
    const unlock = barrier();
    const reconcile = vi.fn(async (...args: unknown[]) => {
      const signal = args[5] as AbortSignal;
      entered.release();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const diagnostic = vi.fn();
    const owner = worker(fault.database, f.registry, reconcile, {
      claimLeaseMs: 500,
      claimRenewMs: 50,
      onDiagnostic: diagnostic,
    });
    const run = owner.runOnce();
    let lock: Promise<void> | undefined;
    try {
      await entered.promise;
      lock = peer.database.transaction(async (tx) => {
        await tx.execute(sql`select id from im_message_deliveries where id=${f.deliveryId} for update`);
        locked.release();
        await unlock.promise;
      });
      await locked.promise;
      await expect
        .poll(async () => {
          const [activity] = await client.sql<
            { wait_event_type: string }[]
          >`select wait_event_type from pg_stat_activity where pid=${backend.pid}`;
          return activity?.wait_event_type;
        })
        .toBe("Lock");
      await client.sql`select pg_terminate_backend(${backend.pid})`;
      unlock.release();
      await Promise.all([lock, run]);
      expect(diagnostic).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect((await readDelivery(f.deliveryId)).attemptCount).toBe(25);
      await owner.stop();
      await client.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() - 1) })
        .where(eq(imMessageDeliveries.id, f.deliveryId));
      const next = vi.fn().mockResolvedValue({ status: "busy" });
      const successor = worker(peer.database, f.registry, next);
      await successor.runOnce();
      expect((await readDelivery(f.deliveryId)).attemptCount).toBe(26);
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      unlock.release();
      await lock;
      await owner.stop();
      await run;
      await fault.sql.end({ timeout: 5 });
    }
  });

  it("lets a successor claim after a stopped owner's lease expires", async () => {
    const f = await fixture();
    const entered = barrier();
    const cancelled = vi.fn(async (...args: unknown[]) => {
      const signal = args[5] as AbortSignal;
      entered.release();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const owner = worker(client.database, f.registry, cancelled, { claimLeaseMs: 150, claimRenewMs: 30 });
    const first = owner.runOnce();
    await entered.promise;
    await owner.stop();
    await first;
    const reconcile = vi.fn().mockResolvedValue({ status: "busy" });
    const successor = worker(peer.database, f.registry, reconcile);
    await expect
      .poll(async () => {
        await successor.runOnce();
        return (await readDelivery(f.deliveryId)).attemptCount;
      })
      .toBe(26);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(await readDelivery(f.deliveryId)).toMatchObject({
      state: "accepted",
      inputHash: "original-input",
      turnId: "original-turn",
      reportedAt: null,
    });
  });

  it.each(["binding", "session", "placement"] as const)(
    "rechecks %s authority after claim and before reconcile",
    async (changed) => {
      const f = await fixture();
      const reconcile = vi.fn();
      const owner = worker(client.database, f.registry, reconcile, {
        afterClaimRowLocked: async () => {
          if (changed === "binding")
            await peer.database
              .update(imBindings)
              .set({ status: "disabled", encryptedCredential: null, disabledAt: new Date() })
              .where(eq(imBindings.id, deliveryTestId("binding", 1)));
          if (changed === "session")
            await peer.database.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, f.sessionId));
          if (changed === "placement")
            await peer.database
              .update(sessionPlacements)
              .set({ generation: 2 })
              .where(eq(sessionPlacements.sessionId, f.sessionId));
        },
      });
      await owner.runOnce();
      expect(reconcile).not.toHaveBeenCalled();
      expect(await readDelivery(f.deliveryId)).toMatchObject({
        state: "accepted",
        inputHash: "original-input",
        turnId: "original-turn",
        reportedAt: null,
        resultHash: null,
      });
    },
  );
});
