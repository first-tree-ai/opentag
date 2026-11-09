import { randomUUID } from "node:crypto";
import { setImmediate as nextEventLoop } from "node:timers/promises";
import {
  computeDirectInputHash,
  computeLegacyDirectInputHash,
  computeRuntimeImMessageSemanticHash,
  computeRuntimeImSteerInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  RUNTIME_CAPABILITY,
  type RuntimeImSteerRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext, vi } from "vitest";
import {
  agents,
  computers,
  feishuInboundReceipts,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
  slackWebhookReceipts,
  users,
} from "../db/schema/index.js";
import { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import { createServerDiagnosticReporter } from "../observability/diagnostics.js";
import { createPerformanceLogger, type PerformanceLogger } from "../observability/performance-logger.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { ImDeliveryInputError, validateFreshImRequest } from "../runtime/im-delivery-content.js";
import { fitDeliveryFrame } from "../runtime/im-delivery-custody.js";
import { recordDeliveryFailure } from "../runtime/im-delivery-failure.js";
import { runImDeliverySteerRecovery } from "../runtime/im-delivery-janitor.js";
import { ACCEPTED_REPORT_WINDOW_MS } from "../runtime/im-delivery-retry.js";
import { ImDeliveryWorker } from "../runtime/im-delivery-worker.js";
import { KeyedTaskScheduler } from "../runtime/keyed-task-scheduler.js";
import { PostgresRuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { RuntimeDispatchDeferredError } from "../runtime/runtime-domain-owner.js";
import { EffectiveRuntimeSnapshotAssemblerError } from "../services/runtime-config/errors.js";
import { deferred } from "./support/deferred.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

describe("ImDeliveryWorker diagnostics", () => {
  it("contains a scheduler database failure and emits only a bounded diagnostic code", async () => {
    const diagnostic = vi.fn();
    const database = {
      execute: vi.fn().mockRejectedValue(new Error("secret provider response must not escape")),
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
    expect(diagnostic).toHaveBeenCalledWith("IM_DELIVERY_WORKER_SCHEDULING_FAILED", { phase: "worker" });
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
      execute: vi.fn().mockRejectedValue(new Error("claim failed")),
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

  it.each(["direct", "steer"])(
    "delivers attachment-only %s input with stable IDs and no validation retry",
    async (kind) => {
      const fixture = kind === "steer" ? await steerFixture(unit) : await workerFixture(unit);
      await unit.database
        .update(imMessages)
        .set({
          content: {
            version: 1,
            fallbackText: "",
            blocks: [],
            truncated: false,
            resources: [
              {
                providerResourceKey: "F_NATIVE",
                kind: "image",
                filename: "图😀.png",
                mediaType: "image/png",
                sizeBytes: 12,
              },
            ],
          },
        })
        .where(eq(imMessages.id, fixture.messageId));
      const diagnostic = vi.fn();
      const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture);
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: domain as never,
        assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
        registry: fixture.registry,
        onDiagnostic: diagnostic,
      });
      await worker.runOnce();
      const calls = kind === "steer" ? domain.requestSteer.mock.calls : domain.requestDelivery.mock.calls;
      expect(calls).toHaveLength(1);
      const request = calls[0]?.[2] as DirectImMessageDeliveryRequest | RuntimeImSteerRequest;
      expect(request.content.text).toContain('"file_id":"F_NATIVE"');
      expect(request.content.providerRef.provider).toBe("slack");
      expect(request.content.resources?.[0]?.filename).toBe("图😀.png");
      expect(diagnosticCodes(diagnostic)).not.toContain("IM_DELIVERY_RUNTIME_FAILED");
      expect(diagnosticCodes(diagnostic)).not.toContain("IM_DELIVERY_STEER_FAILED");
    },
  );

  it("terminally rejects unrecoverable empty content before reconcile and never retries that version", async () => {
    const fixture = await workerFixture(unit);
    await unit.database
      .update(imMessages)
      .set({ content: { version: 1, fallbackText: "", blocks: [], truncated: false, resources: [] } })
      .where(eq(imMessages.id, fixture.messageId));
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture);
    const diagnostic = vi.fn();
    const assembler = { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) };
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler,
      registry: fixture.registry,
      onDiagnostic: diagnostic,
    });
    await worker.runOnce();
    await worker.runOnce();
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row).toMatchObject({
      state: "terminal_rejected",
      reason: "content_unrecoverable",
      lastErrorCode: "IM_DELIVERY_CONTENT_INVALID",
      attemptCount: 1,
      dispatchRequestId: null,
    });
    expect(domain.requestReconcile).not.toHaveBeenCalled();
    expect(domain.requestDelivery).not.toHaveBeenCalled();
    expect(assembler.assembleForSession).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith("IM_DELIVERY_CONTENT_INVALID", expect.any(Object));
  });

  it("rejects malformed stored resource metadata before external calls without leaking its contents", async () => {
    const fixture = await workerFixture(unit);
    await unit.database
      .update(imMessages)
      .set({
        content: {
          version: 1,
          fallbackText: "secret body",
          blocks: [],
          truncated: false,
          resources: [
            {
              providerResourceKey: "F_SECRET",
              kind: "file",
              filename: "secret filename",
              mediaType: null,
              sizeBytes: 1,
              ordinal: 99,
            },
          ],
        },
      } as never)
      .where(eq(imMessages.id, fixture.messageId));
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture);
    const diagnostic = vi.fn();
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn() },
      registry: fixture.registry,
      onDiagnostic: diagnostic,
    });
    await worker.runOnce();
    await worker.runOnce();
    expect(domain.requestReconcile).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith("IM_DELIVERY_CONTENT_INVALID", expect.any(Object));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret");
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row).toMatchObject({ state: "terminal_rejected", reason: "invalid_content", attemptCount: 1 });
  });

  it("classifies fresh request errors separately from mutable runtime configuration", async () => {
    const fixture = await workerFixture(unit);
    expect(() => validateFreshImRequest({ ...fixture.request, deadlineAt: "bad-date" })).toThrow(ImDeliveryInputError);
    const mutableConfig = { ...fixture.request, runtime: { ...fixture.runtime, agentId: "other-agent" } };
    try {
      validateFreshImRequest(mutableConfig);
      throw new Error("Expected invalid configuration");
    } catch (error) {
      expect(error).not.toBeInstanceOf(ImDeliveryInputError);
      expect(error).toHaveProperty("issues");
    }
  });

  it("only terminally classifies frame overflow independent of mutable Runtime configuration", async () => {
    const fixture = await workerFixture(unit);
    const configOverflow = structuredClone(fixture.request);
    configOverflow.runtime.instructions.agent = "\0".repeat(20 * 1024);
    expect(() => validateFreshImRequest(configOverflow)).not.toThrow();
    try {
      fitDeliveryFrame(configOverflow);
      throw new Error("Expected frame overflow");
    } catch (error) {
      expect(error).not.toBeInstanceOf(ImDeliveryInputError);
      expect(error).toHaveProperty("message", "IM_DELIVERY_FRAME_TOO_LARGE");
    }
    const contentOverflow = structuredClone(fixture.request);
    contentOverflow.content.text = "\0".repeat(16 * 1024);
    expect(() => validateFreshImRequest(contentOverflow)).not.toThrow();
    expect(() => fitDeliveryFrame(contentOverflow)).toThrow(ImDeliveryInputError);
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
    expect(diagnosticCodes(diagnostic)).toContain("IM_DELIVERY_AGENT_NOT_ACTIVE");
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
      const logger = { info: vi.fn() };
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
        assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
        registry: fixture.registry,
        now: () => now,
        maxQueueAgeMs: 100,
        onMetric: (metric) => {
          metrics.push(metric);
          logger.info({ metric }, "IM delivery worker metric");
        },
      });

      await worker.runOnce();

      expect(metrics).toEqual([
        { name: "queue_age_ms", value: 1_000, agentId: fixture.agentId },
        { name: "saturation", value: 1, agentId: fixture.agentId },
        { name: "retry", value: 1 },
      ]);
      expect(logger.info).toHaveBeenCalledTimes(metrics.length);
      expect(logger.info).toHaveBeenNthCalledWith(
        1,
        { metric: { name: "queue_age_ms", value: 1_000, agentId: fixture.agentId } },
        "IM delivery worker metric",
      );
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
      let admissionCalled = false;
      let admissionAborted = false;
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
        beforeDeliveryAdmission: async (signal) => {
          admissionCalled = true;
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                admissionAborted = true;
                resolve();
              },
              { once: true },
            ),
          );
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
      expect(metrics).toContainEqual({ name: "timeout", value: 1, agentId: fixture.agentId });
      expect(metrics).toContainEqual({ name: "late_settle", value: 1, agentId: fixture.agentId });
      expect(admissionAborted).toBe(true);
      const [row] = await unit.database
        .select({ code: imMessageDeliveries.lastErrorCode })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      expect(row?.code).toBe("IM_DELIVERY_OPERATION_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the scheduler permit until a timed-out delivery settles", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-31T00:00:00.000Z") });
    try {
      const fixture = await workerFixture(unit);
      const secondFixture = await workerFixture(unit);
      const now = new Date();
      await unit.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(now.getTime() - 1_000) })
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      await unit.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(now.getTime() - 500) })
        .where(eq(imMessageDeliveries.id, secondFixture.deliveryId));
      await fixture.registry.register(
        {
          clientVersion: "0.1.1",
          computerId: secondFixture.computerId,
          installationId: randomUUID(),
          instanceId: secondFixture.instanceId,
          lastHeartbeatAt: Date.now(),
          socket: { close: vi.fn(), terminate: vi.fn() } as never,
        },
        async () => undefined,
      );

      let admissionCalls = 0;
      let releaseFirst: (() => void) | undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const metrics: Array<{ name: string; value: number; agentId?: string }> = [];
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: {
          requestReconcile: vi.fn(async (_computerId, _instanceId, request, onDispatched) => {
            onDispatched?.();
            return {
              type: "session:reconcile:result" as const,
              requestId: request.requestId,
              sessionId: request.sessionId,
              placementGeneration: request.placementGeneration,
              status: "ready" as const,
            };
          }),
          requestDelivery: vi.fn(async (_computerId, _instanceId, request, onDispatched) => {
            onDispatched?.();
            return {
              type: "im:deliver:result" as const,
              requestId: request.requestId,
              deliveryId: request.deliveryId,
              sessionId: request.sessionId,
              placementGeneration: request.placementGeneration,
              status: "accepted" as const,
              turnId: `turn-${request.deliveryId}`,
            };
          }),
        } as never,
        assembler: {
          assembleForSession: vi.fn(async (sessionId: string) =>
            sessionId === secondFixture.sessionId ? secondFixture.runtime : fixture.runtime,
          ),
        },
        registry: fixture.registry,
        maxConcurrent: 1,
        operationTimeoutMs: 100,
        beforeDeliveryAdmission: async () => {
          admissionCalls += 1;
          if (admissionCalls === 1) await firstGate;
        },
        onMetric: (metric) => metrics.push(metric),
      });

      const first = worker.runOnce();
      await vi.waitFor(() => expect(admissionCalls).toBe(1), { timeout: 50, interval: 1 });
      let secondSettled = false;
      const secondRun = worker.runOnce().then(() => {
        secondSettled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(metrics).toContainEqual({ name: "timeout", value: 1, agentId: fixture.agentId });
      expect(admissionCalls).toBe(1);
      expect(secondSettled).toBe(false);

      releaseFirst?.();
      await expect(first).resolves.toBeUndefined();
      await expect(secondRun).resolves.toBeUndefined();
      expect(admissionCalls).toBe(2);
      expect(metrics).toContainEqual({ name: "late_settle", value: 1, agentId: fixture.agentId });
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a scheduler slot after the timeout grace when delivery never settles", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-31T00:00:00.000Z") });
    try {
      const firstFixture = await workerFixture(unit);
      const secondFixture = await workerFixture(unit);
      const now = new Date();
      await unit.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(now.getTime() - 1_000) })
        .where(eq(imMessageDeliveries.id, firstFixture.deliveryId));
      await unit.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(now.getTime() - 500) })
        .where(eq(imMessageDeliveries.id, secondFixture.deliveryId));
      await firstFixture.registry.register(
        {
          clientVersion: "0.1.1",
          computerId: secondFixture.computerId,
          installationId: randomUUID(),
          instanceId: secondFixture.instanceId,
          lastHeartbeatAt: Date.now(),
          socket: { close: vi.fn(), terminate: vi.fn() } as never,
        },
        async () => undefined,
      );

      const metrics: Array<{ name: string; value: number; agentId?: string }> = [];
      const diagnostic = vi.fn();
      const requestDelivery = vi.fn(
        async (
          _computerId: string,
          _instanceId: string,
          request: DirectImMessageDeliveryRequest,
          onDispatched?: () => void,
        ) => {
          onDispatched?.();
          if (request.agentId === firstFixture.agentId) return new Promise<never>(() => undefined);
          return {
            type: "im:deliver:result" as const,
            requestId: request.requestId,
            deliveryId: request.deliveryId,
            sessionId: request.sessionId,
            placementGeneration: request.placementGeneration,
            status: "accepted" as const,
            turnId: `turn-${request.deliveryId}`,
          };
        },
      );
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: {
          requestReconcile: vi.fn(async (_computerId, _instanceId, request, onDispatched) => {
            onDispatched?.();
            return {
              type: "session:reconcile:result" as const,
              requestId: request.requestId,
              sessionId: request.sessionId,
              placementGeneration: request.placementGeneration,
              status: "ready" as const,
            };
          }),
          requestDelivery,
        } as never,
        assembler: {
          assembleForSession: vi.fn(async (sessionId: string) =>
            sessionId === secondFixture.sessionId ? secondFixture.runtime : firstFixture.runtime,
          ),
        },
        registry: firstFixture.registry,
        maxConcurrent: 1,
        operationTimeoutMs: 100,
        onDiagnostic: diagnostic,
        onMetric: (metric) => metrics.push(metric),
      });

      const first = worker.runOnce();
      await vi.waitFor(() => expect(requestDelivery).toHaveBeenCalledTimes(1), { timeout: 50, interval: 1 });
      let secondSettled = false;
      void worker.runOnce().then(() => {
        secondSettled = true;
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(secondSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toBeUndefined();
      await vi.waitFor(() => expect(secondSettled).toBe(true), { timeout: 50, interval: 1 });
      expect(requestDelivery).toHaveBeenCalledTimes(2);
      expect(diagnosticCodes(diagnostic)).toContain("IM_DELIVERY_OPERATION_ABANDONED");
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the equal-expiry selector ordered by the composite index", async () => {
    const fixture = await workerFixture(unit);
    await unit.engine.query(
      `insert into im_messages (
         id, im_binding_id, channel_id, external_message_id, provider_revision_key,
         operation, direction, author_kind, author_external_id, content, provider_context, occurred_at
       )
       select gen_random_uuid(), $1, 'equal-expiry', 'equal-expiry-' || series.n, '1',
         'created', 'inbound', 'human', 'equal-expiry-user', '{"fallbackText":"equal-expiry"}'::jsonb,
         '{"provider":"slack","appId":"app","teamId":"team","botUserId":"bot","channelId":"equal-expiry","channelType":"channel","messageTs":"equal"}'::jsonb,
         '2000-01-01T00:00:00Z'::timestamptz
       from generate_series(1, 1000) as series(n)`,
      [fixture.bindingId],
    );
    await unit.engine.query(
      `insert into im_message_deliveries (
         id, message_id, session_id, attention, state, placement_generation, next_attempt_at, expires_at
       )
       select gen_random_uuid(), message.id, $1, 'direct', 'pending', 1,
         '2000-01-01T00:00:00Z'::timestamptz, '2000-01-01T00:00:00Z'::timestamptz
       from im_messages as message
       where message.channel_id = 'equal-expiry'`,
      [fixture.sessionId],
    );
    await unit.engine.exec("analyze im_message_deliveries");
    await unit.engine.exec("begin");
    try {
      const plan = await unit.engine.query<{ "QUERY PLAN": string }>(`
        explain (analyze, buffers, costs off)
        with expired as (
          select id
          from im_message_deliveries
          where state = 'pending'
            and reason is null
            and expires_at <= now()
          order by expires_at asc, id asc
          limit 100
          for update skip locked
        )
        update im_message_deliveries as delivery
        set state = 'expired', reason = 'ttl'
        from expired
        where delivery.id = expired.id
      `);
      const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(planText).toContain("Index Scan using im_message_deliveries_expiry_idx");
      expect(planText).not.toContain("Sort");
      expect(planText).toMatch(/actual [^\n]*rows=100/);
    } finally {
      await unit.engine.exec("rollback");
    }
  });

  it("persists a saturation disposition when an agent lane is full", async () => {
    const fixtures = [await workerFixture(unit), await workerFixture(unit), await workerFixture(unit)];
    const registry = new ConnectionRegistry();
    for (const fixture of fixtures) {
      await registry.register(
        {
          clientVersion: "0.1.1",
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
      assembler: {
        assembleForSession: vi.fn(async (sessionId: string) => {
          const fixture = fixtures.find((item) => item.sessionId === sessionId);
          if (!fixture) throw new Error("Session fixture not found");
          return fixture.runtime;
        }),
      },
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
    expect(absentDiagnostic).toHaveBeenCalledWith("IM_DELIVERY_RUNTIME_UNAVAILABLE", {
      phase: "deliver",
      deliveryId: absent.deliveryId,
      agentId: absent.agentId,
      computerId: absent.computerId,
      attemptCount: 1,
    });

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
    expect(diagnosticCodes(malformedDiagnostic)).toContain("IM_DELIVERY_DISPATCH_PAYLOAD_INVALID");

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
    expect(diagnosticCodes(diagnostic)).toContain("IM_DELIVERY_EXPIRED");
  });

  it.each([
    ["pending", "0.1.0", "0.1.0", {}],
    ["accepted", "0.1.0", "0.1.0", {}],
    ["accepted after upgrade", "0.1.1", "0.1.0", {}],
    ["tampered", "0.1.0", "0.1.0", {}],
    ["staging accepted", "0.1.1-staging.43.1", "self-configuration", { selfConfigurationEnabled: true }],
    ["staging tampered", "0.1.1-staging.43.1", "self-configuration", { selfConfigurationEnabled: true }],
  ] as const)(
    "keeps legacy %s work behind the upgrade gate without new runtime snapshots",
    async (scenario, clientVersion, layout, snapshotFields) => {
      const fixture = await workerFixture(unit);
      const request = { ...fixture.request, runtime: { ...fixture.runtime, ...snapshotFields } };
      await fixture.registry.register(
        {
          clientVersion,
          negotiatedCapabilities: { "runtime.sessionReconcile": 1 },
          computerId: fixture.computerId,
          installationId: randomUUID(),
          instanceId: fixture.instanceId,
          lastHeartbeatAt: Date.now(),
          socket: { close: vi.fn() } as never,
        },
        async () => undefined,
      );
      if (scenario !== "pending") {
        const inputHash = computeLegacyDirectInputHash(request, layout);
        await unit.database
          .update(imMessageDeliveries)
          .set({
            state: "accepted",
            dispatchRequestId: fixture.request.requestId,
            dispatchInputHash: inputHash,
            inputHash,
            turnId: "legacy-turn",
            acceptedAt: new Date(),
            reportOwnerInstanceId: fixture.instanceId,
            dispatchPayload: scenario.endsWith("tampered")
              ? { ...request, content: { ...request.content, text: "changed" } }
              : request,
          })
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      }
      const assembler = { assembleForSession: vi.fn() };
      const domain = {
        requestReconcile: vi.fn(async (_computerId: string, _instanceId: string, _request: unknown) => ({
          status: "stopped",
        })),
        requestDelivery: vi.fn(),
      };
      const diagnostic = vi.fn();
      await new ImDeliveryWorker({
        database: unit.database,
        domain: domain as never,
        assembler,
        registry: fixture.registry,
        onDiagnostic: diagnostic,
      }).runOnce();
      expect(assembler.assembleForSession).not.toHaveBeenCalled();
      expect(domain.requestDelivery).not.toHaveBeenCalled();
      if (scenario.includes("accepted")) {
        expect(domain.requestReconcile).toHaveBeenCalledWith(
          fixture.computerId,
          fixture.instanceId,
          expect.objectContaining({ desired: "stopped" }),
          undefined,
          undefined,
          expect.any(AbortSignal),
          { joinSettlement: true },
        );
        expect(domain.requestReconcile.mock.calls[0]?.[2]).not.toHaveProperty("runtime");
      } else {
        expect(domain.requestReconcile).not.toHaveBeenCalled();
      }
      if (scenario.endsWith("tampered"))
        expect(diagnosticCodes(diagnostic)).toContain("IM_DELIVERY_RECOVERY_PAYLOAD_INVALID");
    },
  );

  it.each([
    ["another instance past the report window", "other", true, "ready", true],
    ["another instance answering stopped", "other", true, "stopped", true],
    ["the same instance past the report window", "same", true, "ready", false],
    ["another instance inside the report window", "other", false, "ready", false],
    ["another instance still running the Turn", "other", true, "running", false],
  ] as const)(
    "settles accepted custody that lost its report only for %s",
    async (_label, owner, closed, status, settled) => {
      const fixture = await workerFixture(unit);
      const clock = Date.now();
      await unit.database
        .update(imMessageDeliveries)
        .set({
          state: "accepted",
          inputHash: "frozen-hash",
          turnId: "original-turn",
          reportOwnerInstanceId: owner === "same" ? fixture.instanceId : randomUUID(),
          acceptedAt: new Date(closed ? clock - ACCEPTED_REPORT_WINDOW_MS - 1_000 : clock),
          nextAttemptAt: new Date(clock - 1),
        })
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, { reconcileStatus: status });
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: domain as never,
        assembler: { assembleForSession: vi.fn() },
        registry: fixture.registry,
        now: () => new Date(clock),
      });
      await worker.runOnce();
      const [row] = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      expect(domain.requestReconcile).toHaveBeenCalledOnce();
      expect(row?.reportedAt !== null).toBe(settled);
      if (settled) expect(row?.turnReport).toMatchObject({ outcome: "unknown" });
      worker.stop();
    },
  );

  it.each([
    ["busy", "IM_DELIVERY_RECOVERY_BUSY", false],
    ["running", "IM_DELIVERY_RECOVERY_RUNNING", false],
    ["reporting", "IM_DELIVERY_RECOVERY_REPORTING", false],
    ["recovery_required", "IM_DELIVERY_RECOVERY_REQUIRED", true],
    ["rejected", "IM_DELIVERY_RECOVERY_REJECTED", true],
    ["ready", "IM_DELIVERY_RECOVERY_AWAITING_REPORT", true],
    ["stopped", "IM_DELIVERY_RECOVERY_AWAITING_REPORT", true],
  ] as const)(
    "defers an accepted %s response without releasing or re-executing custody",
    async (status, code, abnormal) => {
      const seeded = await steerFixture(unit);
      const fixture = { ...seeded, deliveryId: seeded.rootDeliveryId };
      let clock = Date.now();
      await unit.database
        .update(imMessageDeliveries)
        .set({
          state: "accepted",
          inputHash: "frozen-hash",
          turnId: "original-turn",
          reportOwnerInstanceId: fixture.instanceId,
          acceptedAt: new Date(clock),
          nextAttemptAt: new Date(clock - 1),
        })
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      await unit.database
        .update(imMessageDeliveries)
        .set({
          state: "steered",
          inputHash: "child-semantic-hash",
          steerTargetDeliveryId: fixture.deliveryId,
          steeredAt: new Date(clock),
          lastErrorCode: "IM_DELIVERY_STEERED",
        })
        .where(eq(imMessageDeliveries.id, seeded.deliveryId));
      const [child] = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, seeded.deliveryId));
      const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, { reconcileStatus: status });
      const diagnostic = vi.fn();
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: domain as never,
        assembler: { assembleForSession: vi.fn() },
        registry: fixture.registry,
        now: () => new Date(clock),
        onDiagnostic: diagnostic,
      });
      for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        const before = domain.requestReconcile.mock.calls.length;
        await worker.runOnce();
        const [row] = await unit.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
        expect(row).toMatchObject({
          state: "accepted",
          turnId: "original-turn",
          inputHash: "frozen-hash",
          reportOwnerInstanceId: fixture.instanceId,
          reportedAt: null,
          resultHash: null,
          lastErrorCode: code,
        });
        expect(row?.nextAttemptAt.getTime()).toBe(clock + delay);
        expect(domain.requestReconcile).toHaveBeenCalledTimes(before + 1);
        await worker.runOnce();
        expect(domain.requestReconcile).toHaveBeenCalledTimes(before + 1);
        // Run maintenance in the gap after backoff expires, before the next claim clears the code.
        clock += delay + 500;
        await runImDeliverySteerRecovery(unit.database, { clock: () => new Date(clock), expiryBatchSize: 10 });
        const [afterJanitor] = await unit.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, seeded.deliveryId));
        expect(afterJanitor).toEqual(child);
      }
      // One ERROR line per failure run, never one per attempt, however long the deferral lasts.
      if (abnormal) expect(diagnostic).toHaveBeenCalledTimes(1);
      else expect(diagnostic).not.toHaveBeenCalled();
      if (abnormal) expect(diagnosticCodes(diagnostic)).toContain(code);
      expect(domain.requestDelivery).not.toHaveBeenCalled();
      expect(domain.requestSteer).not.toHaveBeenCalled();
    },
  );

  it("records one cooperative accepted-recovery timeout and preserves custody", async () => {
    const f = await workerFixture(unit);
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "original-input",
        turnId: "original-turn",
        reportOwnerInstanceId: f.instanceId,
        acceptedAt: new Date(),
        nextAttemptAt: new Date(Date.now() - 1),
      })
      .where(eq(imMessageDeliveries.id, f.deliveryId));
    const diagnostic = vi.fn();
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), f);
    const requestReconcile = vi.fn(async (...args: unknown[]) => {
      const signal = args[5] as AbortSignal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled transport")), { once: true }),
      );
    });
    const worker = new ImDeliveryWorker({
      database: unit.database,
      registry: f.registry,
      domain: { ...domain, requestReconcile } as never,
      assembler: { assembleForSession: vi.fn() },
      operationTimeoutMs: 200,
      claimLeaseMs: 1_000,
      claimRenewMs: 30,
      onDiagnostic: diagnostic,
    });
    try {
      await worker.runOnce();
      const [row] = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, f.deliveryId));
      expect(row).toMatchObject({
        state: "accepted",
        attemptCount: 1,
        inputHash: "original-input",
        turnId: "original-turn",
        reportedAt: null,
        lastErrorCode: "IM_DELIVERY_OPERATION_TIMEOUT",
      });
      expect(diagnosticCodes(diagnostic)).toEqual(["IM_DELIVERY_OPERATION_TIMEOUT"]);
      expect(domain.requestDelivery).not.toHaveBeenCalled();
      expect(domain.requestSteer).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
    }
  });

  it("renews globally queued recovery and drops it without a shutdown saturation failure", async () => {
    const fixtures = [await workerFixture(unit), await workerFixture(unit)];
    for (const [index, f] of fixtures.entries()) {
      await unit.database
        .update(imMessageDeliveries)
        .set({
          state: "accepted",
          inputHash: "original-input",
          turnId: `original-turn-${index}`,
          reportOwnerInstanceId: f.instanceId,
          acceptedAt: new Date(),
          nextAttemptAt: new Date(Date.now() - 1_000 + index),
        })
        .where(eq(imMessageDeliveries.id, f.deliveryId));
    }
    const first = fixtures[0];
    const second = fixtures[1];
    if (!first || !second) throw new Error("missing recovery fixtures");
    const registry = new ConnectionRegistry();
    for (const f of fixtures)
      await registry.register(
        {
          computerId: f.computerId,
          installationId: randomUUID(),
          instanceId: f.instanceId,
          clientVersion: "0.1.1",
          lastHeartbeatAt: Date.now(),
          socket: { close: vi.fn(), terminate: vi.fn() } as never,
        },
        async () => undefined,
      );
    const requestReconcile = vi.fn(async (...args: unknown[]) => {
      const signal = args[5] as AbortSignal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const diagnostic = vi.fn();
    const worker = new ImDeliveryWorker({
      database: unit.database,
      registry,
      domain: { requestReconcile } as never,
      assembler: { assembleForSession: vi.fn() },
      maxConcurrent: 1,
      claimLeaseMs: 1_000,
      claimRenewMs: 30,
      onDiagnostic: diagnostic,
    });
    const runs = [worker.runOnce()];
    try {
      await vi.waitFor(() => expect(requestReconcile).toHaveBeenCalledTimes(1));
      runs.push(worker.runOnce());
      const read = async () => {
        const [row] = await unit.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, second.deliveryId));
        return row;
      };
      await vi.waitFor(async () => expect((await read())?.attemptCount).toBe(1));
      const initial = (await read())?.nextAttemptAt.getTime() ?? 0;
      await vi.waitFor(async () => expect((await read())?.nextAttemptAt.getTime()).toBeGreaterThan(initial));
      await worker.runOnce();
      expect(requestReconcile).toHaveBeenCalledTimes(1);
      await worker.stop();
      await Promise.all(runs);
      expect((await read())?.lastErrorCode).toBeNull();
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
      await Promise.all(runs);
    }
  });

  it.each(["reported", "newer-attempt"] as const)("does not overwrite a %s race after reconcile", async (race) => {
    const fixture = await workerFixture(unit);
    const clock = Date.now();
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "frozen-hash",
        turnId: "original-turn",
        reportOwnerInstanceId: fixture.instanceId,
        acceptedAt: new Date(clock),
        nextAttemptAt: new Date(clock - 1),
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const winningTime = new Date(clock + 60_000);
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, {
      reconcileStatus: "busy",
      onReconcile: async () => {
        await unit.database
          .update(imMessageDeliveries)
          .set({
            ...(race === "reported"
              ? {
                  reportedAt: new Date(clock),
                  resultHash: "settled-hash",
                  turnReport: {
                    type: "turn:report" as const,
                    requestId: randomUUID(),
                    deliveryId: fixture.deliveryId,
                    turnId: "original-turn",
                    sessionId: fixture.sessionId,
                    agentId: fixture.agentId,
                    placementGeneration: 1,
                    outcome: "completed" as const,
                    executionEffects: "completed" as const,
                    resultHash: "settled-hash",
                    traceSummary: { lastSequence: 0, droppedEvents: 0 },
                  },
                }
              : { attemptCount: 2 }),
            lastErrorCode: "winner",
            nextAttemptAt: winningTime,
          })
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      },
    });
    const diagnostic = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn() },
      registry: fixture.registry,
      now: () => new Date(clock),
      onDiagnostic: diagnostic,
    }).runOnce();
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row?.lastErrorCode).toBe("winner");
    expect(row?.nextAttemptAt).toEqual(winningTime);
    if (race === "reported") expect(row?.resultHash).toBe("settled-hash");
    expect(diagnostic).not.toHaveBeenCalled();
    expect(domain.requestDelivery).not.toHaveBeenCalled();
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
    expect(diagnosticCodes(legacyDiagnostic)).not.toContain("IM_DELIVERY_RECOVERY_LEGACY_SNAPSHOT_FALLBACK");
    expect(legacyAssembler).not.toHaveBeenCalled();

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
    expect(diagnosticCodes(invalidDiagnostic)).toContain("IM_DELIVERY_RECOVERY_PAYLOAD_INVALID");

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
    expect(diagnosticCodes(failureDiagnostic)).toContain("IM_DELIVERY_RECOVERY_FAILED");
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
        expect(diagnosticCodes(diagnostic)).toContain(expected);
      }
    }
  });

  it("retains recent history, batches old rows, and protects live-session deliveries", async () => {
    const ended = await workerFixture(unit);
    const live = await workerFixture(unit);
    const old = new Date(Date.now() - 10_000);
    const recent = new Date(Date.now() - 100);
    await unit.database.update(sessions).set({ endedAt: old }).where(eq(sessions.id, ended.sessionId));
    await unit.database.update(imMessages).set({ occurredAt: old }).where(eq(imMessages.id, ended.messageId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ state: "expired", reason: "ttl", expiresAt: old })
      .where(eq(imMessageDeliveries.id, ended.deliveryId));

    const secondMessageId = randomUUID();
    const secondDeliveryId = randomUUID();
    await unit.database.insert(imMessages).values({
      id: secondMessageId,
      imBindingId: ended.bindingId,
      channelId: "channel",
      externalMessageId: `old-${secondMessageId}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "old",
      content: { fallbackText: "old" },
      providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "old" },
      occurredAt: old,
    } as never);
    await unit.database.insert(imMessageDeliveries).values({
      id: secondDeliveryId,
      messageId: secondMessageId,
      sessionId: ended.sessionId,
      attention: "direct",
      state: "expired",
      placementGeneration: 1,
      reason: "ttl",
      expiresAt: old,
    });
    await unit.database.update(imMessages).set({ occurredAt: old }).where(eq(imMessages.id, live.messageId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ state: "expired", reason: "ttl", expiresAt: old })
      .where(eq(imMessageDeliveries.id, live.deliveryId));

    const recentMessageId = randomUUID();
    await unit.database.insert(imMessages).values({
      id: recentMessageId,
      imBindingId: ended.bindingId,
      channelId: "channel",
      externalMessageId: `recent-${recentMessageId}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "recent",
      content: { fallbackText: "recent" },
      providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "recent" },
      occurredAt: recent,
    } as never);

    await unit.database.insert(slackWebhookReceipts).values([
      {
        installationId: ended.slackInstallationId,
        credentialGeneration: 1,
        eventId: `old-${ended.slackInstallationId}`,
        status: "processed",
        receivedAt: old,
        processedAt: old,
      },
      {
        installationId: ended.slackInstallationId,
        credentialGeneration: 1,
        eventId: `recent-${ended.slackInstallationId}`,
        status: "processed",
        receivedAt: recent,
        processedAt: recent,
      },
      {
        installationId: ended.slackInstallationId,
        credentialGeneration: 1,
        eventId: `processing-${ended.slackInstallationId}`,
        status: "processing",
        receivedAt: old,
      },
    ]);
    await unit.database.insert(feishuInboundReceipts).values([
      {
        imBindingId: ended.bindingId,
        credentialGeneration: 1,
        eventId: `old-${ended.bindingId}`,
        status: "failed",
        receivedAt: old,
        lastErrorCode: "test",
        lastErrorAt: old,
      },
      {
        imBindingId: ended.bindingId,
        credentialGeneration: 1,
        eventId: `recent-${ended.bindingId}`,
        status: "processed",
        receivedAt: recent,
        processedAt: recent,
      },
    ]);

    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: {} as never,
      assembler: { assembleForSession: vi.fn() },
      registry: {} as never,
      now: () => new Date(),
      expiryBatchSize: 1,
      retentionBatchSize: 1,
      imMessagesRetentionMs: 1_000,
      imMessageDeliveriesRetentionMs: 1_000,
      slackWebhookReceiptsRetentionMs: 1_000,
      feishuInboundReceiptsRetentionMs: 1_000,
    });

    await worker.runJanitorOnce();
    const firstRemaining = await unit.database
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.sessionId, ended.sessionId));
    expect(firstRemaining).toHaveLength(1);

    await worker.runJanitorOnce();
    const secondRemaining = await unit.database
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.sessionId, ended.sessionId));
    expect(secondRemaining).toHaveLength(0);
    expect(
      await unit.database.select({ id: imMessages.id }).from(imMessages).where(eq(imMessages.id, ended.messageId)),
    ).toHaveLength(0);
    expect(
      await unit.database.select({ id: imMessages.id }).from(imMessages).where(eq(imMessages.id, secondMessageId)),
    ).toHaveLength(0);
    expect(
      await unit.database.select({ id: imMessages.id }).from(imMessages).where(eq(imMessages.id, recentMessageId)),
    ).toHaveLength(1);
    expect(
      await unit.database
        .select({ id: imMessageDeliveries.id })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, live.deliveryId)),
    ).toHaveLength(1);

    const slackRows = await unit.database.select({ eventId: slackWebhookReceipts.eventId }).from(slackWebhookReceipts);
    expect(slackRows.map((row) => row.eventId)).toEqual([
      `recent-${ended.slackInstallationId}`,
      `processing-${ended.slackInstallationId}`,
    ]);
    const feishuRows = await unit.database
      .select({ eventId: feishuInboundReceipts.eventId })
      .from(feishuInboundReceipts);
    expect(feishuRows.map((row) => row.eventId)).toEqual([`recent-${ended.bindingId}`]);
  });

  it("starts and stops its interval without scheduling duplicate runs", async () => {
    const fixture = await workerFixture(unit);
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      intervalMs: 5,
    });
    // Fake timers cover only this synchronous block: the count is global, so an awaited fixture under them
    // would also count a timer set by any other async work still running in this process.
    vi.useFakeTimers();
    try {
      worker.start();
      const started = vi.getTimerCount();
      expect(started).toBeGreaterThan(0);
      worker.start();
      expect(vi.getTimerCount()).toBe(started);
      worker.stop();
      worker.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes expiry and retention timers to their configured cadences", async () => {
    vi.useFakeTimers();
    try {
      const maintenanceExecute = vi.fn().mockResolvedValue([]);
      const feedbackSelect = {
        from: () => feedbackSelect,
        where: () => feedbackSelect,
        limit: () => feedbackSelect,
        for: vi.fn().mockResolvedValue([]),
      };
      const retentionTransaction = { execute: vi.fn().mockResolvedValue([]), select: () => feedbackSelect };
      const database = {
        execute: maintenanceExecute,
        transaction: vi.fn(async (callback: (transaction: typeof retentionTransaction) => Promise<unknown>) =>
          callback(retentionTransaction),
        ),
      };
      const worker = new ImDeliveryWorker({
        database: database as never,
        domain: {} as never,
        assembler: { assembleForSession: vi.fn() },
        registry: {} as never,
        intervalMs: 1_000,
        janitorIntervalMs: 10,
        retentionIntervalMs: 20,
      });
      vi.spyOn(worker, "runOnce").mockResolvedValue(undefined);

      worker.start();
      await vi.advanceTimersByTimeAsync(10);
      // One expiry pass: steer recovery, the overdue-custody sweep, and the bounded TTL expiry.
      expect(maintenanceExecute).toHaveBeenCalledTimes(3);
      expect(database.transaction).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(database.transaction).toHaveBeenCalledTimes(2);
      expect(feedbackSelect.for).toHaveBeenCalledWith("update", { skipLocked: true });
      expect(retentionTransaction.execute).toHaveBeenCalledTimes(5);
      worker.stop();
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

  it("does not let a Cloud follow-up message starve another tenant's claim", async () => {
    const fixture = await workerFixture(unit);
    const cloud = await cloudFollowUpFixture(unit, fixture.userId);
    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const events: string[] = [];
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(custody, fixture, { onEvent: (event) => events.push(event) }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      onDiagnostic: (code) => events.push(code),
    });
    // The Cloud follow-up is the OLDEST claimable row. Before the fix the claim selects it for
    // steering, finds no Local instance for the Cloud Computer, and returns without advancing it,
    // so every tick re-selects the same row and the unrelated Local tenant is never dispatched.
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 120_000) })
      .where(eq(imMessageDeliveries.id, cloud.followUpDeliveryId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));

    for (let tick = 0; tick < 5; tick += 1) await worker.runOnce();

    expect(events).toContain("delivery");
    const [followUp] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, cloud.followUpDeliveryId));
    expect(followUp).toMatchObject({ state: "pending", dispatchRequestId: null });
  });

  it("defers an unsteerable Local follow-up so it cannot block another tenant", async () => {
    const fixture = await workerFixture(unit);
    const stalled = await workerFixture(unit);
    // The stalled follow-up's Computer has a live instance but no steer capability, so the claim
    // selects it for steering and must then defer it instead of re-selecting it every tick.
    await fixture.registry.register(
      {
        clientVersion: "0.1.1",
        computerId: stalled.computerId,
        installationId: randomUUID(),
        instanceId: stalled.instanceId,
        lastHeartbeatAt: Date.now(),
        socket: { close: vi.fn(), terminate: vi.fn() } as never,
      },
      async () => undefined,
    );
    const rootMessageId = randomUUID();
    const rootDeliveryId = randomUUID();
    const now = new Date();
    await unit.database.insert(imMessages).values({
      id: rootMessageId,
      imBindingId: stalled.bindingId,
      channelId: "channel",
      externalMessageId: `stalled-root-${rootMessageId}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "U_HUMAN",
      content: { fallbackText: "root" },
      providerContext: { provider: "slack", teamId: "team", channelId: "channel", messageTs: "root" },
      occurredAt: now,
    } as never);
    await unit.database.insert(imMessageDeliveries).values({
      id: rootDeliveryId,
      messageId: rootMessageId,
      sessionId: stalled.sessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      inputHash: "stalled-root-hash",
      turnId: "turn-stalled",
      reportOwnerInstanceId: stalled.instanceId,
      acceptedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 120_000) })
      .where(eq(imMessageDeliveries.id, stalled.deliveryId));
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));

    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const events: string[] = [];
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(custody, fixture, { onEvent: (event) => events.push(event) }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      onDiagnostic: (code) => events.push(code),
    });
    for (let tick = 0; tick < 5; tick += 1) await worker.runOnce();

    expect(events).toContain("delivery");
    const [stalledFollowUp] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, stalled.deliveryId));
    expect(stalledFollowUp).toMatchObject({
      state: "pending",
      dispatchRequestId: null,
      lastErrorCode: "IM_DELIVERY_STEER_DEFERRED",
    });
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
    expect(delivered?.content.historyTruncated).toBe(false);
    expect(delivered?.content.text).toContain("Content omitted");
    expect(delivered?.content.resources).toHaveLength(16);
  });

  it("copies Slack human authorUserId onto current delivery and history without exposing bot or system IDs", async () => {
    const fixture = await workerFixture(unit);
    await unit.database.update(agents).set({ receiveMode: "mention_only" }).where(eq(agents.id, fixture.agentId));
    const humanHistoryId = randomUUID();
    const botHistoryId = randomUUID();
    const systemHistoryId = randomUUID();
    const botAsHumanHistoryId = randomUUID();
    const botUserId = `bot-${fixture.bindingId}`;
    await unit.database.insert(imMessages).values([
      {
        id: humanHistoryId,
        imBindingId: fixture.bindingId,
        channelId: "channel",
        externalMessageId: "1710000000.000010",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "U_HUMAN",
        content: {
          fallbackText: "human history",
          resources: [
            {
              providerResourceKey: "F_HISTORY",
              kind: "file",
              filename: "history.txt",
              mediaType: "text/plain",
              sizeBytes: 5,
            },
          ],
        },
        providerContext: { provider: "slack", channelType: "channel" },
        occurredAt: new Date(Date.now() - 4_000),
      },
      {
        id: botHistoryId,
        imBindingId: fixture.bindingId,
        channelId: "channel",
        externalMessageId: "1710000000.000011",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "bot",
        authorExternalId: botUserId,
        content: { fallbackText: "bot history" },
        providerContext: { provider: "slack", channelType: "channel" },
        occurredAt: new Date(Date.now() - 3_000),
      },
      {
        id: systemHistoryId,
        imBindingId: fixture.bindingId,
        channelId: "channel",
        externalMessageId: "1710000000.000012",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "system",
        authorExternalId: "system",
        content: { fallbackText: "system history" },
        providerContext: { provider: "slack", channelType: "channel" },
        occurredAt: new Date(Date.now() - 2_000),
      },
      {
        id: botAsHumanHistoryId,
        imBindingId: fixture.bindingId,
        channelId: "channel",
        externalMessageId: "1710000000.000013",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: botUserId,
        content: { fallbackText: "bot marked human" },
        providerContext: { provider: "slack", channelType: "channel" },
        occurredAt: new Date(Date.now() - 1_000),
      },
    ] as never);
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
    expect(delivered?.content.providerRef).toMatchObject({
      provider: "slack",
      authorUserId: "U_FIXTURE",
    });
    const historyById = new Map((delivered?.content.history ?? []).map((item) => [item.imMessageId, item]));
    expect(historyById.get(humanHistoryId)?.providerRef).toMatchObject({ authorUserId: "U_HUMAN" });
    expect(historyById.get(humanHistoryId)?.text).toContain('"file_id":"F_HISTORY"');
    expect(historyById.get(botHistoryId)?.providerRef).not.toHaveProperty("authorUserId");
    expect(historyById.get(systemHistoryId)?.providerRef).not.toHaveProperty("authorUserId");
    expect(historyById.get(botAsHumanHistoryId)?.providerRef).not.toHaveProperty("authorUserId");
  });

  it.each([
    "completed",
    "owner_mismatch",
    "turn_mismatch",
    "session_mismatch",
    "frozen_dispatch",
    "missing_target",
    "failed_report",
  ] as const)("classifies a %s steer target change after claiming without changing fallback", async (change) => {
    const fixture = await steerFixture(unit);
    let clock = Date.now();
    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const domain = fakeDomain(custody, fixture);
    const error = vi.fn();
    const diagnostic = vi.fn(createServerDiagnosticReporter(() => ({ error }) as never));
    const warn = vi.fn();
    const metric = vi.fn();
    const claimed = deferred();
    const resume = deferred();
    const enqueue = KeyedTaskScheduler.prototype.enqueue;
    const queued = vi.spyOn(KeyedTaskScheduler.prototype, "enqueue").mockImplementation(function (
      this: KeyedTaskScheduler,
      key,
      task,
      onDrop,
    ) {
      return enqueue.call(
        this,
        key,
        async () => {
          claimed.resolve();
          await resume.promise;
          await task();
        },
        onDrop,
      );
    });
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      now: () => new Date(clock),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      onDiagnostic: diagnostic,
      onMetric: metric,
    });
    const running = worker.runOnce();
    try {
      await claimed.promise;
      expect(
        await custody.recordTurn(
          completedReport(fixture.rootDeliveryId, "turn-root", fixture.sessionId, fixture.agentId),
          { computerId: fixture.computerId, instanceId: fixture.instanceId } as never,
        ),
      ).toBe("recorded");
      if (change === "owner_mismatch") {
        await unit.database
          .update(imMessageDeliveries)
          .set({ reportOwnerInstanceId: randomUUID() })
          .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      } else if (change === "turn_mismatch") {
        await unit.database
          .update(imMessageDeliveries)
          .set({ turnId: "other-turn" })
          .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      } else if (change === "session_mismatch") {
        const other = await workerFixture(unit);
        await unit.database
          .update(imMessageDeliveries)
          .set({ sessionId: other.sessionId })
          .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      } else if (change === "frozen_dispatch") {
        await unit.database
          .update(imMessageDeliveries)
          .set({ dispatchRequestId: randomUUID(), dispatchInputHash: "frozen-hash", dispatchPayload: fixture.request })
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      } else if (change === "missing_target") {
        await unit.database.delete(imMessageDeliveries).where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      } else if (change === "failed_report") {
        await unit.database
          .update(imMessageDeliveries)
          .set({
            turnReport: {
              ...completedReport(fixture.rootDeliveryId, "turn-root", fixture.sessionId, fixture.agentId),
              outcome: "failed",
            },
          })
          .where(eq(imMessageDeliveries.id, fixture.rootDeliveryId));
      }
    } finally {
      queued.mockRestore();
      resume.resolve();
      await running;
    }
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row).toMatchObject({
      state: "pending",
      attemptCount: 1,
      lastErrorCode: "IM_DELIVERY_STEER_TARGET_ENDED",
      nextAttemptAt: new Date(clock + 2_000),
      turnId: null,
      reportedAt: null,
      resultHash: null,
    });
    expect(row?.dispatchRequestId === null).toBe(change !== "frozen_dispatch");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: fixture.deliveryId,
        code: "IM_DELIVERY_STEER_TARGET_ENDED",
        outcome: "retry",
        retryDelayMs: 2_000,
      }),
      "IM delivery dispatch retry scheduled",
    );
    expect(metric).toHaveBeenCalledWith({ name: "retry", value: 1 });
    expect(domain.requestSteer).not.toHaveBeenCalled();
    expect(domain.requestDelivery).not.toHaveBeenCalled();
    if (change !== "completed") {
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith("IM_DELIVERY_STEER_TARGET_ENDED", {
        phase: "steer",
        deliveryId: fixture.deliveryId,
        agentId: fixture.agentId,
        computerId: fixture.computerId,
        attemptCount: 1,
      });
      expect(error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          code: "IM_DELIVERY_STEER_TARGET_ENDED",
          errorCode: "IM_DELIVERY_STEER_TARGET_ENDED",
          deliveryId: fixture.deliveryId,
          phase: "steer",
          attemptCount: 1,
        }),
        "Server diagnostic",
      );
      return;
    }
    expect(diagnostic).not.toHaveBeenCalled();
    await worker.runOnce();
    expect(domain.requestDelivery).not.toHaveBeenCalled();
    clock += 2_001;
    await worker.runOnce();
    expect(domain.requestDelivery).toHaveBeenCalledTimes(1);
    expect(domain.requestSteer).not.toHaveBeenCalled();
    const [accepted] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(accepted).toMatchObject({ state: "accepted", turnId: "turn-1", attemptCount: 2, reportedAt: null });
    expect(
      await custody.recordTurn(completedReport(fixture.deliveryId, "turn-1", fixture.sessionId, fixture.agentId), {
        computerId: fixture.computerId,
        instanceId: fixture.instanceId,
      } as never),
    ).toBe("recorded");
    expect(diagnostic).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each(["target_ended", "batch_changed"] as const)(
    "records explicit pre-send %s as a bounded deferral",
    async (reason) => {
      const f = reason === "target_ended" ? await steerFixture(unit) : await workerFixture(unit);
      const clock = Date.now();
      const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), f);
      if (reason === "target_ended")
        domain.requestSteer.mockRejectedValueOnce(new RuntimeDispatchDeferredError(reason));
      else domain.requestDelivery.mockRejectedValueOnce(new RuntimeDispatchDeferredError(reason));
      const diagnostic = vi.fn();
      const metric = vi.fn();
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: domain as never,
        registry: f.registry,
        assembler: { assembleForSession: async () => f.runtime },
        now: () => new Date(clock),
        onDiagnostic: diagnostic,
        onMetric: metric,
      });
      try {
        await worker.runOnce();
        const [row] = await unit.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, f.deliveryId));
        expect(row).toMatchObject({
          state: "pending",
          attemptCount: 1,
          dispatchRequestId: null,
          lastErrorCode: reason === "target_ended" ? "IM_DELIVERY_STEER_TARGET_ENDED" : "IM_DELIVERY_BATCH_CHANGED",
          nextAttemptAt: new Date(clock + 2_000),
        });
        expect(diagnostic).not.toHaveBeenCalled();
        expect(metric).toHaveBeenCalledWith({ name: "retry", value: 1 });
      } finally {
        await worker.stop();
      }
    },
  );

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
    const deferred = await steerFixture(unit);
    const deferredEvents: string[] = [];
    const deferredWarn = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), deferred, {
        steerStatus: "rejected",
        steerReason: "turn_finishing",
      }) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: deferred.registry,
      logger: { debug: vi.fn(), info: vi.fn(), warn: deferredWarn, error: vi.fn() },
      onDiagnostic: (code) => deferredEvents.push(code),
    }).runOnce();
    const [deferredRow] = await unit.database
      .select({ lastErrorCode: imMessageDeliveries.lastErrorCode })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deferred.deliveryId));
    expect(deferredRow?.lastErrorCode).toBe("IM_DELIVERY_STEER_DEFERRED");
    expect(deferredWarn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "IM_DELIVERY_STEER_DEFERRED", outcome: "retry" }),
      "IM delivery dispatch retry scheduled",
    );
    expect(deferredEvents).toEqual([]);

    await unit.reset();
    const retry = await steerFixture(unit);
    const retryEvents: string[] = [];
    const retryWarn = vi.fn();
    await new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), retry, { steerStatus: "retry" }) as never,
      assembler: { assembleForSession: vi.fn() },
      registry: retry.registry,
      logger: { debug: vi.fn(), info: vi.fn(), warn: retryWarn, error: vi.fn() },
      onDiagnostic: (code) => retryEvents.push(code),
    }).runOnce();
    const [retryRow] = await unit.database
      .select({ lastErrorCode: imMessageDeliveries.lastErrorCode })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, retry.deliveryId));
    expect(retryRow?.lastErrorCode).toBe("IM_DELIVERY_STEER_STARTING");
    expect(retryWarn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "IM_DELIVERY_STEER_STARTING", outcome: "retry" }),
      "IM delivery dispatch retry scheduled",
    );
    expect(retryEvents).toEqual([]);

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

    for (const [code, abnormal] of [
      ["IM_DELIVERY_CUSTODY_DEFERRED", false],
      ["IM_DELIVERY_INBOUND_PENDING", false],
      ["IM_DELIVERY_STEER_UNKNOWN", true],
    ] as const) {
      await unit.reset();
      const recorded = await steerFixture(unit);
      const diagnostic = vi.fn();
      const warn = vi.fn();
      const metric = vi.fn();
      await recordDeliveryFailure(
        {
          database: unit.database,
          now: () => Date.now(),
          onDiagnostic: diagnostic,
          onMetric: metric,
          logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
          custody: new PostgresRuntimeCustodyStore(unit.database),
          readyRetryClaims: new Set(),
          recheckReady: vi.fn(),
        },
        {
          phase: "steer",
          deliveryId: recorded.deliveryId,
          agentId: recorded.agentId,
          computerId: recorded.computerId,
          attemptCount: 0,
        },
        code,
      );
      const [row] = await unit.database
        .select({ lastErrorCode: imMessageDeliveries.lastErrorCode })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, recorded.deliveryId));
      expect(row?.lastErrorCode).toBe(code);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ code, outcome: "retry" }),
        "IM delivery dispatch retry scheduled",
      );
      expect(metric).toHaveBeenCalledWith({ name: "retry", value: 1 });
      if (abnormal) expect(diagnosticCodes(diagnostic)).toEqual([code]);
      else expect(diagnostic).not.toHaveBeenCalled();
    }
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
        state: imMessageDeliveries.state,
        reason: imMessageDeliveries.reason,
        dispatchRequestId: imMessageDeliveries.dispatchRequestId,
        steerTargetDeliveryId: imMessageDeliveries.steerTargetDeliveryId,
      })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, retired.deliveryId));
    expect(retiredRow).toEqual({
      state: "terminal_rejected",
      reason: "steer_state_unknown",
      dispatchRequestId: steer.requestId,
      steerTargetDeliveryId: steer.rootDeliveryId,
    });

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

    // A Client at its Agent or Client limit: the message is kept and tried again.
    for (const deliveryReason of ["agent_busy", "client_busy"] as const) {
      await unit.reset();
      const full = await workerFixture(unit);
      await new ImDeliveryWorker({
        database: unit.database,
        domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), full, {
          deliveryStatus: "rejected",
          deliveryReason,
        }) as never,
        assembler: { assembleForSession: vi.fn().mockResolvedValue(full.runtime) },
        registry: full.registry,
      }).runOnce();
      const [fullRow] = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, full.deliveryId));
      expect(fullRow).toMatchObject({
        state: "pending",
        reason: null,
        dispatchRequestId: null,
        lastErrorCode: "IM_DELIVERY_RUNTIME_REJECTED",
      });
      expect(fullRow?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    }

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

  it("backs off every failed reconcile exponentially up to the cap, never at a fixed interval", async () => {
    const cases = [
      { reconcileStatus: "rejected", priorAttempts: 0, delayMs: 2_000 },
      { reconcileStatus: "rejected", priorAttempts: 2, delayMs: 8_000 },
      { reconcileStatus: "rejected", priorAttempts: 50, delayMs: 30_000 },
      { reconcileStatus: "busy", priorAttempts: 0, delayMs: 2_000 },
      { reconcileStatus: "busy", priorAttempts: 50, delayMs: 30_000 },
    ] as const;
    for (const { reconcileStatus, priorAttempts, delayMs } of cases) {
      await unit.reset();
      const fixture = await workerFixture(unit);
      await unit.database
        .update(imMessageDeliveries)
        .set({ attemptCount: priorAttempts })
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      const clock = Date.now() + 1_000;
      await new ImDeliveryWorker({
        database: unit.database,
        domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, { reconcileStatus }) as never,
        assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
        registry: fixture.registry,
        now: () => new Date(clock),
      }).runOnce();
      const [row] = await unit.database
        .select({
          attemptCount: imMessageDeliveries.attemptCount,
          nextAttemptAt: imMessageDeliveries.nextAttemptAt,
          state: imMessageDeliveries.state,
        })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      expect(row).toMatchObject({ attemptCount: priorAttempts + 1, state: "pending" });
      expect(row?.nextAttemptAt.getTime()).toBe(clock + delayMs);
    }
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
  it("keeps an explicitly uncertain steer frozen without sending it again while its Root runs", async () => {
    const fixture = await steerFixture(unit);
    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const request: RuntimeImSteerRequest = {
      type: "im:steer",
      requestId: randomUUID(),
      deliveryId: fixture.deliveryId,
      imMessageId: fixture.messageId,
      sessionId: fixture.sessionId,
      agentId: fixture.agentId,
      placementGeneration: 1,
      rootDeliveryId: fixture.rootDeliveryId,
      expectedTurnId: "turn-root",
      attention: "direct",
      content: fixture.request.content,
    };
    const hash = computeRuntimeImSteerInputHash(request);
    expect(
      await custody.beginSteerDispatch(request, hash, {
        computerId: fixture.computerId,
        instanceId: fixture.instanceId,
      }),
    ).toBe("dispatched");
    expect(await custody.releaseSteerDispatch(request, hash, "uncertain")).toBe("released");
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const domain = fakeDomain(custody, fixture);
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      registry: fixture.registry,
      assembler: { assembleForSession: vi.fn() },
    });
    await worker.runOnce();
    expect(domain.requestSteer).not.toHaveBeenCalled();
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row).toMatchObject({
      state: "pending",
      dispatchRequestId: request.requestId,
      dispatchInputHash: hash,
      lastErrorCode: "IM_DELIVERY_STEER_UNKNOWN",
    });
    await worker.stop();
  });

  it.each([
    { count: 35, text: "small input", expectedMinimumRequests: 2 },
    { count: 6, text: "中".repeat(1800), expectedMinimumRequests: 3 },
  ])(
    "delivers $count ordered inputs in bounded batches into one active Turn",
    async ({ count, text, expectedMinimumRequests }) => {
      const fixture = await workerFixture(unit);
      await fixture.registry.register(
        {
          computerId: fixture.computerId,
          installationId: randomUUID(),
          instanceId: fixture.instanceId,
          clientVersion: "0.1.1",
          lastHeartbeatAt: Date.now(),
          socket: { close: vi.fn(), terminate: vi.fn() } as never,
          negotiatedCapabilities: {
            [RUNTIME_CAPABILITY.imDelivery]: 3,
            [RUNTIME_CAPABILITY.imSteer]: 3,
            [RUNTIME_CAPABILITY.sessionReconcile]: 1,
          },
        },
        async () => undefined,
      );
      const [rootMessage] = await unit.database.select().from(imMessages).where(eq(imMessages.id, fixture.messageId));
      const [rootDelivery] = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      if (!rootMessage || !rootDelivery) throw new Error("missing batch fixture");
      await unit.database
        .update(imMessages)
        .set({ content: { version: 1, fallbackText: `${text} 0`, blocks: [], truncated: false, resources: [] } })
        .where(eq(imMessages.id, rootMessage.id));
      const messages = await unit.database
        .insert(imMessages)
        .values(
          Array.from({ length: count - 1 }, (_, index) => ({
            ...rootMessage,
            id: randomUUID(),
            providerEventId: randomUUID(),
            externalMessageId: `batch-${index}`,
            occurredAt: new Date(rootMessage.occurredAt.getTime() + index + 1),
            content: {
              version: 1 as const,
              fallbackText: `${text} ${index + 1}`,
              blocks: [],
              truncated: false,
              resources: [],
            },
          })),
        )
        .returning({ id: imMessages.id });
      const children = await unit.database
        .insert(imMessageDeliveries)
        .values(
          messages.map((message) => ({
            messageId: message.id,
            sessionId: fixture.sessionId,
            attention: "direct" as const,
            placementGeneration: 1,
            expiresAt: rootDelivery.expiresAt,
          })),
        )
        .returning({ id: imMessageDeliveries.id });
      const custody = new PostgresRuntimeCustodyStore(unit.database);
      const domain = fakeDomain(custody, fixture);
      const sent: Array<DirectImMessageDeliveryRequest | RuntimeImSteerRequest> = [];
      domain.requestDelivery.mockImplementation(async (_computer, _instance, request, onDispatched) => {
        const hash = computeDirectInputHash(request);
        expect(
          await custody.beginDeliveryDispatch(request, hash, {
            computerId: fixture.computerId,
            instanceId: fixture.instanceId,
          }),
        ).toBe("dispatched");
        onDispatched?.();
        sent.push(request);
        expect(
          await custody.acceptDelivery(request, hash, "batch-turn", {
            computerId: fixture.computerId,
            installationId: randomUUID(),
            instanceId: fixture.instanceId,
            signal: new AbortController().signal,
          }),
        ).toBe("accepted");
        return {
          type: "im:deliver:result",
          requestId: request.requestId,
          deliveryId: request.deliveryId,
          sessionId: request.sessionId,
          placementGeneration: 1,
          status: "accepted",
          turnId: "batch-turn",
        };
      });
      domain.requestSteer.mockImplementation(async (_computer, _instance, input, onDispatched) => {
        const request = input as RuntimeImSteerRequest;
        const hash = computeRuntimeImSteerInputHash(request);
        expect(
          await custody.beginSteerDispatch(request, hash, {
            computerId: fixture.computerId,
            instanceId: fixture.instanceId,
          }),
        ).toBe("dispatched");
        onDispatched?.();
        sent.push(request);
        expect(
          await custody.recordSteered(request, hash, computeRuntimeImMessageSemanticHash(request), {
            computerId: fixture.computerId,
            installationId: randomUUID(),
            instanceId: fixture.instanceId,
            signal: new AbortController().signal,
          }),
        ).toBe("steered");
        return {
          type: "im:steer:result",
          requestId: request.requestId,
          deliveryId: request.deliveryId,
          sessionId: request.sessionId,
          placementGeneration: 1,
          status: "steered",
        };
      });
      const worker = new ImDeliveryWorker({
        database: unit.database,
        domain: domain as never,
        registry: fixture.registry,
        assembler: { assembleForSession: vi.fn(async () => fixture.runtime) },
      });
      for (let index = 0; index < count; index += 1) await worker.runOnce();
      expect(domain.requestDelivery).toHaveBeenCalledTimes(1);
      for (const call of domain.requestSteer.mock.results)
        await expect(call.value).resolves.toMatchObject({ status: "steered" });
      expect(sent.length).toBeGreaterThanOrEqual(expectedMinimumRequests);
      expect(sent.length).toBeLessThan(count);
      const deliveredIds = sent.flatMap((request) => [
        request.deliveryId,
        ...(request.batch ?? []).map((member) => member.deliveryId),
      ]);
      expect(deliveredIds).toEqual([fixture.deliveryId, ...children.map((row) => row.id)]);
      for (const request of sent) {
        expect(Buffer.byteLength(request.content.text)).toBeLessThanOrEqual(16 * 1024);
        expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(64 * 1024);
        expect((request.batch?.length ?? 0) + 1).toBeLessThanOrEqual(32);
      }
      const rows = await unit.database
        .select()
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.sessionId, fixture.sessionId));
      expect(rows.filter((row) => row.state === "accepted")).toHaveLength(1);
      expect(rows.filter((row) => row.state === "steered")).toHaveLength(count - 1);
      await worker.stop();
    },
  );

  it("retries an always-timing-out delivery a bounded number of times, then settles it once", async ({
    onTestFinished,
  }) => {
    await withDeliveryTimeouts(
      unit,
      onTestFinished,
      "2026-09-01T00:00:00.000Z",
      async ({ fixture, domain, diagnostic, attempt }) => {
        // One more iteration than the cap proves the settled row is never claimed again.
        for (let index = 0; index < 9; index += 1) await attempt();
        const [row] = await unit.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
        expect(row).toMatchObject({
          state: "terminal_rejected",
          reason: "retry_exhausted",
          lastErrorCode: "IM_DELIVERY_TERMINAL",
          dispatchRequestId: null,
        });
        expect(domain.requestDelivery).toHaveBeenCalledTimes(8);
        const codes = diagnosticCodes(diagnostic);
        // One line per failure run plus the single terminal line, however many attempts it took.
        expect(codes.filter((code) => code === "IM_DELIVERY_OPERATION_TIMEOUT")).toHaveLength(1);
        expect(codes.filter((code) => code === "IM_DELIVERY_RETRY_EXHAUSTED")).toHaveLength(1);
        expect(codes.filter((code) => code === "IM_DELIVERY_OPERATION_LATE_SETTLE").length).toBeLessThanOrEqual(8);
        expect(codes).toHaveLength(codes.filter((code) => code.startsWith("IM_DELIVERY_")).length);
      },
    );
  });

  it("parks a correlated timed-out dispatch so a late acceptance can still record its Turn", async () => {
    const fixture = await workerFixture(unit);
    const custody = new PostgresRuntimeCustodyStore(unit.database);
    const clock = Date.now();
    // The input is already at the cap: seven consecutive timeouts with one attempt to go.
    await unit.database
      .update(imMessageDeliveries)
      .set({
        attemptCount: 7,
        lastErrorCode: "IM_DELIVERY_OPERATION_TIMEOUT_7",
        nextAttemptAt: new Date(clock - 1),
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    // A dispatch that reached the Client: the correlation is persisted before the frame leaves, and
    // the Client answers `accepted` only after the deadline and its grace.
    let correlated = false;
    const requestDelivery = vi.fn(
      async (
        _computerId: string,
        _instanceId: string,
        request: DirectImMessageDeliveryRequest,
        onDispatched?: () => void,
      ) => {
        onDispatched?.();
        const hash = computeDirectInputHash(request);
        const dispatch = await custody.beginDeliveryDispatch(request, hash, {
          computerId: fixture.computerId,
          instanceId: fixture.instanceId,
        });
        expect(dispatch).toBe("dispatched");
        correlated = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 1_400));
        await custody.acceptDelivery(request, hash, "turn-late", {
          computerId: fixture.computerId,
          installationId: randomUUID(),
          instanceId: fixture.instanceId,
          signal: new AbortController().signal,
        });
        return {
          type: "im:deliver:result" as const,
          requestId: request.requestId,
          deliveryId: request.deliveryId,
          sessionId: request.sessionId,
          placementGeneration: request.placementGeneration,
          status: "accepted" as const,
          turnId: "turn-late",
        };
      },
    );
    const diagnostic = vi.fn();
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: {
        requestReconcile: vi.fn(
          async (_computerId: string, _instanceId: string, request: unknown, onDispatched?: () => void) => {
            onDispatched?.();
            return {
              type: "session:reconcile:result" as const,
              requestId: (request as { requestId: string }).requestId,
              sessionId: fixture.sessionId,
              placementGeneration: 1,
              status: "ready" as const,
            };
          },
        ),
        requestDelivery,
      } as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      operationTimeoutMs: 40,
      onDiagnostic: diagnostic,
    });

    const running = worker.runOnce();
    await vi.waitFor(() => expect(correlated).toBe(true), { timeout: 2_000, interval: 10 });
    // The deadline passes with a correlated dispatch, so the row is parked rather than rejected: it
    // stays pending with its correlation, the Turn may still execute and report, and a terminal row
    // would make that report unrecordable.
    await running;
    const [inFlight] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(inFlight).toMatchObject({
      state: "pending",
      lastErrorCode: "IM_DELIVERY_PARKED",
      reason: null,
      reportedAt: null,
      turnReport: null,
      resultHash: null,
    });
    expect(inFlight?.dispatchRequestId).not.toBeNull();
    expect(inFlight?.nextAttemptAt).toEqual(inFlight?.expiresAt);
    expect(diagnosticCodes(diagnostic)).not.toContain("IM_DELIVERY_RETRY_EXHAUSTED");
    expect(diagnosticCodes(diagnostic).filter((code) => code === "IM_DELIVERY_DISPATCH_PARKED")).toHaveLength(1);

    // The late acceptance lands after the grace and keeps its custody.
    await vi.waitFor(
      async () => {
        const [row] = await unit.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
        expect(row).toMatchObject({ state: "accepted", turnId: "turn-late" });
      },
      { timeout: 3_000, interval: 25 },
    );
    // The executed Turn can still record its report.
    await expect(
      custody.recordTurn(completedReport(fixture.deliveryId, "turn-late", fixture.sessionId, fixture.agentId), {
        computerId: fixture.computerId,
        installationId: randomUUID(),
        instanceId: fixture.instanceId,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("recorded");
    expect(diagnosticCodes(diagnostic)).not.toContain("IM_DELIVERY_RETRY_EXHAUSTED");
  });

  it("keeps the consecutive-timeout run across a dispatch release and settles on the next timeout", async ({
    onTestFinished,
  }) => {
    await withDeliveryTimeouts(
      unit,
      onTestFinished,
      "2026-09-04T00:00:00.000Z",
      async ({ fixture, diagnostic, attempt }) => {
        const clock = Date.now();
        const hash = computeDirectInputHash(fixture.request);
        // One timed-out dispatch is still frozen, and the run stands at seven.
        await unit.database
          .update(imMessageDeliveries)
          .set({
            attemptCount: 7,
            lastErrorCode: "IM_DELIVERY_OPERATION_TIMEOUT_7",
            dispatchRequestId: fixture.request.requestId,
            dispatchInputHash: hash,
            dispatchPayload: fixture.request,
            nextAttemptAt: new Date(clock - 1),
          })
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
        const readAttempt = async () => {
          await attempt();
          const [row] = await unit.database
            .select()
            .from(imMessageDeliveries)
            .where(eq(imMessageDeliveries.id, fixture.deliveryId));
          return row;
        };

        // The reconcile releases the unusable dispatch, and the release keeps the timeout run.
        expect(await readAttempt()).toMatchObject({
          state: "pending",
          dispatchRequestId: null,
          lastErrorCode: "IM_DELIVERY_OPERATION_TIMEOUT_7",
        });
        // The next attempt spends the eighth budget and settles.
        expect(await readAttempt()).toMatchObject({ state: "terminal_rejected", reason: "retry_exhausted" });
        expect(diagnosticCodes(diagnostic)).toContain("IM_DELIVERY_RETRY_EXHAUSTED");
      },
    );
  });

  it("counts consecutive operation timeouts instead of claims before it settles a delivery", async ({
    onTestFinished,
  }) => {
    await withDeliveryTimeouts(
      unit,
      onTestFinished,
      "2026-09-02T00:00:00.000Z",
      async ({ fixture, domain, diagnostic, attempt }) => {
        // Seven unrelated failures already spent the attempt counter; none of them was a timeout.
        await unit.database
          .update(imMessageDeliveries)
          .set({
            attemptCount: 7,
            lastErrorCode: "IM_DELIVERY_CLOUD_CAPACITY_WAITING",
            nextAttemptAt: new Date(Date.now() - 1),
          })
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
        const readAttempt = async () => {
          await attempt();
          const [row] = await unit.database
            .select({ state: imMessageDeliveries.state, code: imMessageDeliveries.lastErrorCode })
            .from(imMessageDeliveries)
            .where(eq(imMessageDeliveries.id, fixture.deliveryId));
          return row;
        };

        // The first timeout of this delivery is not the eighth consecutive timeout.
        expect(await readAttempt()).toMatchObject({
          state: "pending",
          code: "IM_DELIVERY_OPERATION_TIMEOUT",
        });
        // The streak is durable and keeps counting, and the diagnostic stays canonical.
        expect(await readAttempt()).toMatchObject({
          state: "pending",
          code: "IM_DELIVERY_OPERATION_TIMEOUT_2",
        });
        for (let rest = 0; rest < 4; rest += 1) await readAttempt();
        expect(await readAttempt()).toMatchObject({
          state: "pending",
          code: "IM_DELIVERY_OPERATION_TIMEOUT_7",
        });
        expect(await readAttempt()).toMatchObject({
          state: "terminal_rejected",
        });
        const [settled] = await unit.database
          .select()
          .from(imMessageDeliveries)
          .where(eq(imMessageDeliveries.id, fixture.deliveryId));
        expect(settled).toMatchObject({
          state: "terminal_rejected",
          reason: "retry_exhausted",
          lastErrorCode: "IM_DELIVERY_TERMINAL",
        });
        expect(domain.requestDelivery).toHaveBeenCalledTimes(8);
        expect(diagnosticCodes(diagnostic).filter((code) => code === "IM_DELIVERY_OPERATION_TIMEOUT")).toHaveLength(1);
        expect(diagnosticCodes(diagnostic).filter((code) => code === "IM_DELIVERY_RETRY_EXHAUSTED")).toHaveLength(1);
      },
    );
  });

  it("backs off a permanently absent runtime and settles the owed Turn when no report can be truthful", async () => {
    const fixture = await workerFixture(unit);
    const clock = Date.now();
    await unit.database
      .update(computers)
      .set({ currentInstanceId: null, lastSeenAt: new Date(clock - 3 * 60 * 60_000) })
      .where(eq(computers.id, fixture.computerId));
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "frozen-hash",
        turnId: "turn-offline",
        reportOwnerInstanceId: fixture.instanceId,
        acceptedAt: new Date(clock),
        nextAttemptAt: new Date(clock - 1),
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture);
    const diagnostic = vi.fn();
    let now = clock;
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: new ConnectionRegistry(),
      now: () => new Date(now),
      onDiagnostic: diagnostic,
    });
    const delays: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await worker.runOnce();
      const [row] = await unit.database
        .select({ nextAttemptAt: imMessageDeliveries.nextAttemptAt, lastErrorCode: imMessageDeliveries.lastErrorCode })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      expect(row?.lastErrorCode).toBe("IM_DELIVERY_RUNTIME_UNAVAILABLE");
      delays.push((row?.nextAttemptAt.getTime() ?? 0) - now);
      now = row?.nextAttemptAt.getTime() ?? now;
    }
    // The rate falls with the silence instead of holding a fixed interval.
    expect(delays).toEqual([...delays].sort((left, right) => left - right));
    expect(delays[0]).toBeLessThan(delays.at(-1) as number);
    expect(domain.requestReconcile).not.toHaveBeenCalled();
    // AC3: the recovery-path diagnostic names the delivery, Agent, Computer, attempt, and phase.
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith("IM_DELIVERY_RUNTIME_UNAVAILABLE", {
      phase: "recover",
      deliveryId: fixture.deliveryId,
      agentId: fixture.agentId,
      computerId: fixture.computerId,
      attemptCount: 1,
    });

    // Past the report-acceptance cutoff the owed custody settles once as unknown, never replayed.
    now = clock + 25 * 60 * 60_000;
    await unit.database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(now - 1) })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    await worker.runOnce();
    const [settled] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(settled).toMatchObject({ state: "accepted", lastErrorCode: null });
    expect(settled?.reportedAt).not.toBeNull();
    const report = settled?.turnReport as TurnReportRequest;
    expect(report).toMatchObject({
      outcome: "unknown",
      executionEffects: "may_have_occurred",
      errorReason: "turn_state_unknown",
      turnId: "turn-offline",
    });
    expect(diagnosticCodes(diagnostic)).toContain("IM_DELIVERY_TURN_STATE_UNKNOWN");
    now += 25 * 60 * 60_000;
    await worker.runOnce();
    expect(diagnosticCodes(diagnostic).filter((code) => code === "IM_DELIVERY_TURN_STATE_UNKNOWN")).toHaveLength(1);
    expect(domain.requestReconcile).not.toHaveBeenCalled();
  });

  it("reconciles a live report owner even after the report-acceptance cutoff", async () => {
    const fixture = await workerFixture(unit);
    const clock = Date.now();
    // Past `accepted_at + platform maximum runtime + grace`, but the owner is live and current.
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "frozen-hash",
        turnId: "turn-live",
        reportOwnerInstanceId: fixture.instanceId,
        acceptedAt: new Date(clock - 25 * 60 * 60_000 - 1),
        nextAttemptAt: new Date(clock - 1),
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, { reconcileStatus: "busy" });
    const diagnostic = vi.fn();
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      now: () => new Date(clock),
      onDiagnostic: diagnostic,
    });

    await worker.runOnce();

    expect(domain.requestReconcile).toHaveBeenCalledTimes(1);
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row).toMatchObject({
      state: "accepted",
      reportedAt: null,
      lastErrorCode: "IM_DELIVERY_RECOVERY_BUSY",
    });
    expect(diagnosticCodes(diagnostic)).not.toContain("IM_DELIVERY_TURN_STATE_UNKNOWN");
  });

  it("settles an absent report owner that is past the cutoff", async () => {
    const fixture = await workerFixture(unit);
    const clock = Date.now();
    await unit.database
      .update(computers)
      .set({ currentInstanceId: null, lastSeenAt: new Date(clock - 60_000) })
      .where(eq(computers.id, fixture.computerId));
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "frozen-hash",
        turnId: "turn-absent",
        reportOwnerInstanceId: fixture.instanceId,
        acceptedAt: new Date(clock - 25 * 60 * 60_000 - 1),
        nextAttemptAt: new Date(clock - 1),
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture);
    const diagnostic = vi.fn();
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: new ConnectionRegistry(),
      now: () => new Date(clock),
      onDiagnostic: diagnostic,
    });

    await worker.runOnce();

    expect(domain.requestReconcile).not.toHaveBeenCalled();
    const [row] = await unit.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row?.reportedAt).not.toBeNull();
    expect(row?.turnReport as TurnReportRequest).toMatchObject({
      outcome: "unknown",
      executionEffects: "may_have_occurred",
      errorReason: "turn_state_unknown",
    });
    expect(diagnosticCodes(diagnostic)).toEqual(["IM_DELIVERY_TURN_STATE_UNKNOWN"]);
  });

  it("makes offline-parked retries due again when the placement Computer registers", async () => {
    const fixture = await workerFixture(unit);
    const clock = Date.now();
    const park = async (nextAttemptAt: Date) => {
      await unit.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt, lastErrorCode: "IM_DELIVERY_RUNTIME_UNAVAILABLE" })
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    };
    const readDue = async () => {
      const [row] = await unit.database
        .select({ nextAttemptAt: imMessageDeliveries.nextAttemptAt })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, fixture.deliveryId));
      return row?.nextAttemptAt.getTime() ?? 0;
    };
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture);
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      now: () => new Date(clock),
    });

    await park(new Date(clock + 20 * 60_000));
    await worker.notifyComputerReady(fixture.computerId);
    expect(await readDue()).toBeLessThanOrEqual(clock + 1_000);
    await worker.runOnce();
    expect(domain.requestDelivery).toHaveBeenCalledTimes(1);

    // A row that the schedule already retried soon stays parked: a reconnecting client cannot
    // turn the offline backoff into a hot retry.
    await park(new Date(clock + 30_000));
    await worker.notifyComputerReady(fixture.computerId);
    expect(await readDue()).toBe(clock + 30_000);
  });

  it("makes an expired dispatch that still fences its Agent due again when the Computer registers", async () => {
    const fixture = await workerFixture(unit);
    const clock = Date.now();
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "expired",
        reason: "ttl",
        expiresAt: new Date(clock - 1_000),
        dispatchRequestId: randomUUID(),
        dispatchInputHash: "frozen-hash",
        dispatchPayload: { frozen: true } as never,
        nextAttemptAt: new Date(clock + 30 * 60_000),
        lastErrorCode: "IM_DELIVERY_RUNTIME_UNAVAILABLE",
      })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      now: () => new Date(clock),
    });
    await worker.notifyComputerReady(fixture.computerId);
    const [row] = await unit.database
      .select({ nextAttemptAt: imMessageDeliveries.nextAttemptAt })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row?.nextAttemptAt.getTime()).toBeLessThanOrEqual(clock + 1_000);
  });

  it("leaves an expired delivery with no dispatch alone when the Computer registers", async () => {
    const fixture = await workerFixture(unit);
    const clock = Date.now();
    const parked = new Date(clock + 30 * 60_000);
    await unit.database
      .update(imMessageDeliveries)
      .set({ state: "expired", reason: "ttl", expiresAt: new Date(clock - 1_000), nextAttemptAt: parked })
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    const worker = new ImDeliveryWorker({
      database: unit.database,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      now: () => new Date(clock),
    });
    await worker.notifyComputerReady(fixture.computerId);
    const [row] = await unit.database
      .select({ nextAttemptAt: imMessageDeliveries.nextAttemptAt })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, fixture.deliveryId));
    expect(row?.nextAttemptAt).toEqual(parked);
  });

  it("populates delivery row performance context for subsequent DB and runtime operations across deliver, steer, and recover", async () => {
    const records: Record<string, unknown>[] = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          debug: (payload: Record<string, unknown>) => records.push(payload),
          info: (payload: Record<string, unknown>) => records.push(payload),
          warn: (payload: Record<string, unknown>) => records.push(payload),
        }) as never,
    );
    const db = wrapDbWithPerformanceLogger(unit.database, perfLogger);

    const deliverFixture = await workerFixture(unit);
    await unit.database.update(agents).set({ status: "active" }).where(eq(agents.id, deliverFixture.agentId));
    const deliverWorker = new ImDeliveryWorker({
      database: db,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), deliverFixture, {
        reconcileStatus: "running",
      }) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(deliverFixture.runtime) },
      registry: deliverFixture.registry,
    });
    await perfLogger.traceAsync({ module: "im-delivery", category: "worker", operation: "test.deliver" }, () =>
      deliverWorker.runOnce(),
    );
    const firstDeliverPostRead = records.find(
      (r) => r.operation === "db.update" && r.outcome === "completed" && r.deliveryId === deliverFixture.deliveryId,
    );
    expect(firstDeliverPostRead).toMatchObject({
      accountId: deliverFixture.userId,
      agentId: deliverFixture.agentId,
      computerId: deliverFixture.computerId,
      sessionId: deliverFixture.sessionId,
      deliveryId: deliverFixture.deliveryId,
    });

    records.length = 0;
    const clock = Date.now();
    await unit.database
      .update(imMessageDeliveries)
      .set({
        state: "accepted",
        inputHash: "frozen-hash",
        turnId: "turn-recover",
        reportOwnerInstanceId: deliverFixture.instanceId,
        acceptedAt: new Date(clock),
        nextAttemptAt: new Date(clock - 1),
      })
      .where(eq(imMessageDeliveries.id, deliverFixture.deliveryId));
    await perfLogger.traceAsync({ module: "im-delivery", category: "worker", operation: "test.recover" }, () =>
      deliverWorker.runOnce(),
    );
    const firstRecoverPostRead = records.find(
      (r) => r.operation === "db.update" && r.outcome === "completed" && r.deliveryId === deliverFixture.deliveryId,
    );
    expect(firstRecoverPostRead).toMatchObject({
      accountId: deliverFixture.userId,
      agentId: deliverFixture.agentId,
      computerId: deliverFixture.computerId,
      sessionId: deliverFixture.sessionId,
      deliveryId: deliverFixture.deliveryId,
      turnId: "turn-recover",
    });

    await unit.reset();
    records.length = 0;
    const steer = await steerFixture(unit);
    const steerWorker = new ImDeliveryWorker({
      database: db,
      domain: fakeDomain(new PostgresRuntimeCustodyStore(unit.database), steer) as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(steer.runtime) },
      registry: steer.registry,
    });
    await perfLogger.traceAsync({ module: "im-delivery", category: "worker", operation: "test.steer" }, () =>
      steerWorker.runOnce(),
    );
    const steerSelects = records.filter(
      (r) => r.operation === "db.select" && r.outcome === "completed" && r.deliveryId === steer.deliveryId,
    );
    expect(steerSelects[1]).toMatchObject({
      accountId: steer.userId,
      agentId: steer.agentId,
      computerId: steer.computerId,
      sessionId: steer.sessionId,
      deliveryId: steer.deliveryId,
      turnId: "turn-root",
    });
  });
});

function wrapDbWithPerformanceLogger(
  database: UnitDatabase["database"],
  perfLogger: PerformanceLogger,
): UnitDatabase["database"] {
  const wrapBuilder = <T extends object>(builder: T, operation: string): T =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === "then") {
          const thenFn = Reflect.get(target, prop, receiver);
          if (typeof thenFn !== "function") return thenFn;
          return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            perfLogger
              .traceAsync(
                { module: "db", category: "db", operation },
                () => new Promise((resolve, reject) => thenFn.call(target, resolve, reject)),
              )
              .then(onFulfilled, onRejected);
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const next = value.apply(target, args);
          return next && typeof next === "object" ? wrapBuilder(next, operation) : next;
        };
      },
    });
  return new Proxy(database, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === "select" || prop === "update") && typeof value === "function") {
        return (...args: unknown[]) => wrapBuilder(value.apply(target, args), `db.${String(prop)}`);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

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
    authorExternalId: "U_FIXTURE",
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
    contextTrees: [],
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
      clientVersion: "0.1.1",
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
    messageId,
    registry,
    request,
    runtime,
    sessionId,
    slackInstallationId,
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
      clientVersion: "0.1.1",
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

/** A Cloud agent with an accepted unreported turn plus a pending follow-up in the same Session. */
async function cloudFollowUpFixture(unit: UnitDatabase, userId: string) {
  const now = new Date();
  const computerId = randomUUID();
  const agentId = randomUUID();
  const bindingId = randomUUID();
  const sessionId = randomUUID();
  const rootMessageId = randomUUID();
  const rootDeliveryId = randomUUID();
  const followUpMessageId = randomUUID();
  const followUpDeliveryId = randomUUID();
  await unit.database.insert(computers).values({
    id: computerId,
    ownerAccountId: userId,
    kind: "cloud",
    currentInstallationId: randomUUID(),
    displayName: "Cloud",
    platform: "linux",
    arch: "x64",
    clientVersion: "test",
  });
  await unit.database.insert(agents).values({
    id: agentId,
    createdByUserId: userId,
    computerId,
    name: `cloud-agent-${agentId}`,
    displayName: "Cloud Agent",
    runtimeProvider: "pi",
  });
  await unit.database.insert(imBindings).values({
    id: bindingId,
    agentId,
    provider: "feishu",
    status: "active",
    externalAppId: `cloud-app-${bindingId}`,
    externalBotId: "bot",
    credentialSchemaVersion: 1,
    credentialGeneration: 1,
    encryptedCredential: "encrypted",
    activatedAt: now,
  });
  await unit.database.insert(sessions).values({
    id: sessionId,
    imBindingId: bindingId,
    channelId: "cloud-channel",
    conversationKind: "channel",
    kind: "channel",
  });
  await unit.database.insert(sessionPlacements).values({ sessionId, computerId, generation: 1 });
  await unit.database.insert(imMessages).values([
    {
      id: rootMessageId,
      imBindingId: bindingId,
      channelId: "cloud-channel",
      externalMessageId: `root-${rootMessageId}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "U_HUMAN",
      content: { fallbackText: "root" },
      providerContext: { provider: "feishu" as const, channelType: "channel" as const },
      occurredAt: now,
    },
    {
      id: followUpMessageId,
      imBindingId: bindingId,
      channelId: "cloud-channel",
      externalMessageId: `follow-${followUpMessageId}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "U_HUMAN",
      content: { fallbackText: "follow-up" },
      providerContext: { provider: "feishu" as const, channelType: "channel" as const },
      occurredAt: now,
    },
  ] as never);
  await unit.database.insert(imMessageDeliveries).values([
    {
      id: rootDeliveryId,
      messageId: rootMessageId,
      sessionId,
      attention: "direct",
      state: "accepted",
      placementGeneration: 1,
      inputHash: "root-hash",
      turnId: "turn-cloud",
      reportOwnerInstanceId: randomUUID(),
      acceptedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    },
    {
      id: followUpDeliveryId,
      messageId: followUpMessageId,
      sessionId,
      attention: "direct",
      placementGeneration: 1,
      expiresAt: new Date(now.getTime() + 60_000),
    },
  ]);
  return { agentId, computerId, sessionId, rootDeliveryId, followUpDeliveryId };
}

async function settleTimedOutDelivery(
  operation: Promise<void>,
  deliveryStarted: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  await Promise.race([deliveryStarted, operation]);
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void operation.then(markSettled, markSettled);
  while (!settled && !signal.aborted) {
    await nextEventLoop();
    if (!settled && !signal.aborted) await vi.advanceTimersByTimeAsync(100);
  }
  await operation;
}

async function withDeliveryTimeouts(
  unit: UnitDatabase,
  onTestFinished: TestContext["onTestFinished"],
  now: string,
  test: (context: {
    fixture: Awaited<ReturnType<typeof workerFixture>>;
    domain: ReturnType<typeof fakeDomain>;
    diagnostic: ReturnType<typeof vi.fn>;
    attempt: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  vi.useFakeTimers({ now: new Date(now) });
  const cleanup = new AbortController();
  let worker: ImDeliveryWorker | undefined;
  const body = (async () => {
    const fixture = await workerFixture(unit);
    cleanup.signal.throwIfAborted();
    const diagnostic = vi.fn();
    let deliveryStarted = deferred();
    const domain = fakeDomain(new PostgresRuntimeCustodyStore(unit.database), fixture, {
      onDelivery: () => deliveryStarted.resolve(),
      deliveryHangUntil: cleanup.signal,
    });
    const activeWorker = new ImDeliveryWorker({
      database: unit.database,
      domain: domain as never,
      assembler: { assembleForSession: vi.fn().mockResolvedValue(fixture.runtime) },
      registry: fixture.registry,
      operationTimeoutMs: 100,
      onDiagnostic: diagnostic,
    });
    worker = activeWorker;
    await test({
      fixture,
      domain,
      diagnostic,
      attempt: async () => {
        cleanup.signal.throwIfAborted();
        await settleTimedOutDelivery(activeWorker.runOnce(), deliveryStarted.promise, cleanup.signal);
        cleanup.signal.throwIfAborted();
        deliveryStarted = deferred();
        vi.setSystemTime(Date.now() + 31_000);
      },
    });
  })();
  const finished = body.finally(async () => {
    cleanup.abort();
    await worker?.stop();
  });
  onTestFinished(async () => {
    cleanup.abort();
    try {
      await Promise.allSettled([finished]);
      expect(vi.isFakeTimers()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  await finished;
}

function fakeDomain(
  custody: PostgresRuntimeCustodyStore,
  fixture: Awaited<ReturnType<typeof workerFixture>>,
  options: {
    deliveryStatus?: string;
    deliveryReason?: string;
    reconcileFailure?: boolean;
    reconcileStatus?: SessionReconcileResult["status"];
    deliveryFailure?: boolean;
    onReconcile?: () => Promise<void>;
    steerStatus?: string;
    steerReason?: string;
    steerFailure?: boolean;
    deliveryHangUntil?: AbortSignal;
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
        const hang = options.deliveryHangUntil;
        if (hang) {
          await new Promise<void>((_resolve, reject) => {
            if (hang.aborted) reject(hang.reason);
            else hang.addEventListener("abort", () => reject(hang.reason), { once: true });
          });
        }
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

/** The diagnostic codes a reporter emitted, so a context assertion cannot hide a missing or extra code. */
function diagnosticCodes(reporter: { mock: { calls: unknown[][] } }): string[] {
  return reporter.mock.calls.map(([code]) => code as string);
}

/** A completed Turn Report for one delivery, hashed the way the Server checks it. */
function completedReport(deliveryId: string, turnId: string, sessionId: string, agentId: string): TurnReportRequest {
  const body = {
    deliveryId,
    turnId,
    sessionId,
    agentId,
    placementGeneration: 1,
    outcome: "completed" as const,
    executionEffects: "completed" as const,
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
  };
  return { type: "turn:report", requestId: randomUUID(), ...body, resultHash: computeTurnResultHash(body) };
}
