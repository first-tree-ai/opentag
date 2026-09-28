import type { AgentScheduleLastDispatch, AgentScheduleRule } from "@opentag/shared";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { sessions } from "./sessions.js";

/**
 * Agent Schedules: one row per fixed-Chat schedule. The row stores identity, the owning Agent,
 * the pinned target Session, the validated rule, timezone, enablement, the next claimable
 * occurrence, an optimistic-concurrency revision, and only the LATEST dispatch summary (never a
 * run history). Semantic calendar validation is the Server calculator's job; the CHECKs here pin
 * the structural contract so a malformed rule can never be persisted.
 */
export const agentSchedules = pgTable(
  "agent_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    targetSessionId: uuid("target_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    schedule: jsonb("schedule").$type<AgentScheduleRule>().notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    nextTriggerAt: timestamp("next_trigger_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    lastDispatch: jsonb("last_dispatch").$type<AgentScheduleLastDispatch>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The due-scan hot path: enabled schedules with a claimable occurrence, in claim order.
    index("agent_schedules_due_idx")
      .on(table.nextTriggerAt, table.id)
      .where(sql`${table.enabled} and ${table.nextTriggerAt} is not null`),
    index("agent_schedules_agent_created_idx").on(table.agentId, table.createdAt, table.id),
    index("agent_schedules_target_session_idx").on(table.targetSessionId),
    check("agent_schedules_name_bounds", sql`char_length(${table.name}) between 1 and 120`),
    check("agent_schedules_prompt_bounds", sql`octet_length(${table.prompt}) between 1 and 16384`),
    check("agent_schedules_revision_positive", sql`${table.revision} >= 1`),
    check("agent_schedules_disabled_next_null", sql`${table.enabled} or ${table.nextTriggerAt} is null`),
    check("agent_schedules_timezone_shape", sql`${table.timezone} ~ '^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+)*$'`),
    check(
      "agent_schedules_schedule_shape",
      sql`jsonb_typeof(${table.schedule}) = 'object'
        and jsonb_typeof(${table.schedule}->'kind') = 'string' and (
        (
          ${table.schedule}->>'kind' = 'at'
          and ${table.schedule} ?& array['kind', 'at']
          and (${table.schedule} - 'kind' - 'at') = '{}'::jsonb
          and jsonb_typeof(${table.schedule}->'at') = 'string'
          and length(${table.schedule}->>'at') > 0
        ) or (
          ${table.schedule}->>'kind' = 'every'
          and ${table.schedule} ?& array['kind', 'intervalSeconds', 'anchorAt']
          and (${table.schedule} - 'kind' - 'intervalSeconds' - 'anchorAt') = '{}'::jsonb
          and case when jsonb_typeof(${table.schedule}->'intervalSeconds') = 'number'
            then ((${table.schedule}->>'intervalSeconds')::numeric >= 60
              and (${table.schedule}->>'intervalSeconds')::numeric <= 9007199254740991
              and (${table.schedule}->>'intervalSeconds')::numeric = floor((${table.schedule}->>'intervalSeconds')::numeric))
            else false end
          and jsonb_typeof(${table.schedule}->'anchorAt') = 'string'
          and length(${table.schedule}->>'anchorAt') > 0
        ) or (
          ${table.schedule}->>'kind' = 'cron'
          and ${table.schedule} ?& array['kind', 'expression']
          and (${table.schedule} - 'kind' - 'expression') = '{}'::jsonb
          and jsonb_typeof(${table.schedule}->'expression') = 'string'
          and length(${table.schedule}->>'expression') > 0
        )
      )`,
    ),
  ],
);
