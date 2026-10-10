import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkClaudeSkills } from "../providers/claude-code/skill-plugin.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "opentag-claude-skills-"));
  homes.push(home);
  const plugin = join(home, "plugin");
  const skills = join(home, "workspace", ".claude", "skills");
  await mkdir(skills, { recursive: true });
  return { home, plugin, skills };
}

async function skill(path: string, name = "example") {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: An example skill\nallowed-tools: Bash(git *)\n---\nRead resources/example.txt.\n`,
  );
  await mkdir(join(path, "resources"));
  await writeFile(join(path, "resources", "example.txt"), "original resource");
  return path;
}

describe("Claude native skill links", () => {
  it("links only selected skills, keeps native metadata, and exposes live resources without replacing duplicates", async () => {
    const f = await fixture();
    const selected = await skill(join(f.skills, "example"));
    await skill(join(f.skills, "unmanaged"), "unmanaged");
    const packaged = await skill(join(f.home, "packaged", "memory"), "memory");
    const duplicate = await skill(join(f.home, "duplicates", "example"));
    await linkClaudeSkills(f.plugin, [selected, selected, packaged, duplicate]);
    const link = join(f.plugin, "skills", "example");
    expect((await readdir(join(f.plugin, "skills"))).sort()).toEqual(["example", "memory"]);
    expect(await realpath(link)).toBe(await realpath(selected));
    expect(await realpath(join(f.plugin, "skills", "memory"))).toBe(await realpath(packaged));
    expect(await readFile(join(link, "SKILL.md"), "utf8")).toContain("allowed-tools: Bash(git *)");
    await writeFile(join(selected, "resources", "example.txt"), "updated resource");
    expect(await readFile(join(link, "resources", "example.txt"), "utf8")).toBe("updated resource");
  });

  it("skips missing, invalid, or conflicting skills and continues with available skills", async () => {
    const f = await fixture();
    const invalid = join(f.skills, "invalid");
    await mkdir(invalid);
    await writeFile(join(invalid, "SKILL.md"), "invalid manifest");
    const conflict = await skill(join(f.skills, "conflict"), "conflict");
    await mkdir(join(f.plugin, "skills"), { recursive: true });
    await writeFile(join(f.plugin, "skills", "conflict"), "existing entry");
    const good = await skill(join(f.skills, "good"), "good");
    await linkClaudeSkills(f.plugin, [join(f.skills, "missing"), invalid, conflict, good]);
    expect((await readdir(join(f.plugin, "skills"))).sort()).toEqual(["conflict", "good"]);
    expect(await readFile(join(f.plugin, "skills", "conflict"), "utf8")).toBe("existing entry");
    expect(await realpath(join(f.plugin, "skills", "good"))).toBe(await realpath(good));
  });

  it("supports no selected skills", async () => {
    const f = await fixture();
    await linkClaudeSkills(f.plugin, []);
    expect(await readdir(join(f.plugin, "skills"))).toEqual([]);
  });
});
