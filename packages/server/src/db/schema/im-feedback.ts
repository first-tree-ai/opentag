import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const imFeedbackTargets = pgTable(
  "im_feedback_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    bindingId: uuid("binding_id").notNull(),
    bindingGeneration: bigint("binding_generation", { mode: "number" }).notNull(),
    provider: text("provider").$type<"slack" | "feishu">().notNull(),
    installationId: uuid("installation_id"),
    messageId: uuid("message_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    deliveryId: uuid("delivery_id").notNull(),
    turnId: text("turn_id"),
    placementGeneration: bigint("placement_generation", { mode: "number" }).notNull(),
    channelId: text("channel_id").notNull(),
    inputExternalId: text("input_external_id").notNull(),
    threadKey: text("thread_key"),
    senderExternalId: text("sender_external_id").notNull(),
    cardOwnerDeliveryId: uuid("card_owner_delivery_id").notNull(),
    sandboxId: uuid("sandbox_id"),
    environmentGeneration: bigint("environment_generation", { mode: "number" }),
    resourceUid: text("resource_uid"),
    state: text("state")
      .$type<
        "queued" | "working" | "completed" | "failed" | "workspace_blocked" | "retry_queued" | "resolved" | "stale"
      >()
      .notNull(),
    errorCode: text("error_code"),
    effects: text("effects").$type<"not_started" | "may_have_occurred" | "completed">(),
    reportHash: text("report_hash"),
    desiredReaction: text("desired_reaction").$type<"working" | "none" | "warning">().notNull().default("none"),
    appliedReaction: text("applied_reaction").$type<"working" | "none" | "warning">(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    appliedRevision: bigint("applied_revision", { mode: "number" }).notNull().default(0),
    cardRevision: bigint("card_revision", { mode: "number" }).notNull().default(0),
    // Every new send is a card (interactive_v1). text_v1 marks a plain-text message from before cards came back,
    // which keeps being edited as text.
    messageFormat: text("message_format").$type<"interactive_v1" | "text_v1">().notNull().default("interactive_v1"),
    cardState: text("card_state")
      .$type<"none" | "pending" | "sending" | "sent" | "send_unknown" | "blocked">()
      .notNull()
      .default("none"),
    cardMessageId: text("card_message_id"),
    providerRequestId: uuid("provider_request_id").notNull().defaultRandom(),
    sendStartedAt: timestamp("send_started_at", { withTimezone: true }),
    reconciliationCursor: text("reconciliation_cursor"),
    claimId: uuid("claim_id"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    actionsExpireAt: timestamp("actions_expire_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("im_feedback_targets_delivery_unique").on(t.deliveryId, t.bindingId, t.bindingGeneration),
    index("im_feedback_targets_card_owner_idx").on(t.cardOwnerDeliveryId, t.id),
    index("im_feedback_targets_message_idx").on(t.messageId),
    index("im_feedback_targets_due_idx").on(t.nextAttemptAt, t.id),
    index("im_feedback_targets_account_agent_idx").on(t.accountId, t.agentId, t.createdAt, t.id),
    index("im_feedback_targets_retention_idx").on(t.settledAt, t.id),
    check(
      "im_feedback_targets_state",
      sql`${t.state} in ('queued','working','completed','failed','workspace_blocked','retry_queued','resolved','stale')`,
    ),
    check(
      "im_feedback_targets_reactions",
      sql`${t.desiredReaction} in ('working','none','warning') and (${t.appliedReaction} is null or ${t.appliedReaction} in ('working','none','warning'))`,
    ),
    check("im_feedback_targets_message_format", sql`${t.messageFormat} in ('interactive_v1','text_v1')`),
    check(
      "im_feedback_targets_card_state",
      sql`${t.cardState} in ('none','pending','sending','sent','send_unknown','blocked')`,
    ),
    check(
      "im_feedback_targets_effects",
      sql`${t.effects} is null or ${t.effects} in ('not_started','may_have_occurred','completed')`,
    ),
    check(
      "im_feedback_targets_provider",
      sql`${t.provider} in ('slack','feishu') and (${t.provider} <> 'slack' or ${t.installationId} is not null)`,
    ),
    check(
      "im_feedback_targets_versions",
      sql`${t.bindingGeneration} >= 1 and ${t.placementGeneration} >= 1 and ${t.revision} >= 1 and ${t.appliedRevision} >= 0 and ${t.cardRevision} >= 0 and ${t.attemptCount} >= 0`,
    ),
    check(
      "im_feedback_targets_bounds",
      sql`length(${t.channelId}) between 1 and 255 and length(${t.inputExternalId}) between 1 and 255 and length(${t.senderExternalId}) between 1 and 255 and (${t.errorCode} is null or ${t.errorCode} ~ '^[a-zA-Z0-9_]{1,128}$')`,
    ),
  ],
);

export const imFeedbackActions = pgTable(
  "im_feedback_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedbackId: uuid("feedback_id").notNull(),
    feedbackRevision: bigint("feedback_revision", { mode: "number" }).notNull(),
    kind: text("kind").$type<"retry_task" | "save_release" | "discard">().notNull(),
    state: text("state").$type<"confirmed" | "submitting" | "checking" | "succeeded" | "failed" | "stale">().notNull(),
    actorAccountId: uuid("actor_account_id"),
    actorProviderId: text("actor_provider_id"),
    actorDisplayName: text("actor_display_name").notNull(),
    bindingGeneration: bigint("binding_generation", { mode: "number" }).notNull(),
    sessionId: uuid("session_id").notNull(),
    placementGeneration: bigint("placement_generation", { mode: "number" }).notNull(),
    environmentGeneration: bigint("environment_generation", { mode: "number" }),
    resourceUid: text("resource_uid"),
    reportHash: text("report_hash"),
    idempotencyKey: text("idempotency_key").notNull(),
    resultDeliveryId: uuid("result_delivery_id"),
    resultCode: text("result_code"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("im_feedback_actions_identity_unique").on(t.idempotencyKey),
    uniqueIndex("im_feedback_actions_revision_unique").on(t.feedbackId, t.feedbackRevision),
    index("im_feedback_actions_result_idx").on(t.state, t.updatedAt, t.id),
    check("im_feedback_actions_kind", sql`${t.kind} in ('retry_task','save_release','discard')`),
    check(
      "im_feedback_actions_state",
      sql`${t.state} in ('confirmed','submitting','checking','succeeded','failed','stale')`,
    ),
    check(
      "im_feedback_actions_actor",
      sql`${t.actorAccountId} is not null or (${t.kind} = 'retry_task' and ${t.actorProviderId} is not null)`,
    ),
    check(
      "im_feedback_actions_bounds",
      sql`length(${t.actorDisplayName}) between 1 and 255 and length(${t.idempotencyKey}) between 1 and 255 and ${t.feedbackRevision} >= 1`,
    ),
  ],
);
