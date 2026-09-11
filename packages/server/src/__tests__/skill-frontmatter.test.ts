import { SKILL_MD_MAX_BYTES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { parseSkillFrontmatter, SkillServiceError } from "../services/skills/index.js";

const encode = (value: string | Uint8Array) => (typeof value === "string" ? new TextEncoder().encode(value) : value);

function failure(input: string | Uint8Array) {
  try {
    parseSkillFrontmatter(encode(input));
  } catch (error) {
    if (error instanceof SkillServiceError)
      return { code: error.code, field: error.details?.field, message: error.message };
    throw error;
  }
  throw new Error("expected the frontmatter to be rejected");
}

describe("parseSkillFrontmatter", () => {
  it("reads name and description and keeps the original markdown", () => {
    const markdown = "---\nname: my-skill\ndescription: Formats commits\nextra: kept\n---\n# Body\n";
    expect(parseSkillFrontmatter(encode(markdown))).toEqual({
      name: "my-skill",
      description: "Formats commits",
      markdown,
    });
  });

  it("supports block scalars and multi-line descriptions", () => {
    const markdown = "---\nname: my-skill\ndescription: >\n  First line\n  second line\n---\nbody";
    expect(parseSkillFrontmatter(encode(markdown)).description).toBe("First line second line");
    const literal = "---\nname: my-skill\ndescription: |\n  Line one\n  Line two\n---\n";
    expect(parseSkillFrontmatter(encode(literal)).description).toBe("Line one\nLine two");
  });

  it("tolerates a UTF-8 BOM and CRLF line endings", () => {
    const crlf = "﻿---\r\nname: my-skill\r\ndescription: Windows authored\r\n---\r\n# Body\r\n";
    const parsed = parseSkillFrontmatter(encode(crlf));
    expect(parsed).toMatchObject({ name: "my-skill", description: "Windows authored" });
    expect(parsed.markdown.startsWith("---\r\n")).toBe(true);
  });

  it("rejects a missing or malformed frontmatter block", () => {
    expect(failure("# No frontmatter\n")).toMatchObject({ code: "SKILL_MANIFEST_INVALID", field: "SKILL.md" });
    expect(failure("---\nname: x\n")).toMatchObject({ code: "SKILL_MANIFEST_INVALID", field: "SKILL.md" });
    expect(failure("---\n- list\n---\n")).toMatchObject({ code: "SKILL_MANIFEST_INVALID", field: "SKILL.md" });
    expect(failure("---\nname: [unclosed\n---\n")).toMatchObject({ code: "SKILL_MANIFEST_INVALID", field: "SKILL.md" });
  });

  it("names the offending field for a missing, invalid, or oversized name and description", () => {
    expect(failure("---\ndescription: x\n---\n")).toMatchObject({ code: "SKILL_MANIFEST_INVALID", field: "name" });
    expect(failure("---\nname: Bad_Name\ndescription: x\n---\n")).toMatchObject({ field: "name" });
    expect(failure("---\nname: 42\ndescription: x\n---\n")).toMatchObject({ field: "name" });
    expect(failure("---\nname: ok\n---\n")).toMatchObject({ field: "description" });
    expect(failure("---\nname: ok\ndescription: ''\n---\n")).toMatchObject({ field: "description" });
    expect(failure(`---\nname: ok\ndescription: ${"d".repeat(1025)}\n---\n`)).toMatchObject({
      field: "description",
    });
  });

  it("rejects invalid UTF-8 and files over the size limit", () => {
    expect(failure(Uint8Array.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]))).toMatchObject({
      field: "SKILL.md",
      message: expect.stringContaining("UTF-8"),
    });
    const oversized = `---\nname: ok\ndescription: x\n---\n${"a".repeat(SKILL_MD_MAX_BYTES)}`;
    expect(failure(oversized)).toMatchObject({ field: "SKILL.md", message: expect.stringContaining("bytes") });
  });
});
