import { relations, sql } from "drizzle-orm";
import { bigint, check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { imBindings } from "./im-bindings.js";

export const feishuInboundReceiptStatus = pgEnum("feishu_inbound_receipt_status", [
  "processing",
  "processed",
  "failed",
]);

export const feishuInboundReceipts = pgTable(
  "feishu_inbound_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    imBindingId: uuid("im_binding_id")
      .notNull()
      .references(() => imBindings.id, { onDelete: "restrict" }),
    credentialGeneration: bigint("credential_generation", { mode: "number" }).notNull(),
    eventId: text("event_id").notNull(),
    status: feishuInboundReceiptStatus("status").notNull().default("processing"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(1),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("feishu_inbound_receipts_identity_unique").on(table.imBindingId, table.eventId),
    index("feishu_inbound_receipts_status_idx").on(table.status, table.receivedAt),
    index("feishu_inbound_receipts_retention_idx")
      .on(table.receivedAt, table.id)
      .where(sql`${table.status} in ('processed', 'failed')`),
    check("feishu_inbound_receipts_generation_nonnegative", sql`${table.credentialGeneration} >= 1`),
    check("feishu_inbound_receipts_event_id_bounded", sql`length(${table.eventId}) between 1 and 512`),
    check(
      "feishu_inbound_receipts_failure_shape",
      sql`(${table.status} <> 'failed' and ${table.lastErrorCode} is null and ${table.lastErrorAt} is null)
        or (${table.status} = 'failed' and ${table.lastErrorCode} is not null and ${table.lastErrorAt} is not null)`,
    ),
    check(
      "feishu_inbound_receipts_processed_shape",
      sql`(${table.status} = 'processed' and ${table.processedAt} is not null)
        or (${table.status} <> 'processed')`,
    ),
  ],
);

export const feishuInboundReceiptsRelations = relations(feishuInboundReceipts, ({ one }) => ({
  imBinding: one(imBindings, {
    fields: [feishuInboundReceipts.imBindingId],
    references: [imBindings.id],
  }),
}));
