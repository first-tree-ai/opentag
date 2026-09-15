import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerPresenceGrace } from "../presence-grace.js";

const COMPUTER = "computer-1";
const OTHER_COMPUTER = "computer-2";
const INSTANCE = "instance-a";
const REPLACEMENT = "instance-b";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ComputerPresenceGrace", () => {
  it("clears presence only once the grace window has passed", async () => {
    const clearPresence = vi.fn().mockResolvedValue(true);
    const grace = new ComputerPresenceGrace(clearPresence, { graceMs: 15_000 });

    grace.schedule(COMPUTER, INSTANCE);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(clearPresence).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(clearPresence).toHaveBeenCalledExactlyOnceWith(COMPUTER, INSTANCE);
  });

  it("keeps a Computer present when it registers again inside the window", async () => {
    const clearPresence = vi.fn().mockResolvedValue(true);
    const grace = new ComputerPresenceGrace(clearPresence, { graceMs: 15_000 });

    // The 2-second reconnect this window exists for.
    grace.schedule(COMPUTER, INSTANCE);
    await vi.advanceTimersByTimeAsync(2_000);
    grace.cancel(COMPUTER);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(clearPresence).not.toHaveBeenCalled();
  });

  it("replaces a pending release rather than releasing twice, and scopes cancellation to one Computer", async () => {
    const clearPresence = vi.fn().mockResolvedValue(true);
    const grace = new ComputerPresenceGrace(clearPresence, { graceMs: 15_000 });

    grace.schedule(COMPUTER, INSTANCE);
    await vi.advanceTimersByTimeAsync(10_000);
    // The Computer reconnected and dropped again: only the newest close decides when presence goes.
    grace.schedule(COMPUTER, REPLACEMENT);
    grace.schedule(OTHER_COMPUTER, INSTANCE);
    grace.cancel(OTHER_COMPUTER);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(clearPresence).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(clearPresence).toHaveBeenCalledExactlyOnceWith(COMPUTER, REPLACEMENT);
  });

  it("cancelling an unknown Computer and a failing release are both no-ops", async () => {
    const clearPresence = vi.fn().mockRejectedValue(new Error("the database is gone"));
    const grace = new ComputerPresenceGrace(clearPresence, { graceMs: 1_000 });

    expect(() => grace.cancel(COMPUTER)).not.toThrow();
    grace.schedule(COMPUTER, INSTANCE);
    // A release that cannot reach the database is swallowed rather than left unhandled.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clearPresence).toHaveBeenCalledExactlyOnceWith(COMPUTER, INSTANCE);

    // The window is over, so the entry is gone and a later cancel has nothing left to do.
    expect(() => grace.cancel(COMPUTER)).not.toThrow();
  });

  it("drops every pending release when the server shuts down", async () => {
    const clearPresence = vi.fn().mockResolvedValue(true);
    const grace = new ComputerPresenceGrace(clearPresence, { graceMs: 15_000 });

    grace.schedule(COMPUTER, INSTANCE);
    grace.schedule(OTHER_COMPUTER, REPLACEMENT);
    grace.close();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(clearPresence).not.toHaveBeenCalled();
  });
});
