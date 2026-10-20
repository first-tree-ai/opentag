import { randomUUID } from "node:crypto";
import { computeDirectInputHash, type SessionReconcileRequest } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import { computers, imMessageDeliveries, sessions } from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { runImDeliveryExpiry } from "../../runtime/im-delivery-janitor.js";
import { STEER_TARGET_ENDED_ERROR_CODE } from "../../runtime/im-delivery-recovery.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import {
  acceptAndSteer,
  createFixture,
  deliveryRows,
  janitorOptions,
  runRecoveryWorker,
  turnReport,
} from "./im-recovery-locks-fixture.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

describe("steered IM delivery recovery", () => {
  let testDatabase: MigratedTestDatabase;
  let client: ReturnType<typeof createDatabaseClient>;

  beforeAll(async () => {
    testDatabase = await startMigratedTestDatabase();
    client = createDatabaseClient(testDatabase.databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await client?.sql.end();
    await testDatabase?.stop();
  });

  beforeEach(async () => {
    await testDatabase.reset();
  });

  it.each([
    ["failed", "turn_timeout"],
    ["cancelled", "client_shutdown"],
    ["unknown", "turn_state_unknown"],
  ] as const)("requeues %s target children once and preserves ingress order", async (outcome, reason) => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    const report = turnReport(fixture, outcome, reason);
    await expect(custody.recordTurn(report, fixture.context)).resolves.toBe("recorded");

    const recovered = await deliveryRows(client.database, fixture);
    expect(recovered.children.map((row) => row.id)).toEqual(fixture.steerRequests.map((request) => request.deliveryId));
    expect(recovered.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "pending",
          steerTargetDeliveryId: null,
          attemptCount: 1,
          lastErrorCode: STEER_TARGET_ENDED_ERROR_CODE,
        }),
      ]),
    );
    expect(recovered.children[0]?.nextAttemptAt.getTime()).toBeLessThan(
      recovered.children[1]?.nextAttemptAt.getTime() ?? Number.POSITIVE_INFINITY,
    );

    await runImDeliveryExpiry(client.database, janitorOptions(fixture.now));
    const afterJanitor = await deliveryRows(client.database, fixture);
    expect(afterJanitor.children).toEqual(recovered.children);
    await expect(custody.recordTurn({ ...report, requestId: randomUUID() }, fixture.context)).resolves.toBe(
      "already_recorded",
    );
    await expect(custody.recordTurn(turnReport(fixture, "completed"), fixture.context)).resolves.toBe("conflict");
    expect(await deliveryRows(client.database, fixture)).toEqual(afterJanitor);
  });

  it.each(["transport-failure", "offline", "session-ended"] as const)(
    "preserves custody through %s and settles the original report after reconnect",
    async (failure) => {
      const fixture = await createFixture(client.database);
      let clock = fixture.now.getTime();
      const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => new Date(clock) });
      await acceptAndSteer(fixture, custody);
      const registry = new ConnectionRegistry();
      const connect = async () => {
        const socket = { close: vi.fn(), terminate: vi.fn() };
        await registry.register(
          {
            computerId: fixture.context.computerId,
            installationId: fixture.context.installationId,
            instanceId: fixture.context.instanceId,
            clientVersion: "0.1.2",
            lastHeartbeatAt: clock,
            socket: socket as never,
          },
          async () => {
            await client.database
              .update(computers)
              .set({ currentInstanceId: fixture.context.instanceId })
              .where(eq(computers.id, fixture.context.computerId));
          },
        );
        return socket;
      };
      const socket = await connect();
      let disconnected = true;
      const requestReconcile = vi.fn(async (_computer: string, _instance: string, request: SessionReconcileRequest) => {
        if (disconnected) throw new Error("synthetic transport failure");
        return {
          type: "session:reconcile:result" as const,
          requestId: request.requestId,
          sessionId: request.sessionId,
          placementGeneration: request.placementGeneration,
          status: "busy" as const,
          reason: "active_turn",
        };
      });
      const requestDelivery = vi.fn();
      const requestSteer = vi.fn();
      const diagnostic = vi.fn();
      const worker = new ImDeliveryWorker({
        database: client.database,
        domain: { requestReconcile, requestDelivery, requestSteer } as never,
        registry,
        assembler: { assembleForSession: vi.fn(async () => fixture.runtime) },
        now: () => new Date(clock),
        onDiagnostic: diagnostic,
      });
      try {
        if (failure === "offline") {
          expect(registry.remove(fixture.context.computerId, fixture.context.instanceId, socket as never)).toBe(true);
          await client.database
            .update(computers)
            .set({ currentInstanceId: null })
            .where(eq(computers.id, fixture.context.computerId));
        }
        if (failure === "session-ended") {
          await client.database
            .update(sessions)
            .set({ endedAt: new Date(clock) })
            .where(eq(sessions.id, fixture.sessionId));
        }
        await client.database
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(clock - 1) })
          .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
        const original = await deliveryRows(client.database, fixture);
        await worker.runOnce();
        if (failure !== "session-ended") {
          expect(diagnostic).toHaveBeenCalledWith(
            failure === "offline" ? "IM_DELIVERY_RUNTIME_UNAVAILABLE" : "IM_DELIVERY_RECOVERY_FAILED",
          );
        }
        const unreported = await deliveryRows(client.database, fixture);
        for (const elapsed of [5_000, 60_000, 86_400_000]) {
          clock += elapsed;
          await runImDeliveryExpiry(client.database, janitorOptions(new Date(clock)));
          expect(await deliveryRows(client.database, fixture)).toEqual(unreported);
        }
        await worker.runOnce();
        disconnected = false;
        await connect();
        clock += 30_000;
        await worker.runOnce();
        expect((await deliveryRows(client.database, fixture)).children).toEqual(original.children);
        if (failure !== "session-ended")
          expect(await requestReconcile.mock.results.at(-1)?.value).toMatchObject({ status: "busy" });
        const failed = turnReport(fixture, "failed", "turn_timeout");
        await expect(
          custody.recordTurn(failed, { ...fixture.context, instanceId: randomUUID() }),
        ).resolves.toBeUndefined();
        await expect(
          custody.recordTurn(
            turnReport({ ...fixture, rootTurnId: randomUUID() }, "failed", "turn_timeout"),
            fixture.context,
          ),
        ).resolves.toBe("conflict");
        expect((await deliveryRows(client.database, fixture)).children).toEqual(original.children);

        const report = turnReport(fixture, "completed");
        await expect(custody.recordTurn(report, fixture.context)).resolves.toBe("recorded");
        await expect(custody.recordTurn({ ...report, requestId: randomUUID() }, fixture.context)).resolves.toBe(
          "already_recorded",
        );
        await runImDeliveryExpiry(client.database, janitorOptions(new Date(clock)));
        const settled = await deliveryRows(client.database, fixture);
        expect(settled.root).toMatchObject({
          state: "accepted",
          turnId: fixture.rootTurnId,
          inputHash: computeDirectInputHash(fixture.rootRequest),
          reportOwnerInstanceId: fixture.context.instanceId,
          reportedAt: new Date(clock),
          resultHash: report.resultHash,
          turnReport: report,
        });
        expect(settled.children).toEqual(original.children);
        await worker.runOnce();
        expect(requestDelivery).not.toHaveBeenCalled();
        expect(requestSteer).not.toHaveBeenCalled();
      } finally {
        worker.stop();
      }
    },
  );

  it("requeues a timed-out target", async () => {
    const timedOut = await createFixture(client.database);
    const timedOutCustody = new PostgresRuntimeCustodyStore(client.database, { now: () => timedOut.now });
    await acceptAndSteer(timedOut, timedOutCustody);
    await expect(
      timedOutCustody.recordTurn(turnReport(timedOut, "failed", "turn_timeout"), timedOut.context),
    ).resolves.toBe("recorded");
    expect((await deliveryRows(client.database, timedOut)).children).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "pending", steerTargetDeliveryId: null })]),
    );
  });

  it.each([
    "IM_DELIVERY_RECOVERY_BUSY",
    "IM_DELIVERY_RECOVERY_RUNNING",
    "IM_DELIVERY_RECOVERY_REPORTING",
    "IM_DELIVERY_RECOVERY_REQUIRED",
    "IM_DELIVERY_RECOVERY_REJECTED",
    "IM_DELIVERY_RECOVERY_AWAITING_REPORT",
  ])("keeps already absorbed children while recovery defers with %s", async (lastErrorCode) => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await client.database
      .update(imMessageDeliveries)
      .set({ lastErrorCode, nextAttemptAt: fixture.now })
      .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
    const before = await deliveryRows(client.database, fixture);

    await runImDeliveryExpiry(client.database, janitorOptions(new Date(fixture.now.getTime() + 500)));

    expect(await deliveryRows(client.database, fixture)).toEqual(before);
  });

  it("re-places children from an ended target Session before the worker claims them", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await client.database
      .update(sessions)
      .set({ endedAt: new Date(fixture.now.getTime() + 1_000) })
      .where(eq(sessions.id, fixture.sessionId));

    await expect(
      custody.recordTurn(turnReport(fixture, "cancelled", "client_shutdown"), fixture.context),
    ).resolves.toBe("recorded");

    const recovered = await deliveryRows(client.database, fixture);
    expect(recovered.children.every((row) => row.sessionId !== fixture.sessionId)).toBe(true);
    expect(recovered.children[0]?.placementGeneration).toBe(1);

    const requestDelivery = await runRecoveryWorker(client.database, fixture, custody);

    expect(requestDelivery).toHaveBeenCalledTimes(1);
    expect(requestDelivery.mock.calls[0]?.[2]).toMatchObject({
      deliveryId: fixture.steerRequests[0].deliveryId,
      sessionId: recovered.children[0]?.sessionId,
    });
    expect((await deliveryRows(client.database, fixture)).children[0]?.state).toBe("accepted");
  });

  it("keeps live-Session recoveries claimable by the worker", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await expect(
      custody.recordTurn(turnReport(fixture, "cancelled", "client_shutdown"), fixture.context),
    ).resolves.toBe("recorded");

    const recovered = await deliveryRows(client.database, fixture);
    expect(recovered.children.every((row) => row.sessionId === fixture.sessionId)).toBe(true);
    const requestDelivery = await runRecoveryWorker(client.database, fixture, custody);

    expect(requestDelivery).toHaveBeenCalledTimes(1);
    expect((await deliveryRows(client.database, fixture)).children[0]?.state).toBe("accepted");
  });

  it("leaves completed target children steered after the janitor runs", async () => {
    const completed = await createFixture(client.database);
    const completedCustody = new PostgresRuntimeCustodyStore(client.database, { now: () => completed.now });
    await acceptAndSteer(completed, completedCustody);
    await expect(completedCustody.recordTurn(turnReport(completed, "completed"), completed.context)).resolves.toBe(
      "recorded",
    );
    await runImDeliveryExpiry(client.database, janitorOptions(completed.now));
    expect((await deliveryRows(client.database, completed)).children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "steered", steerTargetDeliveryId: completed.rootDeliveryId, attemptCount: 0 }),
      ]),
    );
  });
});
