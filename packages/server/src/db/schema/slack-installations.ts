import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { workspaces } from "./auth.js";

export const slackInstallationStatus = pgEnum("slack_installation_status", [
  "active",
  "reauthorization_required",
  "disabled",
]);

export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "restrict" }),
    status: slackInstallationStatus("status").notNull().default("active"),

    externalAppId: text("external_app_id").notNull(),
    externalTeamId: text("external_team_id").notNull(),
    externalEnterpriseId: text("external_enterprise_id"),
    externalBotId: text("external_bot_id").notNull(),
    externalTeamName: text("external_team_name"),
    botDisplayName: text("bot_display_name"),
    botAvatarUrl: text("bot_avatar_url"),

    credentialSchemaVersion: bigint("credential_schema_version", { mode: "number" }),
    credentialGeneration: bigint("credential_generation", { mode: "number" }).notNull().default(0),
    encryptedCredential: text("encrypted_credential"),
    grantedCapabilities: text("granted_capabilities").array().notNull().default(sql`'{}'::text[]`),

    replacementSlackInstallationId: uuid("replacement_slack_installation_id").references(
      (): AnyPgColumn => slackInstallations.id,
      { onDelete: "set null" },
    ),

    observedConnectedAt: timestamp("observed_connected_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }),

    activatedAt: timestamp("activated_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("slack_installations_app_team_current_unique")
      .on(table.externalAppId, table.externalTeamId)
      .where(sql`${table.status} <> 'disabled'`),
    uniqueIndex("slack_installations_workspace_current_unique")
      .on(table.workspaceId)
      .where(sql`${table.status} <> 'disabled'`),
    index("slack_installations_workspace_id_idx").on(table.workspaceId),
    index("slack_installations_agent_id_idx").on(table.agentId),
    index("slack_installations_app_team_idx").on(table.externalAppId, table.externalTeamId),
    check("slack_installations_credential_generation_nonnegative", sql`${table.credentialGeneration} >= 0`),
    check(
      "slack_installations_active_shape",
      sql`${table.status} not in ('active', 'reauthorization_required') or (
        ${table.credentialSchemaVersion} is not null and
        ${table.credentialGeneration} >= 1 and ${table.encryptedCredential} is not null and
        ${table.activatedAt} is not null and ${table.disabledAt} is null
      )`,
    ),
    check(
      "slack_installations_disabled_secret_shape",
      sql`${table.status} <> 'disabled' or (
        ${table.encryptedCredential} is null and ${table.disabledAt} is not null
      )`,
    ),
  ],
);

export const slackInstallationsRelations = relations(slackInstallations, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [slackInstallations.workspaceId], references: [workspaces.id] }),
  agent: one(agents, { fields: [slackInstallations.agentId], references: [agents.id] }),
  replacement: one(slackInstallations, {
    fields: [slackInstallations.replacementSlackInstallationId],
    references: [slackInstallations.id],
    relationName: "slackInstallationReplacement",
  }),
  replacedBy: many(slackInstallations, { relationName: "slackInstallationReplacement" }),
}));
