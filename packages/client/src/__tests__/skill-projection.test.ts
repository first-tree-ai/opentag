import { lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSkillsProjectionRoot, projectionTarget, projectSkills } from "../runtime/skills/skill-projection.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

async function agentHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-skill-projection-"));
  homes.push(home);
  await mkdir(join(home, ".skills", "alpha"), { recursive: true });
  await mkdir(join(home, ".skills", "beta"), { recursive: true });
  await writeFile(join(home, ".skills", "alpha", "SKILL.md"), "# alpha");
  await writeFile(join(home, ".skills", "beta", "SKILL.md"), "# beta");
  return home;
}

describe("projectSkills", () => {
  it("creates relative links into .skills/ idempotently and removes only its own stale links", async () => {
    const home = await agentHome();
    const root = claudeSkillsProjectionRoot(home);
    await expect(projectSkills(home, ["alpha", "beta"])).resolves.toEqual({
      linked: ["alpha", "beta"],
      removed: [],
      skipped: [],
    });
    expect(await readlink(join(root, "alpha"))).toBe(projectionTarget("alpha"));
    expect(await readlink(join(root, "alpha"))).toBe("../../.skills/alpha");
    expect((await lstat(join(root, "alpha", "SKILL.md"))).isFile()).toBe(true);
    await expect(projectSkills(home, ["alpha", "beta"])).resolves.toEqual({
      linked: ["alpha", "beta"],
      removed: [],
      skipped: [],
    });
    await expect(projectSkills(home, ["beta"])).resolves.toEqual({ linked: ["beta"], removed: ["alpha"], skipped: [] });
    expect((await readdir(root)).sort()).toEqual(["beta"]);
  });

  it("leaves context-tree directories, user entries, and foreign links untouched", async () => {
    const home = await agentHome();
    const root = claudeSkillsProjectionRoot(home);
    await mkdir(join(root, "context-tree-read"), { recursive: true });
    await writeFile(join(root, "context-tree-read", "SKILL.md"), "# ct");
    await mkdir(join(root, "user-skill"));
    await symlink("/somewhere/else", join(root, "elsewhere"));
    await symlink("/somewhere/else", join(root, "alpha"));
    await symlink("../../.skills/stale", join(root, "stale"));
    await symlink("../../.skills/alpha", join(root, "beta"));
    await expect(projectSkills(home, ["alpha", "beta"])).resolves.toEqual({
      linked: ["beta"],
      removed: ["stale"],
      skipped: ["alpha"],
    });
    expect(await readlink(join(root, "alpha"))).toBe("/somewhere/else");
    expect(await readlink(join(root, "beta"))).toBe("../../.skills/beta");
    expect(await readlink(join(root, "elsewhere"))).toBe("/somewhere/else");
    expect((await lstat(join(root, "user-skill"))).isDirectory()).toBe(true);
    expect((await lstat(join(root, "context-tree-read"))).isDirectory()).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["alpha", "beta", "context-tree-read", "elsewhere", "user-skill"]);
  });

  it("rejects unsafe skill names before touching the filesystem", async () => {
    const home = await agentHome();
    await expect(projectSkills(home, ["../escape"])).rejects.toThrow();
    expect(() => projectionTarget("Bad Name")).toThrow();
  });
});
