import { describe, expect, it, vi } from "vitest";
import { runBudgetTimer, scheduleUnrefTimeout } from "../agent-runtime/run-budget-timer.js";

describe("runBudgetTimer", () => {
  it("stands still while paused and expires once the rest of the budget has run", async () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const timer = runBudgetTimer(scheduleUnrefTimeout, Date.now, 10_000, expired);
      const start = Date.now();
      expect(timer.expiresAt).toBe(start + 10_000);
      await vi.advanceTimersByTimeAsync(4_000);
      timer.pause();
      timer.pause();
      expect(timer.expiresAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(expired).not.toHaveBeenCalled();
      timer.resume();
      timer.resume();
      expect(timer.expiresAt).toBe(Date.now() + 6_000);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(expired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(expired).toHaveBeenCalledOnce();
      // An expired or cancelled budget does not start again.
      timer.pause();
      timer.resume();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fires after cancel", async () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const timer = runBudgetTimer(scheduleUnrefTimeout, Date.now, 1_000, expired);
      timer.cancel();
      timer.resume();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(expired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
