import { afterEach, describe, expect, it, vi } from "vitest";
import { type OutboundDeadlineReason, withOutboundDeadline } from "../services/outbound/deadline.js";

/**
 * The shared outbound deadline: it has to bound a whole operation — an address check that cannot be
 * interrupted followed by a request — and it has to release everything it armed however the
 * operation ends. Both halves are asserted here rather than through a caller, because a caller can
 * only show that its own promise settled, not that nothing was left behind.
 */

class TestFailure extends Error {
  readonly reason: OutboundDeadlineReason;

  constructor(reason: OutboundDeadlineReason) {
    super(`outbound ended: ${reason}`);
    this.name = "TestFailure";
    this.reason = reason;
  }
}

function failure(reason: OutboundDeadlineReason): Error {
  return new TestFailure(reason);
}

/**
 * A signal that counts its own handlers.
 *
 * `AbortSignal` exposes no way to read its listener list, and "the caller's signal is not retained
 * after the operation ended" is otherwise unobservable until it leaks in production.
 */
function countingSignal() {
  const target = new EventTarget();
  const state = { added: 0, removed: 0, aborted: false };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  const signal = {
    get aborted(): boolean {
      return state.aborted;
    },
    addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void {
      state.added += 1;
      add(type, listener, options);
    },
    removeEventListener(type: string, listener: EventListener): void {
      state.removed += 1;
      remove(type, listener);
    },
  };
  return {
    signal: signal as unknown as AbortSignal,
    counts: () => ({ ...state }),
    abort() {
      state.aborted = true;
      target.dispatchEvent(new Event("abort"));
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("withOutboundDeadline", () => {
  it("returns the work's result and disarms its timer", async () => {
    vi.useFakeTimers();
    const result = await withOutboundDeadline({ timeoutMs: 100, failure }, async () => "ok");
    expect(result).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles at the deadline even when the work never settles", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    const pending = withOutboundDeadline({ timeoutMs: 20, failure }, () => never);
    const failed = expect(pending).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a signal that was already aborted, without running the work", async () => {
    const caller = countingSignal();
    caller.abort();
    const run = vi.fn(async () => "ok");
    await expect(withOutboundDeadline({ timeoutMs: 100, signal: caller.signal, failure }, run)).rejects.toMatchObject({
      reason: "aborted",
    });
    expect(run).not.toHaveBeenCalled();
    // Nothing was armed, so nothing needs releasing.
    expect(caller.counts()).toEqual({ added: 0, removed: 0, aborted: true });
  });

  it("ends the operation when the caller cancels, then removes its listener", async () => {
    vi.useFakeTimers();
    const caller = countingSignal();
    const never = new Promise<string>(() => undefined);
    const pending = withOutboundDeadline({ timeoutMs: 10_000, signal: caller.signal, failure }, () => never);
    const failed = expect(pending).rejects.toMatchObject({ reason: "aborted" });
    caller.abort();
    await failed;
    expect(caller.counts()).toEqual({ added: 1, removed: 1, aborted: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes its listener when the work finishes first", async () => {
    const caller = countingSignal();
    await withOutboundDeadline({ timeoutMs: 10_000, signal: caller.signal, failure }, async () => "ok");
    // A listener left behind would keep this operation's controller reachable from the caller's
    // signal, and fire into an operation that already answered.
    expect(caller.counts()).toEqual({ added: 1, removed: 1, aborted: false });
  });

  it("aborts the signal it hands the work, so a socket closes with the answer", async () => {
    vi.useFakeTimers();
    let observed: boolean | undefined;
    const never = new Promise<string>(() => undefined);
    const pending = withOutboundDeadline({ timeoutMs: 20, failure }, async (deadline) => {
      deadline.signal.addEventListener("abort", () => {
        observed = deadline.signal.aborted;
      });
      return never;
    });
    const failed = expect(pending).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(observed).toBe(true);
  });

  it("reports what is left of the budget rather than a fresh one", async () => {
    vi.useFakeTimers();
    let remaining: number | undefined;
    const pending = withOutboundDeadline({ timeoutMs: 100, failure }, async (deadline) => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      remaining = deadline.remainingMs();
      return "ok";
    });
    await vi.advanceTimersByTimeAsync(70);
    await expect(pending).resolves.toBe("ok");
    expect(remaining).toBe(30);
  });

  it("lets the work see that its budget ended, before it takes the next step", async () => {
    vi.useFakeTimers();
    const steps: string[] = [];
    const pending = withOutboundDeadline({ timeoutMs: 10, failure }, async (deadline) => {
      // A resolver that outlives the budget: it cannot be interrupted, so the guard after it is the
      // only thing that stops the request it was resolved for.
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        deadline.throwIfEnded();
        steps.push("dialed");
      } catch (error) {
        steps.push((error as TestFailure).reason);
      }
      return "done";
    });
    const failed = expect(pending).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(10);
    await failed;
    await vi.advanceTimersByTimeAsync(50);
    expect(steps).toEqual(["deadline"]);
  });

  it("keeps a late rejection of the work observed instead of letting it escape", async () => {
    vi.useFakeTimers();
    let rejectWork!: (error: Error) => void;
    const work = new Promise<string>((_resolve, reject) => {
      rejectWork = reject;
    });
    const pending = withOutboundDeadline({ timeoutMs: 10, failure }, () => work);
    const failed = expect(pending).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(10);
    await failed;
    // A DNS promise cannot be cancelled, so it fails after the caller was answered. An unhandled
    // rejection here would fail this test.
    rejectWork(new Error("resolver failed after the deadline"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
