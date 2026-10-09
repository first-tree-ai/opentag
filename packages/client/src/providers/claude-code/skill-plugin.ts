import { mkdir, readFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSkillManifest } from "@opentag/shared";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("provider-claude-skills");

/** Selected skills keep their native metadata and resources; edits remain visible during the run. */
export async function linkClaudeSkills(pluginPath: string, paths: readonly string[]): Promise<void> {
  const root = join(pluginPath, "skills");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const installed = new Set<string>();
  for (const path of new Set(paths)) {
    try {
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
