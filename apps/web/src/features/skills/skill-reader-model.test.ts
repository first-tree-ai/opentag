import { describe, expect, it } from "vitest";
import { resolveSkillFileLink, skillFileTree, splitSkillFrontmatter } from "./skill-reader-model.js";

const files = ["SKILL.md", "references/guide.md", "references/nested/a b.txt", "scripts/draft.ts"].map((path) => ({
  path,
  bytes: 1,
}));
describe("Skill reader navigation", () => {
  it("groups nested paths and pins SKILL.md before folders", () => {
    const tree = skillFileTree(files);
    expect(tree.map((node) => node.name)).toEqual(["SKILL.md", "references", "scripts"]);
    expect(tree[1]?.children?.[0]?.children?.[0]?.path).toBe("references/nested/a b.txt");
  });
  it("resolves only package members, including parent paths and encoded names", () => {
    expect(resolveSkillFileLink("../SKILL.md", "references/guide.md", files)).toBe("SKILL.md");
    expect(resolveSkillFileLink("nested/a%20b.txt", "references/guide.md", files)).toBe("references/nested/a b.txt");
    expect(resolveSkillFileLink("references/guide.md#example", "SKILL.md", files)).toBe("references/guide.md");
    for (const link of [
      "../../SKILL.md",
      "%2e%2e/SKILL.md",
      "javascript:alert(1)",
      "https://example.test/SKILL.md",
      "//example.test",
      "%E0%A4%A",
      "missing.md",
      "#heading",
      "a\\b",
    ]) {
      expect(resolveSkillFileLink(link, "SKILL.md", files)).toBeUndefined();
    }
  });
  it("separates valid frontmatter without dropping body/source bytes", () => {
    const frontmatter = "\uFEFF---\r\nname: reader\r\n---\r\n";
    expect(splitSkillFrontmatter(`${frontmatter}# Body`)).toEqual({ frontmatter, body: "# Body" });
    expect(splitSkillFrontmatter("---\nIncomplete")).toEqual({ body: "---\nIncomplete" });
  });
});
