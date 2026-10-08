import type { SkillPresetCategoryId } from "@opentag/shared";
import { PRESET_SKILL_ARCHIVES, PRESET_SKILL_CATEGORIES } from "./presets.gen.js";

/**
 * The repository's preset Skill catalog: the metadata every discovery surface serves plus the
 * decoded archives the Server installs.
 *
 * `presets.gen.ts` is generated from `presets.yaml` and `skills/*` by
 * `scripts/generate-skill-presets.mjs` and committed; every bundle was packed by the same packer an
 * upload uses, so the bytes here are exactly what `SkillService.upload` would store. The Server is
 * the only consumer of the archives; clients read the catalog over the API.
 */

export interface PresetSkillCategory {
  readonly id: SkillPresetCategoryId;
  readonly order: number;
}

export interface PresetSkill {
  readonly name: string;
  readonly description: string;
  readonly category: SkillPresetCategoryId;
  readonly order: number;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly fileCount: number;
  /** The deterministic `tar.gz` the upload packer produced. */
  readonly archive: Uint8Array;
}

/** Tab order is this array's order. */
export const SKILL_PRESET_CATEGORIES: readonly PresetSkillCategory[] = PRESET_SKILL_CATEGORIES;

/** Grouped by category order, then preset order. */
export const SKILL_PRESETS: readonly PresetSkill[] = PRESET_SKILL_ARCHIVES.map((entry) => ({
  name: entry.name,
  description: entry.description,
  category: entry.category,
  order: entry.order,
  archiveSha256: entry.archiveSha256,
  archiveBytes: entry.archiveBytes,
  fileCount: entry.fileCount,
  archive: new Uint8Array(Buffer.from(entry.archiveBase64, "base64")),
}));

export function findSkillPreset(name: string): PresetSkill | undefined {
  return SKILL_PRESETS.find((preset) => preset.name === name);
}
