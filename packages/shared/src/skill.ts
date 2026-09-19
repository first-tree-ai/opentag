import { z } from "zod";
import { SKILL_DESCRIPTION_MAX_LENGTH, SkillNameSchema } from "./skill-manifest.js";

export * from "./skill-manifest.js";

/**
 * Agent Skills contract.
 *
 * A Skill is a directory containing a `SKILL.md` manifest plus supporting files, uploaded to the
 * platform, stored as one archive object, owned by exactly one Agent, and materialized into that
 * Agent's workspace at runtime. This module is the shared contract only: the Server, Client/CLI and
 * Web lanes build on these schemas, constants, and parsing rules. See
 * `docs/design/agent-skills.md`. Manifest parsing lives in `./skill-manifest.ts`, which this module
 * re-exports.
 *
 * Like every module under `src/` that the browser entrypoint re-exports, this one is
 * browser-compatible: it imports nothing from the Node standard library and never uses the Node
 * byte-array global. Byte lengths are measured with `TextEncoder`, as `mcp.ts` does.
 */

/* ---------------------------------- limits --------------------------------- */

export const SKILL_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
export const SKILL_UNPACKED_MAX_BYTES = 64 * 1024 * 1024;
export const SKILL_MAX_ENTRIES = 1000;
export const SKILL_MAX_PATH_BYTES = 256;
export const SKILL_MAX_PER_AGENT = 64;
export const SKILL_MAX_LISTED_FILES = 500;
export const SKILL_MANIFEST_FILE = "SKILL.md";
/**
 * The marker the Client writes inside every platform-managed skill directory. Sync only ever
 * rewrites directories that carry it, so a Skill an Agent authors locally, and every Context Tree
 * skill, is left alone.
 */
export const SKILL_MARKER_FILE = ".opentag-skill.json";

/* --------------------------------- resources ------------------------------- */

const SkillIdSchema = z.string().uuid();
export const SkillSourceSchema = z.enum(["web_upload", "cli_upload", "agent_upload"]);
export type SkillSource = z.infer<typeof SkillSourceSchema>;
export const SkillArchiveFormatSchema = z.enum(["tar.gz", "zip"]);
export type SkillArchiveFormat = z.infer<typeof SkillArchiveFormatSchema>;
export const SkillStorageStatusSchema = z.enum(["available", "unavailable"]);
export type SkillStorageStatus = z.infer<typeof SkillStorageStatusSchema>;

/** Lowercase hex SHA-256 of the stored archive. */
export const SkillArchiveSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export type SkillArchiveSha256 = z.infer<typeof SkillArchiveSha256Schema>;

export const SkillFileEntrySchema = z
  .object({
    path: z.string().min(1).max(SKILL_MAX_PATH_BYTES),
    bytes: z.number().int().min(0),
  })
  .strict();
export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;

export const SkillSchema = z
  .object({
    id: SkillIdSchema,
    agentId: SkillIdSchema,
    name: SkillNameSchema,
    description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH),
    enabled: z.boolean(),
    source: SkillSourceSchema,
    archiveSha256: SkillArchiveSha256Schema,
    archiveBytes: z.number().int().min(1).max(SKILL_ARCHIVE_MAX_BYTES),
    fileCount: z.number().int().min(1).max(SKILL_MAX_ENTRIES),
    revision: z.number().int().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Skill = z.infer<typeof SkillSchema>;

export const SkillDetailSchema = SkillSchema.extend({
  files: z.array(SkillFileEntrySchema).max(SKILL_MAX_LISTED_FILES),
  filesTruncated: z.boolean(),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const ListAgentSkillsResponseSchema = z
  .object({
    skills: z.array(SkillSchema),
    storage: SkillStorageStatusSchema,
  })
  .strict();
export type ListAgentSkillsResponse = z.infer<typeof ListAgentSkillsResponseSchema>;

export const UpdateSkillRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequestSchema>;

/** One enabled Skill as a Computer needs it to fetch and verify a bundle. */
export const RuntimeSkillManifestEntrySchema = z
  .object({
    id: SkillIdSchema,
    name: SkillNameSchema,
    archiveSha256: SkillArchiveSha256Schema,
    archiveBytes: z.number().int().min(1).max(SKILL_ARCHIVE_MAX_BYTES),
  })
  .strict();
export type RuntimeSkillManifestEntry = z.infer<typeof RuntimeSkillManifestEntrySchema>;

export const RuntimeSkillManifestSchema = z
  .object({
    skills: z.array(RuntimeSkillManifestEntrySchema).max(SKILL_MAX_PER_AGENT),
  })
  .strict();
export type RuntimeSkillManifest = z.infer<typeof RuntimeSkillManifestSchema>;

/** The content of `SKILL_MARKER_FILE` written inside every platform-managed skill directory. */
export const SkillInstallMarkerSchema = z
  .object({
    skillId: SkillIdSchema,
    archiveSha256: SkillArchiveSha256Schema,
  })
  .strict();
export type SkillInstallMarker = z.infer<typeof SkillInstallMarkerSchema>;

/* ------------------------------ upload headers ----------------------------- */

export const SKILL_SHA256_HEADER = "x-opentag-skill-sha256";
export const SKILL_FORMAT_HEADER = "x-opentag-skill-format";
export const SKILL_REPLACE_HEADER = "x-opentag-skill-replace";
export const SKILL_UPLOAD_CONTENT_TYPE = "application/octet-stream";

/* ---------------------------------- errors --------------------------------- */

export const SKILL_ERROR_CODES = {
  NOT_FOUND: "SKILL_NOT_FOUND",
  NAME_CONFLICT: "SKILL_NAME_CONFLICT",
  LIMIT_REACHED: "SKILL_LIMIT_REACHED",
  NAME_RESERVED: "SKILL_NAME_RESERVED",
  MANIFEST_INVALID: "SKILL_MANIFEST_INVALID",
  ARCHIVE_INVALID: "SKILL_ARCHIVE_INVALID",
  HASH_MISMATCH: "SKILL_HASH_MISMATCH",
  ARCHIVE_TOO_LARGE: "SKILL_ARCHIVE_TOO_LARGE",
  STORAGE_UNAVAILABLE: "SKILL_STORAGE_UNAVAILABLE",
} as const;
export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[keyof typeof SKILL_ERROR_CODES];
export type SkillErrorCategory = "credential" | "deterministic" | "validation" | "transient";

export const SKILL_ERROR_CODE_METADATA: Readonly<
  Record<SkillErrorCode, { category: SkillErrorCategory; statusCode: number }>
> = {
  [SKILL_ERROR_CODES.NOT_FOUND]: { category: "deterministic", statusCode: 404 },
  [SKILL_ERROR_CODES.NAME_CONFLICT]: { category: "deterministic", statusCode: 409 },
  [SKILL_ERROR_CODES.LIMIT_REACHED]: { category: "deterministic", statusCode: 409 },
  [SKILL_ERROR_CODES.NAME_RESERVED]: { category: "validation", statusCode: 400 },
  [SKILL_ERROR_CODES.MANIFEST_INVALID]: { category: "validation", statusCode: 400 },
  [SKILL_ERROR_CODES.ARCHIVE_INVALID]: { category: "validation", statusCode: 400 },
  [SKILL_ERROR_CODES.HASH_MISMATCH]: { category: "validation", statusCode: 400 },
  [SKILL_ERROR_CODES.ARCHIVE_TOO_LARGE]: { category: "validation", statusCode: 413 },
  [SKILL_ERROR_CODES.STORAGE_UNAVAILABLE]: { category: "transient", statusCode: 503 },
};
