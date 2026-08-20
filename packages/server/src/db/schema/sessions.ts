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
import { computers } from "./computers.js";
import { imConversationKind, integrations } from "./integrations.js";

export const sessionKind = pgEnum("session_kind", ["channel", "thread", "internal"]);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "restrict" }),
    channelId: text("channel_id").notNull(),
    conversationKind: imConversationKind("conversation_kind").notNull(),
    kind: sessionKind("kind").notNull(),
    threadKey: text("thread_key"),
    createdBySessionId: uuid("created_by_session_id").references((): AnyPgColumn => sessions.id, {
      onDelete: "restrict",
    }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_active_channel_unique")
      .on(table.integrationId, table.channelId)
      .where(sql`${table.kind} = 'channel' and ${table.endedAt} is null`),
    uniqueIndex("sessions_active_thread_unique")
      .on(table.integrationId, table.channelId, table.threadKey)
      .where(sql`${table.kind} = 'thread' and ${table.endedAt} is null`),
    index("sessions_integration_scope_idx").on(table.integrationId, table.channelId, table.threadKey),
    check(
      "sessions_shape_check",
      sql`(${table.kind} = 'channel' and ${table.threadKey} is null and ${table.createdBySessionId} is null)
        or (${table.kind} = 'thread' and ${table.threadKey} is not null and ${table.createdBySessionId} is null)
        or (${table.kind} = 'internal' and ${table.createdBySessionId} is not null)`,
    ),
    check("sessions_revision_positive", sql`${table.revision} >= 1`),
  ],
);

export const sessionPlacements = pgTable(
  "session_placements",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    computerId: uuid("computer_id")
      .notNull()
      .references(() => computers.id, { onDelete: "restrict" }),
    generation: bigint("generation", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("session_placements_computer_id_idx").on(table.computerId),
    check("session_placements_generation_positive", sql`${table.generation} >= 1`),
  ],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  integration: one(integrations, { fields: [sessions.integrationId], references: [integrations.id] }),
  placement: one(sessionPlacements),
  creator: one(sessions, { fields: [sessions.createdBySessionId], references: [sessions.id] }),
}));
