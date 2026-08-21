import { relations, sql } from "drizzle-orm";
import { bigint, check, integer, pgSequence, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const runtimeConfigRevisionSequence = pgSequence("runtime_config_revision_sequence", {
  startWith: 1,
  minValue: 1,
  maxValue: Number.MAX_SAFE_INTEGER,
});

export const agentRuntimeConfigs = pgTable(
  "agent_runtime_configs",
  {
    agentId: uuid("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" })
      .notNull()
      .default(sql`nextval('runtime_config_revision_sequence')`),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    instructions: text("instructions").notNull(),
    maxDurationMs: integer("max_duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "agent_runtime_configs_revision_safe_positive",
      sql`${table.revision} > 0 and ${table.revision} <= 9007199254740991`,
    ),
    check(
      "agent_runtime_configs_max_duration_valid",
      sql`${table.maxDurationMs} is null or (${table.maxDurationMs} > 0 and ${table.maxDurationMs} <= 86400000)`,
    ),
  ],
);

export const agentRuntimeConfigsRelations = relations(agentRuntimeConfigs, ({ one }) => ({
  agent: one(agents, { fields: [agentRuntimeConfigs.agentId], references: [agents.id] }),
}));
