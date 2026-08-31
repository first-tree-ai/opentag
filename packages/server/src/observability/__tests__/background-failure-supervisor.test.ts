import { describe, expect, it, vi } from "vitest";
import { BackgroundFailureSupervisor } from "../background-failure-supervisor.js";

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
});
