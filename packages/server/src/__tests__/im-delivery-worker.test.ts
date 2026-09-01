import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeRuntimeImSteerInputHash,
  type DirectImMessageDeliveryRequest,
  RUNTIME_CAPABILITY,
  type RuntimeImSteerRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../db/schema/index.js";
import { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { ImDeliveryWorker } from "../runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { EffectiveRuntimeSnapshotAssemblerError } from "../services/runtime-config/errors.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

describe("ImDeliveryWorker diagnostics", () => {
  it("contains a scheduler database failure and emits only a bounded diagnostic code", async () => {
    const diagnostic = vi.fn();
    const database = {
      transaction: vi.fn().mockRejectedValue(new Error("secret provider response must not escape")),
    };
    const worker = new ImDeliveryWorker({
      assembler: { assembleForSession: vi.fn() },
      database: database as never,
      domain: {} as never,
      registry: {} as never,
      intervalMs: 60_000,
      onDiagnostic: diagnostic,
    });

    worker.start();
    await expect.poll(() => diagnostic.mock.calls.length).toBe(1);
    worker.stop();
    expect(diagnostic).toHaveBeenCalledWith("IM_DELIVERY_WORKER_SCHEDULING_FAILED");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret provider response");
  });

  it("supervises a detached scheduler failure with one event and counter", async () => {
    const events: unknown[] = [];
    const counters: unknown[] = [];
    const supervisor = new BackgroundFailureSupervisor({
      onEvent: (event) => events.push(event),
      onCounter: (name, labels) => counters.push({ name, labels }),
    });
    const database = {
      transaction: vi.fn().mockRejectedValue(new Error("claim failed")),
    };
    const worker = new ImDeliveryWorker({
      assembler: { assembleForSession: vi.fn() },
      database: database as never,
      domain: {} as never,
      registry: {} as never,
      intervalMs: 60_000,
      onDiagnostic: vi.fn(),
      supervisor,
    });

    worker.start();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(counters).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "diagnostic.error",
      error: {
        code: "IM_DELIVERY_WORKER_SCHEDULING_FAILED",
        category: "internal",
        retryability: "backoff",
        phase: "worker",
      },
    });
    worker.stop();
  });
});

describe("ImDeliveryWorker database workflow", () => {
  let unit: UnitDatabase;

  beforeAll(async () => {
    unit = await createUnitDatabase();
  }, 60_000);

  afterAll(async () => {
    await unit?.close();
  });

  beforeEach(async () => {
    await unit.reset();
  });

  it("claims, reconciles, builds, and delivers a pending message", async () => {
    const fixture = await workerFixture(unit);
    const events: string[] = [];
    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const domain = fakeDomain(custody, fixture, { onEvent: (event) => events.push(event) });
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      intervalMs: 60_000,
      onDiagnostic: (code) => events.push(code),
    });

    await worker.runOnce();
    expect(events).toContain("reconcile");
    expect(events).toContain("delivery");
    expect(await custody.getDelivery(fixture.deliveryId)).toMatchObject({ turnId: "turn-1" });
  });

  it("rejects admission when the agent is not active and records a bounded retry code", async () => {
    const fixture = await workerFixture(unit);
    const diagnostic = vi.fn();
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, {
        onReconcile: async () => {
          await unit.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, fixture.agentId));
        },
      }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      onDiagnostic: diagnostic,
    });

    await worker.runOnce();
    expect(diagnostic).toHaveBeenCalledWith("IM_DELIVERY_AGENT_NOT_ACTIVE");
    const [row] = await unit.database
      .select({ code: imMessageDeliveries.lastErrorCode })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row?.code).toBe("IM_DELIVERY_AGENT_NOT_ACTIVE");
  });

  it("rejects claims that exceed the queue-age budget", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-31T00:00:00.000Z") });
    try {
      const fixture = await workerFixture(unit);
      const now = new Date();
      await unit.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(now.getTime() - 1_000) })
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      const metrics: Array<{ name: string; value: number; agentId?: string }> = [];
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
        assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
        registry: fixture.registry,
        now: () => now,
        maxQueueAgeMs: 100,
        onMetric: (metric) => metrics.push(metric),
      });

      await worker.runOnce();

      expect(metrics).toEqual([
        { name: "queue_age_ms", value: 1_000, agentId: fixture.agentId },
        { name: "saturation", value: 1, agentId: fixture.agentId },
        { name: "retry", value: 1 },
      ]);
      const [row] = await unit.database
        .select({ code: imMessageDeliveries.lastErrorCode })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      expect(row?.code).toBe("IM_DELIVERY_QUEUE_AGE_EXCEEDED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks placement admission after the external-work boundary", async () => {
    const fixture = await workerFixture(unit);
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      beforeDeliveryAdmission: async () => {
        await unit.database
          .update(sessionPlacements)
          .set({ generation: 2 })
          .where(eq(sessionPlacements.sessionId, fixture.sessionId));
      },
    });

    await worker.runOnce();

    const [row] = await unit.database
      .select({ code: imMessageDeliveries.lastErrorCode })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row?.code).toBe("IM_DELIVERY_AGENT_NOT_ACTIVE");
  });

  it("records operation timeouts and renews a live claim with the injected clock", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-31T00:00:00.000Z") });
    try {
      const fixture = await workerFixture(unit);
      const base = Date.now();
      const attemptAt = new Date(base - 1_000);
      await unit.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: attemptAt })
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      let clockNow = base;
      const metrics: Array<{ name: string; value: number; agentId?: string }> = [];
      let releaseAdmission: (() => void) | undefined;
      const admissionRelease = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      let admissionCalled = false;
      const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture);
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: domain as never,
        assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
        registry: fixture.registry,
        now: () => new Date(clockNow),
        claimRenewMs: 50,
        claimLeaseMs: 30_000,
        operationTimeoutMs: 1_000,
        beforeDeliveryAdmission: async () => {
          admissionCalled = true;
          await admissionRelease;
        },
        onMetric: (metric) => metrics.push(metric),
      });

      const running = worker.runOnce();
      await vi.waitFor(() => expect(admissionCalled).toBe(true), { timeout: 50, interval: 1 });
      clockNow = base + 500;
      await vi.advanceTimersByTimeAsync(50);
      const [renewed] = await unit.database
        .select({ nextAttemptAt: imMessageDeliveries.nextAttemptAt })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      expect(renewed?.nextAttemptAt.getTime()).toBe(base + 500 + 30_000);

      await vi.advanceTimersByTimeAsync(950);
      await expect(running).resolves.toBeUndefined();
      releaseAdmission?.();
      expect(metrics).toContainEqual({ name: "timeout", value: 1, agentId: fixture.agentId });
      const [row] = await unit.database
        .select({ code: imMessageDeliveries.lastErrorCode })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      expect(row?.code).toBe("IM_DELIVERY_OPERATION_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists a saturation disposition when an agent lane is full", async () => {
    const fixtures = [await workerFixture(unit), await workerFixture(unit), await workerFixture(unit)];
    const registry = new ConnectionRegistry();
    for (const fixture of fixtures) {
      await registry.register(
        {
          computerId: fixture.computerId,
          installationId: randomUUID(),
          instanceId: fixture.instanceId,
          lastHeartbeatAt: Date.now(),
          socket: { close: vi.fn(), terminate: vi.fn() } as never,
        },
        async () => undefined,
      );
      await unit.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    }
    let releaseAdmission: (() => void) | undefined;
    const admissionRelease = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let blockFirst = true;
    let admissionCalled = false;
    const metrics: Array<{ name: string; value: number; agentId?: string }> = [];
    const domain = {
      requestReconcile: vi.fn(
        async (
          _computerId: string,
          _instanceId: string,
          request: { requestId: string; sessionId: string; placementGeneration: number },
          onDispatched?: () => void,
        ) => {
          onDispatched?.();
          return {
            type: "session:reconcile:result" as const,
            requestId: request.requestId,
            sessionId: request.sessionId,
            placementGeneration: request.placementGeneration,
            status: "ready" as const,
          };
        },
      ),
      requestDelivery: vi.fn(
        async (
          _computerId: string,
          _instanceId: string,
          request: DirectImMessageDeliveryRequest,
          onDispatched?: () => void,
        ) => {
          onDispatched?.();
          return {
            type: "im:deliver:result" as const,
            requestId: request.requestId,
            deliveryId: request.deliveryId,
            sessionId: request.sessionId,
            placementGeneration: request.placementGeneration,
            status: "accepted" as const,
            turnId: "turn-saturation",
          };
        },
      ),
    };
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixtures[0]?.runtime) },
      registry,
      maxConcurrent: 1,
      maxQueuedPerAgent: 1,
      maxQueuedTotal: 1,
      beforeDeliveryAdmission: async () => {
        if (!blockFirst) return;
        blockFirst = false;
        admissionCalled = true;
        await admissionRelease;
      },
      onMetric: (metric) => metrics.push(metric),
    });

    const first = worker.runOnce();
    await vi.waitFor(() => expect(admissionCalled).toBe(true));
    const second = worker.runOnce();
    const third = worker.runOnce();
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
    await expect(third).resolves.toBeUndefined();
    worker.stop();
    releaseAdmission?.();
    await Promise.all([first, second]);

    expect(metrics.some((metric) => metric.name === "saturation" && metric.value === 1)).toBe(true);
    const rows = await unit.database
      .select({ code: imMessageDeliveries.lastErrorCode })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.lastErrorCode, "IM_DELIVERY_WORKER_SATURATED"));
    expect(rows).toHaveLength(2);
  });

  it("handles runtime absence, stale correlations, malformed payloads, and terminal rejection", async () => {
    const absent = await workerFixture(unit);
    const absentDiagnostic = vi.fn();
    const absentWorker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), absent) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(absent.runtime) },
      registry: new ConnectionRegistry(),
      onDiagnostic: absentDiagnostic,
    });
    await absentWorker.runOnce();
    expect(absentDiagnostic).toHaveBeenCalledWith("IM_DELIVERY_RUNTIME_UNAVAILABLE");

    const stale = await workerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "expired",
        placementGeneration: 2,
        dispatchRequestId: randomUUID(),
        dispatchInputHash: "bad",
        dispatchPayload: { invalid: true } as never,
      })
      .where(eq(imMessageDeliveries.id, stale.deliveryId));
    const staleDiagnostic = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), stale) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: stale.registry,
      onDiagnostic: staleDiagnostic,
    }).runOnce();
    const [staleRow] = await unit.database
      .select({ code: imMessageDeliveries.lastErrorCode })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, stale.deliveryId));
    expect(staleRow?.code).toBe("IM_DELIVERY_PLACEMENT_STALE");
    expect(staleDiagnostic).not.toHaveBeenCalled();

    const malformed = await workerFixture(unit);
    const malformedRequest = { ...malformed.request, requestId: randomUUID() };
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "expired",
        dispatchRequestId: malformedRequest.requestId,
        dispatchInputHash: "bad",
        dispatchPayload: { invalid: true } as never,
      })
      .where(eq(imMessageDeliveries.id, malformed.deliveryId));
    const malformedDiagnostic = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), malformed) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: malformed.registry,
      onDiagnostic: malformedDiagnostic,
    }).runOnce();
    expect(malformedDiagnostic).toHaveBeenCalledWith("IM_DELIVERY_DISPATCH_PAYLOAD_INVALID");

    const terminal = await workerFixture(unit);
    const terminalRequest = { ...terminal.request, requestId: randomUUID() };
    const terminalHash = computeDirectInputHash(terminalRequest);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        dispatchRequestId: terminalRequest.requestId,
        dispatchInputHash: terminalHash,
        dispatchPayload: terminalRequest,
      })
      .where(eq(imMessageDeliveries.id, terminal.deliveryId));
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), terminal, {
      deliveryStatus: "rejected",
      deliveryReason: "configuration_unsupported",
    });
    await new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(terminal.runtime) },
      registry: terminal.registry,
    }).runOnce();
    const [terminalRow] = await unit.database
      .select({ state: imMessageDeliveries.state, code: imMessageDeliveries.lastErrorCode })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, terminal.deliveryId));
    expect(terminalRow).toMatchObject({ state: "pending", code: "IM_DELIVERY_RECONCILED_NO_CUSTODY" });
  });

  it("releases an expired persisted dispatch after reconciliation", async () => {
    const fixture = await workerFixture(unit);
    const request = { ...fixture.request, requestId: randomUUID() };
    const hash = computeDirectInputHash(request);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "expired",
        dispatchRequestId: request.requestId,
        dispatchInputHash: hash,
        dispatchPayload: request,
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const diagnostic = vi.fn();
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: fixture.registry,
      onDiagnostic: diagnostic,
    });
    await worker.runOnce();
    const [row] = await unit.database
      .select({ dispatchRequestId: imMessageDeliveries.dispatchRequestId, code: imMessageDeliveries.lastErrorCode })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row).toMatchObject({ dispatchRequestId: null, code: "IM_DELIVERY_EXPIRED" });
    expect(diagnostic).toHaveBeenCalledWith("IM_DELIVERY_EXPIRED");
  });

  it("recovers accepted custody with pinned and legacy snapshots, including failures", async () => {
    const pinned = await workerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        dispatchRequestId: pinned.request.requestId,
        dispatchInputHash: computeDirectInputHash(pinned.request),
        dispatchPayload: pinned.request,
        inputHash: computeDirectInputHash(pinned.request),
        turnId: "turn-1",
        reportOwnerInstanceId: pinned.instanceId,
        acceptedAt: new Date(),
      })
      .where(eq(imMessageDeliveries.id, pinned.deliveryId));
    const events: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), pinned, {
        onEvent: (event) => events.push(event),
      }) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: pinned.registry,
      onDiagnostic: (code) => events.push(code),
    }).runOnce();
    expect(events).toContain("reconcile");

    const legacy = await workerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "hash",
        turnId: "turn-legacy",
        reportOwnerInstanceId: legacy.instanceId,
        acceptedAt: new Date(),
        dispatchPayload: null,
        dispatchRequestId: null,
        dispatchInputHash: null,
      })
      .where(eq(imMessageDeliveries.id, legacy.deliveryId));
    const legacyAssembler = vi.fn().mockResolvedValue(legacy.runtime);
    const legacyDiagnostic = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), legacy) as never,
      assembler: { assembleForSession: legacyAssembler },
      registry: legacy.registry,
      onDiagnostic: legacyDiagnostic,
    }).runOnce();
    expect(legacyDiagnostic).toHaveBeenCalledWith("IM_DELIVERY_RECOVERY_LEGACY_SNAPSHOT_FALLBACK");
    expect(legacyAssembler).toHaveBeenCalledWith(legacy.sessionId);

    const invalid = await workerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        dispatchRequestId: randomUUID(),
        dispatchInputHash: "bad",
        dispatchPayload: { nope: true } as never,
        inputHash: "bad",
        turnId: "turn-invalid",
        reportOwnerInstanceId: invalid.instanceId,
        acceptedAt: new Date(),
      })
      .where(eq(imMessageDeliveries.id, invalid.deliveryId));
    const invalidDiagnostic = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), invalid) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: invalid.registry,
      onDiagnostic: invalidDiagnostic,
    }).runOnce();
    expect(invalidDiagnostic).toHaveBeenCalledWith("IM_DELIVERY_RECOVERY_PAYLOAD_INVALID");

    const failed = await workerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "hash",
        turnId: "turn-failed",
        reportOwnerInstanceId: failed.instanceId,
        acceptedAt: new Date(),
      })
      .where(eq(imMessageDeliveries.id, failed.deliveryId));
    const failureDiagnostic = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), failed, { reconcileFailure: true }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(failed.runtime) },
      registry: failed.registry,
      onDiagnostic: failureDiagnostic,
    }).runOnce();
    expect(failureDiagnostic).toHaveBeenCalledWith("IM_DELIVERY_RECOVERY_FAILED");
  });

  it("turns assembler failures into terminal rejection or retry diagnostics", async () => {
    for (const [code, expected] of [
      ["UNSUPPORTED_PROVIDER", "IM_DELIVERY_TERMINAL"],
      ["DATABASE_FAILURE", "IM_DELIVERY_RUNTIME_AUTHORITY_FAILED"],
      ["SESSION_NOT_FOUND", "IM_DELIVERY_RUNTIME_AUTHORITY_UNAVAILABLE"],
    ] as const) {
      const fixture = await workerFixture(unit);
      const diagnostic = vi.fn();
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
        assembler: { assembleForSession: vi.fn().mockRejectedValue(new EffectiveRuntimeSnapshotAssemblerError(code)) },
        registry: fixture.registry,
        onDiagnostic: diagnostic,
      });
      await worker.runOnce();
      if (code === "UNSUPPORTED_PROVIDER") {
        const [row] = await unit.database
          .select({ state: imMessageDeliveries.state })
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
        expect(row?.state).toBe("terminal_rejected");
      } else {
        expect(diagnostic).toHaveBeenCalledWith(expected);
      }
    }
  });

  it("starts and stops its interval without scheduling duplicate runs", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await workerFixture(unit);
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
        assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
        registry: fixture.registry,
        intervalMs: 5,
      });
      worker.start();
      worker.start();
      worker.stop();
      worker.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches steering when another accepted turn owns the agent", async () => {
    const fixture = await steerFixture(unit);
    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const events: string[] = [];
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(custody, fixture, { onEvent: (event) => events.push(event) }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      onDiagnostic: (code) => events.push(code),
    });
    await worker.runOnce();
    expect(events).toContain("steer");
  });

  it("includes revision-aware history and trims oversized resource frames", async () => {
    const fixture = await workerFixture(unit);
    await unit.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, fixture.agentId));
    const acceptedMessageId = randomUUID();
    const historyMessageId = randomUUID();
    const acceptedDeliveryId = randomUUID();
    const now = new Date(Date.now() + 60 * 60_000);
    await unit.database.insert(imMessages).values([
      {
        id: acceptedMessageId,
        imBindingId: fixture.bindingId,
        channelId: "channel",
        externalMessageId: `accepted-${acceptedMessageId}`,
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "human",
        content: { fallbackText: "accepted history" },
        providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "accepted" },
        occurredAt: new Date(now.getTime() - 2_000),
      },
      {
        id: historyMessageId,
        imBindingId: fixture.bindingId,
        channelId: "channel",
        externalMessageId: `history-${historyMessageId}`,
        providerRevisionKey: "1",
        operation: "deleted",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "human",
        content: { fallbackText: "deleted history" },
        providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "history" },
        occurredAt: new Date(now.getTime() - 1_000),
      },
    ] as never);
    await unit.database.insert(imMessageDeliveries).values({
      id: acceptedDeliveryId,
      messageId: acceptedMessageId,
      sessionId: fixture.sessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      inputHash: "history-input",
      turnId: "history-turn",
      reportOwnerInstanceId: fixture.instanceId,
      resultHash: "history-result",
      turnReport: {
        type: "turn:report",
        requestId: randomUUID(),
        deliveryId: acceptedDeliveryId,
        turnId: "history-turn",
        sessionId: fixture.sessionId,
        agentId: fixture.agentId,
        placementGeneration: 1,
        outcome: "completed",
        executionEffects: "completed",
        finalText: "ok",
        resultHash: "history-result",
        traceSummary: { lastSequence: 0, droppedEvents: 0 },
      },
      reportedAt: now,
      acceptedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    } as never);
    await unit.database
      .update(imMessages)
      .set({
        content: {
          version: 1,
          fallbackText: "x".repeat(20_000),
          blocks: [],
          truncated: false,
          resources: Array.from({ length: 900 }, (_, index) => ({
            kind: "file",
            filename: `file-${index}.txt`,
            mediaType: "text/plain",
            sizeBytes: 10,
            providerResourceKey: `resource-${index}`,
          })),
        },
      })
      .where(eq(imMessages.id, fixture.request.imMessageId));
    let delivered: DirectImMessageDeliveryRequest | undefined;
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, {
        onDelivery: (request) => {
          delivered = request;
        },
      }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
    });
    await worker.runOnce();
    expect(delivered?.content.text.length).toBeLessThan(20_000);
    expect(delivered?.content.historyTruncated).toBe(true);
    expect(delivered?.content.resources?.length ?? 900).toBeLessThan(900);
  });

  it("rejects or retries steering when its authority changes", async () => {
    const ownerMismatch = await steerFixture(unit);
    const otherUserId = randomUUID();
    await unit.database
      .insert(users)
      .values({ id: otherUserId, email: `${otherUserId}@example.com`, displayName: "Other" });
    await unit.database
      .update(agents)
      .set({ createdByUserId: otherUserId })
      .where(eq(agents.id, ownerMismatch.agentId));
    const ownerDiagnostic = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), ownerMismatch) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: ownerMismatch.registry,
      onDiagnostic: ownerDiagnostic,
    }).runOnce();
    expect(ownerDiagnostic).not.toHaveBeenCalled();

    await unit.reset();
    const rejected = await steerFixture(unit);
    const rejectedEvents: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), rejected, {
        steerStatus: "rejected",
        steerReason: "invalid_input",
      }) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: rejected.registry,
      onDiagnostic: (code) => rejectedEvents.push(code),
    }).runOnce();
    expect(rejectedEvents).not.toContain("IM_DELIVERY_STEER_DEFERRED");

    await unit.reset();
    const retry = await steerFixture(unit);
    const retryEvents: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), retry, { steerStatus: "retry" }) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: retry.registry,
      onDiagnostic: (code) => retryEvents.push(code),
    }).runOnce();
    expect(retryEvents).toContain("IM_DELIVERY_STEER_STARTING");

    await unit.reset();
    const failed = await steerFixture(unit);
    const failedEvents: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), failed, { steerFailure: true }) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: failed.registry,
      onDiagnostic: (code) => failedEvents.push(code),
    }).runOnce();
    expect(failedEvents).toContain("IM_DELIVERY_STEER_FAILED");
  });

  it("fences competing custody, retired steer correlations, and recovery authority", async () => {
    const competing = await steerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({ reportOwnerInstanceId: randomUUID() })
      .where(eq(imMessageDeliveries.id, competing.rootDeliveryId));
    const competingEvents: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), competing) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: competing.registry,
      onDiagnostic: (code) => competingEvents.push(code),
    }).runOnce();
    expect(competingEvents).toEqual([]);

    await unit.reset();
    const retired = await workerFixture(unit);
    const steer: RuntimeImSteerRequest = {
      type: "im:steer",
      requestId: randomUUID(),
      deliveryId: retired.deliveryId,
      imMessageId: retired.request.imMessageId,
      sessionId: retired.sessionId,
      agentId: retired.agentId,
      placementGeneration: 1,
      rootDeliveryId: retired.deliveryId,
      expectedTurnId: "retired-turn",
      attention: "direct",
      content: retired.request.content,
    };
    const steerInputHash = computeRuntimeImSteerInputHash(steer);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "expired",
        dispatchRequestId: steer.requestId,
        dispatchInputHash: steerInputHash,
        dispatchPayload: steer,
        steerTargetDeliveryId: steer.rootDeliveryId,
      })
      .where(eq(imMessageDeliveries.id, retired.deliveryId));
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), retired) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: retired.registry,
    }).runOnce();
    const [retiredRow] = await unit.database
      .select({
        dispatchRequestId: imMessageDeliveries.dispatchRequestId,
        steerTargetDeliveryId: imMessageDeliveries.steerTargetDeliveryId,
      })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, retired.deliveryId));
    expect(retiredRow).toEqual({ dispatchRequestId: null, steerTargetDeliveryId: null });

    await unit.reset();
    const staleRecovery = await workerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        placementGeneration: 2,
        inputHash: computeDirectInputHash(staleRecovery.request),
        turnId: "stale-turn",
        reportOwnerInstanceId: staleRecovery.instanceId,
        acceptedAt: new Date(),
      })
      .where(eq(imMessageDeliveries.id, staleRecovery.deliveryId));
    const staleEvents: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), staleRecovery) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: staleRecovery.registry,
      onDiagnostic: (code) => staleEvents.push(code),
    }).runOnce();
    expect(staleEvents).toContain("IM_DELIVERY_PLACEMENT_STALE");

    await unit.reset();
    const unavailable = await workerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: computeDirectInputHash(unavailable.request),
        turnId: "unavailable-turn",
        reportOwnerInstanceId: unavailable.instanceId,
        acceptedAt: new Date(),
      })
      .where(eq(imMessageDeliveries.id, unavailable.deliveryId));
    const unavailableEvents: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), unavailable) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: new ConnectionRegistry(),
      onDiagnostic: (code) => unavailableEvents.push(code),
    }).runOnce();
    expect(unavailableEvents).toContain("IM_DELIVERY_RUNTIME_UNAVAILABLE");
  });

  it("records reconcile and delivery disposition branches", async () => {
    for (const reconcileStatus of ["rejected", "busy"] as const) {
      await unit.reset();
      const fixture = await workerFixture(unit);
      const events: string[] = [];
      await new ImDeliveryWorker({
        database: unit.database,
        domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, { reconcileStatus }) as never,
        assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
        registry: fixture.registry,
        onDiagnostic: (code) => events.push(code),
      }).runOnce();
      expect(events).toContain(
        reconcileStatus === "rejected" ? "IM_DELIVERY_RECONCILE_REJECTED" : "IM_DELIVERY_RECONCILE_NOT_READY",
      );
    }

    await unit.reset();
    const terminal = await workerFixture(unit);
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), terminal, {
        deliveryStatus: "rejected",
        deliveryReason: "configuration_unsupported",
      }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(terminal.runtime) },
      registry: terminal.registry,
    }).runOnce();
    const [terminalRow] = await unit.database
      .select({ state: imMessageDeliveries.state })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, terminal.deliveryId));
    expect(terminalRow?.state).toBe("terminal_rejected");

    await unit.reset();
    const released = await workerFixture(unit);
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), released, {
        deliveryStatus: "rejected",
        deliveryReason: "target_mismatch",
      }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(released.runtime) },
      registry: released.registry,
    }).runOnce();
    const [releasedRow] = await unit.database
      .select({
        dispatchRequestId: imMessageDeliveries.dispatchRequestId,
        lastErrorCode: imMessageDeliveries.lastErrorCode,
      })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, released.deliveryId));
    expect(releasedRow).toMatchObject({ dispatchRequestId: null, lastErrorCode: "IM_DELIVERY_RUNTIME_REJECTED" });

    await unit.reset();
    const failed = await workerFixture(unit);
    const failedEvents: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), failed, { deliveryFailure: true }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(failed.runtime) },
      registry: failed.registry,
      onDiagnostic: (code) => failedEvents.push(code),
    }).runOnce();
    expect(failedEvents).toContain("IM_DELIVERY_RUNTIME_FAILED");
  });

  it("rejects deliveries when the Computer owner or steer authority is stale", async () => {
    const ownerMismatch = await workerFixture(unit);
    const otherUserId = randomUUID();
    await unit.database
      .insert(users)
      .values({ id: otherUserId, email: `${otherUserId}@example.com`, displayName: "Other" });
    await unit.database
      .update(agents)
      .set({ createdByUserId: otherUserId })
      .where(eq(agents.id, ownerMismatch.agentId));
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), ownerMismatch) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(ownerMismatch.runtime) },
      registry: ownerMismatch.registry,
    }).runOnce();
    const [ownerRow] = await unit.database
      .select({ state: imMessageDeliveries.state })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, ownerMismatch.deliveryId));
    expect(ownerRow?.state).toBe("terminal_rejected");

    await unit.reset();
    const steerUnavailable = await steerFixture(unit);
    await unit.database
      .update(computers)
      .set({ currentInstanceId: randomUUID() })
      .where(eq(computers.id, steerUnavailable.computerId));
    const steerEvents: string[] = [];
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), steerUnavailable) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(steerUnavailable.runtime) },
      registry: steerUnavailable.registry,
      onDiagnostic: (code) => steerEvents.push(code),
    }).runOnce();
    expect(steerEvents).toContain("IM_DELIVERY_STEER_UNAVAILABLE");
  });
});

async function workerFixture(unit: UnitDatabase) {
  const now = new Date(Date.now() + 60 * 60_000);
  const userId = randomUUID();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  const instanceId = randomUUID();
  await unit.database.insert(users).values({ id: userId, email: `${userId}@example.com`, displayName: "User" });
  await unit.database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    currentInstallationId: randomUUID(),
    displayName: "Computer",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
    currentInstanceId: instanceId,
  });
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `agent-${agentId}`,
    displayName: "Agent",
    runtimeProvider: "codex",
  });
  const slackInstallationId = randomUUID();
  const externalAppId = `app-${bindingId}`;
  const externalTeamId = `team-${bindingId}`;
  const externalBotId = `bot-${bindingId}`;
  await unit.database.insert(slackInstallations).values({
    id: slackInstallationId,
    agentId,
    status: "active",
    externalAppId,
    externalTeamId,
    externalBotId,
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "encrypted",
    activatedAt: now,
  });
  await unit.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "slack",
    status: "active",
    externalAppId,
    externalTeamId,
    externalBotId,
    credentialSchemaVersion: 1,
    slackInstallationId,
    slackRouteKind: "default",
    credentialGeneration: 1,
    activatedAt: now,
  });
  await unit.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "channel",
    conversationKind: "channel",
    kind: "channel",
  });
  await unit.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  const content = {
    fallbackText: "hello",
    resources: [{ kind: "file" as const, filename: "note.txt", mediaType: "text/plain", sizeBytes: 5 }],
  };
  await unit.database.insert(imMessages).values({
    id: messageId,
    imBindingId: bindingId,
    channelId: "channel",
    externalMessageId: `message-${messageId}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "human",
    content,
    providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "1" },
    occurredAt: now,
  } as never);
  await unit.database.insert(imMessageDeliveries).values({
    id: deliveryId,
    messageId,
    sessionId,
    attention: "direct",
    placementGeneration: 1,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const runtime = {
    revision: { agent: { sequence: 1, id: agentId }, session: { sequence: 1, id: sessionId } },
    agentId,
    provider: "codex" as const,
    instructions: { platform: "", agent: "", session: "" },
    execution: { approvalPolicy: "never" as const, networkAccess: false },
    workspace: { workspaceId: agentId, mode: "empty_on_create" as const, sharing: "agent" as const },
  };
  const registry = new ConnectionRegistry();
  await registry.register(
    {
      computerId,
      installationId: randomUUID(),
      instanceId,
      lastHeartbeatAt: Date.now(),
      socket: { close: vi.fn(), terminate: vi.fn() } as never,
    },
    async () => undefined,
  );
  const request: DirectImMessageDeliveryRequest = {
    type: "im:deliver",
    requestId: randomUUID(),
    deliveryId,
    imMessageId: messageId,
    sessionId,
    agentId,
    placementGeneration: 1,
    attention: "direct",
    content: {
      kind: "text",
      text: "hello",
      providerRef: {
        provider: "slack",
        appId: "app",
        teamId: "team",
        botUserId: "bot",
        channelId: "channel",
        messageTs: "1",
      },
    },
    runtime,
  };
  return {
    agentId,
    bindingId,
    computerId,
    deliveryId,
    instanceId,
    registry,
    request,
    runtime,
    sessionId,
    userId,
  };
}

async function steerFixture(unit: UnitDatabase) {
  const fixture = await workerFixture(unit);
  const rootMessageId = randomUUID();
  const rootDeliveryId = randomUUID();
  const now = new Date(Date.now() + 60 * 60_000);
  await unit.database.insert(imMessages).values({
    id: rootMessageId,
    imBindingId: fixture.bindingId,
    channelId: "channel",
    externalMessageId: `root-${rootMessageId}`,
    providerRevisionKey: "1",
    operation: "created",
    direction: "inbound",
    authorKind: "human",
    authorExternalId: "human",
    content: { fallbackText: "root" },
    providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "root" },
    occurredAt: now,
  } as never);
  await unit.database.insert(imMessageDeliveries).values({
    id: rootDeliveryId,
    messageId: rootMessageId,
    sessionId: fixture.sessionId,
    attention: "direct",
    state: "accepted",
    placementGeneration: 1,
    inputHash: "root-hash",
    turnId: "turn-root",
    reportOwnerInstanceId: fixture.instanceId,
    acceptedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  await unit.database
    .update(imMessageDeliveries)
    .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
    .where(eq(imMessageDeliveries.id, fixture.deliveryId));
  await unit.database
    .update(imMessageDeliveries)
    .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
    .where(eq(imMessageDeliveries.id, rootDeliveryId));
  await unit.database.update(agents).set({ status: "active" }).where(eq(agents.id, fixture.agentId));
  await unit.database
    .update(sessionPlacements)
    .set({ generation: 1 })
    .where(eq(sessionPlacements.sessionId, fixture.sessionId));
  const steerRegistry = new ConnectionRegistry();
  await steerRegistry.register(
    {
      computerId: fixture.computerId,
      installationId: randomUUID(),
      instanceId: fixture.instanceId,
      lastHeartbeatAt: Date.now(),
      negotiatedCapabilities: { [RUNTIME_CAPABILITY.imSteer]: 2 },
      socket: { close: vi.fn(), terminate: vi.fn() } as never,
    },
    async () => undefined,
  );
  return { ...fixture, registry: steerRegistry, rootDeliveryId };
}

function fakeDomain(
  custody: PostgresRuntimeCustodyStore,
  fixture: Awaited<ReturnType<typeof workerFixture>>,
  options: {
    deliveryStatus?: string;
    deliveryReason?: string;
    reconcileFailure?: boolean;
    reconcileStatus?: "ready" | "rejected" | "busy" | "stopped";
    deliveryFailure?: boolean;
    onReconcile?: () => Promise<void>;
    steerStatus?: string;
    steerReason?: string;
    steerFailure?: boolean;
    deliveryHang?: boolean;
    onDelivery?: (request: DirectImMessageDeliveryRequest) => void;
    onEvent?: (event: string) => void;
  } = {},
) {
  return {
    requestReconcile: vi.fn(
      async (_computerId: string, _instanceId: string, _request: unknown, onDispatched?: () => void) => {
        options.onEvent?.("reconcile");
        onDispatched?.();
        if (options.reconcileFailure) throw new Error("reconcile failed");
        await options.onReconcile?.();
        return {
          type: "session:reconcile:result",
          requestId: randomUUID(),
          sessionId: fixture.sessionId,
          placementGeneration: 1,
          status: options.reconcileStatus ?? "ready",
          ...(options.reconcileStatus && options.reconcileStatus !== "ready" ? { reason: "test" } : {}),
        };
      },
    ),
    requestDelivery: vi.fn(
      async (
        _computerId: string,
        _instanceId: string,
        request: DirectImMessageDeliveryRequest,
        onDispatched?: () => void,
      ) => {
        options.onEvent?.("delivery");
        options.onDelivery?.(request);
        onDispatched?.();
        if (options.deliveryHang) await new Promise<void>(() => undefined);
        if (options.deliveryFailure) throw new Error("delivery failed");
        const hash = computeDirectInputHash(request);
        await custody.beginDeliveryDispatch(request, hash, {
          computerId: fixture.computerId,
          instanceId: fixture.instanceId,
        });
        if (options.deliveryStatus === "rejected")
          return {
            type: "im:deliver:result",
            requestId: request.requestId,
            deliveryId: request.deliveryId,
            sessionId: request.sessionId,
            placementGeneration: request.placementGeneration,
            status: "rejected",
            reason: options.deliveryReason ?? "invalid_input",
          };
        await custody.acceptDelivery(request, hash, "turn-1", {
          computerId: fixture.computerId,
          installationId: randomUUID(),
          instanceId: fixture.instanceId,
          signal: new AbortController().signal,
        });
        return {
          type: "im:deliver:result",
          requestId: request.requestId,
          deliveryId: request.deliveryId,
          sessionId: request.sessionId,
          placementGeneration: request.placementGeneration,
          status: "accepted",
          turnId: "turn-1",
        };
      },
    ),
    requestSteer: vi.fn(
      async (
        _computerId: string,
        _instanceId: string,
        request: { requestId: string; deliveryId: string; sessionId: string; placementGeneration: number },
        onDispatched?: () => void,
      ) => {
        options.onEvent?.("steer");
        onDispatched?.();
        if (options.steerFailure) throw new Error("steer failed");
        return {
          type: "im:steer:result",
          requestId: request.requestId,
          deliveryId: request.deliveryId,
          sessionId: request.sessionId,
          placementGeneration: request.placementGeneration,
          status: options.steerStatus ?? "steered",
          ...(options.steerReason ? { reason: options.steerReason } : {}),
        };
      },
    ),
  };
}
