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
 * It runs under `tsx` because it reads the shared contract from source: `pnpm check` runs before
 * `pnpm build`, so `packages/shared/dist` does not exist yet.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_MAX_ENTRIES, SKILL_MAX_PATH_BYTES, SKILL_UNPACKED_MAX_BYTES } from "../packages/shared/src/skill.ts";
import {
  isReservedSkillName,
  parseSkillManifest,
  SKILL_MANIFEST_MAX_BYTES,
  SkillNameSchema,
} from "../packages/shared/src/skill-manifest.ts";

/** The manifest a bundle must carry at its root, and the only member with a fixed name. */
const MANIFEST = "SKILL.md";

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const overrideRoot = flag("--root");
const root = overrideRoot ? `${overrideRoot.replace(/[/\\]+$/, "")}/` : fileURLToPath(new URL("..", import.meta.url));
const skillsDirectory = `${root}skills`;

/** Every member of one bundle, and the totals the server bounds an upload by. */
async function walk(directory, prefix, totals, violations) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = join(directory, entry.name);
    totals.entries += 1;
    if (Buffer.byteLength(path, "utf8") > SKILL_MAX_PATH_BYTES) {
      violations.push(`${path}: path exceeds ${SKILL_MAX_PATH_BYTES} bytes`);
    }
    if (entry.isSymbolicLink()) {
      // The server refuses links outright: an archive member that points outside the bundle would
      // write wherever it resolved to on the Computer that materializes it.
      violations.push(`${path}: symlinks are not permitted in a Skill bundle`);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(absolute, path, totals, violations);
      continue;
    }
    if (!entry.isFile()) {
      violations.push(`${path}: only regular files and directories are permitted`);
      continue;
    }
    totals.bytes += (await stat(absolute)).size;
  }
}

/** Validate one Skill bundle, pushing every problem it has rather than stopping at the first. */
async function checkBundle(name, violations) {
  const bundle = `${skillsDirectory}/${name}`;
  const manifestPath = `${bundle}/${MANIFEST}`;
  const at = `skills/${name}`;

  let markdown;
  try {
    markdown = await readFile(manifestPath, "utf8");
  } catch {
    violations.push(`${at}: ${MANIFEST} is missing`);
    return;
  }
  if (Buffer.byteLength(markdown, "utf8") > SKILL_MANIFEST_MAX_BYTES) {
    violations.push(`${at}/${MANIFEST}: exceeds ${SKILL_MANIFEST_MAX_BYTES} bytes`);
    return;
  }

  const parsed = parseSkillManifest(markdown);
  if (!parsed.ok) {
    violations.push(`${at}/${MANIFEST}: ${parsed.reason}`);
    return;
  }
  const manifest = parsed.manifest;
  if (!SkillNameSchema.safeParse(manifest.name).success) {
    violations.push(`${at}/${MANIFEST}: "name" is not a valid Skill name`);
  }
  // The directory name is what `opentag skill push` reports against on a collision, so a bundle
  // whose two names disagree is not addressable by the name it carries.
  if (manifest.name !== name) {
    violations.push(`${at}: manifest name "${manifest.name}" does not match the directory name`);
  }
  if (isReservedSkillName(manifest.name)) {
    violations.push(`${at}: "${manifest.name}" is reserved by the platform`);
  }

  const totals = { entries: 0, bytes: 0 };
  await walk(bundle, "", totals, violations);
  if (totals.entries > SKILL_MAX_ENTRIES) {
    violations.push(`${at}: ${totals.entries} members exceed the ${SKILL_MAX_ENTRIES} bound`);
  }
  if (totals.bytes > SKILL_UNPACKED_MAX_BYTES) {
    violations.push(`${at}: ${totals.bytes} unpacked bytes exceed the ${SKILL_UNPACKED_MAX_BYTES} bound`);
  }
}

async function main() {
  const violations = [];
  let names;
  try {
    const entries = await readdir(skillsDirectory, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") {
      // A repository with no first-party Skill bundles is valid.
      console.log("[skill-bundles] no skills/ directory to check");
      return;
    }
    throw error;
  }

  for (const name of names) await checkBundle(name, violations);

  if (violations.length > 0) {
    for (const violation of violations) console.error(`[skill-bundles] ${violation}`);
    throw new Error(`The Skill bundles have ${violations.length} problem(s)`);
  }
  console.log(`[skill-bundles] ${names.length} bundle(s) match the Agent Skills contract`);
}

await main();
