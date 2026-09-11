import { describe, expect, it } from "vitest";
import { availableDefaultAgentName, emptyDraft } from "./flow.js";

describe("default Agent names", () => {
  it("keeps the short product name for the first Agent", () => {
    expect(availableDefaultAgentName([])).toBe("opentag");
    expect(emptyDraft().name).toBe("opentag");
  });

  it("uses the first available stable suffix for an additional Agent", () => {
    expect(availableDefaultAgentName(["opentag", "opentag-2", "researcher", "opentag-4"])).toBe("opentag-3");
  });

  it("compares held names defensively without case or surrounding whitespace", () => {
    expect(availableDefaultAgentName([" OpenTag "])).toBe("opentag-2");
  });
});
