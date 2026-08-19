import type { ImContentV1, TurnReportRequest } from "@opentag/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { imConversations, integrations } from "./integrations.js";
import { sessions } from "./sessions.js";

export const imMessageDirection = pgEnum("im_message_direction", ["inbound", "outbound"]);
export const imMessageOperation = pgEnum("im_message_operation", ["created", "edited", "deleted"]);
export const imAuthorKind = pgEnum("im_author_kind", ["human", "bot", "system"]);
export const imDeliveryAttention = pgEnum("im_delivery_attention", ["direct", "ambient"]);
export const imDeliveryState = pgEnum("im_delivery_state", ["pending", "accepted", "terminal_rejected", "expired"]);
export const imOutboundOperation = pgEnum("im_outbound_operation", ["send", "reply", "react"]);
export const imOutboundState = pgEnum("im_outbound_state", [
  "prepared",
  "succeeded",
  "deterministic_failed",
  "credential_failed",
  "transient_failed",
  "unknown",
]);
export const imResourceKind = pgEnum("im_resource_kind", ["image", "file", "audio", "video"]);
export const imResourceAvailability = pgEnum("im_resource_availability", [
  "available",
  "unavailable",
  "too_large",
  "unsupported",
]);

export const imMessages = pgTable(
  "im_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => imConversations.id, { onDelete: "restrict" }),
    externalMessageId: text("external_message_id").notNull(),
    currentRevision: bigint("current_revision", { mode: "number" }).notNull(),
    currentRevisionKey: text("current_revision_key").notNull(),
    direction: imMessageDirection("direction").notNull(),
    threadKey: text("thread_key"),
    replyToExternalId: text("reply_to_external_id"),
    authorKind: imAuthorKind("author_kind").notNull(),
    authorExternalId: text("author_external_id").notNull(),
    authorDisplayName: text("author_display_name"),
    content: jsonb("content").$type<ImContentV1>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("im_messages_conversation_external_unique").on(table.conversationId, table.externalMessageId),
    index("im_messages_conversation_occurred_idx").on(table.conversationId, table.occurredAt),
    check("im_messages_current_revision_positive", sql`${table.currentRevision} >= 1`),
  ],
);

export const imMessageEvents = pgTable(
  "im_message_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "restrict" }),
    providerEventId: text("provider_event_id").notNull(),
    messageId: uuid("message_id").references(() => imMessages.id, { onDelete: "set null" }),
    revisionKey: text("revision_key").notNull(),
    operation: imMessageOperation("operation").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("im_message_events_integration_provider_unique").on(table.integrationId, table.providerEventId),
  ],
);

export const imMessageDeliveries = pgTable(
  "im_message_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => imMessages.id, { onDelete: "restrict" }),
    messageRevision: bigint("message_revision", { mode: "number" }).notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    attention: imDeliveryAttention("attention").notNull(),
    state: imDeliveryState("state").notNull().default("pending"),
    placementGeneration: bigint("placement_generation", { mode: "number" }).notNull(),
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
    uniqueIndex("im_message_deliveries_message_revision_session_unique").on(
      table.messageId,
      table.messageRevision,
      table.sessionId,
    ),
    index("im_message_deliveries_pending_idx").on(table.state, table.nextAttemptAt),
    uniqueIndex("im_message_deliveries_turn_id_unique").on(table.turnId).where(sql`${table.turnId} is not null`),
    check("im_message_deliveries_revision_positive", sql`${table.messageRevision} >= 1`),
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

export const imOutboundRequests = pgTable(
  "im_outbound_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    expectedLatestImMessageId: uuid("expected_latest_im_message_id")
      .notNull()
      .references(() => imMessages.id, { onDelete: "restrict" }),
    operation: imOutboundOperation("operation").notNull(),
    payloadHash: text("payload_hash").notNull(),
    normalizedPayload: jsonb("normalized_payload").$type<Record<string, unknown>>().notNull(),
    state: imOutboundState("state").notNull(),
    providerMessageId: text("provider_message_id"),
    resultCode: text("result_code"),
    retryAfterSeconds: integer("retry_after_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("im_outbound_requests_request_id_unique").on(table.requestId)],
);

export const imMessageResources = pgTable(
  "im_message_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => imMessages.id, { onDelete: "restrict" }),
    messageRevision: bigint("message_revision", { mode: "number" }).notNull(),
    providerResourceKey: text("provider_resource_key").notNull(),
    kind: imResourceKind("kind").notNull(),
    filename: text("filename"),
    mediaType: text("media_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    ordinal: bigint("ordinal", { mode: "number" }).notNull(),
    availability: imResourceAvailability("availability").notNull().default("available"),
  },
  (table) => [
    uniqueIndex("im_message_resources_message_revision_ordinal_unique").on(
      table.messageId,
      table.messageRevision,
      table.ordinal,
    ),
    check("im_message_resources_ordinal_range", sql`${table.ordinal} >= 0 and ${table.ordinal} < 16`),
    check("im_message_resources_size_limit", sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`),
  ],
);
