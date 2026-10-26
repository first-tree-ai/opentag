/**
 * The barrier helpers exist so a failing concurrency test reports its assertion instead of hanging in cleanup.
 *
 * These cases pin that guarantee without a database: a paused operation holds a pooled connection, so a barrier
 * that is not released on the failure path turns an assertion failure into a timeout in `afterEach`.
 */
import { describe, expect, it, vi } from "vitest";
import { rethrowGateFailure, settle, whilePaused } from "./support/barrier.js";

function barrier() {
  let released = false;
  return {
    handle: {
      resolve: () => {
        released = true;
      },
    },
    get released() {
      return released;
    },
  };
}

describe("paused-operation barrier helpers", () => {
  it("releases the barrier and settles spawned work when the gated work succeeds", async () => {
    const gateBarrier = barrier();
    const settled = settle(Promise.resolve("read"));
    const outcome = await whilePaused({
      release: gateBarrier.handle,
      settled: [settled],
      gate: async () => "ok",
    });
    expect(outcome).toEqual({ failed: false });
    expect(gateBarrier.released).toBe(true);
    await expect(settled).resolves.toEqual({ status: "fulfilled", value: "read" });
  });

  it("releases the barrier and returns the gate error instead of throwing from cleanup", async () => {
    // The paused read only finishes when the barrier releases it, like a service call waiting inside its transaction.
    let finishRead: (value: string) => void = () => undefined;
    let readFinished = false;
    const paused = new Promise<string>((resolve) => {
      finishRead = (value) => {
        readFinished = true;
        resolve(value);
      };
    });
    const read = settle(paused);
    const release = { resolve: () => finishRead("read") };
    const outcome = await whilePaused({
      release,
      settled: [read],
      gate: async () => {
        throw new Error("assertion failed before release");
      },
    });
    expect(readFinished).toBe(true);
    await expect(read).resolves.toEqual({ status: "fulfilled", value: "read" });
    expect(outcome).toMatchObject({ failed: true, error: { message: "assertion failed before release" } });
  });

  it("waits for a rejecting operation without masking the gate error", async () => {
    const gateBarrier = barrier();
    const failing = settle(Promise.reject(new Error("read failed")));
    const onUnhandled = vi.fn();
    process.once("unhandledRejection", onUnhandled);
    const outcome = await whilePaused({
      release: gateBarrier.handle,
      settled: [failing],
      gate: async () => {
        throw new Error("assertion failed first");
      },
    });
    await expect(failing).resolves.toEqual({ status: "rejected", reason: new Error("read failed") });
    expect(outcome).toMatchObject({ failed: true, error: { message: "assertion failed first" } });
    // Give the microtask queue a turn: a rejection nobody awaited would surface here.
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.removeListener("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it("re-throws only a real gate failure, so a successful test reports nothing", () => {
    expect(() => rethrowGateFailure({ failed: false })).not.toThrow();
    expect(() => rethrowGateFailure({ failed: true, error: new Error("primary") })).toThrow("primary");
    // A non-Error rejection is re-thrown as it arrived rather than converted into a new error.
    let thrown: unknown;
    try {
      rethrowGateFailure({ failed: true, error: "string failure" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe("string failure");
  });
});
