import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import {
  createRunnerImagePrewarmWorker,
  RunnerImagePrewarmWorker,
  type RunnerImagePrewarmWorkerOptions,
} from "../services/cloud-run/runner-image-prewarm-worker.js";

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture(overrides: Partial<RunnerImagePrewarmWorkerOptions> = {}) {
  const leadership = { isHeld: vi.fn(async () => true), release: vi.fn(async () => undefined) };
  const prepare = vi.fn<RunnerImagePrewarmWorkerOptions["prewarmer"]["prepare"]>(async () => ({
    image: "runner@sha256:unit",
    resourceName: "instances/unit",
    uid: "probe-unit",
    preparationMs: 42,
    importedAt: "imported",
    runningAt: "running",
    cacheRetentionGuaranteed: false,
  }));
  const options = {
    prewarmer: { image: "runner@sha256:unit", resourceName: "instances/unit", prepare },
    acquire: vi.fn(async () => leadership),
    intervalMs: 1_000,
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  const worker = new RunnerImagePrewarmWorker(options);
  return { worker, options, leadership, prepare };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("Runner image prewarm lifecycle", () => {
  it("starts asynchronously once and retains leadership after success without repeating imports", async () => {
    const f = fixture();
    f.worker.start();
    f.worker.start();
    expect(f.prepare).not.toHaveBeenCalled();
    await flush();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.options.acquire).toHaveBeenCalledTimes(1);
    expect(f.leadership.release).not.toHaveBeenCalled();
    await f.worker.stop();
    expect(f.leadership.release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overlap slow preparation checks", async () => {
    const f = fixture();
    const deferred = deferredValue<Awaited<ReturnType<typeof f.prepare>>>();
    f.prepare.mockReturnValueOnce(deferred.promise);
    f.worker.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    const result = await f.prepare.getMockImplementation()?.();
    if (!result) throw new Error("Missing preparation fixture");
    deferred.resolve(result);
    await flush();
    await f.worker.stop();
  });

  it("records background failures, releases leadership and retries on the next interval", async () => {
    const onCounter = vi.fn();
    const f = fixture({ supervisor: createBackgroundFailureSupervisor({ onCounter }) });
    f.prepare.mockRejectedValueOnce(new Error("transient import failure"));
    f.worker.start();
    await flush();
    expect(onCounter).toHaveBeenCalledWith(
      "opentag.background_failures.total",
      expect.objectContaining({ code: "RUNNER_IMAGE_PREWARM_FAILED", retryability: "backoff" }),
    );
    expect(f.leadership.release).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.options.acquire).toHaveBeenCalledTimes(2);
    await f.worker.stop();
  });

  it("coordinates two replicas and permits takeover after the successful leader stops", async () => {
    let held = false;
    const acquire = vi.fn(async () => {
      if (held) return undefined;
      held = true;
      return {
        isHeld: async () => held,
        release: async () => {
          held = false;
        },
      };
    });
    const first = fixture({ acquire });
    const second = fixture({ acquire });
    first.worker.start();
    second.worker.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(first.prepare).toHaveBeenCalledTimes(1);
    expect(second.prepare).not.toHaveBeenCalled();
    await first.worker.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.prepare).toHaveBeenCalledTimes(1);
    await second.worker.stop();
    expect(held).toBe(false);
  });

  it("clears the success marker when its database session loses leadership", async () => {
    const f = fixture();
    f.worker.start();
    await flush();
    f.leadership.isHeld.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.leadership.release).toHaveBeenCalledTimes(1);
    await f.worker.stop();
  });

  it("checks the current lock before every probe mutation", async () => {
    const f = fixture();
    f.prepare.mockImplementationOnce(async (_signal, assertLeadership) => {
      f.leadership.isHeld.mockResolvedValueOnce(false);
      await assertLeadership?.();
      throw new Error("unreachable mutation");
    });
    f.worker.start();
    await flush();
    expect(f.options.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.options.logger.info).toHaveBeenCalledTimes(1);
    expect(f.leadership.release).toHaveBeenCalledTimes(1);
    await f.worker.stop();
  });

  it("waits for aborted preparation cleanup before releasing the lock", async () => {
    const f = fixture();
    const cleanup = deferredValue<void>();
    const events: string[] = [];
    f.leadership.release.mockImplementation(async () => {
      events.push("release");
    });
    f.prepare.mockImplementationOnce(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            events.push("abort");
            void cleanup.promise.then(() => {
              events.push("cleaned");
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        }),
    );
    f.worker.start();
    await flush();
    const stopped = f.worker.stop();
    await flush();
    expect(events).toEqual(["abort"]);
    cleanup.resolve();
    await stopped;
    expect(events).toEqual(["abort", "cleaned", "release"]);
    expect(f.options.logger.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps cleanup failures observable during shutdown", async () => {
    const f = fixture();
    f.prepare.mockImplementationOnce(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new AggregateError([], "cleanup failed")));
        }),
    );
    f.worker.start();
    await flush();
    await f.worker.stop();
    await flush();
    expect(f.options.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.leadership.release).toHaveBeenCalledTimes(1);
  });

  it("reports lock-release failure without blocking the remaining Server shutdown", async () => {
    const f = fixture();
    f.worker.start();
    await flush();
    f.leadership.release.mockRejectedValueOnce(new Error("database disconnect failed"));
    await expect(f.worker.stop()).resolves.toBeUndefined();
    await flush();
    expect(f.options.logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not allocate a worker when Cloud Runner is disabled", () => {
    expect(
      createRunnerImagePrewarmWorker({
        environment: "staging",
        config: { enabled: false },
        databaseUrl: "postgres://unused",
        logger: { info: vi.fn(), warn: vi.fn() },
      }),
    ).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
