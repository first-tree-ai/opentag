#!/usr/bin/env node
/**
 * Pre-flight a candidate Skill bundle before it is recorded in the preset catalog.
 *
 * Recording a preset means copying a bundle into `packages/skill-presets/skills/<name>/` and
 * declaring it in `packages/skill-presets/presets.yaml`; the generator then packs every bundle and
 * fails `pnpm check` on anything the catalog rejects. That is too late for a contributor carrying a
 * bundle in from elsewhere. This checker answers the same questions early, against a bundle that is
 * not in the repository yet, and writes nothing.
 *
 * It drives the same `packSkillDirectory` the upload and the generator use, so the Agent Skills
 * contract (manifest, reserved names, symlinks, entry/path/byte ceilings) is decided by one
 * implementation. On top of that it applies the catalog rules a candidate cannot see from inside its
 * own directory: the manifest name must not already be declared in `presets.yaml`, a supplied
 * category must be one that file declares, a supplied order must satisfy the shared contract, and
 * the candidate directory name must agree with the manifest name the catalog addresses it by.
 *
 * `--root` points the metadata read at a fixture repository; a script test sets it so it never
 * touches this repository. Like `check-skill-bundles.mjs`, it runs under `tsx` with
 * `scripts/tsconfig.scripts.json` because `pnpm check` runs before `pnpm build` and
 * `packages/shared/dist` does not exist yet.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { packSkillDirectory, SkillArchiveError } from "../packages/client/src/skills/skill-archive.ts";
import { SkillPresetCategoryIdSchema, SkillPresetSchema } from "../packages/shared/src/skill-preset.ts";

/**
 * The value of `--name`, or `undefined` when the option is absent. An option that is present with no
 * value is a violation rather than an omission: `--category` typed on its own must not produce a
 * green pre-flight that never looked at a category. `--root` points the checker at a fixture tree; a
 * script test sets it so it never touches the repo.
 */
function flag(name, violations) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined) {
    violations.push(`${name}: requires a value`);
    return undefined;
  }
  return value;
}

/** The candidate is the first positional argument; flags may appear before or after it. */
function positional() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      index += 1;
      continue;
    }
    return args[index];
  }
  return undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeIssues(error) {
  return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
}

/**
 * The catalog facts a candidate must be compared against: the declared category ids and the names
 * already taken. Both come from `presets.yaml`, the same source the generator reads.
 */
async function readCatalog(metadataPath, violations) {
  let parsed;
  try {
    parsed = parseYaml(await readFile(metadataPath, "utf8"));
  } catch (error) {
    violations.push(`${metadataPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { categories: [], names: new Set() };
  }
  if (!isRecord(parsed)) {
    violations.push(`${metadataPath}: the file must hold a mapping of "categories" and "presets"`);
    return { categories: [], names: new Set() };
  }
  return {
    categories: collectCategoryIds(parsed.categories, metadataPath, violations),
    names: collectPresetNames(parsed.presets, metadataPath, violations),
  };
}

function collectCategoryIds(value, metadataPath, violations) {
  if (!Array.isArray(value)) {
    violations.push(`${metadataPath}: "categories" must be a list`);
    return [];
  }
  return value.filter((row) => isRecord(row) && typeof row.id === "string").map((row) => row.id);
}

function collectPresetNames(value, metadataPath, violations) {
  if (!Array.isArray(value)) {
    violations.push(`${metadataPath}: "presets" must be a list`);
    return new Set();
  }
  const names = new Set();
  for (const row of value) {
    if (isRecord(row) && typeof row.name === "string") names.add(row.name);
  }
  return names;
}

/** Pack the candidate and require the directory name to be the name the catalog will address it by. */
async function checkCandidate(candidate, violations) {
  let packed;
  try {
    packed = await packSkillDirectory(candidate);
  } catch (error) {
    if (error instanceof SkillArchiveError) {
      violations.push(`${candidate}: ${error.code}: ${error.message}`);
      return undefined;
    }
    throw error;
  }
  const directoryName = basename(candidate.replace(/[/\\]+$/, ""));
  if (packed.name !== directoryName) {
    violations.push(
      `${candidate}: manifest name "${packed.name}" does not match the candidate directory name "${directoryName}"; the catalog addresses a bundle by its directory name, so rename the directory before entry`,
    );
  }
  return packed;
}

/**
 * The two fields a contributor supplies when the category or the display order is already decided.
 * `rawOrder` stays the argument string until its presence is established, so a value-less flag is
 * reported as a missing value instead of being converted into a number nobody supplied.
 */
function checkSuppliedMetadata(category, rawOrder, catalog, metadataPath) {
  const violations = [];
  if (category !== undefined) {
    const parsed = SkillPresetCategoryIdSchema.safeParse(category);
    if (!parsed.success) {
      violations.push(`--category: "${category}" is not a catalog category id`);
    } else if (!catalog.categories.includes(category)) {
      violations.push(`--category: "${category}" is not declared in ${metadataPath}`);
    }
  }
  if (rawOrder !== undefined) {
    const parsed = SkillPresetSchema.shape.order.safeParse(Number(rawOrder));
    if (!parsed.success) {
      violations.push(`--order: ${describeIssues(parsed.error)}`);
    }
  }
  return violations;
}

async function main() {
  const candidate = positional();
  if (candidate === undefined) {
    throw new Error(
      "usage: check-skill-preset-candidate <candidate-directory> [--root <repo>] [--category <id>] [--order <n>]",
    );
  }

  const violations = [];
  const overrideRoot = flag("--root", violations);
  const root = overrideRoot ? `${overrideRoot.replace(/[/\\]+$/, "")}/` : fileURLToPath(new URL("..", import.meta.url));
  const metadataPath = `${root}packages/skill-presets/presets.yaml`;

  const catalog = await readCatalog(metadataPath, violations);
  const packed = await checkCandidate(candidate, violations);
  if (packed !== undefined && catalog.names.has(packed.name)) {
    violations.push(`${candidate}: name "${packed.name}" is already declared in ${metadataPath}`);
  }
  violations.push(
    ...checkSuppliedMetadata(flag("--category", violations), flag("--order", violations), catalog, metadataPath),
  );

  if (violations.length > 0) {
    for (const violation of violations) console.error(`[skill-preset-candidate] ${violation}`);
    throw new Error(`The candidate bundle has ${violations.length} problem(s) and must not enter the catalog`);
  }

  console.log("[skill-preset-candidate] candidate is ready to enter the catalog");
  console.log(`[skill-preset-candidate] name: ${packed.name}`);
  console.log(`[skill-preset-candidate] sha256: ${packed.sha256}`);
  console.log(`[skill-preset-candidate] archive bytes: ${packed.archive.byteLength}`);
  console.log(`[skill-preset-candidate] file count: ${packed.fileCount}`);
  console.log(`[skill-preset-candidate] declared categories: ${catalog.categories.join(", ")}`);
}

await main();
