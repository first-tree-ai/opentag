import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { SkillNameSchema } from "@opentag/shared";
import { SKILLS_DIRECTORY } from "./skill-manifest-store.js";

/**
 * Project `.skills/<name>` into the directories the Providers read relative to the Agent Home:
 * `<agentHome>/.claude/skills/<name>` for Claude Code (`--setting-sources project`) and
 * `<agentHome>/.agents/skills/<name>` for Codex (its repo-scoped skill root, discovered from the
 * thread cwd). Each entry becomes a relative symlink to `../../.skills/<name>`, so the projection
 * stays valid when the Agent Home moves and never reaches outside it.
 *
 * The projection owns only links that point into `.skills/`. Real directories (the Context Tree
 * installs `context-tree-*` under `.claude/skills/`), user-created entries, and links pointing
 * elsewhere are never created, replaced, or removed. Nothing is ever written to the Computer-wide
 * `$CODEX_HOME/skills`: skills stay per Agent inside the workspace.
 */

export const CLAUDE_SKILLS_DIRECTORY = posix.join(".claude", "skills");
export const CODEX_SKILLS_DIRECTORY = posix.join(".agents", "skills");
export type SkillProjectionTarget = "claude" | "codex";
export const SKILL_PROJECTION_TARGETS: Readonly<Record<SkillProjectionTarget, string>> = {
  claude: CLAUDE_SKILLS_DIRECTORY,
  codex: CODEX_SKILLS_DIRECTORY,
};
const PROJECTION_TARGET_PREFIX = `../../${SKILLS_DIRECTORY}/`;

export interface SkillProjectionResult {
  readonly linked: readonly string[];
  readonly removed: readonly string[];
  /** Names whose link could not be placed because a foreign entry already occupies the path. */
  readonly skipped: readonly string[];
}

export function claudeSkillsProjectionRoot(agentHome: string): string {
  return skillsProjectionRoot(agentHome, "claude");
}

export function codexSkillsProjectionRoot(agentHome: string): string {
  return skillsProjectionRoot(agentHome, "codex");
}

export function skillsProjectionRoot(agentHome: string, target: SkillProjectionTarget): string {
  return resolve(agentHome, ...SKILL_PROJECTION_TARGETS[target].split("/"));
}

export function projectionTarget(name: string): string {
  return `${PROJECTION_TARGET_PREFIX}${SkillNameSchema.parse(name)}`;
}

/** A link is ours only when it points into the managed `.skills/` directory with a relative target. */
async function ownedLinkTarget(path: string): Promise<string | undefined> {
  const status = await lstat(path);
  if (!status.isSymbolicLink()) return undefined;
  const target = await readlink(path);
  return target.startsWith(PROJECTION_TARGET_PREFIX) ? target : undefined;
}

async function placeLink(root: string, name: string): Promise<"linked" | "skipped"> {
  const path = resolve(root, name);
  const target = projectionTarget(name);
  try {
    const current = await ownedLinkTarget(path);
    if (current === target) return "linked";
    if (current === undefined) return "skipped";
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(target, path);
  return "linked";
}

/** Make every Provider projection directory contain exactly one owned link per name; idempotent. */
export async function projectSkills(
  agentHome: string,
  names: readonly string[],
): Promise<Record<SkillProjectionTarget, SkillProjectionResult>> {
  const wanted = new Set(names.map((name) => SkillNameSchema.parse(name)));
  return {
    claude: await projectInto(skillsProjectionRoot(agentHome, "claude"), wanted),
    codex: await projectInto(skillsProjectionRoot(agentHome, "codex"), wanted),
  };
}

async function projectInto(root: string, wanted: ReadonlySet<string>): Promise<SkillProjectionResult> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const name of wanted) {
    if ((await placeLink(root, name)) === "linked") linked.push(name);
    else skipped.push(name);
  }
  const removed: string[] = [];
  for (const entry of await readdir(root)) {
    if (wanted.has(entry) || entry.startsWith("context-tree-")) continue;
    const path = resolve(root, entry);
    if ((await ownedLinkTarget(path)) === undefined) continue;
    await unlink(path);
    removed.push(entry);
  }
  return { linked, removed, skipped };
}
