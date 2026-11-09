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

describe("Agent name rule", () => {
  it.each(["Atlas", "研发助理", "Atlas-研发-2"])("accepts %j", (name) => {
    expect(validateAgentName(name)).toBeUndefined();
  });

  it.each(["-atlas", "研发 助理", "研发助理！", "a_b"])("refuses %j as a character problem", (name) => {
    expect(validateAgentName(name)).toBe("charset");
  });
});

describe("Agent name length", () => {
  it("counts bytes like the Server: 64 letters or 21 Chinese characters", () => {
    expect(validateAgentName("a".repeat(64))).toBeUndefined();
    expect(validateAgentName("a".repeat(65))).toBe("too-long");
    expect(validateAgentName("中".repeat(21))).toBeUndefined();
    expect(validateAgentName("中".repeat(22))).toBe("too-long");
  });
});
