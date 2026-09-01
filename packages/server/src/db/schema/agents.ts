import { relations, sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { computers } from "./computers.js";

export const agentRuntimeProvider = pgEnum("agent_runtime_provider", ["codex", "claude-code"]);
export const agentReceiveMode = pgEnum("agent_receive_mode", ["all_message", "mention_only"]);
export const agentStatus = pgEnum("agent_status", ["active", "suspended", "deleted"]);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    creationIntentId: uuid("creation_intent_id"),
    creationIntentFingerprint: text("creation_intent_fingerprint"),
    /** Null until the Agent is bound to a Computer owned by its Account. */
    computerId: uuid("computer_id").references(() => computers.id, { onDelete: "restrict" }),
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
    uniqueIndex("agents_account_name_active_unique")
      .on(table.createdByUserId, sql`lower(${table.name})`)
      .where(sql`${table.status} <> 'deleted'`),
    uniqueIndex("agents_creation_intent_unique")
      .on(table.createdByUserId, table.creationIntentId)
      .where(sql`${table.creationIntentId} is not null`),
    index("agents_created_by_user_id_idx").on(table.createdByUserId),
    index("agents_computer_id_idx").on(table.computerId),
    check(
      "agents_creation_intent_pair",
      sql`(${table.creationIntentId} is null) = (${table.creationIntentFingerprint} is null)`,
    ),
    check("agents_revision_positive", sql`${table.revision} >= 1`),
  ],
);

export const agentsRelations = relations(agents, ({ one }) => ({
  creator: one(users, { fields: [agents.createdByUserId], references: [users.id] }),
  computer: one(computers, {
    fields: [agents.computerId],
    references: [computers.id],
  }),
}));
