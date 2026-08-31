import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_RETRY_POLICY,
  MemoryRuntimeDurabilityStore,
  RuntimeDurabilityMetrics,
  retryDelay,
  retryExhausted,
} from "../runtime/runtime-durability.js";

describe("runtime durability primitives", () => {
  it("keeps retry delay exponential and bounded by age and attempts", () => {
    expect(retryDelay({ ...DEFAULT_RUNTIME_RETRY_POLICY, baseDelayMs: 10, maxDelayMs: 25 }, 1)).toBe(10);
    expect(retryDelay({ ...DEFAULT_RUNTIME_RETRY_POLICY, baseDelayMs: 10, maxDelayMs: 25 }, 4)).toBe(25);
    expect(
      retryExhausted(
        { ...DEFAULT_RUNTIME_RETRY_POLICY, maxAttempts: 3, maxAgeMs: 100 },
        { attempts: 2, acceptedAt: 1_000 },
        1_099,
      ),
    ).toBe(false);
    expect(
      retryExhausted(
        { ...DEFAULT_RUNTIME_RETRY_POLICY, maxAttempts: 3, maxAgeMs: 100 },
        { attempts: 3, acceptedAt: 1_000 },
        1_001,
      ),
    ).toBe(true);
    expect(
      retryExhausted(
        { ...DEFAULT_RUNTIME_RETRY_POLICY, maxAttempts: 3, maxAgeMs: 100 },
        { attempts: 1, acceptedAt: 1_000 },
        1_100,
      ),
    ).toBe(true);
  });

  it("exposes transition, retry, and dead-letter counters", () => {
    const metrics = new RuntimeDurabilityMetrics();
    metrics.transition("session-message", undefined, "accepted");
    metrics.transition("session-message", "accepted", "running");
    metrics.transition("session-message", "running", "retryable");
    metrics.transition("session-message", "retryable", "dead-letter");
    expect(metrics.snapshot()).toEqual({
      deadLetters: 1,
      retries: 1,
      transitions: {
        "session-message:new->accepted": 1,
        "session-message:accepted->running": 1,
        "session-message:running->retryable": 1,
        "session-message:retryable->dead-letter": 1,
      },
    });
  });

  it("stores immutable records in the memory persistence seam", async () => {
    const store = new MemoryRuntimeDurabilityStore();
    await store.write({
      acceptedAt: 1,
      attempts: 0,
      key: "turn-1",
      kind: "turn-report",
      payload: { value: "opaque" },
      status: "accepted",
      updatedAt: 1,
    });
    await expect(store.list("turn-report")).resolves.toMatchObject([{ key: "turn-1", status: "accepted" }]);
  });
});
