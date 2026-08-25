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
import { memberships, teams, users } from "./auth.js";
import { computers } from "./computers.js";

export const agentRuntimeProvider = pgEnum("agent_runtime_provider", ["codex", "claude-code"]);
export const agentReceiveMode = pgEnum("agent_receive_mode", ["all_message", "mention_only"]);
export const agentStatus = pgEnum("agent_status", ["active", "suspended", "deleted"]);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    managerUserId: uuid("manager_user_id").notNull(),
    creationIntentId: uuid("creation_intent_id"),
    creationIntentFingerprint: text("creation_intent_fingerprint"),
    computerId: uuid("computer_id").notNull(),
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
    uniqueIndex("agents_team_name_active_unique")
      .on(table.teamId, sql`lower(${table.name})`)
      .where(sql`${table.status} <> 'deleted'`),
    uniqueIndex("agents_creation_intent_unique")
      .on(table.teamId, table.managerUserId, table.creationIntentId)
      .where(sql`${table.creationIntentId} is not null`),
    index("agents_team_id_idx").on(table.teamId),
    index("agents_manager_user_id_idx").on(table.managerUserId),
    index("agents_computer_id_idx").on(table.computerId),
    foreignKey({
      columns: [table.teamId, table.managerUserId],
      foreignColumns: [memberships.teamId, memberships.userId],
      name: "agents_manager_membership_fk",
    }).onDelete("restrict"),
    check(
      "agents_creation_intent_pair",
      sql`(${table.creationIntentId} is null) = (${table.creationIntentFingerprint} is null)`,
    ),
    check("agents_revision_positive", sql`${table.revision} >= 1`),
  ],
);

export const agentsRelations = relations(agents, ({ one }) => ({
  team: one(teams, { fields: [agents.teamId], references: [teams.id] }),
  manager: one(users, { fields: [agents.managerUserId], references: [users.id] }),
  computer: one(computers, { fields: [agents.computerId], references: [computers.id] }),
  managerMembership: one(memberships, {
    fields: [agents.teamId, agents.managerUserId],
    references: [memberships.teamId, memberships.userId],
  }),
}));
