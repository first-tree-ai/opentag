import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_RETRY_POLICY,
  durableFailureFromUnknown,
  FileRuntimeDurabilityStore,
  MemoryRuntimeDurabilityStore,
  RuntimeDurabilityFailure,
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

  it("persists records on disk and ignores malformed or foreign entries", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-durability-"));
    try {
      const store = new FileRuntimeDurabilityStore(home);
      const record = {
        acceptedAt: 1,
        attempts: 0,
        key: "turn-1",
        kind: "turn-report" as const,
        payload: { value: "opaque" },
        status: "accepted" as const,
        updatedAt: 1,
      };
      await store.write(record);
      await store.write({ ...record, status: "running" });
      const path = resolve(home, "data/runtime/durability/turn-report.json");
      await writeFile(
        path,
        JSON.stringify([
          record,
          null,
          "invalid",
          { ...record, kind: "session-message" },
          { ...record, payload: "invalid" },
        ]),
      );
      await expect(store.list("turn-report")).resolves.toMatchObject([{ key: "turn-1", status: "accepted" }]);
      await writeFile(path, JSON.stringify({ invalid: true }));
      await expect(store.list("turn-report")).rejects.toThrow(
        "Runtime storage contains data that does not match its schema",
      );
      await writeFile(path, "{ invalid");
      await expect(store.list("turn-report")).rejects.toThrow("Runtime storage contains invalid JSON");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("exposes structured durable failures", () => {
    const failure = new RuntimeDurabilityFailure({
      category: "unavailable",
      code: "transport_unavailable",
      message: "socket closed",
      phase: "transport",
      requestId: "request-1",
      retryability: "backoff",
    });
    expect(failure).toMatchObject({
      category: "unavailable",
      code: "transport_unavailable",
      phase: "transport",
      requestId: "request-1",
      retryability: "backoff",
    });
    expect(failure.message).toBe("socket closed");
  });

  it("normalizes legacy and malformed failures into the shared taxonomy", () => {
    const nested = {
      category: "dependency" as const,
      code: "upstream_timeout",
      message: "upstream failed",
      phase: "provider" as const,
      retryability: "backoff" as const,
    };
    const rich = new RuntimeDurabilityFailure({
      category: "unavailable",
      code: "transport_closed",
      message: "socket closed",
      phase: "transport",
      retryability: "backoff",
      cause: nested,
    });
    expect(rich.requestId).toBe("unknown");
    expect(durableFailureFromUnknown("request-1", "request", rich, "fallback_code")).toMatchObject({
      category: "unavailable",
      code: "transport_closed",
      phase: "transport",
      retryability: "backoff",
      requestId: "request-1",
      cause: nested,
    });

    const aliases = [
      ["credential", "authentication"],
      ["confirmation", "request"],
      ["persist", "persistence"],
      ["prompt", "provider"],
      ["runtime", "transport"],
      ["server", "transport"],
      ["unrecognized", "unknown"],
    ] as const;
    for (const [phase, expectedPhase] of aliases) {
      expect(durableFailureFromUnknown("", phase, { message: "" }, "fallback_code")).toMatchObject({
        phase: expectedPhase,
        requestId: "unknown",
        message: "Runtime operation failed",
      });
    }

    const retryabilityCases = [
      ["immediate", "immediate"],
      ["terminal", "never"],
      ["invalid", "backoff"],
    ] as const;
    for (const [retryability, expectedRetryability] of retryabilityCases) {
      expect(
        durableFailureFromUnknown("request-2", "request", { retryability, message: "failed" }, "fallback_code"),
      ).toMatchObject({ retryability: expectedRetryability });
    }

    const categoryCases = [
      ["validation", "validation", "request"],
      ["credential", "auth", "request"],
      ["provider", "dependency", "request"],
      ["server", "dependency", "request"],
      ["transport", "unavailable", "request"],
      ["runtime", "unavailable", "request"],
      ["invalid", "internal", "validation"],
      ["invalid", "auth", "authentication"],
      ["invalid", "dependency", "provider"],
      ["invalid", "unavailable", "transport"],
      ["invalid", "dependency", "persistence"],
      ["invalid", "internal", "request"],
    ] as const;
    for (const [category, expectedCategory, phase] of categoryCases) {
      expect(
        durableFailureFromUnknown("request-3", phase, { category, message: "failed" }, "fallback_code"),
      ).toMatchObject({ category: expectedCategory });
    }

    expect(
      durableFailureFromUnknown(
        "request-4",
        "request",
        {
          structuredError: {
            category: "auth",
            code: "auth_failed",
            message: "safe diagnostic message",
            phase: "authentication",
            requestId: "nested-request",
            retryability: "after_auth",
          },
        },
        "fallback_code",
      ),
    ).toMatchObject({ category: "auth", code: "auth_failed", requestId: "nested-request" });
    expect(durableFailureFromUnknown("request-5", "request", "plain failure", "fallback_code")).toMatchObject({
      message: "Runtime operation failed",
      code: "fallback_code",
    });
    expect(
      durableFailureFromUnknown("request-error", "request", new Error("error message"), "fallback_code"),
    ).toMatchObject({
      message: "error message",
      code: "fallback_code",
    });
    const errorWithoutMessage = new Error("unused");
    Object.defineProperty(errorWithoutMessage, "message", { value: undefined });
    expect(durableFailureFromUnknown("request-error-2", "request", errorWithoutMessage, "fallback_code")).toMatchObject(
      {
        message: "Runtime operation failed",
        code: "fallback_code",
      },
    );
    expect(
      durableFailureFromUnknown(
        "request-6",
        "request",
        { cause: { invalid: true }, message: "failed" },
        "fallback_code",
      ),
    ).toMatchObject({ code: "fallback_code", category: "internal", phase: "unknown" });
  });
});
