import { bigint, boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { imBindings } from "./im-bindings.js";
import { imMessageDeliveries } from "./im-messages.js";
import { slackInstallations } from "./slack-installations.js";

/** Durable cleanup outbox. Secrets and message bodies never enter this projection. */
export const slackWorkingTargets = pgTable(
  "slack_working_targets",
  {
    id: text("id").primaryKey(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => imBindings.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => slackInstallations.id, { onDelete: "cascade" }),
    credentialGeneration: bigint("credential_generation", { mode: "number" }).notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    working: boolean("working").notNull().default(false),
    disabled: boolean("disabled").notNull().default(false),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    notBeforeAt: timestamp("not_before_at", { withTimezone: true }).notNull().defaultNow(),
    claimId: uuid("claim_id"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    failures: bigint("failures", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("slack_working_targets_due_idx").on(t.disabled, t.nextAttemptAt)],
);

export const slackWorkingTurns = pgTable(
  "slack_working_turns",
  {
    deliveryId: uuid("delivery_id")
      .primaryKey()
      .references(() => imMessageDeliveries.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => slackWorkingTargets.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    phase: text("phase").$type<"running" | "waiting_user" | "terminal">().notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("slack_working_turns_target_idx").on(t.targetId)],
);
