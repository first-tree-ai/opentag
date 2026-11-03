import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import {
  createPerformanceLogger,
  getCurrentPerformanceContext,
  runWithPerformanceContext,
  safePerformanceErrorCode,
  updateCurrentPerformanceContext,
} from "../performance-logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("performance logger", () => {
  it("emits paired started and completed logs with callId, startedAt, endedAt, and durationMs", async () => {
    const records: Array<{ level: string; payload: Record<string, unknown>; message: string }> = [];
    const fakeLogger = {
      isLevelEnabled: () => true,
      debug: (payload: Record<string, unknown>, message: string) => records.push({ level: "debug", payload, message }),
      info: (payload: Record<string, unknown>, message: string) => records.push({ level: "info", payload, message }),
      warn: (payload: Record<string, unknown>, message: string) => records.push({ level: "warn", payload, message }),
      error: (payload: Record<string, unknown>, message: string) => records.push({ level: "error", payload, message }),
    };

    const perf = createPerformanceLogger(() => fakeLogger as never, {
      enabled: true,
      level: "info",
      slowThresholdMs: 500,
    });

    const result = await perf.traceAsync(
      {
        module: "agent-service",
        category: "service",
        operation: "AgentService.listAgents",
        requestId: "req-123",
        accountId: "acc-1",
      },
      async () => "ok",
      {
        resultAttributes: (value) => ({ summary: value }),
      },
    );

    expect(result).toBe("ok");
    expect(records).toHaveLength(2);
    const [started, completed] = records;
    expect(started?.level).toBe("info");
    expect(started?.message).toBe("Service operation started");
    expect(started?.payload).toMatchObject({
      module: "agent-service",
      perfCategory: "service",
      operation: "AgentService.listAgents",
      requestId: "req-123",
      accountId: "acc-1",
      outcome: "started",
    });
    expect(typeof started?.payload.callId).toBe("string");
    expect(typeof started?.payload.startedAt).toBe("string");

    expect(completed?.level).toBe("info");
    expect(completed?.message).toBe("Service operation completed");
    expect(completed?.payload).toMatchObject({
      module: "agent-service",
      perfCategory: "service",
      operation: "AgentService.listAgents",
      callId: started?.payload.callId,
      requestId: "req-123",
      accountId: "acc-1",
      startedAt: started?.payload.startedAt,
      outcome: "completed",
      summary: "ok",
    });
    expect(typeof completed?.payload.endedAt).toBe("string");
    expect(completed?.payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates parentCallId, callerOperation, and requestId across nested async operations and concurrent branches", async () => {
    const records: Array<{ payload: Record<string, unknown> }> = [];
    const fakeLogger = {
      isLevelEnabled: () => true,
      debug: (payload: Record<string, unknown>) => records.push({ payload }),
      info: (payload: Record<string, unknown>) => records.push({ payload }),
      warn: (payload: Record<string, unknown>) => records.push({ payload }),
    };
    const perf = createPerformanceLogger(() => fakeLogger as never);

    await perf.traceAsync(
      {
        module: "http",
        category: "http",
        operation: "GET /api/v1/agents",
        requestId: "req-root",
      },
      async (httpHandle) => {
        updateCurrentPerformanceContext({ accountId: "acc-root" });
        expect(getCurrentPerformanceContext()?.callId).toBe(httpHandle.callId);

        await perf.traceAsync(
          {
            module: "AgentService",
            category: "service",
            operation: "AgentService.listAgents",
          },
          async (serviceHandle) => {
            await Promise.all([
              perf.traceAsync(
                {
                  module: "database",
                  category: "db",
                  operation: "db.query",
                  attributes: { sqlCommand: "SELECT", dbTarget: "agents" },
                },
                async () => {
                  expect(getCurrentPerformanceContext()?.operation).toBe("db.query");
                  return 1;
                },
              ),
              perf.traceAsync(
                {
                  module: "external",
                  category: "external",
                  operation: "external.slack.auth.test",
                  attributes: { provider: "slack" },
                },
                async () => {
                  expect(getCurrentPerformanceContext()?.operation).toBe("external.slack.auth.test");
                  return 2;
                },
              ),
            ]);
            expect(getCurrentPerformanceContext()?.callId).toBe(serviceHandle.callId);
          },
        );
      },
    );

    const startedRecords = records.filter((r) => r.payload.outcome === "started");
    expect(startedRecords).toHaveLength(4);
    const httpStart = startedRecords.find((r) => r.payload.operation === "GET /api/v1/agents")?.payload;
    const serviceStart = startedRecords.find((r) => r.payload.operation === "AgentService.listAgents")?.payload;
    const dbStart = startedRecords.find((r) => r.payload.operation === "db.query")?.payload;
    const externalStart = startedRecords.find((r) => r.payload.operation === "external.slack.auth.test")?.payload;

    expect(serviceStart).toMatchObject({
      parentCallId: httpStart?.callId,
      callerOperation: "GET /api/v1/agents",
      requestId: "req-root",
      accountId: "acc-root",
    });
    expect(dbStart).toMatchObject({
      parentCallId: serviceStart?.callId,
      callerOperation: "AgentService.listAgents",
      requestId: "req-root",
      accountId: "acc-root",
    });
    expect(externalStart).toMatchObject({
      parentCallId: serviceStart?.callId,
      callerOperation: "AgentService.listAgents",
      requestId: "req-root",
      accountId: "acc-root",
    });
    expect(dbStart?.callId).not.toBe(externalStart?.callId);
  });

  it("marks slow completions with slow=true at the configured routine level without escalating to warn", async () => {
    const records: Array<{ level: string; payload: Record<string, unknown> }> = [];
    const fakeLogger = {
      isLevelEnabled: () => true,
      debug: (payload: Record<string, unknown>) => records.push({ level: "debug", payload }),
      info: (payload: Record<string, unknown>) => records.push({ level: "info", payload }),
      warn: (payload: Record<string, unknown>) => records.push({ level: "warn", payload }),
    };

    let nowMs = 100;
    vi.spyOn(performance, "now").mockImplementation(() => {
      const value = nowMs;
      nowMs += 250;
      return value;
    });

    const perf = createPerformanceLogger(() => fakeLogger as never, {
      enabled: true,
      level: "debug",
      slowThresholdMs: 200,
    });

    await perf.traceAsync(
      {
        module: "database",
        category: "db",
        operation: "db.query",
      },
      async () => "done",
    );

    expect(records).toHaveLength(2);
    expect(records[0]?.level).toBe("debug");
    expect(records[1]?.level).toBe("debug");
    expect(records[1]?.payload).toMatchObject({
      outcome: "completed",
      slow: true,
      durationMs: 250,
    });
  });

  it("records failed outcome at warn level with validated errorCode and never leaks credential-shaped codes", async () => {
    const chunks: string[] = [];
    const app = createApp({
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
      performanceLogging: { enabled: false },
    });
    try {
      const perf = createPerformanceLogger(() => app.log, {
        enabled: true,
        level: "info",
        slowThresholdMs: 1_000,
      });

      const structuredFailure = Object.assign(new Error("Authorization: Bearer secret-value"), {
        code: "AGENT_NOT_FOUND",
      });
      await expect(
        perf.traceAsync(
          {
            module: "AgentService",
            category: "service",
            operation: "AgentService.getAgent",
          },
          async () => {
            throw structuredFailure;
          },
        ),
      ).rejects.toBe(structuredFailure);

      const secretCodeFailure = Object.assign(new Error("failed"), {
        code: "token:secret-credential-value",
      });
      expect(safePerformanceErrorCode(secretCodeFailure, "FALLBACK_ERROR")).toBe("FALLBACK_ERROR");
    } finally {
      await app.close();
    }

    const lines = chunks
      .flatMap((c) => c.trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failedRecord = lines.find((line) => line.outcome === "failed");
    expect(failedRecord).toMatchObject({
      module: "AgentService",
      operation: "AgentService.getAgent",
      outcome: "failed",
      code: "AGENT_NOT_FOUND",
      errorCode: "AGENT_NOT_FOUND",
    });
    expect(JSON.stringify(lines)).not.toContain("secret-value");
  });

  it("suppresses emission and skips AsyncLocalStorage allocation when disabled", () => {
    const debug = vi.fn();
    const perf = createPerformanceLogger(() => ({ debug }) as never, { enabled: false });
    const result = perf.traceOperation(
      {
        module: "service",
        category: "service",
        operation: "noop",
      },
      (handle) => {
        expect(handle.callId).toBe("");
        expect(getCurrentPerformanceContext()).toBeUndefined();
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(debug).not.toHaveBeenCalled();

    updateCurrentPerformanceContext({ requestId: "ignored" });
    expect(
      runWithPerformanceContext({ callId: "c-1", operation: "manual" }, () => getCurrentPerformanceContext()?.callId),
    ).toBe("c-1");
  });
});
