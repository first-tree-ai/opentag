import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeClaudeSkills } from "../providers/claude-code/skill-plugin.js";
import * as archives from "../skills/skill-archive.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "opentag-claude-skills-"));
  homes.push(home);
  const cwd = join(home, "workspace");
  const plugin = join(home, "plugin");
  const skills = join(cwd, ".claude", "skills");
  await mkdir(skills, { recursive: true });
  return { home, cwd, plugin, skills };
}

async function skill(path: string, name = "example") {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: An example skill\nallowed-tools: Bash(rm *)\nhooks:\n  PreToolUse: []\ncontext: fork\nagent: general-purpose\n---\n# Instructions\nRead resources/example.txt.\n`,
  );
  await mkdir(join(path, "resources"));
  await writeFile(join(path, "resources", "example.txt"), "original resource");
  return path;
}

describe("Claude native skill snapshots", () => {
  it("copies only selected skills, strips native capability metadata, and preserves independent resources", async () => {
    const f = await fixture();
    const selected = await skill(join(f.skills, "example"));
    await skill(join(f.skills, "unmanaged"), "unmanaged");
    const packaged = await skill(join(f.home, "packaged", "memory"), "memory");
    // A repeated path or duplicate name must not replace the selected skill.
    const duplicate = await skill(join(f.home, "duplicates", "example"));
    await writeFile(join(duplicate, "resources", "example.txt"), "duplicate resource");
    await materializeClaudeSkills(f.plugin, f.cwd, [selected, selected, packaged, duplicate]);
    const copy = join(f.plugin, "skills", "example");
    expect((await readdir(join(f.plugin, "skills"))).sort()).toEqual(["example", "memory"]);
    expect(await readFile(join(copy, "SKILL.md"), "utf8")).toBe(
      '---\nname: "example"\ndescription: "An example skill"\n---\n# Instructions\nRead resources/example.txt.\n',
    );
    await writeFile(join(selected, "resources", "example.txt"), "changed after snapshot");
    expect(await readFile(join(copy, "resources", "example.txt"), "utf8")).toBe("original resource");
    expect(await readFile(join(selected, "SKILL.md"), "utf8")).toContain("allowed-tools:");
  });

  it.each(["root", "directory", "manifest"] as const)("skips a skill with a symlinked %s", async (kind) => {
    const f = await fixture();
    const original = await skill(join(f.home, "external", "example"));
    const selected = join(f.skills, "example");
    if (kind === "root") {
      await rm(f.skills, { recursive: true });
      await symlink(join(f.home, "external"), f.skills, "dir");
    } else {
      await skill(selected);
      const entry = kind === "directory" ? "resources" : "SKILL.md";
      await rm(join(selected, entry), { recursive: true });
      await symlink(join(original, entry), join(selected, entry), kind === "directory" ? "dir" : "file");
    }
    await materializeClaudeSkills(f.plugin, f.cwd, [selected]);
    expect(await readdir(join(f.plugin, "skills"))).toEqual([]);
  });

  it("rejects missing and replaced roots while continuing with valid skills", async () => {
    const f = await fixture();
    const replaced = await skill(join(f.skills, "replaced"), "replaced");
    const good = await skill(join(f.skills, "good"), "good");
    const pack = archives.packSkillDirectory;
    vi.spyOn(archives, "packSkillDirectory").mockImplementation(async (path) => {
      const packed = await pack(path);
      if (path === replaced) {
        await rename(path, `${path}-old`);
        await mkdir(path);
      }
      return packed;
    });
    await materializeClaudeSkills(f.plugin, f.cwd, [join(f.skills, "missing"), replaced, good]);
    expect(await readdir(join(f.plugin, "skills"))).toEqual(["good"]);
  });

  it("removes an incomplete snapshot if extraction or copied manifest validation fails", async () => {
    const f = await fixture();
    const first = await skill(join(f.skills, "first"), "first");
    const second = await skill(join(f.skills, "second"), "second");
    const extract = archives.extractSkillArchive;
    vi.spyOn(archives, "extractSkillArchive").mockImplementation(async (stream, target) => {
      await extract(stream, target);
      if (target.endsWith("first")) throw new Error("Incomplete archive");
      await writeFile(join(target, "SKILL.md"), "invalid manifest");
    });
    await materializeClaudeSkills(f.plugin, f.cwd, [first, second]);
    expect(await readdir(join(f.plugin, "skills"))).toEqual([]);
  });

  it("supports no selected skills and rejects the workspace's parent as a skill", async () => {
    const f = await fixture();
    await materializeClaudeSkills(f.plugin, f.cwd, []);
    await materializeClaudeSkills(f.plugin, f.cwd, [f.home]);
    expect(await readdir(join(f.plugin, "skills"))).toEqual([]);
  });
});
