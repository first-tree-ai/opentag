import { describe, expect, it } from "vitest";
import { composeRuntimeBusinessOptions } from "../api/runtime.js";
import type { RuntimeBusinessContext, RuntimeBusinessOptions } from "../runtime/runtime-session.js";

const context = {
  computerId: "computer",
  instanceId: "instance",
  signal: new AbortController().signal,
  workspaceComputerId: "computer",
  workspaceId: "workspace",
} satisfies RuntimeBusinessContext;

function owner(label: string, parseValue: unknown = undefined): RuntimeBusinessOptions {
  return {
    parse: (input) => (input === label ? (parseValue ?? input) : undefined),
    laneKey: () => `${label}-lane`,
    handle: () => `${label}-handle`,
    failureResult: () => `${label}-failure`,
    overloadResult: () => `${label}-overload`,
  } as RuntimeBusinessOptions;
}

describe("composeRuntimeBusinessOptions", () => {
  it("composes two owners and prefers the first matching parse", async () => {
    const first = owner("first", { kind: "first" });
    const second = owner("second", { kind: "second" });
    const composed = composeRuntimeBusinessOptions(undefined, first, second);
    expect(composed).toBeDefined();
    expect(composed?.parse("first")).toEqual({ kind: "first" });
    expect(composed?.parse("second")).toEqual({ kind: "second" });
    expect(composed?.parse("missing")).toBeUndefined();
    expect(composed?.laneKey("first" as never)).toBe("first-lane");
    expect(composed?.laneKey("second" as never)).toBe("second-lane");
    expect(composed?.laneKey("missing" as never)).toBe("first-lane");
    expect(composed?.handle("first" as never, context)).toBe("first-handle");
    expect(composed?.handle("second" as never, context)).toBe("second-handle");
    expect(composed?.handle("missing" as never, context)).toBe("first-handle");
    expect(composed?.failureResult("first" as never)).toBe("first-failure");
    expect(composed?.failureResult("second" as never)).toBe("second-failure");
    expect(composed?.failureResult("missing" as never)).toBe("first-failure");
    expect(composed?.overloadResult("first" as never)).toBe("first-overload");
    expect(composed?.overloadResult("second" as never)).toBe("second-overload");
    expect(composed?.overloadResult("missing" as never)).toBe("first-overload");
    expect(composed?.maxConcurrent).toBe(32);
    expect(composed?.maxQueuedPerKey).toBe(32);
    expect(composed?.maxQueuedTotal).toBe(1024);
  });

  it("uses the tighter queue limits from either owner", () => {
    const first: RuntimeBusinessOptions = {
      ...owner("first"),
      maxConcurrent: 8,
      maxQueuedPerKey: 3,
      maxQueuedTotal: 40,
    };
    const second: RuntimeBusinessOptions = {
      ...owner("second"),
      maxConcurrent: 2,
      maxQueuedPerKey: 9,
      maxQueuedTotal: 12,
    };
    const composed = composeRuntimeBusinessOptions(first, second);
    expect(composed?.maxConcurrent).toBe(2);
    expect(composed?.maxQueuedPerKey).toBe(3);
    expect(composed?.maxQueuedTotal).toBe(12);
  });
});
