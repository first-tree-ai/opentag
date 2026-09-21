import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleContextTreeSkills,
  assembleRunnerToolSkills,
  CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES,
  RUNNER_TOOL_SKILL_DIRECTORIES,
} from "../runner/skills.js";
import { resolveContextTreePackage } from "../runtime/context-tree.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("context tree skill assembly", () => {
  it("loads the six packaged skills through the real Client resolver", async () => {
    expect(CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES).toHaveLength(6);
    const assembled = await assembleContextTreeSkills();
    const resolved = resolveContextTreePackage();
    expect(resolved?.skillsPath).toBe(assembled.skillsPath);
    expect(assembled.skills.map((skill) => skill.name)).toEqual([...CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES]);
    expect(assembled.skillPaths).toEqual(assembled.skills.map((skill) => skill.directory));
    expect(assembled.skillPaths).not.toContain(assembled.skillsPath);
  });
});

describe("runner tool skill assembly", () => {
  it("is empty when the skills directory is absent (host development)", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-tool-skills-"));
    directories.push(root);
    const missing = join(root, "absent");
    const assembled = await assembleRunnerToolSkills(missing);
    expect(assembled.skills).toEqual([]);
    expect(assembled.skillsPath).toBe(missing);
  });

  it("loads the four source-owned tool skills from a complete directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-tool-skills-"));
    directories.push(root);
    expect(RUNNER_TOOL_SKILL_DIRECTORIES).toEqual(["git", "gh", "lark-cli", "slack"]);
    for (const name of RUNNER_TOOL_SKILL_DIRECTORIES) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
    }
    const assembled = await assembleRunnerToolSkills(root);
    expect(assembled.skills.map((skill) => skill.name)).toEqual([...RUNNER_TOOL_SKILL_DIRECTORIES]);
    for (const skill of assembled.skills) {
      expect(skill.directory).toBe(join(root, skill.name));
      expect(skill.skillFile).toBe(join(root, skill.name, "SKILL.md"));
    }
  });

  it("fails loudly when a tool skill directory is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-tool-skills-incomplete-"));
    directories.push(root);
    for (const name of RUNNER_TOOL_SKILL_DIRECTORIES) {
      await mkdir(join(root, name), { recursive: true });
    }
    // Only three of four have SKILL.md; the fourth is a bare directory.
    for (const name of RUNNER_TOOL_SKILL_DIRECTORIES.slice(0, 3)) {
      await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    await expect(assembleRunnerToolSkills(root)).rejects.toThrow(/incomplete/);
  });
});
