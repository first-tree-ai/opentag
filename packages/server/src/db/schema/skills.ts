import type { SkillFileEntry } from "@opentag/shared";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

/**
 * Agent Skills metadata. One row per Skill; the archive itself lives in S3-compatible object
 * storage keyed by `object_key`.
 *
 * A Skill belongs to exactly one Agent, so the table carries no `account_id`: ownership is
 * resolved by joining `agents.created_by_user_id`, the same reasoning as
 * `mcp_server_authorizations`. The unique index is over `lower(name)` within an Agent, so two
 * spellings of one name can never both be stored, and replacing an archive bumps `revision`
 * in place rather than keeping history.
 *
 * `files` is a bounded snapshot of the bundle's member list (not the content); it may be
 * truncated to `SKILL_MAX_LISTED_FILES`, which `files_truncated` records.
 */

export const skillSource = pgEnum("skill_source", ["web_upload", "cli_upload", "agent_upload"]);

/**
 * The name format is the shared `SkillNameSchema` spelled for PostgreSQL: lowercase alphanumerics
 * joined by single hyphens, so a leading, trailing, or doubled hyphen is rejected. Quoted with
 * `sql.raw`, the same technique `mcp.ts` uses, so the generated DDL needs no quote or backslash
 * escaping. The length bound is a separate `char_length` check because PostgreSQL's `~` is not
 * anchored by the pattern's own length and the shared rule caps the name at 64 characters.
 */
const SKILL_NAME_REGEX = "^[a-z0-9]+(-[a-z0-9]+)*$";
const SKILL_SHA256_REGEX = "^[0-9a-f]{64}$";

export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Restrict, not cascade: an Agent with Skills is never hard-deleted out from under them. */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    source: skillSource("source").notNull(),
    /** Server-derived object key; never accepted from a caller. */
    objectKey: text("object_key").notNull(),
    archiveSha256: text("archive_sha256").notNull(),
    archiveBytes: integer("archive_bytes").notNull(),
    fileCount: integer("file_count").notNull(),
    files: jsonb("files").$type<SkillFileEntry[]>().notNull().default(sql`'[]'::jsonb`),
    filesTruncated: boolean("files_truncated").notNull().default(false),
    /** Bumped on every archive replacement; a fresh row starts at 1. */
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_skills_agent_name_unique").on(table.agentId, sql`lower(${table.name})`),
    index("agent_skills_agent_id_idx").on(table.agentId),
    check("agent_skills_name_format", sql`${table.name} ~ ${sql.raw(`'${SKILL_NAME_REGEX}'`)}`),
    check("agent_skills_name_length", sql`char_length(${table.name}) between 1 and 64`),
    check("agent_skills_description_bounds", sql`char_length(${table.description}) between 1 and 1024`),
    check("agent_skills_sha256_format", sql`${table.archiveSha256} ~ ${sql.raw(`'${SKILL_SHA256_REGEX}'`)}`),
    check("agent_skills_archive_bytes_bounds", sql`${table.archiveBytes} between 1 and 16777216`),
    check("agent_skills_file_count_bounds", sql`${table.fileCount} between 1 and 1000`),
    check("agent_skills_revision_positive", sql`${table.revision} >= 1`),
    check("agent_skills_object_key_bounds", sql`char_length(${table.objectKey}) between 1 and 1024`),
  ],
);

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agent: one(agents, { fields: [agentSkills.agentId], references: [agents.id] }),
}));
