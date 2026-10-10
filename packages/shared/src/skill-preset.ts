import { z } from "zod";
import { SKILL_ARCHIVE_MAX_BYTES, SKILL_MAX_ENTRIES, SkillArchiveSha256Schema, SkillSchema } from "./skill.js";
import { SKILL_DESCRIPTION_MAX_LENGTH, SkillNameSchema } from "./skill-manifest.js";

/**
 * Preset Skill catalog contract.
 *
 * A preset is a Skill the platform's own team ships in this repository: its bundle is validated by
 * the same packer an upload uses and compiled into `@opentag/skill-presets`, and the Server serves
 * the catalog to the Account surface (Web, human CLI) and the session-proof runtime surface (Agent
 * CLI). Installing one materializes an ordinary Agent Skill whose `source` is `preset`.
 *
 * A catalog entry deliberately does not carry its own copy or an icon: the card text is the
 * Skill manifest's own `name`/`description`, the same text the Skills list already renders, and the
 * category taxonomy is fixed here so every consumer shares one vocabulary. Category labels are
 * user-facing copy and live in the Web message catalog, not in catalog data.
 */

/* --------------------------------- categories ------------------------------- */

/** The fixed taxonomy every preset chooses from. Adding one is a contract change. */
export const SKILL_PRESET_CATEGORY_IDS = ["getting-started", "engineering"] as const;
export type SkillPresetCategoryId = (typeof SKILL_PRESET_CATEGORY_IDS)[number];
export const SkillPresetCategoryIdSchema = z.enum(SKILL_PRESET_CATEGORY_IDS);

/* ----------------------------------- limits --------------------------------- */

export const SKILL_PRESET_MAX_ENTRIES = 128;
export const SKILL_PRESET_MAX_CATEGORIES = 16;
/** Display orders are sort keys with gaps, not indexes; the ceiling only keeps them machine-sized. */
const SKILL_PRESET_MAX_ORDER = 1_000_000;
/** Total decoded archive budget for the whole catalog, enforced when the catalog is generated. */
export const SKILL_PRESET_CATALOG_MAX_BYTES = 32 * 1024 * 1024;

/* --------------------------------- resources -------------------------------- */

export const SkillPresetCategorySchema = z
  .object({
    id: SkillPresetCategoryIdSchema,
    order: z.number().int().min(0).max(SKILL_PRESET_MAX_ORDER),
  })
  .strict();
export type SkillPresetCategory = z.infer<typeof SkillPresetCategorySchema>;

/**
 * How a preset relates to the target Agent's Skills. `update_available` is reserved for a Skill
 * whose `source` is `preset`, so the catalog can never overwrite content a user uploaded; a
 * same-named Skill from any other source reports `name_conflict` instead.
 */
export const SkillPresetStateSchema = z.enum(["not_installed", "installed", "update_available", "name_conflict"]);
export type SkillPresetState = z.infer<typeof SkillPresetStateSchema>;

export const SkillPresetSchema = z
  .object({
    name: SkillNameSchema,
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
    category: SkillPresetCategoryIdSchema,
    order: z.number().int().min(0).max(SKILL_PRESET_MAX_ORDER),
    archiveSha256: SkillArchiveSha256Schema,
    archiveBytes: z.number().int().min(1).max(SKILL_ARCHIVE_MAX_BYTES),
    fileCount: z.number().int().min(1).max(SKILL_MAX_ENTRIES),
    state: SkillPresetStateSchema,
  })
  .strict();
export type SkillPreset = z.infer<typeof SkillPresetSchema>;

export const ListSkillPresetsResponseSchema = z
  .object({
    categories: z.array(SkillPresetCategorySchema).min(1).max(SKILL_PRESET_MAX_CATEGORIES),
    presets: z.array(SkillPresetSchema).min(1).max(SKILL_PRESET_MAX_ENTRIES),
  })
  .strict();
export type ListSkillPresetsResponse = z.infer<typeof ListSkillPresetsResponseSchema>;

/** The write an install performed, as opposed to the state it read before writing. */
export const SkillPresetInstallActionSchema = z.enum(["installed", "updated", "unchanged"]);
export type SkillPresetInstallAction = z.infer<typeof SkillPresetInstallActionSchema>;

export const InstallSkillPresetResponseSchema = z
  .object({
    action: SkillPresetInstallActionSchema,
    skill: SkillSchema,
  })
  .strict();
export type InstallSkillPresetResponse = z.infer<typeof InstallSkillPresetResponseSchema>;
