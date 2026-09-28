import type { SessionMessageScheduledOrigin } from "@opentag/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sessions } from "./sessions.js";

export const sessionMessageOutcome = pgEnum("session_message_outcome", [
  "unknown",
  "accepted",
  "unreachable",
  "rejected",
]);

export const sessionMessages = pgTable(
  "session_messages",
  {
    id: uuid("id").primaryKey(),
    /*
     * Exactly one origin per message: an ordinary message carries the source Session; a
     * Server-scheduled message carries the immutable `scheduledOrigin` snapshot instead. The
     * snapshot's scheduleId is traceability only — deliberately no FK, so deleting a Schedule
     * never deletes or disqualifies messages it already produced.
     */
    sourceSessionId: uuid("source_session_id").references(() => sessions.id, { onDelete: "restrict" }),
    scheduledOrigin: jsonb("scheduled_origin").$type<SessionMessageScheduledOrigin>(),
    targetSessionId: uuid("target_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    lastOutcome: sessionMessageOutcome("last_outcome").notNull().default("unknown"),
    lastErrorCode: text("last_error_code"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("session_messages_target_created_idx").on(table.targetSessionId, table.createdAt, table.id),
    index("session_messages_source_created_idx").on(table.sourceSessionId, table.createdAt, table.id),
    check("session_messages_content_hash_shape", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("session_messages_content_bounds", sql`octet_length(${table.content}) between 1 and 16384`),
    check(
      "session_messages_source_shape",
      sql`(${table.sourceSessionId} is not null and ${table.scheduledOrigin} is null)
        or (${table.sourceSessionId} is null
          and ${table.scheduledOrigin} is not null
          and jsonb_typeof(${table.scheduledOrigin}) = 'object'
          and ${table.scheduledOrigin} ?& array['scheduleId', 'scheduledFor', 'timezone', 'name']
          and (${table.scheduledOrigin} - 'scheduleId' - 'scheduledFor' - 'timezone' - 'name') = '{}'::jsonb
          and jsonb_typeof(${table.scheduledOrigin}->'scheduleId') = 'string'
          and ${table.scheduledOrigin}->>'scheduleId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          and jsonb_typeof(${table.scheduledOrigin}->'scheduledFor') = 'string'
          and length(${table.scheduledOrigin}->>'scheduledFor') > 0
          and jsonb_typeof(${table.scheduledOrigin}->'timezone') = 'string'
          and length(${table.scheduledOrigin}->>'timezone') > 0
          and jsonb_typeof(${table.scheduledOrigin}->'name') = 'string'
          and char_length(${table.scheduledOrigin}->>'name') between 1 and 120)`,
    ),
    check(
      "session_messages_error_code_shape",
      sql`${table.lastErrorCode} is null or (${table.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,127}$')`,
    ),
    check("session_messages_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check(
      "session_messages_attempt_shape",
      sql`(${table.attemptCount} = 0 and ${table.lastAttemptAt} is null)
        or (${table.attemptCount} > 0 and ${table.lastAttemptAt} is not null)`,
    ),
  ],
);
