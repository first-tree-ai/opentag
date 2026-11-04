import { afterEach, describe, expect, it, vi } from "vitest";
import { withOperationDeadline } from "../runtime/im-delivery-deadline.js";

afterEach(() => vi.useRealTimers());
describe("IM operation deadline settlement", () => {
  it.each(["cancelled", "resolved", "rejected", "abandoned"] as const)(
    "classifies %s work after the deadline",
    async (outcome) => {
      vi.useFakeTimers();
      const timeout = vi.fn(async () => {});
      const late = vi.fn(async () => {});
      const abandoned = vi.fn();
      let finish = () => {};
      const run = withOperationDeadline(
        100,
        (signal) =>
          new Promise<void>((resolve, reject) => {
            if (outcome === "cancelled") signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            finish = outcome === "rejected" ? () => reject(new Error("late error")) : resolve;
          }),
        timeout,
        late,
        abandoned,
        50,
      );
      await vi.advanceTimersByTimeAsync(100);
      if (outcome !== "abandoned") finish();
      await vi.advanceTimersByTimeAsync(50);
      await run;
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(late).toHaveBeenCalledTimes(outcome === "resolved" || outcome === "rejected" ? 1 : 0);
      expect(abandoned).toHaveBeenCalledTimes(outcome === "abandoned" ? 1 : 0);
      finish();
      await vi.runAllTimersAsync();
      expect(late).toHaveBeenCalledTimes(outcome === "resolved" || outcome === "rejected" ? 1 : 0);
    },
  );
});
