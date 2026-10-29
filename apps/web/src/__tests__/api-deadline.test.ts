import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withDeadline } from "../api.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["resolve", "reject"] as const)("cleans up the observer and timer when the operation %ss", async (outcome) => {
  const observer = new AbortController();
  const add = vi.spyOn(observer.signal, "addEventListener");
  const remove = vi.spyOn(observer.signal, "removeEventListener");
  const error = new Error("read failed");
  let transportSignal: AbortSignal | undefined;
  const result = withDeadline(
    100,
    async (signal) => {
      transportSignal = signal;
      if (outcome === "reject") throw error;
      return "ready";
    },
    observer.signal,
  );
  if (outcome === "reject") await expect(result).rejects.toBe(error);
  else await expect(result).resolves.toBe("ready");
  expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  expect(vi.getTimerCount()).toBe(0);
  observer.abort();
  expect(transportSignal?.aborted).toBe(false);
});

it("does not start a read for an already cancelled observer", async () => {
  const observer = new AbortController();
  const cause = new Error("observer removed");
  observer.abort(cause);
  const run = vi.fn();
  await expect(withDeadline(100, run, observer.signal)).rejects.toMatchObject({
    name: "AbortError",
    code: "cancelled",
    cause,
  });
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a read when the observer cancels before its microtask", async () => {
  const observer = new AbortController();
  const run = vi.fn();
  const result = withDeadline(100, run, observer.signal);
  observer.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["observer", "deadline"] as const)(
  "aborts on %s cancellation even when the read ignores abort",
  async (source) => {
    const observer = new AbortController();
    const add = vi.spyOn(observer.signal, "addEventListener");
    const remove = vi.spyOn(observer.signal, "removeEventListener");
    let transportSignal: AbortSignal | undefined;
    let rejectRead: ((error: Error) => void) | undefined;
    const result = withDeadline(
      100,
      (signal) => {
        transportSignal = signal;
        return new Promise<never>((_, reject) => {
          rejectRead = reject;
        });
      },
      observer.signal,
    );
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    await vi.advanceTimersByTimeAsync(0);
    if (source === "observer") observer.abort(new Error("observer removed"));
    else await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(transportSignal?.aborted).toBe(true);
    if (source === "deadline") expect(transportSignal?.reason.cause.name).toBe("TimeoutError");
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
    expect(vi.getTimerCount()).toBe(0);
    // Late failures from an uncooperative transport must remain handled by the race.
    rejectRead?.(new Error("late transport failure"));
    await vi.advanceTimersByTimeAsync(0);
  },
);
