import { SKILL_RESERVED_NAMES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES, RUNNER_TOOL_SKILL_DIRECTORIES } from "../runner/skills.js";

describe("reserved Skill names", () => {
  it("equals the union of the Client's packaged and runner tool skill directories", () => {
    const expected = [...CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES, ...RUNNER_TOOL_SKILL_DIRECTORIES].sort();
    expect([...SKILL_RESERVED_NAMES].sort()).toEqual(expected);
  });
});
