#!/usr/bin/env node
/**
 * Validate every committed first-party Skill bundle under `skills/` against the Agent Skills
 * contract.
 *
 * A Skill is a directory with a root `SKILL.md` plus supporting files; an operator uploads one with
 * `opentag skill push <dir>`, and the Server validates it again before it stores anything. Doing that
 * work here as well means an invalid manifest fails `pnpm check` in the pull request that wrote it,
 * instead of failing an operator's upload later.
 *
 * This script drives the same `packSkillDirectory` the upload runs rather than restating its rules.
 * A local restatement would drift from the packer, and the rules that matter most cannot be
 * restated at all: the packed archive's byte ceiling exists only on the compressed stream, and a
 * symlinked bundle root looks like nothing in particular to a directory walk.
 *
 * It runs under tsx, and `pnpm check` runs before `pnpm build`, so `packages/shared/dist` does not
 * exist yet. `scripts/tsconfig.scripts.json` maps `@opentag/shared` to its source for that reason,
 * and `package.json` passes it with `--tsconfig`.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { packSkillDirectory, SkillArchiveError } from "../packages/client/src/skills/skill-archive.ts";

/** `--root` points the checker at a fixture tree; a script test sets it so it never touches the repo. */
function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const overrideRoot = flag("--root");
const root = overrideRoot ? `${overrideRoot.replace(/[/\\]+$/, "")}/` : fileURLToPath(new URL("..", import.meta.url));
const skillsDirectory = `${root}skills`;

/**
 * The bundle directory names under `skills/`, in a stable order.
 *
 * Every direct member must be one. `Dirent.isDirectory()` is false for a symlink, so filtering on it
 * would drop `skills/linked -> ../elsewhere` before anything looked at it, while the upload refuses a
 * symlinked root outright.
 */
function collectBundles(entries, violations) {
  const names = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      violations.push(`skills/${entry.name}: symlinks are not permitted; a bundle must be a real directory`);
      continue;
    }
    if (!entry.isDirectory()) {
      violations.push(`skills/${entry.name}: only a Skill bundle directory may live under skills/`);
      continue;
    }
    names.push(entry.name);
  }
  return names;
}

/** Validate one bundle by packing it: the one operation that decides what an upload accepts. */
async function checkBundle(name, violations) {
  const at = `skills/${name}`;
  let packed;
  try {
    packed = await packSkillDirectory(`${skillsDirectory}/${name}`);
  } catch (error) {
    if (error instanceof SkillArchiveError) {
      violations.push(`${at}: ${error.code}: ${error.message}`);
      return;
    }
    throw error;
  }
  // The directory name is what `opentag skill push` reports against on a collision, so a bundle
  // whose two names disagree is not addressable by the name it carries.
  if (packed.name !== name) {
    violations.push(`${at}: manifest name "${packed.name}" does not match the directory name`);
  }
}

async function main() {
  const violations = [];
  let entries;
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      // A repository with no first-party Skill bundles is valid.
      console.log("[skill-bundles] no skills/ directory to check");
      return;
    }
    throw error;
  }

  const names = collectBundles(entries, violations);
  for (const name of names) await checkBundle(name, violations);

  if (violations.length > 0) {
    for (const violation of violations) console.error(`[skill-bundles] ${violation}`);
    throw new Error(`The Skill bundles have ${violations.length} problem(s)`);
  }
  console.log(`[skill-bundles] ${names.length} bundle(s) match the Agent Skills contract`);
}

await main();
