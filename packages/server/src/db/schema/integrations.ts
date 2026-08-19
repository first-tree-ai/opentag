import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const imProvider = pgEnum("im_provider", ["feishu", "slack"]);
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

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    provider: imProvider("provider").notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    reauthorizationRequired: boolean("reauthorization_required").notNull().default(false),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("integrations_agent_id_unique").on(table.agentId)],
);

export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    integrationId: uuid("integration_id")
      .primaryKey()
      .references(() => integrations.id, { onDelete: "cascade" }),
    schemaVersion: bigint("schema_version", { mode: "number" }).notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    grantedCapabilities: jsonb("granted_capabilities").$type<string[]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("integration_credentials_schema_version_positive", sql`${table.schemaVersion} >= 1`),
    check("integration_credentials_generation_positive", sql`${table.generation} >= 1`),
  ],
);

export const feishuIntegrationIdentities = pgTable(
  "feishu_integration_identities",
  {
    integrationId: uuid("integration_id")
      .primaryKey()
      .references(() => integrations.id, { onDelete: "cascade" }),
    appId: text("app_id").notNull(),
    tenantKey: text("tenant_key"),
    botOpenId: text("bot_open_id").notNull(),
    tenantBrand: text("tenant_brand"),
  },
  (table) => [uniqueIndex("feishu_integration_identities_app_id_unique").on(table.appId)],
);

export const slackIntegrationIdentities = pgTable(
  "slack_integration_identities",
  {
    integrationId: uuid("integration_id")
      .primaryKey()
      .references(() => integrations.id, { onDelete: "cascade" }),
    appId: text("app_id").notNull(),
    teamId: text("team_id").notNull(),
    enterpriseId: text("enterprise_id"),
    botUserId: text("bot_user_id").notNull(),
  },
  (table) => [
    uniqueIndex("slack_integration_identities_app_team_unique").on(table.appId, table.teamId),
    index("slack_integration_identities_route_idx").on(table.appId, table.teamId),
  ],
);

export const feishuSetupAttempts = pgTable(
  "feishu_setup_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    intent: feishuSetupIntent("intent").notNull(),
    state: feishuSetupState("state").notNull(),
    ownerInstanceId: uuid("owner_instance_id").notNull(),
    ownerHeartbeatAt: timestamp("owner_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    encryptedQrContext: text("encrypted_qr_context").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    errorCode: text("error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("feishu_setup_attempts_agent_id_idx").on(table.agentId),
    uniqueIndex("feishu_setup_attempts_agent_active_unique")
      .on(table.agentId)
      .where(sql`${table.state} in ('awaiting_user', 'validating')`),
  ],
);

export const feishuConnectionLeases = pgTable("feishu_connection_leases", {
  integrationId: uuid("integration_id")
    .primaryKey()
    .references(() => integrations.id, { onDelete: "cascade" }),
  holderInstanceId: uuid("holder_instance_id").notNull(),
  fencingEpoch: bigint("fencing_epoch", { mode: "number" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  observedConnectedAt: timestamp("observed_connected_at", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
});

export const imConversations = pgTable(
  "im_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "restrict" }),
    externalId: text("external_id").notNull(),
    kind: imConversationKind("kind").notNull(),
    displayName: text("display_name"),
    detachedAt: timestamp("detached_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("im_conversations_integration_external_unique").on(table.integrationId, table.externalId),
    index("im_conversations_integration_id_idx").on(table.integrationId),
  ],
);

export const integrationsRelations = relations(integrations, ({ one, many }) => ({
  agent: one(agents, { fields: [integrations.agentId], references: [agents.id] }),
  credential: one(integrationCredentials),
  conversations: many(imConversations),
}));
