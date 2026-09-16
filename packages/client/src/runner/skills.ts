import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { type ContextTreePackage, resolveContextTreePackage } from "../runtime/context-tree.js";

/** Packaged Context Tree skills OpenTag ships to Pi. Matches scripts/portable/runtime-dependencies.mjs. */
export const CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES = Object.freeze([
  "context-tree-connect",
  "context-tree-create",
  "context-tree-publish",
  "context-tree-read",
  "context-tree-setup",
  "context-tree-write",
]);

/**
 * Source-owned Git/gh/Slack/Lark skill guidance assembled into the image at /opt/opentag/skills.
 * Host checkouts do not ship them; override with OPENTAG_RUNNER_SKILLS_DIR for relocated runs.
 */
export const RUNNER_TOOL_SKILL_DIRECTORIES = Object.freeze(["git", "gh", "lark-cli", "slack"]);
const DEFAULT_RUNNER_SKILLS_DIR = "/opt/opentag/skills";

export interface AssembledContextTreeSkill {
  readonly directory: string;
  readonly name: string;
  readonly skillFile: string;
}

export interface AssembledContextTreeSkills {
  readonly package: ContextTreePackage;
  readonly skillPaths: readonly string[];
  readonly skills: readonly AssembledContextTreeSkill[];
  readonly skillsPath: string;
}

export interface AssembledRunnerToolSkills {
  readonly skills: readonly AssembledContextTreeSkill[];
  readonly skillsPath: string;
}

/** Image-assembled tool skills; empty when the runner skills directory is absent (host dev). */
export async function assembleRunnerToolSkills(from?: string): Promise<AssembledRunnerToolSkills> {
  const skillsPath = from ?? process.env.OPENTAG_RUNNER_SKILLS_DIR ?? DEFAULT_RUNNER_SKILLS_DIR;
  const skills: AssembledContextTreeSkill[] = [];
  let present = false;
  try {
    present = (await stat(skillsPath)).isDirectory();
  } catch {
    present = false;
  }
  if (present) {
    for (const name of RUNNER_TOOL_SKILL_DIRECTORIES) {
      const directory = join(skillsPath, name);
      const skillFile = join(directory, "SKILL.md");
      const [dirStats, fileStats] = await Promise.all([stat(directory), stat(skillFile)]);
      if (!dirStats.isDirectory() || !fileStats.isFile()) {
        throw new Error(`Runner tool skill ${name} is incomplete under ${skillsPath}`);
      }
      skills.push({ directory, name, skillFile });
    }
  }
  return { skills, skillsPath };
}

async function requireSkillDirectory(skillsPath: string, name: string): Promise<AssembledContextTreeSkill> {
  const directory = join(skillsPath, name);
  const skillFile = join(directory, "SKILL.md");
  const [dirStats, fileStats] = await Promise.all([stat(directory), stat(skillFile)]);
  if (!dirStats.isDirectory()) throw new Error(`Context Tree skill ${name} is not a directory`);
  if (!fileStats.isFile()) throw new Error(`Context Tree skill ${name} is missing SKILL.md`);
  return { directory, name, skillFile };
}

/**
 * Assemble the six packaged Context Tree skills using the real Client package resolver.
 * Extra directories that may exist in the npm package are ignored on purpose.
 */
export async function assembleContextTreeSkills(from?: string): Promise<AssembledContextTreeSkills> {
  const contextTreePackage = resolveContextTreePackage(from);
  if (!contextTreePackage) throw new Error("Context Tree package is not resolvable");
  const entries = await readdir(contextTreePackage.skillsPath);
  const present = new Set(entries);
  const missing = CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(`Context Tree packaged skills missing: ${missing.join(", ")}`);
  }
  const skills = await Promise.all(
    CONTEXT_TREE_PACKAGED_SKILL_DIRECTORIES.map((name) => requireSkillDirectory(contextTreePackage.skillsPath, name)),
  );
  return {
    package: contextTreePackage,
    skillsPath: contextTreePackage.skillsPath,
    skillPaths: skills.map((skill) => skill.directory),
    skills,
  };
}
