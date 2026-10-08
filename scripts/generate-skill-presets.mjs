#!/usr/bin/env node
/**
 * Compile the preset Skill catalog from its committed sources into a committed TypeScript module.
 *
 * `packages/skill-presets/presets.yaml` names the bundles and the shared category taxonomy each one
 * belongs to; each bundle under `packages/skill-presets/skills/<name>/` is a real Skill directory.
 * This script packs every bundle with `packSkillDirectory` — the same packer an upload runs — and
 * emits `packages/skill-presets/src/presets.gen.ts` with the metadata and the base64 archives.
 *
 * Run it with `pnpm presets:generate` to write the module and with `--check` to reject drift;
 * `pnpm check` runs the latter. It mirrors `generate-mcp-catalog.mjs`: every invariant is enforced
 * here rather than at an install click, including the reserved-name rule, the manifest/directory
 * agreement, the category taxonomy, the declared-but-unused category, the per-archive ceilings, and
 * the total catalog budget.
 *
 * It runs under `tsx` because it reads `@opentag/shared` and the Client packer from source:
 * `pnpm check` runs before `pnpm build`, so neither package's `dist` exists yet.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { packSkillDirectory, SkillArchiveError } from "../packages/client/src/skills/skill-archive.ts";
import { parseSkillManifest, SkillNameSchema } from "../packages/shared/src/skill-manifest.ts";
import {
  SKILL_PRESET_CATALOG_MAX_BYTES,
  SKILL_PRESET_MAX_CATEGORIES,
  SKILL_PRESET_MAX_ENTRIES,
  SkillPresetCategorySchema,
  SkillPresetSchema,
} from "../packages/shared/src/skill-preset.ts";

/** `--root` points the generator at a fixture tree; a script test sets it so it never touches the repo. */
function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const overrideRoot = flag("--root");
const root = overrideRoot ? `${overrideRoot.replace(/[/\\]+$/, "")}/` : fileURLToPath(new URL("..", import.meta.url));
const presetsRoot = `${root}packages/skill-presets`;
const metadataPath = `${presetsRoot}/presets.yaml`;
const skillsDirectory = `${presetsRoot}/skills`;
const targetPath = `${presetsRoot}/src/presets.gen.ts`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeIssues(error) {
  return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ");
}

async function readMetadata(violations) {
  let parsed;
  try {
    parsed = parseYaml(await readFile(metadataPath, "utf8"));
  } catch (error) {
    violations.push(`${metadataPath}: ${error instanceof Error ? error.message : String(error)}`);
    return { categories: [], presets: [] };
  }
  if (!isRecord(parsed)) {
    violations.push(`${metadataPath}: the file must hold a mapping of "categories" and "presets"`);
    return { categories: [], presets: [] };
  }
  return parsed;
}

/** Category rows are the shared contract's shape: a taxonomy id and a small integer order. */
function collectCategories(value, violations) {
  if (!Array.isArray(value)) {
    violations.push(`${metadataPath}: "categories" must be a list`);
    return [];
  }
  if (value.length > SKILL_PRESET_MAX_CATEGORIES) {
    violations.push(`${metadataPath}: more than ${SKILL_PRESET_MAX_CATEGORIES} categories are declared`);
  }
  const categories = [];
  const seen = new Set();
  value.forEach((row, index) => {
    const at = `${metadataPath} categories[${index}]`;
    const parsed = SkillPresetCategorySchema.safeParse(row);
    if (!parsed.success) {
      violations.push(`${at}: ${describeIssues(parsed.error)}`);
      return;
    }
    if (seen.has(parsed.data.id)) {
      violations.push(`${at}: duplicate category id "${parsed.data.id}"`);
      return;
    }
    seen.add(parsed.data.id);
    categories.push(parsed.data);
  });
  return categories;
}

/** Preset rows name a bundle, a declared category, and a display order; the content lives on disk. */
function collectPresets(value, categoryIds, violations) {
  if (!Array.isArray(value)) {
    violations.push(`${metadataPath}: "presets" must be a list`);
    return [];
  }
  if (value.length > SKILL_PRESET_MAX_ENTRIES) {
    violations.push(`${metadataPath}: more than ${SKILL_PRESET_MAX_ENTRIES} presets are declared`);
  }
  const presets = [];
  const seen = new Set();
  value.forEach((row, index) => {
    const at = `${metadataPath} presets[${index}]`;
    if (!isRecord(row)) {
      violations.push(`${at}: must be a mapping`);
      return;
    }
    const name = SkillNameSchema.safeParse(row.name);
    if (!name.success) {
      violations.push(`${at}.name: ${describeIssues(name.error)}`);
      return;
    }
    if (seen.has(name.data)) {
      violations.push(`${at}: duplicate preset name "${name.data}"`);
      return;
    }
    seen.add(name.data);
    if (typeof row.category !== "string" || !categoryIds.has(row.category)) {
      violations.push(`${at}.category: "${String(row.category)}" is not declared in presets.yaml`);
      return;
    }
    if (typeof row.order !== "number" || !Number.isFinite(row.order) || row.order < 0) {
      violations.push(`${at}.order: "order" must be a non-negative finite number`);
      return;
    }
    presets.push({ name: name.data, category: row.category, order: row.order });
  });
  return presets;
}

/**
 * The `skills/` directory is the packer's input, so a stray file, a symlink, or a bundle no preset
 * references is a catalog problem rather than something to ignore.
 */
async function collectBundleDirectories(violations) {
  let entries;
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      violations.push(`${skillsDirectory}: the preset skills directory does not exist`);
      return new Map();
    }
    throw error;
  }
  const directories = new Map();
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      violations.push(`skills/${entry.name}: symlinks are not permitted; a bundle must be a real directory`);
      continue;
    }
    if (!entry.isDirectory()) {
      violations.push(`skills/${entry.name}: only a Skill bundle directory may live under skills/`);
      continue;
    }
    directories.set(entry.name, `${skillsDirectory}/${entry.name}`);
  }
  return directories;
}

/** Pack one bundle and read the manifest facts the catalog carries. */
async function readBundledPreset(preset, directory, violations) {
  let packed;
  try {
    packed = await packSkillDirectory(directory);
  } catch (error) {
    if (error instanceof SkillArchiveError) {
      violations.push(`skills/${preset.name}: ${error.code}: ${error.message}`);
      return undefined;
    }
    throw error;
  }
  if (packed.name !== preset.name) {
    violations.push(`skills/${preset.name}: manifest name "${packed.name}" does not match the preset name`);
    return undefined;
  }
  const manifest = parseSkillManifest(await readFile(`${directory}/SKILL.md`, "utf8"));
  if (!manifest.ok) {
    violations.push(`skills/${preset.name}: ${manifest.reason}`);
    return undefined;
  }
  const entry = {
    name: packed.name,
    description: manifest.manifest.description,
    category: preset.category,
    order: preset.order,
    archiveSha256: packed.sha256,
    archiveBytes: packed.archive.byteLength,
    fileCount: packed.fileCount,
  };
  // The generated row is the contract the Server and clients parse, minus the runtime state the
  // Server adds; validating it here keeps this script from emitting a module the API would reject.
  const contract = SkillPresetSchema.omit({ state: true }).safeParse(entry);
  if (!contract.success) {
    violations.push(`skills/${preset.name}: ${describeIssues(contract.error)}`);
    return undefined;
  }
  return { entry, archiveBase64: Buffer.from(packed.archive).toString("base64") };
}

function orderedCategories(categories) {
  return [...categories].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/**
 * A string property in the emitted module, wrapped the way Biome formats a line over 120 columns: a
 * long description or base64 payload moves to its own line rather than making the checked-in module
 * fail formatting.
 */
function stringProperty(key, value, indent) {
  const quoted = JSON.stringify(value);
  const inline = `${indent}${key}: ${quoted},`;
  if (inline.length <= 120) return [inline];
  return [`${indent}${key}:`, `${indent}  ${quoted},`];
}

function emitModule(categories, entries) {
  const categoryOrder = new Map(categories.map((category) => [category.id, category.order]));
  const orderedEntries = [...entries].sort(
    (left, right) =>
      (categoryOrder.get(left.category) ?? 0) - (categoryOrder.get(right.category) ?? 0) ||
      left.order - right.order ||
      left.name.localeCompare(right.name),
  );

  const lines = [
    "/**",
    " * Generated by scripts/generate-skill-presets.mjs from presets.yaml and skills/*.",
    " * Do not edit by hand. Run `pnpm presets:generate`.",
    " */",
    'import type { SkillPresetCategoryId } from "@opentag/shared";',
    "",
    "/** One catalog category in tab order. */",
    "export type PresetSkillCategory = {",
    "  id: SkillPresetCategoryId;",
    "  order: number;",
    "};",
    "",
    "/** One packed preset bundle; `archiveBase64` is the deterministic tar.gz the packer produced. */",
    "export type PresetSkillArchive = {",
    "  name: string;",
    "  description: string;",
    "  category: SkillPresetCategoryId;",
    "  order: number;",
    "  archiveSha256: string;",
    "  archiveBytes: number;",
    "  fileCount: number;",
    "  archiveBase64: string;",
    "};",
    "",
    "/** Tab order is this array's order. */",
    "export const PRESET_SKILL_CATEGORIES: readonly PresetSkillCategory[] = [",
  ];
  for (const category of orderedCategories(categories)) {
    lines.push("  {", `    id: ${JSON.stringify(category.id)},`, `    order: ${category.order},`, "  },");
  }
  lines.push(
    "];",
    "",
    "/** Grouped by category order, then preset order. */",
    "export const PRESET_SKILL_ARCHIVES: readonly PresetSkillArchive[] = [",
  );
  for (const entry of orderedEntries) {
    lines.push(
      "  {",
      ...stringProperty("name", entry.name, "    "),
      ...stringProperty("description", entry.description, "    "),
    );
    lines.push(
      `    category: ${JSON.stringify(entry.category)},`,
      `    order: ${entry.order},`,
      ...stringProperty("archiveSha256", entry.archiveSha256, "    "),
      `    archiveBytes: ${entry.archiveBytes},`,
      `    fileCount: ${entry.fileCount},`,
      ...stringProperty("archiveBase64", entry.archiveBase64, "    "),
      "  },",
    );
  }
  lines.push("];", "");
  return lines.join("\n");
}

async function main() {
  const violations = [];
  const metadata = await readMetadata(violations);
  const categories = collectCategories(metadata.categories, violations);
  const categoryIds = new Set(categories.map((category) => category.id));
  const presets = collectPresets(metadata.presets, categoryIds, violations);
  const bundleDirectories = await collectBundleDirectories(violations);

  checkCatalogIntegrity(presets, categories, bundleDirectories, violations);
  const bundledEntries = await packPresets(presets, bundleDirectories, violations);
  checkCatalogBudget(bundledEntries, violations);

  if (violations.length > 0) {
    for (const violation of violations) console.error(`[skill-presets] ${violation}`);
    throw new Error(`The preset Skill catalog has ${violations.length} problem(s)`);
  }

  const text = emitModule(
    categories,
    bundledEntries.map((bundled) => ({ ...bundled.entry, archiveBase64: bundled.archiveBase64 })),
  );
  if (process.argv.includes("--check")) {
    const current = await readFile(targetPath, "utf8").catch(() => "");
    if (current !== text) {
      throw new Error("The generated preset Skill catalog is out of date. Run pnpm presets:generate.");
    }
    console.log("[skill-presets] generated module is current");
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, text);
  console.log(`[skill-presets] wrote ${targetPath}`);
}

/** Every declared category is used, and every bundle on disk is referenced by a preset. */
function checkCatalogIntegrity(presets, categories, bundleDirectories, violations) {
  for (const category of categories) {
    if (!presets.some((preset) => preset.category === category.id)) {
      violations.push(`${metadataPath}: category "${category.id}" is declared but no preset uses it`);
    }
  }
  const referenced = new Set(presets.map((preset) => preset.name));
  for (const name of bundleDirectories.keys()) {
    if (!referenced.has(name)) {
      violations.push(`skills/${name}: the bundle is not referenced by any preset in presets.yaml`);
    }
  }
}

/** Pack every referenced bundle, collecting what the generated module will carry. */
async function packPresets(presets, bundleDirectories, violations) {
  const bundledEntries = [];
  for (const preset of presets) {
    const directory = bundleDirectories.get(preset.name);
    if (directory === undefined) {
      violations.push(`skills/${preset.name}: the bundle directory does not exist`);
      continue;
    }
    const bundled = await readBundledPreset(preset, directory, violations);
    if (bundled !== undefined) bundledEntries.push(bundled);
  }
  return bundledEntries;
}

function checkCatalogBudget(bundledEntries, violations) {
  const totalBytes = bundledEntries.reduce((total, bundled) => total + bundled.entry.archiveBytes, 0);
  if (totalBytes > SKILL_PRESET_CATALOG_MAX_BYTES) {
    violations.push(
      `${metadataPath}: the catalog packs to ${totalBytes} bytes, beyond the ${SKILL_PRESET_CATALOG_MAX_BYTES} byte budget`,
    );
  }
}

await main();
