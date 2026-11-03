import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { createInstrumentedFetch, createPerformanceLogger, instrumentService } from "../observability/index.js";

class PrivateFieldService {
  readonly #secretPrefix = "agent";
  readonly #fetch: typeof fetch;

  constructor(fetchImpl: typeof fetch) {
    this.#fetch = fetchImpl;
  }

  async resolveAgent(input: { accountId: string; agentId: string }): Promise<string> {
    await this.#fetch("https://api.example.com/v1/check?token=do-not-log");
    return `${this.#secretPrefix}:${input.accountId}:${input.agentId}`;
  }

  currentInstanceId(): string {
    return "ignored-sync-reader";
  }
}

describe("service and HTTP performance instrumentation", () => {
  it("preserves private class fields, skips excluded sync readers, and orders start/end logs across layers", async () => {
    const records: Array<Record<string, unknown>> = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          info: (payload: Record<string, unknown>) => records.push(payload),
          warn: (payload: Record<string, unknown>) => records.push(payload),
        }) as never,
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

    expect(records.map((r) => [r.perfCategory, r.operation, r.outcome])).toEqual([
      ["service", "PrivateFieldService.resolveAgent", "started"],
      ["external", "external.example.http", "started"],
      ["external", "external.example.http", "completed"],
      ["service", "PrivateFieldService.resolveAgent", "completed"],
    ]);

    expect(records[1]).toMatchObject({
      parentCallId: records[0]?.callId,
      callerOperation: "PrivateFieldService.resolveAgent",
      accountId: "acc-1",
      agentId: "agent-9",
    });
  });

  it("correlates HTTP route, instrumented service, and requestId end-to-end while silencing probes", async () => {
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
      loggerStream: { write: (chunk) => chunks.push(String(chunk)) },
    });

    try {
      await app.inject({ method: "GET", url: "/healthz" });
      await app.inject({ method: "GET", url: "/readyz" });
      expect(chunks).toEqual([]);

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
});
