import { describe, expect, it } from "vitest";
import { availableDefaultAgentName, emptyDraft, validateAgentName } from "./flow.js";

describe("default Agent names", () => {
  it("keeps the short product name for the first Agent", () => {
    expect(availableDefaultAgentName([])).toBe("opentag");
    expect(emptyDraft().name).toBe("opentag");
  });

  it("uses the first available stable suffix for an additional Agent", () => {
    expect(availableDefaultAgentName(["opentag", "opentag-2", "researcher", "opentag-4"])).toBe("opentag-3");
  });

  it("compares held names defensively without case or surrounding whitespace", () => {
    expect(availableDefaultAgentName([" openTag "])).toBe("opentag-2");
  });
});

describe("Agent name validation", () => {
  it.each(["opentag", "OpenTag", "Code-Reviewer-2", "代码审查", "小A-助手", "  审查  ", "中".repeat(64)])(
    "accepts %j",
    (name) => expect(validateAgentName(name)).toBeUndefined(),
  );

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["中".repeat(65), "too-long"],
    ["-代码", "charset"],
    ["代码 审查", "charset"],
    ["under_score", "charset"],
    ["ｆｕｌｌ", "charset"],
    ["まる", "charset"],
  ] as const)("rejects %j as %s", (name, error) => expect(validateAgentName(name)).toBe(error));
});
