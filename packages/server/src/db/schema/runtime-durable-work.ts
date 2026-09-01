import type { RuntimeDurableFailure, RuntimeDurableWorkRecord } from "@opentag/shared";
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { computers } from "./computers.js";

export const runtimeDurableWorkKind = pgEnum("runtime_durable_work_kind", ["session-message", "turn-report"]);
export const runtimeDurableWorkStatus = pgEnum("runtime_durable_work_status", [
  "accepted",
  "running",
  "succeeded",
  "retryable",
  "failed",
  "dead-letter",
]);

export const runtimeDurableWork = pgTable(
  "runtime_durable_work",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    computerId: uuid("computer_id")
      .notNull()
      .references(() => computers.id, { onDelete: "cascade" }),
    kind: runtimeDurableWorkKind("kind").notNull(),
    recordKey: text("record_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: runtimeDurableWorkStatus("status").notNull(),
    attempts: integer("attempts").notNull(),
    acceptedAt: bigint("accepted_at", { mode: "number" }).notNull(),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }),
    lastError: jsonb("last_error").$type<RuntimeDurableFailure>(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("runtime_durable_work_scope_key_unique").on(table.computerId, table.kind, table.recordKey),
    index("runtime_durable_work_scope_status_idx").on(table.computerId, table.kind, table.status),
    check("runtime_durable_work_key_shape", sql`${table.recordKey} ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'`),
    check("runtime_durable_work_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check("runtime_durable_work_accepted_at_nonnegative", sql`${table.acceptedAt} >= 0`),
    check("runtime_durable_work_updated_at_nonnegative", sql`${table.updatedAt} >= 0`),
    check(
      "runtime_durable_work_next_attempt_nonnegative",
      sql`${table.nextAttemptAt} is null or ${table.nextAttemptAt} >= 0`,
    ),
  ],
);

export type RuntimeDurableWorkRow = typeof runtimeDurableWork.$inferSelect;
export type RuntimeDurableWorkInsert = typeof runtimeDurableWork.$inferInsert;
export type RuntimeDurableWorkPayload = RuntimeDurableWorkRecord["payload"];
