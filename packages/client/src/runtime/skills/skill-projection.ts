import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { SkillNameSchema } from "@opentag/shared";
import { SKILLS_DIRECTORY } from "./skill-manifest-store.js";

/**
 * Project `.skills/<name>` into the directory Claude Code reads with `--setting-sources project`:
 * `<agentHome>/.claude/skills/<name>` becomes a relative symlink to `../../.skills/<name>`.
 *
 * The projection owns only links that point into `.skills/`. Real directories (the Context Tree
 * installs `context-tree-*` there), user-created entries, and links pointing elsewhere are never
 * created, replaced, or removed.
 *
 * Codex reads skills from `$CODEX_HOME/skills`, which is one directory shared by every agent on
 * the Computer, so per-agent assignments cannot be projected there without cross-agent leakage;
 * Codex projection is deliberately not implemented here.
 */

export const CLAUDE_SKILLS_DIRECTORY = posix.join(".claude", "skills");
const PROJECTION_TARGET_PREFIX = `../../${SKILLS_DIRECTORY}/`;

export interface SkillProjectionResult {
  readonly linked: readonly string[];
  readonly removed: readonly string[];
  /** Names whose link could not be placed because a foreign entry already occupies the path. */
  readonly skipped: readonly string[];
}

export function claudeSkillsProjectionRoot(agentHome: string): string {
  return resolve(agentHome, ".claude", "skills");
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

/** Make `.claude/skills/` contain exactly one owned link per name; idempotent. */
export async function projectSkills(agentHome: string, names: readonly string[]): Promise<SkillProjectionResult> {
  const root = claudeSkillsProjectionRoot(agentHome);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const wanted = new Set(names.map((name) => SkillNameSchema.parse(name)));
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
