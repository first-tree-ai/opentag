import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseSkillManifest } from "@opentag/shared";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("provider-claude-skills");

/** Selected skills keep their native metadata and resources; edits remain visible during the run. */
export async function linkClaudeSkills(pluginPath: string, paths: readonly string[], cwd?: string): Promise<void> {
  const root = join(pluginPath, "skills");
  const nativeRoot = cwd
    ? await realpath(resolve(cwd, ".claude", "skills")).catch((error: unknown) => {
        logger.debug({ code: "claude_native_skills_unavailable", reason: String(error) }, "No native Skill root");
        return undefined;
      })
    : undefined;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const installed = new Set<string>();
  for (const path of new Set(paths)) {
    try {
      if (nativeRoot && nativeRoot === (await realpath(dirname(resolve(path))))) continue;
      const parsed = parseSkillManifest(await readFile(join(path, "SKILL.md"), "utf8"));
      if (!parsed.ok) throw new Error(parsed.reason);
      const name = parsed.manifest.name;
      if (installed.has(name)) continue;
      await symlink(resolve(path), join(root, name), "junction");
      installed.add(name);
    } catch (error) {
      logger.warn({ code: "claude_skill_unavailable", reason: String(error) }, "Skipping an unavailable Claude skill");
    }
  }
}
