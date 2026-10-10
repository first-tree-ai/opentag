import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) }));
vi.mock("postgres", () => ({ default: () => Object.assign(state.query, { end: state.end }) }));

import { createRunnerImagePrewarmCoordinator } from "../services/cloud-run/runner-image-prewarm-coordinator.js";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("Runner image preparation coordination failures", () => {
  it("bounds an unresponsive database and closes its pending dedicated connection", async () => {
    vi.useFakeTimers();
    state.query.mockReturnValue(new Promise(() => undefined));
    const acquired = createRunnerImagePrewarmCoordinator("postgres://unused", "unit")();
    const rejected = expect(acquired).rejects.toThrow("coordination unavailable");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(state.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed if a previously held session stops responding", async () => {
    vi.useFakeTimers();
    state.query.mockResolvedValueOnce([{ acquired: true }]);
    const leader = await createRunnerImagePrewarmCoordinator("postgres://unused", "unit")();
    state.query.mockReturnValueOnce(new Promise(() => undefined));
    const held = leader?.isHeld();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await held).toBe(false);
    await leader?.release();
    expect(state.end).toHaveBeenCalledWith({ timeout: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
