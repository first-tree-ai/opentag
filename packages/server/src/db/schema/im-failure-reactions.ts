import { bigint, boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { imBindings } from "./im-bindings.js";

/** One bot-owned failure marker per provider message, shared by all revisions and deliveries. */
export const imFailureReactions = pgTable(
  "im_failure_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bindingId: uuid("binding_id")
      .notNull()
      .references(() => imBindings.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    credentialGeneration: bigint("credential_generation", { mode: "number" }).notNull(),
    desired: boolean("desired").notNull(),
    applied: boolean("applied"),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    failures: bigint("failures", { mode: "number" }).notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimId: uuid("claim_id"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("im_failure_reactions_message_unique").on(t.bindingId, t.channelId, t.externalMessageId),
    index("im_failure_reactions_due_idx").on(t.nextAttemptAt),
  ],
);
