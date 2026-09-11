import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type LocalSkillsManifest,
  readLocalSkillsManifest,
  skillDirectoryPath,
  skillsManifestPath,
  skillsRootPath,
  verifyLocalSkills,
  writeLocalSkillsManifest,
} from "../runtime/skills/skill-manifest-store.js";
import { buildSkillZip } from "./fixtures/skill-zip.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

async function agentHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "opentag-skill-store-"));
  homes.push(home);
  return home;
}

async function materialize(home: string, name: string, files: Record<string, string>): Promise<LocalSkillsManifest> {
  const fixture = buildSkillZip(name, files);
  const directory = skillDirectoryPath(home, name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(directory, ...path.split("/")), content);
  }
  return {
    schemaVersion: 1,
    agentId: "agent-1",
    digest: "a".repeat(64),
    skills: { [name]: { digest: fixture.digest, archiveSha256: fixture.archiveSha256, manifest: fixture.manifest } },
    syncedAt: "2026-09-11T00:00:00.000Z",
  };
}

describe("skill manifest store", () => {
  it("writes the manifest with mode 0600 inside .skills/ and reads it back", async () => {
    const home = await agentHome();
    const manifest = await materialize(home, "demo", { "SKILL.md": "# demo" });
    await writeLocalSkillsManifest(home, manifest);
    expect(skillsManifestPath(home)).toBe(join(skillsRootPath(home), ".opentag-skills.json"));
    expect((await stat(skillsManifestPath(home))).mode & 0o777).toBe(0o600);
    expect((await stat(skillsRootPath(home))).mode & 0o777).toBe(0o700);
    await expect(readLocalSkillsManifest(home)).resolves.toEqual(manifest);
    await expect(readLocalSkillsManifest(await agentHome())).resolves.toBeUndefined();
  });

  it("rejects a manifest that does not match its schema", async () => {
    const home = await agentHome();
    await mkdir(skillsRootPath(home), { recursive: true });
    await writeFile(skillsManifestPath(home), JSON.stringify({ schemaVersion: 2 }));
    await expect(readLocalSkillsManifest(home)).rejects.toThrow();
    await expect(
      writeLocalSkillsManifest(home, { schemaVersion: 1 } as unknown as LocalSkillsManifest),
    ).rejects.toThrow();
  });

  it("verifies every listed file and reports missing, resized, and altered skills", async () => {
    const home = await agentHome();
    const manifest = await materialize(home, "demo", { "SKILL.md": "# demo", "scripts/run.sh": "echo" });
    await expect(verifyLocalSkills(home, manifest)).resolves.toEqual({ ok: true, damaged: [] });
    await writeFile(join(skillDirectoryPath(home, "demo"), "scripts", "run.sh"), "ohce");
    await expect(verifyLocalSkills(home, manifest)).resolves.toEqual({ ok: false, damaged: ["demo"] });
    await writeFile(join(skillDirectoryPath(home, "demo"), "scripts", "run.sh"), "echo!");
    await expect(verifyLocalSkills(home, manifest)).resolves.toEqual({ ok: false, damaged: ["demo"] });
    await rm(join(skillDirectoryPath(home, "demo"), "scripts", "run.sh"));
    await expect(verifyLocalSkills(home, manifest)).resolves.toEqual({ ok: false, damaged: ["demo"] });
    await mkdir(join(skillDirectoryPath(home, "demo"), "scripts", "run.sh"));
    await expect(verifyLocalSkills(home, manifest)).resolves.toEqual({ ok: false, damaged: ["demo"] });
  });

  it("refuses skill names that are not safe directory names", () => {
    expect(() => skillDirectoryPath("/tmp/home", "../evil")).toThrow();
    expect(() => skillDirectoryPath("/tmp/home", "Upper")).toThrow();
  });
});
