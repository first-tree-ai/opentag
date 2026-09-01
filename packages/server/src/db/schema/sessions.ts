import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { computers } from "./computers.js";
import { imBindings, imConversationKind } from "./im-bindings.js";

export const sessionKind = pgEnum("session_kind", ["channel", "thread", "internal"]);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    imBindingId: uuid("im_binding_id")
      .notNull()
      .references(() => imBindings.id, { onDelete: "restrict" }),
    channelId: text("channel_id").notNull(),
    conversationKind: imConversationKind("conversation_kind").notNull(),
    kind: sessionKind("kind").notNull(),
    threadKey: text("thread_key"),
    manualTitle: text("manual_title"),
    generatedTitle: text("generated_title"),
    createdBySessionId: uuid("created_by_session_id").references((): AnyPgColumn => sessions.id, {
      onDelete: "restrict",
    }),
    runtimeModel: text("runtime_model"),
    runtimeReasoningEffort: text("runtime_reasoning_effort"),
    runtimeMaxDurationMs: integer("runtime_max_duration_ms"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_active_channel_unique")
      .on(table.imBindingId, table.channelId)
      .where(sql`${table.kind} = 'channel' and ${table.endedAt} is null`),
    uniqueIndex("sessions_active_thread_unique")
      .on(table.imBindingId, table.channelId, table.threadKey)
      .where(sql`${table.kind} = 'thread' and ${table.endedAt} is null`),
    index("sessions_im_binding_scope_idx").on(table.imBindingId, table.channelId, table.threadKey),
    index("sessions_creator_created_idx").on(table.createdBySessionId, table.createdAt, table.id),
    check(
      "sessions_shape_check",
      sql`(${table.kind} = 'channel' and ${table.threadKey} is null and ${table.createdBySessionId} is null and ${table.runtimeModel} is null and ${table.runtimeReasoningEffort} is null and ${table.runtimeMaxDurationMs} is null)
        or (${table.kind} = 'thread' and ${table.threadKey} is not null and ${table.createdBySessionId} is null and ${table.runtimeModel} is null and ${table.runtimeReasoningEffort} is null and ${table.runtimeMaxDurationMs} is null)
        or (${table.kind} = 'internal' and ${table.createdBySessionId} is not null)`,
    ),
    check(
      "sessions_runtime_max_duration_valid",
      sql`${table.runtimeMaxDurationMs} is null or (${table.runtimeMaxDurationMs} > 0 and ${table.runtimeMaxDurationMs} <= 86400000)`,
    ),
    check(
      "sessions_runtime_model_bounds",
      sql`${table.runtimeModel} is null or octet_length(${table.runtimeModel}) between 1 and 128`,
    ),
    check(
      "sessions_runtime_reasoning_effort_bounds",
      sql`${table.runtimeReasoningEffort} is null or octet_length(${table.runtimeReasoningEffort}) between 1 and 64`,
    ),
    check("sessions_revision_positive", sql`${table.revision} >= 1`),
    check(
      "sessions_manual_title_bounds",
      sql`${table.manualTitle} is null or char_length(${table.manualTitle}) between 1 and 120`,
    ),
    check(
      "sessions_generated_title_bounds",
      sql`${table.generatedTitle} is null or char_length(${table.generatedTitle}) between 1 and 120`,
    ),
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

export const sessionDescendants = pgTable(
  "session_descendants",
  {
    ancestorSessionId: uuid("ancestor_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    descendantSessionId: uuid("descendant_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    depth: integer("depth").notNull(),
    lastMessageCreatedAt: timestamp("last_message_created_at", { withTimezone: true }).notNull(),
    lastMessageId: uuid("last_message_id").notNull(),
    lastDeliveryOutcome: text("last_delivery_outcome").notNull(),
    taskPreview: text("task_preview").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ancestorSessionId, table.descendantSessionId] }),
    index("session_descendants_ancestor_activity_idx").on(
      table.ancestorSessionId,
      table.lastMessageCreatedAt,
      table.lastMessageId,
      table.descendantSessionId,
    ),
    index("session_descendants_ancestor_depth_activity_idx").on(
      table.ancestorSessionId,
      table.depth,
      table.lastMessageCreatedAt,
      table.lastMessageId,
      table.descendantSessionId,
    ),
    index("session_descendants_descendant_ancestor_idx").on(table.descendantSessionId, table.ancestorSessionId),
    index("session_descendants_last_message_idx").on(table.lastMessageId),
    check("session_descendants_depth_positive", sql`${table.depth} >= 1`),
    check(
      "session_descendants_outcome_valid",
      sql`${table.lastDeliveryOutcome} in ('accepted', 'unreachable', 'unknown', 'rejected')`,
    ),
    check("session_descendants_preview_bounds", sql`char_length(${table.taskPreview}) between 1 and 256`),
  ],
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  imBinding: one(imBindings, { fields: [sessions.imBindingId], references: [imBindings.id] }),
  placement: one(sessionPlacements),
  creator: one(sessions, { fields: [sessions.createdBySessionId], references: [sessions.id] }),
}));
