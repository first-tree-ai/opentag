import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeRuntimeImMessageSemanticHash,
  computeRuntimeImSteerInputHash,
  type SessionReconcileRequest,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  sessionPlacements,
  sessions,
  slackInstallations,
  slackWorkingTargets,
  slackWorkingTurns,
} from "../../db/schema/index.js";
import { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { runImDeliveryExpiry, runImDeliveryOverdueSettlement } from "../../runtime/im-delivery-janitor.js";
import { STEER_TARGET_ENDED_ERROR_CODE } from "../../runtime/im-delivery-recovery.js";
import { ImDeliveryWorker } from "../../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { ImMessageInbox } from "../../services/im/im-message-inbox.js";
import { disableImBindingInTransaction } from "../../services/im-bindings/disable-im-binding.js";
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

  it("atomically freezes, releases and acknowledges initial batch members without requeueing them on failure", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => new Date() });
    const request = {
      ...fixture.rootRequest,
      batch: fixture.steerRequests.map((child) => ({
        deliveryId: child.deliveryId,
        imMessageId: child.imMessageId,
        inputHash: computeRuntimeImMessageSemanticHash(child),
      })),
    };
    const hash = computeDirectInputHash(request);
    expect(await custody.beginDeliveryDispatch(request, hash, fixture.dispatchContext)).toBe("dispatched");
    expect(await custody.beginDeliveryDispatch(request, hash, fixture.dispatchContext)).toBe("already_dispatched");
    expect((await deliveryRows(client.database, fixture)).children.every((row) => row.reason === "batch_pending")).toBe(
      true,
    );
    expect(await custody.releaseDeliveryDispatch(request, hash, "retry")).toBe("released");
    expect(
      (await deliveryRows(client.database, fixture)).children.every(
        (row) => row.reason === null && row.steerTargetDeliveryId === null,
      ),
    ).toBe(true);
    expect(await custody.beginDeliveryDispatch(request, hash, fixture.dispatchContext)).toBe("dispatched");
    expect(await custody.acceptDelivery(request, hash, fixture.rootTurnId, fixture.context)).toBe("accepted");
    expect(await custody.acceptDelivery(request, hash, fixture.rootTurnId, fixture.context)).toBe("already_accepted");
    expect(
      (await deliveryRows(client.database, fixture)).children.every(
        (row) => row.state === "steered" && row.reason === "batch_initial",
      ),
    ).toBe(true);
    expect(await custody.recordTurn(turnReport(fixture, "failed", "turn_timeout"), fixture.context)).toBe("recorded");
    await runImDeliveryExpiry(client.database, janitorOptions(fixture.now));
    expect(
      (await deliveryRows(client.database, fixture)).children.every(
        (row) => row.state === "steered" && row.reason === "batch_initial",
      ),
    ).toBe(true);
  });

  it("recovers every member of a frozen unconfirmed steer batch after its target fails", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => new Date() });
    const rootHash = computeDirectInputHash(fixture.rootRequest);
    await custody.beginDeliveryDispatch(fixture.rootRequest, rootHash, fixture.dispatchContext);
    await custody.acceptDelivery(fixture.rootRequest, rootHash, fixture.rootTurnId, fixture.context);
    const [first, second] = fixture.steerRequests;
    const request = {
      ...first,
      batch: [
        {
          deliveryId: second.deliveryId,
          imMessageId: second.imMessageId,
          inputHash: computeRuntimeImMessageSemanticHash(second),
        },
      ],
    };
    const hash = computeRuntimeImSteerInputHash(request);
    expect(await custody.beginSteerDispatch(request, hash, fixture.dispatchContext)).toBe("dispatched");
    expect(await custody.releaseSteerDispatch(request, hash, "uncertain")).toBe("released");
    expect((await deliveryRows(client.database, fixture)).children[0]?.dispatchRequestId).toBe(request.requestId);
    expect(await custody.recordTurn(turnReport(fixture, "failed", "turn_timeout"), fixture.context)).toBe("recorded");
    const rows = (await deliveryRows(client.database, fixture)).children;
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.state === "pending" &&
          row.reason === null &&
          row.dispatchRequestId === null &&
          row.steerTargetDeliveryId === null,
      ),
    ).toBe(true);
    expect(rows[0]?.nextAttemptAt.getTime()).toBeLessThan(rows[1]?.nextAttemptAt.getTime() ?? 0);
  });

  it("rolls back the entire batch receipt when any reserved member changed", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => new Date() });
    const request = {
      ...fixture.rootRequest,
      batch: fixture.steerRequests.map((child) => ({
        deliveryId: child.deliveryId,
        imMessageId: child.imMessageId,
        inputHash: computeRuntimeImMessageSemanticHash(child),
      })),
    };
    const hash = computeDirectInputHash(request);
    await custody.beginDeliveryDispatch(request, hash, fixture.dispatchContext);
    await client.database
      .update(imMessageDeliveries)
      .set({ steerTargetDeliveryId: null })
      .where(eq(imMessageDeliveries.id, fixture.steerRequests[1].deliveryId));
    await expect(custody.acceptDelivery(request, hash, fixture.rootTurnId, fixture.context)).rejects.toThrow(
      "IM_BATCH_MEMBER_CONFLICT",
    );
    const rows = await deliveryRows(client.database, fixture);
    expect(rows.root?.state).toBe("pending");
    expect(rows.children.every((row) => row.state === "pending")).toBe(true);
  });

  it.each(["head", "member"] as const)(
    "recovers exact frozen identities after a provider edits the %s",
    async (edited) => {
      const fixture = await createFixture(client.database);
      const custody = new PostgresRuntimeCustodyStore(client.database);
      const rootHash = computeDirectInputHash(fixture.rootRequest);
      await custody.beginDeliveryDispatch(fixture.rootRequest, rootHash, fixture.dispatchContext);
      await custody.acceptDelivery(fixture.rootRequest, rootHash, fixture.rootTurnId, fixture.context);
      const [first, second] = fixture.steerRequests;
      const request = {
        ...first,
        batch: [
          {
            deliveryId: second.deliveryId,
            imMessageId: second.imMessageId,
            inputHash: computeRuntimeImMessageSemanticHash(second),
          },
        ],
      };
      const hash = computeRuntimeImSteerInputHash(request);
      await custody.beginSteerDispatch(request, hash, fixture.dispatchContext);
      await custody.releaseSteerDispatch(request, hash, "uncertain");
      const [binding] = await client.database.select().from(imBindings);
      if (!binding) throw new Error("missing binding");
      const event = {
        providerEventId: `edited-frozen-${edited}`,
        externalAppId: "app",
        externalTeamId: "team",
        providerContext: { provider: "feishu" as const, chatType: "group" as const },
        conversation: { externalId: "channel", kind: "channel" as const },
        message: {
          externalId: edited === "head" ? "follow-up-1" : "follow-up-2",
          revisionKey: "2",
          operation: "edited" as const,
          author: { externalId: "human", kind: "human" as const },
          occurredAt: new Date(fixture.now.getTime() + 3_000),
          content: {
            version: 1 as const,
            fallbackText: "edited content",
            blocks: [{ type: "text" as const, text: "edited content" }],
            truncated: false,
          },
          resources: [],
        },
        mentions: [{ externalId: "bot", displayName: null }],
      };
      const result = await new ImMessageInbox(client.database).ingest(binding.id, 1, event);
      expect(result.duplicate).toBe(false);
      const before = (await deliveryRows(client.database, fixture)).children;
      expect(before[edited === "head" ? 0 : 1]).toMatchObject({ state: "expired", reason: "superseded_revision" });
      expect(await custody.recordTurn(turnReport(fixture, "failed", "turn_timeout"), fixture.context)).toBe("recorded");
      await runImDeliveryExpiry(client.database, janitorOptions(new Date()));
      const after = (await deliveryRows(client.database, fixture)).children;
      expect(after.map((row) => row.id)).toEqual([first.deliveryId, second.deliveryId]);
      expect(
        after.every(
          (row) =>
            row.state === "pending" &&
            row.reason === null &&
            row.dispatchRequestId === null &&
            row.steerTargetDeliveryId === null,
        ),
      ).toBe(true);
      expect(after[0]?.nextAttemptAt.getTime()).toBeLessThan(after[1]?.nextAttemptAt.getTime() ?? 0);
    },
  );

  it.each(["retry", "deferred"] as const)(
    "keeps exact uncertainty frozen after a later %s receipt and accepts exact success",
    async (disposition) => {
      const fixture = await createFixture(client.database);
      const custody = new PostgresRuntimeCustodyStore(client.database);
      const rootHash = computeDirectInputHash(fixture.rootRequest);
      await custody.beginDeliveryDispatch(fixture.rootRequest, rootHash, fixture.dispatchContext);
      await custody.acceptDelivery(fixture.rootRequest, rootHash, fixture.rootTurnId, fixture.context);
      const [first, second] = fixture.steerRequests;
      const request = {
        ...first,
        batch: [
          {
            deliveryId: second.deliveryId,
            imMessageId: second.imMessageId,
            inputHash: computeRuntimeImMessageSemanticHash(second),
          },
        ],
      };
      const hash = computeRuntimeImSteerInputHash(request);
      await custody.beginSteerDispatch(request, hash, fixture.dispatchContext);
      await custody.releaseSteerDispatch(request, hash, "uncertain");
      expect(await custody.releaseSteerDispatch({ ...request, requestId: randomUUID() }, hash, disposition)).toBe(
        "conflict",
      );
      expect(await custody.releaseSteerDispatch(request, hash, disposition)).toBe("released");
      const frozen = (await deliveryRows(client.database, fixture)).children;
      expect(frozen[0]).toMatchObject({
        state: "pending",
        dispatchRequestId: request.requestId,
        dispatchInputHash: hash,
        lastErrorCode: "IM_DELIVERY_STEER_UNKNOWN",
      });
      expect(frozen[1]).toMatchObject({
        state: "pending",
        reason: "batch_pending",
        steerTargetDeliveryId: first.deliveryId,
      });
      expect(
        await custody.recordSteered(request, hash, computeRuntimeImMessageSemanticHash(request), fixture.context),
      ).toBe("steered");
      expect(
        (await deliveryRows(client.database, fixture)).children.every(
          (row) => row.state === "steered" && row.lastErrorCode === null,
        ),
      ).toBe(true);
    },
  );

  it("settles an exact late receipt after an unconfirmed batch was marked unknown", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => new Date() });
    const rootHash = computeDirectInputHash(fixture.rootRequest);
    await custody.beginDeliveryDispatch(fixture.rootRequest, rootHash, fixture.dispatchContext);
    await custody.acceptDelivery(fixture.rootRequest, rootHash, fixture.rootTurnId, fixture.context);
    const [first, second] = fixture.steerRequests;
    const request = {
      ...first,
      batch: [
        {
          deliveryId: second.deliveryId,
          imMessageId: second.imMessageId,
          inputHash: computeRuntimeImMessageSemanticHash(second),
        },
      ],
    };
    const hash = computeRuntimeImSteerInputHash(request);
    await custody.beginSteerDispatch(request, hash, fixture.dispatchContext);
    await custody.recordTurn(turnReport(fixture, "completed"), fixture.context);
    await client.database
      .update(imMessageDeliveries)
      .set({ state: "terminal_rejected", reason: "steer_state_unknown" })
      .where(
        inArray(
          imMessageDeliveries.id,
          fixture.steerRequests.map((child) => child.deliveryId),
        ),
      );
    expect(
      await custody.recordSteered(
        request,
        "0".repeat(64),
        computeRuntimeImMessageSemanticHash(request),
        fixture.context,
      ),
    ).toBe("conflict");
    expect(
      await custody.recordSteered(request, hash, computeRuntimeImMessageSemanticHash(request), fixture.context),
    ).toBe("steered");
    expect(
      await custody.recordSteered(request, hash, computeRuntimeImMessageSemanticHash(request), fixture.context),
    ).toBe("already_steered");
    expect(
      (await deliveryRows(client.database, fixture)).children.every(
        (row) => row.state === "steered" && row.reason === null,
      ),
    ).toBe(true);
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
            {
              phase: "recover",
              deliveryId: fixture.rootDeliveryId,
              agentId: fixture.agentId,
              computerId: fixture.context.computerId,
              attemptCount: 1,
            },
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
        // Production resumes a parked retry through the registration hook (`onRegistered`), which a
        // direct registry registration in this test does not carry. Without it the offline backoff
        // would hold the custody for its full ceiling and the reconnect would not be observable.
        await worker.notifyComputerReady(fixture.context.computerId);
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

  it("settles custody superseded by a placement rollover exactly once and keeps its generation", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    // The Session is re-placed after the Turn was accepted: the delivery keeps the generation the
    // Turn ran under, and no report can satisfy the custody fence any more.
    await client.database
      .update(sessionPlacements)
      .set({ generation: fixture.placementGeneration + 1 })
      .where(eq(sessionPlacements.sessionId, fixture.sessionId));
    const overdue = new Date(fixture.now.getTime() + 26 * 60 * 60_000);

    await runImDeliveryExpiry(client.database, janitorOptions(overdue));

    const settled = await deliveryRows(client.database, fixture);
    const report = settled.root.turnReport as TurnReportRequest;
    expect(settled.root).toMatchObject({
      state: "accepted",
      placementGeneration: fixture.placementGeneration,
      reason: "placement_superseded",
      turnId: fixture.rootTurnId,
      reportedAt: overdue,
      resultHash: report.resultHash,
    });
    expect(report).toMatchObject({
      type: "turn:report",
      deliveryId: fixture.rootDeliveryId,
      turnId: fixture.rootTurnId,
      sessionId: fixture.sessionId,
      agentId: fixture.agentId,
      placementGeneration: fixture.placementGeneration,
      outcome: "unknown",
      executionEffects: "may_have_occurred",
      errorReason: "turn_state_unknown",
    });

    // The second sweep leaves the settlement alone: the row is reported, so it is out of the set.
    await runImDeliveryExpiry(client.database, janitorOptions(new Date(overdue.getTime() + 60_000)));
    expect((await deliveryRows(client.database, fixture)).root).toEqual(settled.root);
  });

  it("settles a superseded placement with the whole terminal-report contract", async () => {
    const fixture = await createFixture(client.database);
    const settled = vi.fn();
    const custody = new PostgresRuntimeCustodyStore(client.database, {
      now: () => fixture.now,
      onDeliverySettled: settled,
    });
    await acceptAndSteer(fixture, custody);
    settled.mockClear();
    const slack = await seedSlackWorkingTurn(client.database, fixture);
    // Suspending the Agent makes the steered children unplaceable, so the settlement has to
    // terminalize them exactly as a real terminal report does.
    await client.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
    await client.database
      .update(sessionPlacements)
      .set({ generation: fixture.placementGeneration + 1 })
      .where(eq(sessionPlacements.sessionId, fixture.sessionId));
    const overdue = new Date(fixture.now.getTime() + 26 * 60 * 60_000);

    await runImDeliveryExpiry(client.database, janitorOptions(overdue), settled);

    const rollover = await deliveryRows(client.database, fixture);
    expect(rollover.root.reason).toBe("placement_superseded");
    expect(rollover.root.turnReport).toMatchObject({ outcome: "unknown", errorReason: "turn_state_unknown" });
    // The children reach the outcome a real terminal report gives them (the next test settles a
    // control fixture through `recordTurn` and asserts this same shape).
    expect(rollover.children.map(terminalizedChildContract)).toEqual([TERMINALIZED_CHILD, TERMINALIZED_CHILD]);
    // The settled callback covers the delivery and every child it terminalized.
    expect(new Set(settled.mock.calls.map(([id]) => id as string))).toEqual(
      new Set([fixture.rootDeliveryId, ...fixture.steerRequests.map((request) => request.deliveryId)]),
    );
    // No Slack working turn survives the settlement: it is terminal, its lease expired at the
    // settlement instant, and its target was dirtied for the cleanup pass.
    const [turn] = await client.database
      .select()
      .from(slackWorkingTurns)
      .where(eq(slackWorkingTurns.deliveryId, fixture.rootDeliveryId));
    expect(turn).toMatchObject({ phase: "terminal", leaseExpiresAt: overdue });
    const [target] = await client.database
      .select()
      .from(slackWorkingTargets)
      .where(eq(slackWorkingTargets.id, slack.targetId));
    expect(target).toMatchObject({ nextAttemptAt: overdue, revision: slack.revision + 1 });
  });

  it("gives a settled parent's steered children the same outcome a real terminal report gives them", async () => {
    const fixture = await createFixture(client.database);
    const settled = vi.fn();
    const custody = new PostgresRuntimeCustodyStore(client.database, {
      now: () => fixture.now,
      onDeliverySettled: settled,
    });
    await acceptAndSteer(fixture, custody);
    settled.mockClear();
    await client.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));

    await expect(
      custody.recordTurn(turnReport(fixture, "unknown", "turn_state_unknown"), fixture.context),
    ).resolves.toBe("recorded");

    const control = await deliveryRows(client.database, fixture);
    expect(control.children.map(terminalizedChildContract)).toEqual([TERMINALIZED_CHILD, TERMINALIZED_CHILD]);
    expect(new Set(settled.mock.calls.map(([id]) => id as string))).toEqual(
      new Set([fixture.rootDeliveryId, ...fixture.steerRequests.map((request) => request.deliveryId)]),
    );
  });

  it("takes the recovery-Session lock before the delivery lock so a concurrent report cannot deadlock", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await client.database
      .update(sessionPlacements)
      .set({ generation: fixture.placementGeneration + 1 })
      .where(eq(sessionPlacements.sessionId, fixture.sessionId));
    const overdue = new Date(fixture.now.getTime() + 26 * 60 * 60_000);
    // Second connection: it plays the concurrent non-completed report, whose first lock is the
    // recovery Session (`lockSteeredRecoverySessions`), exactly as `recordTurn` documents.
    const other = createDatabaseClient(testDatabase.databaseUrl);
    let releaseSession!: () => void;
    const holdSession = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    let sessionHeld!: () => void;
    const sessionIsHeld = new Promise<void>((resolve) => {
      sessionHeld = resolve;
    });
    try {
      const reportSide = other.sql.begin(async (tx) => {
        await tx.unsafe("select id from sessions where id = $1::uuid for no key update", [fixture.sessionId]);
        sessionHeld();
        await holdSession;
        // The report's next locks, in `recordTurn`'s order: placement, then delivery. With the
        // settlement holding the delivery before the Session, this is where the cycle would form.
        await tx.unsafe("select session_id from session_placements where session_id = $1::uuid for update", [
          fixture.sessionId,
        ]);
        await tx.unsafe("select id from im_message_deliveries where id = $1::uuid for update", [
          fixture.rootDeliveryId,
        ]);
        return "locks-taken" as const;
      });
      await sessionIsHeld;

      const settlement = runImDeliveryOverdueSettlement(client.database, {
        clock: () => overdue,
        expiryBatchSize: 10,
      });
      // The settlement must wait on the Session lock and therefore hold no delivery lock.
      await expect(Promise.race([settlement.then(() => "settled" as const), sleep(300)])).resolves.toBeUndefined();
      const [whileBlocked] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      expect(whileBlocked).toMatchObject({ reportedAt: null, reason: null });

      // The reporting side reaches its delivery lock without a 40P01 or a timeout: the ordering is
      // broken, not the fences.
      releaseSession();
      await expect(reportSide).resolves.toBe("locks-taken");
      // One deterministic outcome: the settlement takes the released Session and settles the row.
      await expect(settlement).resolves.toBeUndefined();
      const [settled] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      expect(settled).toMatchObject({ reason: "placement_superseded" });
      expect(settled?.turnReport).toMatchObject({ errorReason: "turn_state_unknown" });
    } finally {
      await other.sql.end();
    }
  });

  it("shares one lock order with the binding disable path", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    // A binding that needs reauthorization is a maintenance candidate whose Session is still live,
    // so the real disable below has a Session row to end.
    await client.database
      .update(imBindings)
      .set({ status: "reauthorization_required", updatedAt: fixture.now })
      .where(eq(imBindings.id, fixture.bindingId));
    const overdue = new Date(fixture.now.getTime() + 26 * 60 * 60_000);

    // Two independent pools: one holds the lifecycle transaction, one runs the settlement.
    const lifecycle = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    const maintenance = createDatabaseClient(testDatabase.databaseUrl, { max: 1 });
    try {
      const authorityHeld = deferred();
      const resumeLifecycle = deferred();
      const disabling = lifecycle.database.transaction(async (transaction) => {
        // `ImBindingService.disable`: the Agent lock, then the binding lock, then the Session update.
        await transaction.execute(sql`select id from agents where id = ${fixture.agentId}::uuid for update`);
        await transaction.execute(sql`select id from im_bindings where id = ${fixture.bindingId}::uuid for update`);
        authorityHeld.resolve();
        await resumeLifecycle.promise;
        await disableImBindingInTransaction(transaction, fixture.bindingId, overdue);
      });
      await authorityHeld.promise;

      const settlement = runImDeliveryOverdueSettlement(maintenance.database, {
        clock: () => overdue,
        expiryBatchSize: 10,
      });
      // The settlement waits at the Agent lock, so it holds no Session lock the disable needs.
      await expect(Promise.race([settlement.then(() => "settled" as const), sleep(300)])).resolves.toBeUndefined();
      const [whileBlocked] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      expect(whileBlocked).toMatchObject({ reportedAt: null, turnReport: null, reason: null });

      resumeLifecycle.resolve();
      // Neither side is aborted with 40P01: the lifecycle commits its disable, then the settlement
      // re-reads the committed authority before it writes anything.
      await expect(disabling).resolves.toBeUndefined();
      await expect(settlement).resolves.toBeUndefined();

      const [binding] = await client.database
        .select({ status: imBindings.status })
        .from(imBindings)
        .where(eq(imBindings.id, fixture.bindingId));
      const [session] = await client.database
        .select({ endedAt: sessions.endedAt })
        .from(sessions)
        .where(eq(sessions.id, fixture.sessionId));
      expect(binding?.status).toBe("disabled");
      expect(session?.endedAt).toEqual(overdue);
      // One deterministic winner: the disable. The settlement then settles the row exactly once
      // because the authority it re-read is still gone.
      const [settled] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      expect(settled?.reportedAt).toEqual(overdue);
      expect(settled?.turnReport).toMatchObject({ outcome: "unknown", errorReason: "turn_state_unknown" });
    } finally {
      await lifecycle.sql.end();
      await maintenance.sql.end();
    }
  });

  it("blocks a maintenance settlement behind an uncommitted reactivation and then refuses it", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await client.database
      .update(imBindings)
      .set({ status: "reauthorization_required", updatedAt: fixture.now })
      .where(eq(imBindings.id, fixture.bindingId));
    const overdue = new Date(fixture.now.getTime() + 26 * 60 * 60_000);
    // Second connection: reactivates the binding and keeps it uncommitted, which the settlement's
    // snapshot cannot see and which no read-only predicate can exclude.
    const other = createDatabaseClient(testDatabase.databaseUrl);
    let releaseReactivation!: () => void;
    const holdReactivation = new Promise<void>((resolve) => {
      releaseReactivation = resolve;
    });
    let reactivated!: () => void;
    const reactivationApplied = new Promise<void>((resolve) => {
      reactivated = resolve;
    });
    try {
      const reactivation = other.sql.begin(async (tx) => {
        await tx.unsafe("update im_bindings set status = 'active', updated_at = $1::timestamptz where id = $2::uuid", [
          fixture.now.toISOString(),
          fixture.bindingId,
        ]);
        reactivated();
        await holdReactivation;
      });
      await reactivationApplied;

      const settlement = runImDeliveryOverdueSettlement(client.database, {
        clock: () => overdue,
        expiryBatchSize: 10,
      });
      // The settlement must wait for the uncommitted reactivation, not commit an `unknown` past it.
      await expect(Promise.race([settlement.then(() => "settled" as const), sleep(400)])).resolves.toBeUndefined();
      const [whileBlocked] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      expect(whileBlocked).toMatchObject({ reportedAt: null, turnReport: null, resultHash: null, reason: null });

      releaseReactivation();
      await reactivation;
      await expect(settlement).resolves.toBeUndefined();
      const [afterSweep] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      // The committed reactivation was seen by the recheck, so the synthetic report was refused.
      expect(afterSweep).toMatchObject({ reportedAt: null, turnReport: null, resultHash: null, reason: null });
      // The live owner's report then records, and nothing synthetic was ever persisted.
      await expect(custody.recordTurn(turnReport(fixture, "completed"), fixture.context)).resolves.toBe("recorded");
      const [reported] = await client.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      expect(reported?.turnReport).toMatchObject({ outcome: "completed" });
      expect(reported?.reason).toBeNull();
    } finally {
      await other.sql.end();
    }
  });

  it("leaves a rolled-over delivery alone while its report-acceptance window is open", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await client.database
      .update(sessionPlacements)
      .set({ generation: fixture.placementGeneration + 1 })
      .where(eq(sessionPlacements.sessionId, fixture.sessionId));

    // One hour after acceptance, an hour-long grace and a day-long runtime are still open.
    await runImDeliveryExpiry(client.database, janitorOptions(new Date(fixture.now.getTime() + 60 * 60_000)));

    const untouched = await deliveryRows(client.database, fixture);
    expect(untouched.root).toMatchObject({
      state: "accepted",
      reportedAt: null,
      turnReport: null,
      reason: null,
      resultHash: null,
    });
  });

  it("refuses a later genuine report for a superseded placement without overwriting the settlement", async () => {
    const fixture = await createFixture(client.database);
    const custody = new PostgresRuntimeCustodyStore(client.database, { now: () => fixture.now });
    await acceptAndSteer(fixture, custody);
    await client.database
      .update(sessionPlacements)
      .set({ generation: fixture.placementGeneration + 1 })
      .where(eq(sessionPlacements.sessionId, fixture.sessionId));
    await runImDeliveryExpiry(client.database, janitorOptions(new Date(fixture.now.getTime() + 26 * 60 * 60_000)));
    const settled = await deliveryRows(client.database, fixture);

    // A genuine report cannot be recorded for a superseded placement: `recordTurn`'s placement fence
    // refuses it before the recorded-report comparison, for the delivery's own generation and for the
    // current one alike. The refusal is `stale_generation` here, not `conflict`; what the settlement
    // needs is that the report loses and the recorded outcome is untouched.
    await expect(custody.recordTurn(turnReport(fixture, "completed"), fixture.context)).resolves.toBe(
      "stale_generation",
    );
    await expect(
      custody.recordTurn(
        { ...turnReport(fixture, "completed"), placementGeneration: fixture.placementGeneration + 1 },
        fixture.context,
      ),
    ).resolves.toBe("stale_generation");
    const after = await deliveryRows(client.database, fixture);
    expect(after.root.turnReport).toEqual(settled.root.turnReport);
    expect(after.root.resultHash).toEqual(settled.root.resultHash);
    expect(after.root.reason).toBe("placement_superseded");
    expect(after.root.reportedAt).toEqual(settled.root.reportedAt);
  });

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

/** A promise plus its resolver, for holding a transaction open at a chosen point. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Resolves after `ms`, so a barrier test can observe that a statement is still waiting. */
function sleep(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

/** The contract a settled parent owes its steered children, asserted by both settlement paths. */
const TERMINALIZED_CHILD = {
  state: "terminal_rejected",
  reason: "steer_target_ended_unplaceable",
  lastErrorCode: "IM_DELIVERY_STEER_TARGET_UNPLACEABLE",
  steerTargetDeliveryId: null,
  attemptCount: 1,
  reportedAt: null,
  acceptedAt: null,
  turnId: null,
};

function terminalizedChildContract(row: typeof imMessageDeliveries.$inferSelect) {
  return {
    state: row.state,
    reason: row.reason,
    lastErrorCode: row.lastErrorCode,
    steerTargetDeliveryId: row.steerTargetDeliveryId,
    attemptCount: row.attemptCount,
    reportedAt: row.reportedAt,
    acceptedAt: row.acceptedAt,
    turnId: row.turnId,
  };
}

/**
 * One open Slack working turn for the fixture's root delivery. `finishSlackWorkingTurn` is keyed by
 * delivery id and never reads the binding's provider, so the fixture's non-Slack binding is enough
 * to exercise the cleanup contract.
 */
async function seedSlackWorkingTurn(
  database: ReturnType<typeof createDatabaseClient>["database"],
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const [session] = await database
    .select({ imBindingId: sessions.imBindingId })
    .from(sessions)
    .where(eq(sessions.id, fixture.sessionId));
  if (!session) throw new Error("Fixture Session is missing");
  const installationId = randomUUID();
  const targetId = `slack-target-${randomUUID()}`;
  await database.insert(slackInstallations).values({
    id: installationId,
    agentId: fixture.agentId,
    status: "active",
    externalAppId: `app-${installationId}`,
    externalTeamId: `team-${installationId}`,
    externalBotId: `bot-${installationId}`,
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "unit-only-unused",
    activatedAt: fixture.now,
  });
  await database.insert(slackWorkingTargets).values({
    id: targetId,
    bindingId: session.imBindingId,
    installationId,
    credentialGeneration: 1,
    channelId: "channel",
    threadTs: "thread-1",
    revision: 4,
    working: true,
    nextAttemptAt: fixture.now,
    notBeforeAt: fixture.now,
  });
  await database.insert(slackWorkingTurns).values({
    deliveryId: fixture.rootDeliveryId,
    targetId,
    turnId: fixture.rootTurnId,
    sequence: 1,
    phase: "running",
    leaseExpiresAt: new Date(fixture.now.getTime() + 90_000),
    deadlineAt: new Date(fixture.now.getTime() + 30 * 60_000),
  });
  return { installationId, targetId, revision: 4 };
}
