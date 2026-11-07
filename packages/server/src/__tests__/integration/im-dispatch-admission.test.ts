import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeRuntimeImMessageSemanticHash,
  computeRuntimeImSteerInputHash,
  type DirectImMessageDeliveryRequest,
  type RuntimeImSteerRequest,
  type SessionReconcileRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, type DatabaseTransaction } from "../../db/client.js";
import { imMessageDeliveries, sessions } from "../../db/schema/index.js";
import { createServerDiagnosticReporter } from "../../observability/diagnostics.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "../../runtime/runtime-domain-owner.js";
import { lockImAgentCustody } from "../../services/im/inbound-admission.js";
import { deferred } from "../support/deferred.js";
import { createFixture, deliveryRows, turnReport } from "./im-recovery-locks-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

describe("IM dispatch admission races", () => {
  let testDatabase: MigratedTestDatabase;
  let client: ReturnType<typeof createDatabaseClient>;
  let racer: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    testDatabase = await startMigratedTestDatabase();
    client = createDatabaseClient(testDatabase.databaseUrl);
    racer = createDatabaseClient(testDatabase.databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await racer?.sql.end();
    await client?.sql.end();
    await testDatabase?.stop();
  });

  beforeEach(async () => {
    await testDatabase.reset();
  });

  async function duringCustodyWait<T>(agentId: string, dispatch: () => Promise<T>, change: () => Promise<void>) {
    const locked = deferred<number>();
    const release = deferred();
    const holding = client.database.transaction(async (transaction) => {
      await lockImAgentCustody(transaction, agentId);
      const [row] = await transaction.execute<{ pid: number }>("select pg_backend_pid() as pid");
      if (!row) throw new Error("Missing lock holder PID");
      locked.resolve(row.pid);
      await release.promise;
    });
    const pid = await locked.promise;
    const result = dispatch();
    void result.catch(() => undefined);
    try {
      await expect
        .poll(async () => {
          const [row] = await client.sql<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where ${pid} = any(pg_blocking_pids(pid)) and wait_event = 'advisory'
        `;
          return row?.count;
        })
        .toBe(1);
      await change();
    } finally {
      release.resolve();
      await holding;
    }
    return result;
  }

  it("defers a matching completed target committed while steer waits for the custody lock", async () => {
    const f = await createFixture(client.database);
    const store = new PostgresRuntimeCustodyStore(racer.database);
    const rootHash = computeDirectInputHash(f.rootRequest);
    await store.beginDeliveryDispatch(f.rootRequest, rootHash, f.dispatchContext);
    await store.acceptDelivery(f.rootRequest, rootHash, f.rootTurnId, f.context);
    const request = f.steerRequests[0];
    expect((await deliveryRows(client.database, f)).root?.reportedAt).toBeNull();
    const result = await duringCustodyWait(
      f.agentId,
      () => store.beginSteerDispatch(request, computeRuntimeImSteerInputHash(request), f.dispatchContext),
      async () => {
        expect(await store.recordTurn(turnReport(f, "completed"), f.context)).toBe("recorded");
      },
    );
    expect(result).toBe("target_ended");
    const rows = await deliveryRows(client.database, f);
    expect(rows.root?.turnReport?.outcome).toBe("completed");
    expect(
      rows.children.every(
        (row) => row.state === "pending" && row.dispatchRequestId === null && row.steerTargetDeliveryId === null,
      ),
    ).toBe(true);
    const direct = {
      ...f.rootRequest,
      requestId: randomUUID(),
      deliveryId: request.deliveryId,
      imMessageId: request.imMessageId,
      content: request.content,
    };
    const hash = computeDirectInputHash(direct);
    expect(await store.beginDeliveryDispatch(direct, hash, f.dispatchContext)).toBe("dispatched");
    expect(await store.acceptDelivery(direct, hash, "next-turn", f.context)).toBe("accepted");
    expect(await store.acceptDelivery(direct, hash, "next-turn", f.context)).toBe("already_accepted");
  });

  it.each(["delivery", "steer"] as const)(
    "defers changed %s batch members atomically and retries the same identities",
    async (kind) => {
      const f = await createFixture(client.database);
      const store = new PostgresRuntimeCustodyStore(racer.database);
      if (kind === "steer") {
        const hash = computeDirectInputHash(f.rootRequest);
        await store.beginDeliveryDispatch(f.rootRequest, hash, f.dispatchContext);
        await store.acceptDelivery(f.rootRequest, hash, f.rootTurnId, f.context);
      }
      const head = kind === "delivery" ? f.rootRequest : f.steerRequests[0];
      const members = kind === "delivery" ? f.steerRequests : [f.steerRequests[1]];
      const request = {
        ...head,
        batch: members.map((member) => ({
          deliveryId: member.deliveryId,
          imMessageId: member.imMessageId,
          inputHash: computeRuntimeImMessageSemanticHash(member),
        })),
      };
      const dispatch = () =>
        request.type === "im:deliver"
          ? store.beginDeliveryDispatch(request, computeDirectInputHash(request), f.dispatchContext)
          : store.beginSteerDispatch(request, computeRuntimeImSteerInputHash(request), f.dispatchContext);
      const memberId = f.steerRequests[1].deliveryId;
      const result = await duringCustodyWait(f.agentId, dispatch, async () => {
        await client.database
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
          .where(eq(imMessageDeliveries.id, memberId));
      });
      expect(result).toBe("batch_changed");
      const rows = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.sessionId, f.sessionId));
      expect(
        rows
          .filter((row) => row.state === "pending")
          .every((row) => row.reason === null && row.dispatchRequestId === null && row.steerTargetDeliveryId === null),
      ).toBe(true);
      await client.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date() })
        .where(eq(imMessageDeliveries.id, memberId));
      expect(await dispatch()).toBe("dispatched");
      expect(await dispatch()).toBe("already_dispatched");
      if (request.type === "im:deliver") {
        expect(await store.acceptDelivery(request, computeDirectInputHash(request), f.rootTurnId, f.context)).toBe(
          "accepted",
        );
      } else {
        expect(
          await store.recordSteered(
            request,
            computeRuntimeImSteerInputHash(request),
            computeRuntimeImMessageSemanticHash(request),
            f.context,
          ),
        ).toBe("steered");
      }
      const settled = await deliveryRows(client.database, f);
      expect(settled.children.every((row) => row.state === "steered")).toBe(true);
    },
  );

  it.each(["target_ended", "batch_changed"] as const)(
    "retries %s through Worker and Runtime Domain without error diagnostics or duplicate input",
    async (reason) => {
      const f = await createFixture(client.database);
      let clock = Date.now() + 1_000;
      const store = new PostgresRuntimeCustodyStore(racer.database, { now: () => new Date(clock) });
      if (reason === "target_ended") {
        const hash = computeDirectInputHash(f.rootRequest);
        await store.beginDeliveryDispatch(f.rootRequest, hash, f.dispatchContext);
        await store.acceptDelivery(f.rootRequest, hash, f.rootTurnId, f.context);
        await client.database
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(clock + 60_000) })
          .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
      }
      const headId = reason === "target_ended" ? f.steerRequests[0].deliveryId : f.rootDeliveryId;
      await client.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(clock - 1_000) })
        .where(eq(imMessageDeliveries.id, headId));
      const change = async () => {
        if (reason === "target_ended")
          expect(await store.recordTurn(turnReport(f, "completed"), f.context)).toBe("recorded");
        else
          await client.database
            .update(imMessageDeliveries)
            .set({ nextAttemptAt: new Date(clock + 60_000) })
            .where(eq(imMessageDeliveries.id, f.steerRequests[1].deliveryId));
      };
      const steer = store.beginSteerDispatch.bind(store);
      const deliver = store.beginDeliveryDispatch.bind(store);
      const admission =
        reason === "target_ended"
          ? vi
              .spyOn(store, "beginSteerDispatch")
              .mockImplementationOnce((...args) => duringCustodyWait(f.agentId, () => steer(...args), change))
          : vi
              .spyOn(store, "beginDeliveryDispatch")
              .mockImplementationOnce((...args) => duringCustodyWait(f.agentId, () => deliver(...args), change));
      const registry = new ConnectionRegistry();
      const frames: Array<DirectImMessageDeliveryRequest | RuntimeImSteerRequest | SessionReconcileRequest> = [];
      const transportErrors: unknown[] = [];
      const owner = new RuntimeDomainOwner(registry, store);
      await registry.register(
        {
          clientVersion: "0.1.1",
          computerId: f.dispatchContext.computerId,
          installationId: f.context.installationId,
          instanceId: f.dispatchContext.instanceId,
          lastHeartbeatAt: clock,
          negotiatedCapabilities: { "runtime.sessionReconcile": 1, "runtime.imDelivery": 3, "runtime.imSteer": 3 },
          socket: {
            readyState: 1,
            close: vi.fn(),
            terminate: vi.fn(),
            send: (serialized: string, callback: (error?: Error) => void) => {
              const frame = JSON.parse(serialized) as (typeof frames)[number];
              frames.push(frame);
              callback();
              queueMicrotask(() => {
                const response =
                  frame.type === "session:reconcile"
                    ? {
                        type: "session:reconcile:result" as const,
                        requestId: frame.requestId,
                        sessionId: frame.sessionId,
                        placementGeneration: 1,
                        status: "ready" as const,
                      }
                    : frame.type === "im:deliver"
                      ? {
                          type: "im:deliver:result" as const,
                          requestId: frame.requestId,
                          sessionId: frame.sessionId,
                          deliveryId: frame.deliveryId,
                          placementGeneration: 1,
                          status: "accepted" as const,
                          turnId: "retry-turn",
                        }
                      : {
                          type: "im:steer:result" as const,
                          requestId: frame.requestId,
                          sessionId: frame.sessionId,
                          deliveryId: frame.deliveryId,
                          placementGeneration: 1,
                          rootDeliveryId: frame.rootDeliveryId,
                          expectedTurnId: frame.expectedTurnId,
                          status: "steered" as const,
                        };
                void owner.handle(response, f.context).catch((error) => transportErrors.push(error));
              });
            },
          } as never,
        },
        async () => undefined,
      );
      const error = vi.fn();
      const diagnostic = vi.fn(createServerDiagnosticReporter(() => ({ error }) as never));
      const warn = vi.fn();
      const metric = vi.fn();
      const worker = new ImDeliveryWorker({
        database: client.database,
        domain: owner,
        registry,
        assembler: { assembleForSession: async () => f.runtime },
        now: () => new Date(clock),
        onDiagnostic: diagnostic,
        onMetric: metric,
        logger: { debug: vi.fn(), info: vi.fn(), warn, error },
      });
      try {
        await worker.runOnce();
        expect(admission).toHaveBeenCalledTimes(1);
        const code = reason === "target_ended" ? "IM_DELIVERY_STEER_TARGET_ENDED" : "IM_DELIVERY_BATCH_CHANGED";
        const [row] = await client.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, headId));
        expect(row).toMatchObject({
          state: "pending",
          attemptCount: 1,
          dispatchRequestId: null,
          dispatchPayload: null,
          steerTargetDeliveryId: null,
          lastErrorCode: code,
          nextAttemptAt: new Date(clock + 2_000),
          turnId: null,
          reportedAt: null,
        });
        expect(frames.filter((frame) => frame.type !== "session:reconcile")).toEqual([]);
        expect(diagnostic).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ code, deliveryId: headId, retryDelayMs: 2_000 }),
          "IM delivery dispatch retry scheduled",
        );
        expect(metric.mock.calls.filter(([value]) => value.name === "retry")).toEqual([[{ name: "retry", value: 1 }]]);
        await client.database
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(clock) })
          .where(eq(imMessageDeliveries.id, f.steerRequests[1].deliveryId));
        clock += 2_001;
        await worker.runOnce();
        const sent = frames.filter((frame) => frame.type !== "session:reconcile");
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: "im:deliver", deliveryId: headId });
        const settled = await client.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.sessionId, f.sessionId));
        expect(settled.find((row) => row.id === headId)).toMatchObject({
          state: "accepted",
          attemptCount: 2,
          turnId: "retry-turn",
        });
        expect(
          settled
            .filter((row) => row.id !== headId && row.id !== f.rootDeliveryId)
            .every((row) => row.state === "steered"),
        ).toBe(true);
        expect(transportErrors).toEqual([]);
        expect(diagnostic).not.toHaveBeenCalled();
      } finally {
        admission.mockRestore();
        await worker.stop();
        await owner.close();
      }
    },
  );

  it.each(["owner", "turn", "generation", "failed", "missing"] as const)(
    "keeps a completed target with %s conflict diagnostic",
    async (change) => {
      const f = await createFixture(client.database);
      const store = new PostgresRuntimeCustodyStore(racer.database);
      const rootHash = computeDirectInputHash(f.rootRequest);
      await store.beginDeliveryDispatch(f.rootRequest, rootHash, f.dispatchContext);
      await store.acceptDelivery(f.rootRequest, rootHash, f.rootTurnId, f.context);
      await store.recordTurn(
        turnReport(f, change === "failed" ? "failed" : "completed", change === "failed" ? "turn_timeout" : undefined),
        f.context,
      );
      if (change === "missing")
        await client.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, f.rootDeliveryId));
      const patch = {
        owner: { reportOwnerInstanceId: randomUUID() },
        turn: { turnId: randomUUID() },
        generation: { placementGeneration: 2 },
        failed: undefined,
        missing: undefined,
      }[change];
      if (patch)
        await client.database
          .update(imMessageDeliveries)
          .set(patch)
          .where(eq(imMessageDeliveries.id, f.rootDeliveryId));
      const request = f.steerRequests[0];
      expect(await store.beginSteerDispatch(request, computeRuntimeImSteerInputHash(request), f.dispatchContext)).toBe(
        "conflict",
      );
    },
  );

  it.each(["message", "session", "generation", "attention", "missing"] as const)(
    "keeps a batch %s identity mismatch as conflict",
    async (change) => {
      const f = await createFixture(client.database);
      const store = new PostgresRuntimeCustodyStore(racer.database);
      const member = f.steerRequests[0];
      const request = {
        ...f.rootRequest,
        batch: [
          {
            deliveryId: change === "missing" ? randomUUID() : member.deliveryId,
            imMessageId: change === "message" ? randomUUID() : member.imMessageId,
            inputHash: computeRuntimeImMessageSemanticHash(member),
          },
        ],
      };
      if (change === "session") {
        const otherSessionId = randomUUID();
        await client.database.insert(sessions).values({
          id: otherSessionId,
          imBindingId: f.bindingId,
          channelId: "other-channel",
          conversationKind: "channel",
          kind: "channel",
        });
        await client.database
          .update(imMessageDeliveries)
          .set({ sessionId: otherSessionId })
          .where(eq(imMessageDeliveries.id, member.deliveryId));
      } else if (change === "generation" || change === "attention") {
        await client.database
          .update(imMessageDeliveries)
          .set(change === "generation" ? { placementGeneration: 2 } : { attention: "ambient" })
          .where(eq(imMessageDeliveries.id, member.deliveryId));
      }
      expect(await store.beginDeliveryDispatch(request, computeDirectInputHash(request), f.dispatchContext)).toBe(
        "conflict",
      );
      expect((await deliveryRows(client.database, f)).root.dispatchRequestId).toBeNull();
    },
  );

  it("preserves an existing frozen steer when its target completes", async () => {
    const f = await createFixture(client.database);
    const store = new PostgresRuntimeCustodyStore(racer.database);
    const rootHash = computeDirectInputHash(f.rootRequest);
    await store.beginDeliveryDispatch(f.rootRequest, rootHash, f.dispatchContext);
    await store.acceptDelivery(f.rootRequest, rootHash, f.rootTurnId, f.context);
    const request = f.steerRequests[0];
    const hash = computeRuntimeImSteerInputHash(request);
    expect(await store.beginSteerDispatch(request, hash, f.dispatchContext)).toBe("dispatched");
    await store.recordTurn(turnReport(f, "completed"), f.context);
    expect(await store.beginSteerDispatch(request, hash, f.dispatchContext)).toBe("already_dispatched");
    expect((await deliveryRows(client.database, f)).children[0]).toMatchObject({
      dispatchRequestId: request.requestId,
      dispatchPayload: request,
      steerTargetDeliveryId: f.rootDeliveryId,
    });
  });

  it("rolls back reserved batch members when the subsequent head write fails", async () => {
    const f = await createFixture(client.database);
    const failure = new Error("injected dispatch write failure");
    let writes = 0;
    const database = new Proxy(racer.database, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (callback: (transaction: DatabaseTransaction) => Promise<unknown>) =>
          target.transaction((transaction) =>
            callback(
              new Proxy(transaction, {
                get(target, property, receiver) {
                  if (property !== "update") return Reflect.get(target, property, receiver);
                  return (...args: Parameters<DatabaseTransaction["update"]>) => {
                    if (++writes === 2) throw failure;
                    return target.update(...args);
                  };
                },
              }),
            ),
          );
      },
    });
    const request = {
      ...f.rootRequest,
      batch: f.steerRequests.map((member) => ({
        deliveryId: member.deliveryId,
        imMessageId: member.imMessageId,
        inputHash: computeRuntimeImMessageSemanticHash(member),
      })),
    };
    await expect(
      new PostgresRuntimeCustodyStore(database).beginDeliveryDispatch(
        request,
        computeDirectInputHash(request),
        f.dispatchContext,
      ),
    ).rejects.toBe(failure);
    expect(writes).toBe(2);
    const rows = await deliveryRows(client.database, f);
    expect(
      [rows.root, ...rows.children].every(
        (row) =>
          row.state === "pending" &&
          row.dispatchRequestId === null &&
          row.steerTargetDeliveryId === null &&
          row.reason === null,
      ),
    ).toBe(true);
  });
});
