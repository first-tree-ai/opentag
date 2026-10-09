import { z } from "zod";
import { MCPAuthKindSchema, MCPServerNameSchema } from "./mcp.js";
import { SKILL_DESCRIPTION_MAX_LENGTH, SkillNameSchema } from "./skill-manifest.js";
import { SkillPresetCategoryIdSchema } from "./skill-preset.js";

/**
 * Public catalog contract.
 *
 * The display-only projection of the platform's repo-shipped catalogs — the preset Skills in
 * `@opentag/skill-presets` and the MCP marketplace in `@opentag/mcp-presets` — served anonymously to
 * the official website. Every field is something a card renders: no archive identity, no per-Agent
 * install state, and no MCP endpoint URL or authorization prefill configuration. See
 * `docs/deploying.md` for the origin rules.
 *
 * Browser-compatible like every module the browser entrypoint re-exports: it imports nothing from
 * the Node standard library.
 */

/* ------------------------------- localized copy ------------------------------ */

/** Both locales are always present, so a consumer never falls back to another one. */
export const PublicCatalogLocalizedTextSchema = z
  .object({
    en: z.string().min(1),
    zh: z.string().min(1),
  })
  .strict();
export type PublicCatalogLocalizedText = z.infer<typeof PublicCatalogLocalizedTextSchema>;

/* --------------------------------- Skill catalog ----------------------------- */

/** A preset Skill category. Labels live with the consumer; the id is the shared taxonomy. */
export const PublicSkillCatalogCategorySchema = z
  .object({
    id: SkillPresetCategoryIdSchema,
    order: z.number().int().min(0),
  })
  .strict();
export type PublicSkillCatalogCategory = z.infer<typeof PublicSkillCatalogCategorySchema>;

export const PublicSkillCatalogPresetSchema = z
  .object({
    name: SkillNameSchema,
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
    category: SkillPresetCategoryIdSchema,
    order: z.number().int().min(0),
  })
  .strict();
export type PublicSkillCatalogPreset = z.infer<typeof PublicSkillCatalogPresetSchema>;

export const PublicSkillCatalogResponseSchema = z
  .object({
    categories: z.array(PublicSkillCatalogCategorySchema),
    presets: z.array(PublicSkillCatalogPresetSchema),
  })
  .strict();
export type PublicSkillCatalogResponse = z.infer<typeof PublicSkillCatalogResponseSchema>;

/* ---------------------------------- MCP catalog ------------------------------ */

export const PublicMcpCatalogCategorySchema = z
  .object({
    id: z.string().min(1),
    label: PublicCatalogLocalizedTextSchema,
    order: z.number().int().min(0),
  })
  .strict();
export type PublicMcpCatalogCategory = z.infer<typeof PublicMcpCatalogCategorySchema>;

export const PublicMcpCatalogServerSchema = z
  .object({
    id: z.string().min(1),
    name: MCPServerNameSchema,
    title: PublicCatalogLocalizedTextSchema,
    description: PublicCatalogLocalizedTextSchema,
    category: z.string().min(1),
    website: z.string().url(),
    iconUrl: z.string().min(1),
    order: z.number().int().min(0),
    defaultAuthKind: MCPAuthKindSchema,
  })
  .strict();
export type PublicMcpCatalogServer = z.infer<typeof PublicMcpCatalogServerSchema>;

export const PublicMcpCatalogResponseSchema = z
  .object({
    categories: z.array(PublicMcpCatalogCategorySchema),
    servers: z.array(PublicMcpCatalogServerSchema),
  })
  .strict();
export type PublicMcpCatalogResponse = z.infer<typeof PublicMcpCatalogResponseSchema>;
