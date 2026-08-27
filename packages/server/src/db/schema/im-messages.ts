import type {
  DirectImMessageDeliveryRequest,
  ImContentV1,
  ProviderInboundContext,
  TurnReportRequest,
} from "@opentag/shared";
import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { imBindings } from "./im-bindings.js";
import { sessions } from "./sessions.js";

export const imMessageDirection = pgEnum("im_message_direction", ["inbound", "outbound"]);
export const imMessageOperation = pgEnum("im_message_operation", ["created", "edited", "deleted"]);
export const imAuthorKind = pgEnum("im_author_kind", ["human", "bot", "system"]);
export const imDeliveryAttention = pgEnum("im_delivery_attention", ["direct", "ambient"]);
export const imDeliveryState = pgEnum("im_delivery_state", ["pending", "accepted", "terminal_rejected", "expired"]);
export const imMessages = pgTable(
  "im_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    imBindingId: uuid("im_binding_id")
      .notNull()
      .references(() => imBindings.id, { onDelete: "restrict" }),
    providerEventId: text("provider_event_id"),
    channelId: text("channel_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    providerRevisionKey: text("provider_revision_key").notNull(),
    operation: imMessageOperation("operation").notNull(),
    direction: imMessageDirection("direction").notNull(),
    threadKey: text("thread_key"),
    replyToExternalId: text("reply_to_external_id"),
    authorKind: imAuthorKind("author_kind").notNull(),
    authorExternalId: text("author_external_id").notNull(),
    authorDisplayName: text("author_display_name"),
    content: jsonb("content").$type<ImContentV1>().notNull(),
    providerContext: jsonb("provider_context").$type<ProviderInboundContext>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("im_messages_provider_event_unique")
      .on(table.imBindingId, table.providerEventId)
      .where(sql`${table.providerEventId} is not null`),
    uniqueIndex("im_messages_semantic_revision_unique").on(
      table.imBindingId,
      table.channelId,
      table.externalMessageId,
      table.providerRevisionKey,
    ),
    index("im_messages_scope_occurred_idx").on(table.imBindingId, table.channelId, table.threadKey, table.occurredAt),
    index("im_messages_external_occurred_idx").on(
      table.imBindingId,
      table.channelId,
      table.externalMessageId,
      table.occurredAt,
    ),
  ],
);

export const imMessageDeliveries = pgTable(
  "im_message_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => imMessages.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    attention: imDeliveryAttention("attention").notNull(),
    state: imDeliveryState("state").notNull().default("pending"),
    placementGeneration: bigint("placement_generation", { mode: "number" }).notNull(),
    dispatchRequestId: uuid("dispatch_request_id"),
    dispatchInputHash: text("dispatch_input_hash"),
    dispatchPayload: jsonb("dispatch_payload").$type<DirectImMessageDeliveryRequest>(),
    inputHash: text("input_hash"),
    turnId: text("turn_id"),
    reportOwnerInstanceId: uuid("report_owner_instance_id"),
    resultHash: text("result_hash"),
    turnReport: jsonb("turn_report").$type<TurnReportRequest>(),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    attemptCount: bigint("attempt_count", { mode: "number" }).notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    uniqueIndex("im_message_deliveries_message_session_unique").on(table.messageId, table.sessionId),
    index("im_message_deliveries_session_id_idx").on(table.sessionId),
    index("im_message_deliveries_pending_idx").on(table.state, table.nextAttemptAt),
    uniqueIndex("im_message_deliveries_dispatch_request_unique")
      .on(table.dispatchRequestId)
      .where(sql`${table.dispatchRequestId} is not null`),
    uniqueIndex("im_message_deliveries_turn_id_unique").on(table.turnId).where(sql`${table.turnId} is not null`),
    check(
      "im_message_deliveries_dispatch_shape",
      sql`(${table.dispatchRequestId} is null and ${table.dispatchInputHash} is null and ${table.dispatchPayload} is null)
        or (${table.dispatchRequestId} is not null and ${table.dispatchInputHash} is not null
          and (${table.dispatchPayload} is not null or ${table.state} = 'accepted'))`,
    ),
    check(
      "im_message_deliveries_custody_shape",
      sql`(${table.state} = 'accepted' and ${table.inputHash} is not null and ${table.turnId} is not null and ${table.reportOwnerInstanceId} is not null and ${table.acceptedAt} is not null)
        or (${table.state} <> 'accepted' and ${table.turnId} is null and ${table.reportOwnerInstanceId} is null and ${table.reportedAt} is null and ${table.turnReport} is null and ${table.resultHash} is null)`,
    ),
    check(
      "im_message_deliveries_report_shape",
      sql`(${table.reportedAt} is null and ${table.turnReport} is null)
        or (${table.reportedAt} is not null and ${table.turnReport} is not null and ${table.resultHash} is not null)`,
    ),
  ],
);
