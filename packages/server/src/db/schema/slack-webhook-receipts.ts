import { relations, sql } from "drizzle-orm";
import { bigint, check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { slackInstallations } from "./slack-installations.js";

export const slackWebhookReceiptStatus = pgEnum("slack_webhook_receipt_status", ["processing", "processed", "failed"]);

export const slackWebhookReceipts = pgTable(
  "slack_webhook_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => slackInstallations.id, { onDelete: "restrict" }),
    credentialGeneration: bigint("credential_generation", { mode: "number" }).notNull(),
    eventId: text("event_id").notNull(),
    status: slackWebhookReceiptStatus("status").notNull().default("processing"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(1),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("slack_webhook_receipts_identity_unique").on(
      table.installationId,
      table.credentialGeneration,
      table.eventId,
    ),
    index("slack_webhook_receipts_status_idx").on(table.status, table.receivedAt),
    index("slack_webhook_receipts_retention_idx")
      .on(table.receivedAt, table.id)
      .where(sql`${table.status} in ('processed', 'failed')`),
    check("slack_webhook_receipts_generation_nonnegative", sql`${table.credentialGeneration} >= 1`),
    check("slack_webhook_receipts_event_id_bounded", sql`length(${table.eventId}) between 1 and 255`),
    check(
      "slack_webhook_receipts_failure_shape",
      sql`(${table.status} <> 'failed' and ${table.lastErrorCode} is null and ${table.lastErrorAt} is null)
        or (${table.status} = 'failed' and ${table.lastErrorCode} is not null and ${table.lastErrorAt} is not null)`,
    ),
    check(
      "slack_webhook_receipts_processed_shape",
      sql`(${table.status} = 'processed' and ${table.processedAt} is not null)
        or (${table.status} <> 'processed')`,
    ),
  ],
);

export const slackWebhookReceiptsRelations = relations(slackWebhookReceipts, ({ one }) => ({
  installation: one(slackInstallations, {
    fields: [slackWebhookReceipts.installationId],
    references: [slackInstallations.id],
  }),
}));
