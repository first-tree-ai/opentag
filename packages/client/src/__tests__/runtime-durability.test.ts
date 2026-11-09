import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_RETRY_POLICY,
  type DurableFileQuarantine,
  DurableFileQuarantinedError,
  durableFailureFromUnknown,
  FileRuntimeDurabilityStore,
  MemoryRuntimeDurabilityStore,
  RuntimeDurabilityFailure,
  RuntimeDurabilityMetrics,
  retryDelay,
  retryExhausted,
} from "../runtime/runtime-durability.js";
import { RuntimeStorageError } from "../storage/durable-file.js";

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
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("moves an unreadable file aside, reports the loss, and keeps working for that kind", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-durability-"));
    try {
      const quarantines: DurableFileQuarantine[] = [];
      let now = 100;
      const store = new FileRuntimeDurabilityStore(home, {
        now: () => now,
        onQuarantine: (quarantine) => quarantines.push(quarantine),
      });
      const record = {
        acceptedAt: 1,
        attempts: 0,
        key: "message-1",
        kind: "session-message" as const,
        payload: { value: "opaque" },
        status: "accepted" as const,
        updatedAt: 1,
      };
      await store.write(record);
      const directory = resolve(home, "data/runtime/durability");
      const path = resolve(directory, "session-message.json");

      await writeFile(path, "[{ truncated");
      await expect(store.list("session-message")).resolves.toEqual([]);
      expect(quarantines).toMatchObject([
        { kind: "session-message", quarantinedPath: `${path}.corrupt-100`, lostRecords: 0 },
      ]);
      expect(quarantines[0]?.error.message).toBe("Runtime storage contains invalid JSON");
      await expect(readFile(`${path}.corrupt-100`, "utf8")).resolves.toBe("[{ truncated");
      await expect(store.list("session-message")).resolves.toEqual([]);
      expect(quarantines).toHaveLength(1);

      // A schema mismatch found by a write is moved aside too, and the write still lands.
      now = 200;
      await writeFile(path, JSON.stringify({ invalid: true }));
      await store.write({ ...record, key: "message-2" });
      await expect(store.list("session-message")).resolves.toMatchObject([{ key: "message-2" }]);
      expect(quarantines[1]).toMatchObject({ kind: "session-message", quarantinedPath: `${path}.corrupt-200` });
      expect((await readdir(directory)).sort()).toEqual([
        "session-message.json",
        "session-message.json.corrupt-100",
        "session-message.json.corrupt-200",
      ]);

      // A truncated file is counted by the records it still names.
      now = 300;
      await writeFile(path, JSON.stringify([record, { ...record, key: "message-3" }]).slice(0, -20));
      await expect(store.list("session-message")).resolves.toEqual([]);
      expect(quarantines[2]).toMatchObject({ quarantinedPath: `${path}.corrupt-300`, lostRecords: 2 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("treats foreign entries as absent rather than corrupt, and describes a loss without the path", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-durability-"));
    try {
      const quarantines: DurableFileQuarantine[] = [];
      const store = new FileRuntimeDurabilityStore(home, {
        onQuarantine: (quarantine) => quarantines.push(quarantine),
      });
      await store.write({
        acceptedAt: 1,
        attempts: 0,
        key: "turn-1",
        kind: "turn-report",
        payload: {},
        status: "accepted",
        updatedAt: 1,
      });
      await writeFile(resolve(home, "data/runtime/durability/turn-report.json"), JSON.stringify([{}, {}, {}]));
      // An array whose entries are all foreign parses as empty, so it is not corrupt.
      await expect(store.list("turn-report")).resolves.toEqual([]);
      expect(quarantines).toHaveLength(0);

      const error = new DurableFileQuarantinedError({
        kind: "turn-report",
        lostRecords: 3,
        error: new RuntimeStorageError("invalid", "Runtime storage contains invalid JSON"),
      });
      expect(error.code).toBe("durable_file_quarantined");
      expect(error.message).toBe(
        "Unreadable turn-report durable file moved aside; about 3 records lost (Runtime storage contains invalid JSON)",
      );
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
