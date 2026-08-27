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
import { slackInstallations } from "./slack-installations.js";

export const imProvider = pgEnum("im_provider", ["feishu", "slack"]);
export const imBindingStatus = pgEnum("im_binding_status", [
  "provisioning",
  "active",
  "reauthorization_required",
  "error",
  "disabled",
]);
export const imConversationKind = pgEnum("im_conversation_kind", ["channel", "dm", "group_dm"]);
export const feishuSetupIntent = pgEnum("feishu_setup_intent", ["create", "reauthorize", "replace"]);
export const feishuSetupState = pgEnum("feishu_setup_state", [
  "awaiting_user",
  "validating",
  "succeeded",
  "failed",
  "expired",
  "canceled",
]);
export const slackRouteKind = pgEnum("slack_route_kind", ["default", "explicit"]);

export const imBindings = pgTable(
  "im_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    provider: imProvider("provider").notNull(),
    status: imBindingStatus("status").notNull().default("provisioning"),

    externalAppId: text("external_app_id"),
    externalTeamId: text("external_team_id"),
    externalEnterpriseId: text("external_enterprise_id"),
    externalBotId: text("external_bot_id"),
    externalTeamBrand: text("external_team_brand"),
    externalTeamName: text("external_team_name"),
    botDisplayName: text("bot_display_name"),
    botAvatarUrl: text("bot_avatar_url"),

    credentialSchemaVersion: bigint("credential_schema_version", { mode: "number" }),
    credentialGeneration: bigint("credential_generation", { mode: "number" }).notNull().default(0),
    encryptedCredential: text("encrypted_credential"),
    grantedCapabilities: text("granted_capabilities").array().notNull().default(sql`'{}'::text[]`),

    setupAttemptId: uuid("setup_attempt_id"),
    setupIntent: feishuSetupIntent("setup_intent"),
    setupState: feishuSetupState("setup_state"),
    setupOwnerInstanceId: uuid("setup_owner_instance_id"),
    setupOwnerHeartbeatAt: timestamp("setup_owner_heartbeat_at", { withTimezone: true }),
    encryptedSetupContext: text("encrypted_setup_context"),
    setupExpiresAt: timestamp("setup_expires_at", { withTimezone: true }),
    slackInstallationId: uuid("slack_installation_id").references(() => slackInstallations.id, {
      onDelete: "restrict",
    }),
    slackRouteKind: slackRouteKind("slack_route_kind"),

    replacementImBindingId: uuid("replacement_im_binding_id").references((): AnyPgColumn => imBindings.id, {
      onDelete: "set null",
    }),

    connectionOwnerInstanceId: uuid("connection_owner_instance_id"),
    connectionFencingEpoch: bigint("connection_fencing_epoch", { mode: "number" }).notNull().default(0),
    connectionLeaseExpiresAt: timestamp("connection_lease_expires_at", { withTimezone: true }),
    observedConnectedAt: timestamp("observed_connected_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }),

    activatedAt: timestamp("activated_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("im_bindings_agent_current_unique").on(table.agentId).where(sql`${table.status} <> 'disabled'`),
    uniqueIndex("im_bindings_feishu_app_current_unique")
      .on(table.externalAppId)
      .where(sql`${table.provider} = 'feishu' and ${table.status} <> 'disabled'`),
    uniqueIndex("im_bindings_slack_installation_default_unique")
      .on(table.slackInstallationId)
      .where(
        sql`${table.provider} = 'slack' and ${table.status} <> 'disabled' and ${table.slackRouteKind} = 'default'`,
      ),
    uniqueIndex("im_bindings_slack_installation_agent_current_unique")
      .on(table.slackInstallationId, table.agentId)
      .where(sql`${table.provider} = 'slack' and ${table.status} <> 'disabled'`),
    index("im_bindings_slack_installation_id_idx").on(table.slackInstallationId),
    check("im_bindings_credential_generation_nonnegative", sql`${table.credentialGeneration} >= 0`),
    check("im_bindings_connection_epoch_nonnegative", sql`${table.connectionFencingEpoch} >= 0`),
    check(
      "im_bindings_active_binding_shape",
      sql`${table.status} not in ('active', 'reauthorization_required') or (
        ${table.externalAppId} is not null and
        (${table.provider} = 'feishu' or ${table.externalTeamId} is not null) and
        ${table.externalBotId} is not null and ${table.credentialSchemaVersion} is not null and
        ${table.credentialGeneration} >= 1 and
        ${table.activatedAt} is not null and ${table.disabledAt} is null and
        (
          (${table.provider} = 'feishu' and ${table.encryptedCredential} is not null and
            ${table.slackInstallationId} is null and ${table.slackRouteKind} is null) or
          (${table.provider} = 'slack' and ${table.encryptedCredential} is null and
            ${table.slackInstallationId} is not null and ${table.slackRouteKind} is not null)
        )
      )`,
    ),
    check(
      "im_bindings_disabled_secret_shape",
      sql`${table.status} <> 'disabled' or (
        ${table.encryptedCredential} is null and ${table.encryptedSetupContext} is null and
        ${table.setupOwnerInstanceId} is null and ${table.connectionOwnerInstanceId} is null and
        ${table.connectionLeaseExpiresAt} is null and ${table.disabledAt} is not null
      )`,
    ),
    check(
      "im_bindings_setup_owner_shape",
      sql`(${table.setupOwnerInstanceId} is null and ${table.setupOwnerHeartbeatAt} is null and
        ${table.encryptedSetupContext} is null and ${table.setupExpiresAt} is null)
        or (${table.setupAttemptId} is not null and ${table.setupIntent} is not null and
        ${table.setupState} is not null and ${table.setupOwnerInstanceId} is not null and
        ${table.setupOwnerHeartbeatAt} is not null and ${table.encryptedSetupContext} is not null and
        ${table.setupExpiresAt} is not null)`,
    ),
    check(
      "im_bindings_connection_owner_shape",
      sql`(${table.connectionOwnerInstanceId} is null and ${table.connectionLeaseExpiresAt} is null)
        or (${table.provider} = 'feishu' and ${table.connectionOwnerInstanceId} is not null and
        ${table.connectionLeaseExpiresAt} is not null)`,
    ),
    check(
      "im_bindings_slack_setup_fields_null",
      sql`${table.provider} <> 'slack' or (
        ${table.setupAttemptId} is null and ${table.setupIntent} is null and
        ${table.setupState} is null and ${table.setupOwnerInstanceId} is null and
        ${table.setupOwnerHeartbeatAt} is null and ${table.encryptedSetupContext} is null and
        ${table.setupExpiresAt} is null
      )`,
    ),
    check(
      "im_bindings_slack_route_fields",
      sql`${table.provider} = 'slack' or (
        ${table.slackInstallationId} is null and ${table.slackRouteKind} is null
      )`,
    ),
  ],
);

export const imBindingsRelations = relations(imBindings, ({ one, many }) => ({
  agent: one(agents, { fields: [imBindings.agentId], references: [agents.id] }),
  slackInstallation: one(slackInstallations, {
    fields: [imBindings.slackInstallationId],
    references: [slackInstallations.id],
  }),
  replacement: one(imBindings, {
    fields: [imBindings.replacementImBindingId],
    references: [imBindings.id],
    relationName: "imBindingReplacement",
  }),
  replacedBy: many(imBindings, { relationName: "imBindingReplacement" }),
}));
