import { z } from "zod";
import { AgentDisplayNameSchema, AgentNameSchema } from "./agent.js";

/**
 * Skill library contract shared by the Server, the Web UI, the CLI, and the Client daemon.
 *
 * A skill is a directory whose root holds a `SKILL.md` with YAML frontmatter (`name`, `description`). The Server
 * stores exactly one version per `(account, name)`, keeps the normalized manifest in the database, and streams the
 * canonical zip archive from object storage. Integrity is layered: file `sha256` -> skill `digest` -> agent digest.
 *
 * This module is browser-safe. The digest helpers live in `skill-digest.ts` because they need `node:crypto`.
 */

export const SKILL_MANIFEST_SCHEMA_VERSION = 1;
/** Matches Claude Code skill directory names; safe as a URL segment, directory name, and symlink name. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;
export const SKILL_UNPACKED_MAX_BYTES = 20 * 1024 * 1024;
export const SKILL_MAX_FILES = 200;
export const SKILL_MD_MAX_BYTES = 256 * 1024;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_FILE_PATH_MAX_BYTES = 1024;
export const SKILL_FILE_PATH_SEGMENT_MAX_BYTES = 255;
export const SKILLS_PER_ACCOUNT_MAX = 200;
export const SKILL_LIST_DEFAULT_LIMIT = 50;
export const SKILL_LIST_MAX_LIMIT = 100;
export const SKILL_FILE_NAME = "SKILL.md";

const SkillSha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");

export const SkillNameSchema = z.string().regex(SKILL_NAME_PATTERN, "Skill names must match ^[a-z0-9][a-z0-9-]{0,63}$");
export const SkillDescriptionSchema = z.string().min(1).max(SKILL_DESCRIPTION_MAX_LENGTH);
export const SkillFileModeSchema = z.enum(["0644", "0755"]);

export const SkillFileEntrySchema = z
  .object({
    path: z.string().min(1).max(SKILL_FILE_PATH_MAX_BYTES),
    sha256: SkillSha256Schema,
    size: z.number().int().nonnegative(),
    mode: SkillFileModeSchema,
  })
  .strict();

export const SkillManifestSchema = z
  .object({
    schemaVersion: z.literal(SKILL_MANIFEST_SCHEMA_VERSION),
    name: SkillNameSchema,
    files: z.array(SkillFileEntrySchema).min(1).max(SKILL_MAX_FILES),
  })
  .strict();

export const SkillUpdatedByKindSchema = z.enum(["user", "session"]);
export const SkillUpdatedBySchema = z
  .object({
    kind: SkillUpdatedByKindSchema,
    id: z.string().min(1),
  })
  .strict();

export const SkillSummarySchema = z
  .object({
    name: SkillNameSchema,
    description: SkillDescriptionSchema,
    digest: SkillSha256Schema,
    archiveSha256: SkillSha256Schema,
    archiveBytes: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    agentCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    updatedBy: SkillUpdatedBySchema,
  })
  .strict();

export const SkillDetailSchema = SkillSummarySchema.extend({ manifest: SkillManifestSchema }).strict();

export const ListSkillsResponseSchema = z
  .object({
    skills: z.array(SkillSummarySchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export const SkillListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(SKILL_LIST_MAX_LIMIT).default(SKILL_LIST_DEFAULT_LIMIT),
  })
  .strict();

export const SkillOnConflictSchema = z.enum(["fail", "replace"]);
export const SkillUploadQuerySchema = z
  .object({
    onConflict: SkillOnConflictSchema.default("fail"),
  })
  .strict();

export const AgentSkillAssignmentRequestSchema = z
  .object({
    skillNames: z
      .array(SkillNameSchema)
      .max(SKILLS_PER_ACCOUNT_MAX)
      .refine((names) => new Set(names).size === names.length, { message: "Skill names must be unique" }),
  })
  .strict();

export const AgentSkillsResponseSchema = z
  .object({
    agentId: z.string().min(1),
    digest: SkillSha256Schema,
    skills: z.array(SkillSummarySchema),
  })
  .strict();

export const SkillAgentSummarySchema = z
  .object({
    agentId: z.string().min(1),
    name: AgentNameSchema,
    displayName: AgentDisplayNameSchema,
  })
  .strict();

export const SkillAgentsResponseSchema = z
  .object({
    agents: z.array(SkillAgentSummarySchema),
  })
  .strict();

export const RuntimeSkillsQuerySchema = z
  .object({
    agentId: z.string().min(1).optional(),
  })
  .strict();

export const RuntimeSkillEntrySchema = z
  .object({
    name: SkillNameSchema,
    digest: SkillSha256Schema,
    archiveSha256: SkillSha256Schema,
    archiveBytes: z.number().int().nonnegative(),
    manifest: SkillManifestSchema,
  })
  .strict();

export const RuntimeAgentSkillsSchema = z
  .object({
    agentId: z.string().min(1),
    digest: SkillSha256Schema,
    skills: z.array(RuntimeSkillEntrySchema),
  })
  .strict();

export const RuntimeSkillsManifestSchema = z
  .object({
    agents: z.array(RuntimeAgentSkillsSchema),
  })
  .strict();

export type SkillName = z.infer<typeof SkillNameSchema>;
export type SkillFileMode = z.infer<typeof SkillFileModeSchema>;
export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type SkillUpdatedByKind = z.infer<typeof SkillUpdatedByKindSchema>;
export type SkillUpdatedBy = z.infer<typeof SkillUpdatedBySchema>;
export type SkillSummary = z.infer<typeof SkillSummarySchema>;
export type SkillDetail = z.infer<typeof SkillDetailSchema>;
export type ListSkillsResponse = z.infer<typeof ListSkillsResponseSchema>;
export type SkillListQuery = z.infer<typeof SkillListQuerySchema>;
export type SkillOnConflict = z.infer<typeof SkillOnConflictSchema>;
export type SkillUploadQuery = z.infer<typeof SkillUploadQuerySchema>;
export type AgentSkillAssignmentRequest = z.infer<typeof AgentSkillAssignmentRequestSchema>;
export type AgentSkillsResponse = z.infer<typeof AgentSkillsResponseSchema>;
export type SkillAgentSummary = z.infer<typeof SkillAgentSummarySchema>;
export type SkillAgentsResponse = z.infer<typeof SkillAgentsResponseSchema>;
export type RuntimeSkillsQuery = z.infer<typeof RuntimeSkillsQuerySchema>;
export type RuntimeSkillEntry = z.infer<typeof RuntimeSkillEntrySchema>;
export type RuntimeAgentSkills = z.infer<typeof RuntimeAgentSkillsSchema>;
export type RuntimeSkillsManifest = z.infer<typeof RuntimeSkillsManifestSchema>;
