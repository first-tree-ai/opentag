import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users, workspaces } from "./auth.js";
import { workspaceComputers } from "./computers.js";

export const agentRuntimeProvider = pgEnum("agent_runtime_provider", ["codex", "claude-code"]);
export const agentReceiveMode = pgEnum("agent_receive_mode", ["all_message", "mention_only"]);
export const agentStatus = pgEnum("agent_status", ["active", "suspended", "deleted"]);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    creationIntentId: uuid("creation_intent_id"),
    creationIntentFingerprint: text("creation_intent_fingerprint"),
    workspaceComputerId: uuid("workspace_computer_id").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    runtimeProvider: agentRuntimeProvider("runtime_provider").notNull(),
    receiveMode: agentReceiveMode("receive_mode").notNull().default("all_message"),
    status: agentStatus("status").notNull().default("active"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agents_workspace_name_active_unique")
      .on(table.workspaceId, sql`lower(${table.name})`)
      .where(sql`${table.status} <> 'deleted'`),
    uniqueIndex("agents_creation_intent_unique")
      .on(table.workspaceId, table.creationIntentId)
      .where(sql`${table.creationIntentId} is not null`),
    index("agents_workspace_id_idx").on(table.workspaceId),
    index("agents_created_by_user_id_idx").on(table.createdByUserId),
    index("agents_workspace_computer_id_idx").on(table.workspaceComputerId),
    foreignKey({
      columns: [table.workspaceId, table.workspaceComputerId],
      foreignColumns: [workspaceComputers.workspaceId, workspaceComputers.id],
      name: "agents_workspace_enrollment_fk",
    }).onDelete("restrict"),
    check(
      "agents_creation_intent_pair",
      sql`(${table.creationIntentId} is null) = (${table.creationIntentFingerprint} is null)`,
    ),
    check("agents_revision_positive", sql`${table.revision} >= 1`),
  ],
);

export const agentsRelations = relations(agents, ({ one }) => ({
  workspace: one(workspaces, { fields: [agents.workspaceId], references: [workspaces.id] }),
  creator: one(users, { fields: [agents.createdByUserId], references: [users.id] }),
  workspaceComputer: one(workspaceComputers, {
    fields: [agents.workspaceComputerId],
    references: [workspaceComputers.id],
  }),
}));
