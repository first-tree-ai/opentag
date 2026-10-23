import { describe, expect, it, vi } from "vitest";
import { waitForSendMark } from "../services/sessions/session-service.js";

describe("scheduled dispatch send mark", () => {
  it("accepts a send that marks inside the admission window", async () => {
    let mark: () => void = () => undefined;
    const marked = new Promise<void>((resolve) => {
      mark = resolve;
    });
    const settled = waitForSendMark(marked, 5_000);
    mark();
    await expect(settled).resolves.toBe(true);
  });

  it("refuses the dispatch when the transport never marks the send", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      let outcome: boolean | undefined;
      void waitForSendMark(never, 5_000).then((value) => {
        outcome = value;
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(outcome).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(outcome).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
