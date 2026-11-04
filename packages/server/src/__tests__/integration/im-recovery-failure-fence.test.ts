import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type SessionReconcileRequest,
  type SessionReconcileResult,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imMessageDeliveries } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { deferred } from "../support/deferred.js";
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
  const client = createDatabaseClient(pg.databaseUrl, { max: 1 });
  clients.push(client);
  return client;
}

it.each(["terminal report", "newer attempt", "current attempt"])(
  "fences a recovery timeout against %s",
  async (change) => {
    const client = actor(),
      other = actor();
    const h = await createSlackWorkingFixture(
      client.database,
      new ApplicationCipher(Buffer.alloc(32, 11)),
      () => new Date(),
    );
    const { request } = await h.delivery(),
      hash = computeDirectInputHash(request);
    await client.database
      .update(computers)
      .set({ currentInstanceId: h.context.instanceId, currentInstallationId: h.context.installationId })
      .where(eq(computers.id, h.context.computerId));
    await client.database
      .update(imMessageDeliveries)
      .set({ dispatchInputHash: hash, inputHash: hash, nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(imMessageDeliveries.id, request.deliveryId));
    const entered = deferred(),
      release = deferred(),
      transports: Promise<unknown>[] = [];
    let domain!: RuntimeDomainOwner,
      count = 0;
    const registry = new ConnectionRegistry();
    const socket = {
      readyState: WebSocket.OPEN,
      send: (text: string, done: () => void) => {
        done();
        const frame = JSON.parse(text) as SessionReconcileRequest;
        count++;
        const first = count === 1;
        const result: SessionReconcileResult = {
          type: "session:reconcile:result",
          requestId: frame.requestId,
          sessionId: frame.sessionId,
          placementGeneration: 1,
          status: first ? "stopped" : "ready",
        };
        const work = (async () => {
          if (first) {
            entered.resolve();
            await release.promise;
          }
          await domain.businessOptions().handle(result, h.context);
        })();
        transports.push(work);
        void work.catch(() => undefined);
      },
    } as unknown as WebSocket;
    await registry.register(
      {
        computerId: h.context.computerId,
        instanceId: h.context.instanceId,
        installationId: h.context.installationId,
        socket,
        lastHeartbeatAt: Date.now(),
        clientVersion: "0.1.1",
      },
      async () => undefined,
    );
    const custody = new PostgresRuntimeCustodyStore(client.database);
    domain = new RuntimeDomainOwner(registry, custody, { requestTimeoutMs: 4000 });
    const metrics = vi.fn();
    const worker = new ImDeliveryWorker({
      database: client.database,
      registry,
      domain,
      assembler: { assembleForSession: async () => request.runtime },
      operationTimeoutMs: 1000,
      onMetric: metrics,
    });
    const second = new ImDeliveryWorker({
      database: other.database,
      registry,
      domain,
      assembler: { assembleForSession: async () => request.runtime },
      operationTimeoutMs: 3000,
    });
    const read = async () => {
      const [row] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, request.deliveryId));
      assert(row);
      return row;
    };
    const recovering = worker.runOnce();
    try {
      await entered.promise;
      if (change === "terminal report") {
        const accepted = await read();
        assert(accepted.turnId);
        const body = {
          type: "turn:report" as const,
          requestId: randomUUID(),
          deliveryId: request.deliveryId,
          turnId: accepted.turnId,
          sessionId: request.sessionId,
          agentId: request.agentId,
          placementGeneration: 1,
          outcome: "completed" as const,
          executionEffects: "completed" as const,
          traceSummary: { lastSequence: 0, droppedEvents: 0 },
        };
        expect(await custody.recordTurn({ ...body, resultHash: computeTurnResultHash(body) }, h.context)).toBe(
          "recorded",
        );
      } else if (change === "newer attempt") {
        await other.database
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(Date.now() - 1000) })
          .where(eq(imMessageDeliveries.id, request.deliveryId));
        await second.runOnce();
        expect((await read()).attemptCount).toBe(2);
      }
      expect(metrics.mock.calls.some(([metric]) => metric.name === "timeout")).toBe(false);
      const before = await read();
      await expect
        .poll(() => metrics.mock.calls.some(([metric]) => metric.name === "timeout"), { timeout: 2500, interval: 10 })
        .toBe(true);
      await expect(client.sql`select 1 as healthy`).resolves.toHaveLength(1);
      const timed = await read();
      if (change === "current attempt") {
        await expect.poll(async () => (await read()).lastErrorCode).toBe("IM_DELIVERY_OPERATION_TIMEOUT");
        expect(timed.reportedAt).toBeNull();
      } else {
        expect(timed.lastErrorCode).toBe(before.lastErrorCode);
        expect(timed.nextAttemptAt).toEqual(before.nextAttemptAt);
        expect(timed.resultHash).toBe(before.resultHash);
      }
      release.resolve();
      await recovering;
      if (change !== "current attempt") {
        expect((await read()).lastErrorCode).toBe(before.lastErrorCode);
        expect((await read()).nextAttemptAt).toEqual(before.nextAttemptAt);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([recovering, ...transports]);
      await worker.stop();
      await second.stop();
      domain.close();
    }
  },
);
