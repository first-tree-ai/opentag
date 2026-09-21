import { sql } from "drizzle-orm";
import { bigint, check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sessions } from "./sessions.js";

export const sandboxLifecycle = pgEnum("sandbox_lifecycle", ["unallocated", "preparing", "ready", "releasing"]);

/**
 * The Session-owned Cloud execution environment. One Agent Session has at most one Sandbox.
 * `storage_uri` is the durable persistence address and is treated as immutable by the service.
 * `environment_generation` is the Sandbox environment generation; it is not `session_placements.generation`
 * and not `computers.current_instance_id`. GCP resource identity is the full resource name plus UID,
 * kept until a later phase verifies removal. This table records facts only: it does not allocate,
 * execute, or reclaim resources.
 *
 * `idle_reclaim_at` is E7's single automatic-reclaim marker. It is set atomically before a ready
 * environment is quiesced so execution authority is revoked while the physical binding still
 * exists, and it is the only hand-off between an idle allocation, its automatic deletion, and a
 * same-account Session that borrows the physical Instance. It is not a business identity: the
 * storage URI, physical resource name and UID stay on this row until the binding is transferred
 * or removed.
 */
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    storageUri: text("storage_uri").notNull(),
    lifecycle: sandboxLifecycle("lifecycle").notNull().default("unallocated"),
    currentResourceName: text("current_resource_name"),
    currentResourceUid: text("current_resource_uid"),
    currentOperationName: text("current_operation_name"),
    environmentGeneration: bigint("environment_generation", { mode: "number" }).notNull().default(0),
    idleReclaimAt: timestamp("idle_reclaim_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sandboxes_session_id_unique").on(table.sessionId),
    uniqueIndex("sandboxes_storage_uri_unique").on(table.storageUri),
    uniqueIndex("sandboxes_current_resource_name_unique")
      .on(table.currentResourceName)
      .where(sql`${table.currentResourceName} is not null`),
    uniqueIndex("sandboxes_current_resource_uid_unique")
      .on(table.currentResourceUid)
      .where(sql`${table.currentResourceUid} is not null`),
    index("sandboxes_lifecycle_last_activity_idx").on(table.lifecycle, table.lastActivityAt),
    index("sandboxes_idle_reclaim_at_idx").on(table.idleReclaimAt).where(sql`${table.idleReclaimAt} is not null`),
    check("sandboxes_environment_generation_nonnegative", sql`${table.environmentGeneration} >= 0`),
    check(
      "sandboxes_idle_reclaim_requires_allocation",
      sql`${table.idleReclaimAt} is null or (${table.currentResourceName} is not null and ${table.currentResourceUid} is not null)`,
    ),
    check("sandboxes_storage_uri_bounds", sql`char_length(${table.storageUri}) between 1 and 2048`),
    check(
      "sandboxes_current_resource_name_bounds",
      sql`${table.currentResourceName} is null or char_length(${table.currentResourceName}) between 1 and 1024`,
    ),
    check(
      "sandboxes_current_resource_uid_bounds",
      sql`${table.currentResourceUid} is null or char_length(${table.currentResourceUid}) between 1 and 128`,
    ),
    check(
      "sandboxes_current_operation_name_bounds",
      sql`${table.currentOperationName} is null or char_length(${table.currentOperationName}) between 1 and 1024`,
    ),
    check(
      "sandboxes_last_error_code_shape",
      sql`${table.lastErrorCode} is null or (${table.lastErrorCode} ~ '^[a-z][a-z0-9_]{0,127}$')`,
    ),
    check("sandboxes_last_error_pair", sql`(${table.lastErrorCode} is null) = (${table.lastErrorAt} is null)`),
  ],
);
