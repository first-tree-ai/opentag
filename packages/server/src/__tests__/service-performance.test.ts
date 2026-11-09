import { HTTP_PATHS } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  createInstrumentedFetch,
  createPerformanceLogger,
  getCurrentPerformanceLogger,
  instrumentServerWorkers,
  instrumentService,
} from "../observability/index.js";
import { RuntimeApprovalOwner } from "../runtime/runtime-approval-owner.js";
import { createChannelTargetPoller } from "../services/channel-target/poller.js";
import { runTrustedProcess } from "../services/github-proxy/git-process.js";
import { ScheduleScheduler } from "../services/schedules/scheduler.js";

class PrivateFieldService {
  readonly #secretPrefix = "agent";
  readonly #fetch: typeof fetch;

  constructor(fetchImpl: typeof fetch) {
    this.#fetch = fetchImpl;
  }

  async resolveAgent(input: { accountId: string; agentId: string }): Promise<string> {
    const res = await this.#fetch("https://api.example.com/v1/check?token=do-not-log");
    await res.text();
    return `${this.#secretPrefix}:${input.accountId}:${input.agentId}`;
  }

  async list(input: { accountId: string }): Promise<string[]> {
    return [`${this.#secretPrefix}:${input.accountId}`];
  }

  async get(input: { accountId: string }): Promise<string> {
    return `${this.#secretPrefix}:${input.accountId}`;
  }

  currentInstanceId(): string {
    return "ignored-sync-reader";
  }
}

describe("service and HTTP performance instrumentation", () => {
  it("preserves private class fields, instruments list/get and workers, skips excluded sync readers, and orders start/end logs across layers", async () => {
    const records: Array<Record<string, unknown>> = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          debug: (payload: Record<string, unknown>) => records.push(payload),
          info: (payload: Record<string, unknown>) => records.push(payload),
          warn: (payload: Record<string, unknown>) => records.push(payload),
        }) as never,
    );
    const disabledPerf = createPerformanceLogger(() => undefined, { enabled: false });
    const rawInstance = new PrivateFieldService(vi.fn());
    expect(instrumentService(rawInstance, { serviceName: "PrivateFieldService", perfLogger: disabledPerf })).toBe(
      rawInstance,
    );

    const instrumentedFetch = createInstrumentedFetch(perfLogger, {
      provider: "example",
      baseFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    });
    const service = instrumentService(new PrivateFieldService(instrumentedFetch), {
      serviceName: "PrivateFieldService",
      perfLogger,
    });

    // Excluded sync reader does not emit performance logs
    expect(service.currentInstanceId()).toBe("ignored-sync-reader");
    expect(records).toHaveLength(0);

    const value = await service.resolveAgent({ accountId: "acc-1", agentId: "agent-9" });
    expect(value).toBe("agent:acc-1:agent-9");
    expect(await service.list({ accountId: "acc-1" })).toEqual(["agent:acc-1"]);
    expect(await service.get({ accountId: "acc-1" })).toBe("agent:acc-1");

    const worker = {
      runOnce: vi.fn(async () => "tick-ok"),
    };
    instrumentServerWorkers([["ImDeliveryWorker", worker]], perfLogger);
    expect(await worker.runOnce()).toBe("tick-ok");

    expect(records.map((r) => [r.perfCategory, r.operation, r.outcome])).toEqual([
      ["service", "PrivateFieldService.resolveAgent", "started"],
      ["external", "external.example.http", "started"],
      ["external", "external.example.http", "completed"],
      ["service", "PrivateFieldService.resolveAgent", "completed"],
      ["service", "PrivateFieldService.list", "started"],
      ["service", "PrivateFieldService.list", "completed"],
      ["service", "PrivateFieldService.get", "started"],
      ["service", "PrivateFieldService.get", "completed"],
      ["worker", "ImDeliveryWorker.runOnce", "started"],
      ["worker", "ImDeliveryWorker.runOnce", "completed"],
    ]);

    expect(records[1]).toMatchObject({
      parentCallId: records[0]?.callId,
      callerOperation: "PrivateFieldService.resolveAgent",
      accountId: "acc-1",
      agentId: "agent-9",
    });
  });

  it("correlates HTTP route, instrumented service, and requestId end-to-end while silencing probes and WebSocket upgrades", async () => {
    const chunks: string[] = [];
    const authService = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({
        me: {
          user: {
            id: "00000000-0000-4000-8000-000000000001",
            email: "u@example.com",
            displayName: "Demo User",
          },
          setupCompletedAt: null,
        },
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    };
    const app = createApp({
      authService: authService as never,
      loggerLevel: "debug",
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });

    try {
      await app.inject({ method: "GET", url: "/healthz" });
      await app.inject({ method: "GET", url: "/readyz" });
      await app.inject({
        method: "GET",
        url: HTTP_PATHS.sandboxRunnerWebSocket,
        headers: { upgrade: "websocket" },
      });

      const preUpgradePerfRecords = chunks
        .flatMap((c) => c.trim().split("\n"))
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => typeof line.perfCategory === "string");
      expect(preUpgradePerfRecords).toEqual([]);
      chunks.length = 0;

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: {
          authorization: "Bearer valid-access-token",
          "x-request-id": "req-e2e-1",
        },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    const perfRecords = chunks
      .flatMap((c) => c.trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => typeof line.perfCategory === "string");

    const httpStart = perfRecords.find((r) => r.perfCategory === "http" && r.outcome === "started");
    const httpEnd = perfRecords.find((r) => r.perfCategory === "http" && r.outcome === "completed");
    const authStart = perfRecords.find(
      (r) => r.operation === "AuthService.getAuthenticatedUser" && r.outcome === "started",
    );
    const authEnd = perfRecords.find(
      (r) => r.operation === "AuthService.getAuthenticatedUser" && r.outcome === "completed",
    );

    expect(httpStart).toMatchObject({
      perfCategory: "http",
      requestId: "req-e2e-1",
      outcome: "started",
    });
    expect(httpEnd).toMatchObject({
      callId: httpStart?.callId,
      startedAt: httpStart?.startedAt,
      requestId: "req-e2e-1",
      status: 200,
      outcome: "completed",
    });
    expect(authStart).toMatchObject({
      parentCallId: httpStart?.callId,
      requestId: "req-e2e-1",
    });
    expect(authEnd).toMatchObject({
      callId: authStart?.callId,
      startedAt: authStart?.startedAt,
      requestId: "req-e2e-1",
      outcome: "completed",
    });
  });

  it("isolates context across sequential keep-alive HTTP requests over a live listener", async () => {
    const chunks: string[] = [];
    const authService = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({
        me: {
          user: {
            id: "00000000-0000-4000-8000-000000000001",
            email: "u@example.com",
            displayName: "Demo User",
          },
          setupCompletedAt: null,
        },
        tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    };
    const app = createApp({
      authService: authService as never,
      loggerLevel: "debug",
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      for (const reqId of ["req-keepalive-1", "req-keepalive-2", "req-keepalive-3"]) {
        const res = await fetch(`${address}/api/v1/me`, {
          headers: {
            authorization: "Bearer valid-access-token",
            "x-request-id": reqId,
          },
        });
        expect(res.status).toBe(200);
        await res.json();
        const health = await fetch(`${address}/healthz`);
        expect(health.status).toBe(200);
        await health.json();
      }
    } finally {
      await app.close();
    }

    const perfRecords = chunks
      .flatMap((c) => c.trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => typeof line.perfCategory === "string");

    const httpStarts = perfRecords.filter((r) => r.perfCategory === "http" && r.outcome === "started");
    expect(httpStarts).toHaveLength(3);
    for (const start of httpStarts) {
      expect(start.parentCallId).toBeUndefined();
      expect(start.callerOperation).toBeUndefined();
    }
    expect(httpStarts.map((s) => s.requestId)).toEqual(["req-keepalive-1", "req-keepalive-2", "req-keepalive-3"]);
  });

  it("extracts sandboxId and environmentGeneration from nested scope/allocation objects and traces git subprocesses via getCurrentPerformanceLogger", async () => {
    const records: Array<Record<string, unknown>> = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          debug: (payload: Record<string, unknown>) => records.push(payload),
          info: (payload: Record<string, unknown>) => records.push(payload),
          warn: (payload: Record<string, unknown>) => records.push(payload),
        }) as never,
    );

    class SandboxTestService {
      async handleNestedScope(_input: {
        scope: { sandboxId: string; sessionId: string; environmentGeneration: number };
      }): Promise<number> {
        expect(getCurrentPerformanceLogger()).toBe(perfLogger);
        const res = await runTrustedProcess("git", ["version"], {
          cwd: process.cwd(),
          environment: { PATH: process.env.PATH ?? "" },
          signal: new AbortController().signal,
        });
        return res.code;
      }

      hasActiveCapacityLease(): boolean {
        return true;
      }
    }

    const service = instrumentService(new SandboxTestService(), {
      serviceName: "SandboxTestService",
      perfLogger,
    });

    expect(service.hasActiveCapacityLease()).toBe(true);
    expect(records).toHaveLength(0);

    const code = await service.handleNestedScope({
      scope: {
        sandboxId: "sbx-123",
        sessionId: "ses-456",
        environmentGeneration: 7,
      },
    });
    expect(code).toBe(0);

    expect(records.map((r) => [r.perfCategory, r.operation, r.outcome])).toEqual([
      ["service", "SandboxTestService.handleNestedScope", "started"],
      ["service", "subprocess.git.version", "started"],
      ["service", "subprocess.git.version", "completed"],
      ["service", "SandboxTestService.handleNestedScope", "completed"],
    ]);

    expect(records[0]).toMatchObject({
      sandboxId: "sbx-123",
      sessionId: "ses-456",
      environmentGeneration: 7,
    });
    expect(records[2]).toMatchObject({
      module: "git-subprocess",
      operation: "subprocess.git.version",
      parentCallId: records[0]?.callId,
      callerOperation: "SandboxTestService.handleNestedScope",
      sandboxId: "sbx-123",
      sessionId: "ses-456",
      environmentGeneration: 7,
      statusCode: 0,
    });
  });

  it("propagates callerOperation and parentCallId from periodic background worker spans even after service proxying", async () => {
    const records: Array<Record<string, unknown>> = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          debug: (payload: Record<string, unknown>) => records.push(payload),
          info: (payload: Record<string, unknown>) => records.push(payload),
          warn: (payload: Record<string, unknown>) => records.push(payload),
        }) as never,
    );

    const traceNestedDbQuery = async (dbTarget: string) => {
      await perfLogger.traceAsync(
        {
          module: "database",
          category: "db",
          operation: "db.query",
          attributes: { sqlCommand: "SELECT", dbTarget },
        },
        async () => [],
      );
    };

    const scheduleScheduler = new ScheduleScheduler({
      database: {} as never,
      dispatch: { dispatchScheduledMessage: vi.fn() },
      sessions: { resolveScheduledMessageRoute: vi.fn() },
      publicUrl: "https://app.opentag.build",
      listDue: async () => {
        await traceNestedDbQuery("agent_schedules");
        return [];
      },
    });

    const approvalOwner = new RuntimeApprovalOwner({
      store: {
        find: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        deliver: vi.fn(),
        list: async () => {
          await traceNestedDbQuery("runtime_approvals");
          return [];
        },
        invalidateExpired: vi.fn(async () => undefined),
        purge: vi.fn(async () => undefined),
      },
      registry: { isCurrentConnection: vi.fn(() => false), send: vi.fn() },
      serverInstanceId: "srv-1",
      authority: vi.fn(),
      messenger: { post: vi.fn(), finish: vi.fn() },
      onError: vi.fn(),
    });

    const feishuConnections = {
      maintain: async () => {
        await traceNestedDbQuery("im_bindings");
      },
    };
    const feishuSetupService = {
      maintainHeartbeat: async () => {
        await traceNestedDbQuery("im_bindings");
      },
      maintainSweep: async () => {
        await traceNestedDbQuery("im_bindings");
      },
    };
    const cloudModelService = {
      reconcile: async () => {
        await traceNestedDbQuery("billing.attempts");
      },
    };
    const imDeliveryWorker = {
      runExpiryOnce: async () => {
        await traceNestedDbQuery("im_message_deliveries");
      },
      runRetentionOnce: async () => {
        await traceNestedDbQuery("im_messages");
      },
    };
    const channelTargetPoller = createChannelTargetPoller({
      channel: "staging",
      downloadBaseUrl: "https://dl.opentag.build/releases",
      intervalMs: 60_000,
      fetchImpl: createInstrumentedFetch(perfLogger, {
        provider: "channel-target",
        baseFetch: vi.fn(
          async () => new Response(JSON.stringify({ channel: "staging", version: "0.1.0-staging.1" }), { status: 200 }),
        ),
      }),
    });

    // Proxying a service first must not prevent instrumentServerWorkers from wrapping its worker methods
    instrumentService(approvalOwner, { serviceName: "RuntimeApprovalOwner", perfLogger });
    instrumentService(feishuSetupService, { serviceName: "FeishuSetupService", perfLogger });
    instrumentService(cloudModelService, { serviceName: "CloudModelService", perfLogger });

    instrumentServerWorkers(
      [
        ["ScheduleScheduler", scheduleScheduler],
        ["RuntimeApprovalOwner", approvalOwner],
        ["FeishuConnectionManager", feishuConnections],
        ["FeishuSetupService", feishuSetupService],
        ["CloudModelService", cloudModelService],
        ["ImDeliveryWorker", imDeliveryWorker],
        ["ChannelTargetPoller", channelTargetPoller],
      ],
      perfLogger,
    );

    await scheduleScheduler.scanNow();
    await approvalOwner.poll();
    await feishuConnections.maintain();
    await feishuSetupService.maintainHeartbeat();
    await feishuSetupService.maintainSweep();
    await cloudModelService.reconcile();
    await imDeliveryWorker.runExpiryOnce();
    await imDeliveryWorker.runRetentionOnce();
    channelTargetPoller.start();
    channelTargetPoller.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const childStarts = records.filter(
      (r) => (r.perfCategory === "db" || r.perfCategory === "external") && r.outcome === "started",
    );
    expect(childStarts.map((r) => [r.callerOperation, r.dbTarget ?? r.provider])).toEqual([
      ["ScheduleScheduler.runOnce", "agent_schedules"],
      ["RuntimeApprovalOwner.poll", "runtime_approvals"],
      ["FeishuConnectionManager.maintain", "im_bindings"],
      ["FeishuSetupService.maintainHeartbeat", "im_bindings"],
      ["FeishuSetupService.maintainSweep", "im_bindings"],
      ["CloudModelService.reconcile", "billing.attempts"],
      ["ImDeliveryWorker.runExpiryOnce", "im_message_deliveries"],
      ["ImDeliveryWorker.runRetentionOnce", "im_messages"],
      ["ChannelTargetPoller.refresh", "channel-target"],
    ]);
    for (const child of childStarts) {
      expect(typeof child.parentCallId).toBe("string");
    }
  });
});
