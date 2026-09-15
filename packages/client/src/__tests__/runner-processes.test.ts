import { describe, expect, it } from "vitest";
import { collectDescendantPids, waitForProcessTreeGone } from "../runner/processes.js";

describe("runner process tree", () => {
  it("walks descendants and waits until they disappear", async () => {
    const tree = new Map<number, number[]>([
      [1, [2, 3]],
      [2, [4]],
      [3, []],
      [4, []],
    ]);
    await expect(collectDescendantPids(1, async (pid) => tree.get(pid) ?? [])).resolves.toEqual([1, 2, 3, 4]);
    const live = new Set([8, 9]);
    setTimeout(() => live.clear(), 20);
    await waitForProcessTreeGone([8, 9], {
      timeoutMs: 1_000,
      exists: async (pid) => live.has(pid),
    });
    await expect(waitForProcessTreeGone([11], { timeoutMs: 30, exists: async () => true })).rejects.toThrow(
      /still alive/,
    );
  });
});
