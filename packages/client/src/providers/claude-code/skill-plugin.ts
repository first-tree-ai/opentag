import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { parseSkillManifest } from "@opentag/shared";
import { createLogger } from "../../observability/logger.js";
import { extractSkillArchive, packSkillDirectory } from "../../skills/skill-archive.js";
import { assertSafeSkillRoot } from "../../skills/skill-roots.js";

const logger = createLogger("provider-claude-skills");

async function packSelectedSkill(cwd: string, path: string) {
  const suffix = relative(resolve(cwd), resolve(path));
  if (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)) {
    await assertSafeSkillRoot(cwd, dirname(path));
  }
  const before = await lstat(path);
  const packed = await packSkillDirectory(path);
  const after = await lstat(path);
  if (`${before.dev}:${before.ino}:${before.ctimeMs}` !== `${after.dev}:${after.ino}:${after.ctimeMs}`) {
    throw new Error("Skill directory changed while being copied");
  }
  return packed;
}

async function sanitizeManifest(target: string): Promise<void> {
  const file = join(target, "SKILL.md");
  const markdown = (await readFile(file, "utf8")).replace(/^\uFEFF/u, "").replace(/\r\n|\r/gu, "\n");
  const parsed = parseSkillManifest(markdown);
  if (!parsed.ok) throw new Error(parsed.reason);
  const lines = markdown.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  // Rebuild from OpenTag's schema: native permissions, hooks, agents, and other capability fields are omitted.
  await writeFile(
    file,
    `---\nname: ${JSON.stringify(parsed.manifest.name)}\ndescription: ${JSON.stringify(parsed.manifest.description)}\n---\n${lines.slice(end + 1).join("\n")}`,
    { mode: 0o600 },
  );
}

/** Only explicitly selected synced or packaged skills become native Claude skills. */
export async function materializeClaudeSkills(
  pluginPath: string,
  cwd: string,
  paths: readonly string[],
): Promise<void> {
  const root = join(pluginPath, "skills");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const installed = new Set<string>();
  for (const path of new Set(paths)) {
    let target: string | undefined;
    try {
      const packed = await packSelectedSkill(cwd, path);
      if (installed.has(packed.name)) continue;
      target = join(root, packed.name);
      await extractSkillArchive(Readable.from([packed.archive]), target);
      await sanitizeManifest(target);
      installed.add(packed.name);
    } catch (error) {
      if (target) await rm(target, { recursive: true, force: true });
      logger.warn(
        { code: "claude_skill_unavailable", reason: String(error) },
        "Skipping an unsafe or unavailable Claude skill",
      );
    }
  }
}
