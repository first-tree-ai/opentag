import { describe, expect, it } from "vitest";
import { orderAgentIds } from "./agent-list-order.js";

describe("Agent list order", () => {
  it("takes the incoming priority order on the first render", () => {
    expect(orderAgentIds(["c", "a", "b"], [])).toEqual(["c", "a", "b"]);
  });

  it("keeps the shown order when a status change would resort the list", () => {
    expect(orderAgentIds(["c", "a", "b"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("adds Agents created since the first render at the end", () => {
    expect(orderAgentIds(["d", "a", "c", "b"], ["a", "b"])).toEqual(["a", "b", "d", "c"]);
  });

  it("drops Agents that have left the list", () => {
    expect(orderAgentIds(["c", "a"], ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  it("returns the same order when applied to its own result", () => {
    const once = orderAgentIds(["c", "a", "b"], ["a", "b"]);
    expect(orderAgentIds(["c", "a", "b"], once)).toEqual(once);
  });
});
