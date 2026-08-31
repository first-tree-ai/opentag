import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_FAILURE_COUNTER_NAME,
  BackgroundFailureSupervisor,
  createBackgroundFailureSupervisor,
} from "../background-failure-supervisor.js";

describe("BackgroundFailureSupervisor", () => {
  it("emits one redacted event and counter while preserving an awaited failure", async () => {
    const events: unknown[] = [];
    const counters: unknown[] = [];
    const logs: unknown[] = [];
    const supervisor = new BackgroundFailureSupervisor({
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      onEvent: (event) => events.push(event),
      onCounter: (name, labels) => counters.push({ name, labels }),
      logger: (payload) => logs.push(payload),
    });
    const cause = new Error("provider returned Authorization: Bearer upstream-secret");

    await expect(
      supervisor.supervise(
        async () => {
          throw new Error("request body password=body-secret");
        },
        {
          code: "WORKER_PROVIDER_FAILED",
          category: "unavailable",
          retryability: "backoff",
          phase: "worker",
          requestId: "request-1",
          cause,
        },
      ),
    ).rejects.toThrow("request body password=body-secret");

    expect(events).toHaveLength(1);
    expect(counters).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("body-secret");
    expect(JSON.stringify(events)).not.toContain("upstream-secret");
    expect(JSON.stringify(logs)).not.toContain("body-secret");
    expect(JSON.stringify(logs)).not.toContain("upstream-secret");
    expect(events[0]).toMatchObject({
      type: "diagnostic.error",
      error: {
        code: "WORKER_PROVIDER_FAILED",
        category: "unavailable",
        retryability: "backoff",
        phase: "worker",
        requestId: "request-1",
        cause: { message: expect.stringContaining("[REDACTED]") },
      },
    });
    expect(counters[0]).toMatchObject({ name: "opentag.background_failures.total", labels: { phase: "worker" } });
  });

  it("tracks detached promises, captures synchronous failures, and does not leak observer failures", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("observer-token=must-not-escape");
    });
    const onCounter = vi.fn(() => {
      throw new Error("counter-secret");
    });
    const logger = vi.fn(() => {
      throw new Error("logger-password=secret");
    });
    const supervisor = new BackgroundFailureSupervisor({ onEvent, onCounter, logger });

    expect(() =>
      supervisor.track(
        () => {
          throw new Error("detached Authorization: Bearer detached-secret");
        },
        { phase: "scheduler" },
      ),
    ).not.toThrow();
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onCounter).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("detached-secret");
  });

  it("classifies promise values, primitive throws, metadata, and bounded causes", async () => {
    const events: unknown[] = [];
    const supervisor = createBackgroundFailureSupervisor({
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      onEvent: (event) => events.push(event),
    });
    const cause: Record<string, unknown> = {
      code: "UPSTREAM_TIMEOUT",
      category: "timeout",
      retryability: "backoff",
      phase: "transport",
      message: "upstream password=hidden",
    };
    let current: Error = Object.assign(new Error(cause.message), cause);
    for (let index = 0; index < 10; index += 1) current = new Error("nested", { cause: current });

    await expect(
      supervisor.supervise(Promise.reject("request body password=primitive-secret"), {
        operation: "provider-call",
        requestId: "r".repeat(300),
        cause: current,
      }),
    ).rejects.toBe("request body password=primitive-secret");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      error: {
        code: "BACKGROUND_FAILURE",
        category: "internal",
        retryability: "never",
        phase: "unknown",
        requestId: `${"r".repeat(242)}...[TRUNCATED]`,
        message: "request body password=[REDACTED]",
        cause: { message: "nested" },
      },
    });

    const objectFailure: Record<string, unknown> = {
      code: "OBJECT_FAILURE",
      category: "unavailable",
      retryability: "after_auth",
      phase: "provider",
      message: "provider failed",
      cause: { category: "not-a-category", message: "invalid metadata" },
    };
    await expect(supervisor.supervise(Promise.reject(objectFailure))).rejects.toBe(objectFailure);
    expect(events[1]).toMatchObject({
      error: {
        code: "OBJECT_FAILURE",
        category: "internal",
        retryability: "never",
        phase: "unknown",
        cause: { message: '{"category":"not-a-category","message":"invalid metadata"}' },
      },
    });
  });

  it("uses safe fallback diagnostics when classification or timestamp observation fails", async () => {
    const events: unknown[] = [];
    const supervisor = new BackgroundFailureSupervisor({
      now: () => {
        throw new Error("clock unavailable");
      },
      onEvent: (event) => events.push(event),
    });

    await expect(
      supervisor.supervise(
        () => {
          throw new Error("classification failure");
        },
        { category: "invalid-category" as never },
      ),
    ).rejects.toThrow("classification failure");

    expect(events[0]).toMatchObject({
      type: "diagnostic.error",
      error: {
        code: "BACKGROUND_FAILURE",
        category: "internal",
        retryability: "never",
        phase: "unknown",
        message: "Background failure could not be classified",
      },
    });
  });

  it("uses the invalid-date fallback and exposes the stable counter name", async () => {
    const events: unknown[] = [];
    const supervisor = new BackgroundFailureSupervisor({
      now: () => new Date("invalid"),
      onEvent: (event) => events.push(event),
    });
    const failure = new Error("invalid timestamp");

    await expect(supervisor.supervise(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(events[0]).toMatchObject({ type: "diagnostic.error", error: { message: "invalid timestamp" } });
    expect((events[0] as { occurredAt: string }).occurredAt).toMatch(/Z$/u);
    expect(BACKGROUND_FAILURE_COUNTER_NAME).toBe("opentag.background_failures.total");
  });
});
