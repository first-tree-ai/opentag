import { relations, sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { users } from "./auth.js";

/**
 * The Account-owned skill library. One row per `(owner, name)`: the Server keeps a single version, so replacing a
 * skill rewrites the row in place and the digest changes. `skill_md` is the full SKILL.md so the viewer and the list
 * never touch object storage; the canonical zip lives at `archive_key` and is content-addressed by `digest`.
 */
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerAccountId: uuid("owner_account_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    skillMd: text("skill_md").notNull(),
    /** sha256 of the canonical manifest; independent of zip metadata. */
    digest: text("digest").notNull(),
    /** Object storage key relative to the configured prefix: `<owner>/<skillId>/<digest>.zip`. */
    archiveKey: text("archive_key").notNull(),
    archiveBytes: integer("archive_bytes").notNull(),
    /** sha256 of the normalized, repacked zip; doubles as the download ETag. */
    archiveSha256: text("archive_sha256").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    updatedByKind: text("updated_by_kind", { enum: ["user", "session"] }).notNull(),
    updatedById: text("updated_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("skills_owner_name_unique").on(table.ownerAccountId, table.name),
    check("skills_name_shape", sql`${table.name} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`),
    check("skills_digest_shape", sql`${table.digest} ~ '^[0-9a-f]{64}$'`),
    check("skills_archive_sha256_shape", sql`${table.archiveSha256} ~ '^[0-9a-f]{64}$'`),
    check("skills_counts_non_negative", sql`${table.archiveBytes} >= 0 and ${table.totalBytes} >= 0`),
    check("skills_file_count_positive", sql`${table.fileCount} >= 1`),
  ],
);

/** Manifest entries only; file contents live in the archive. */
export const skillFiles = pgTable(
  "skill_files",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    mode: text("mode", { enum: ["0644", "0755"] }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.skillId, table.path] }),
    check("skill_files_sha256_shape", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("skill_files_size_non_negative", sql`${table.size} >= 0`),
  ],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.skillId] }),
    index("agent_skills_skill_id_idx").on(table.skillId),
  ],
);

export const skillsRelations = relations(skills, ({ one, many }) => ({
  owner: one(users, { fields: [skills.ownerAccountId], references: [users.id] }),
  files: many(skillFiles),
  agentSkills: many(agentSkills),
}));

export const skillFilesRelations = relations(skillFiles, ({ one }) => ({
  skill: one(skills, { fields: [skillFiles.skillId], references: [skills.id] }),
}));

export const agentSkillsRelations = relations(agentSkills, ({ one }) => ({
  agent: one(agents, { fields: [agentSkills.agentId], references: [agents.id] }),
  skill: one(skills, { fields: [agentSkills.skillId], references: [skills.id] }),
}));
