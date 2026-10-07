import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

// The application owns migrations; the private billing module owns these rows.
export const billingSchema = pgSchema("billing");
export const billingSettings = billingSchema.table("settings", {
  id: text("id").primaryKey(),
  value: integer("value").notNull(),
});
export const billingAccounts = billingSchema.table(
  "accounts",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => users.id, { onDelete: "restrict" }),
    keyHash: text("key_hash"),
    encryptedKey: text("encrypted_key"),
    blocked: boolean("blocked").notNull().default(false),
    needsSync: boolean("needs_sync").notNull().default(true),
    syncAfter: timestamp("sync_after", { withTimezone: true }).notNull().defaultNow(),
    syncFailures: integer("sync_failures").notNull().default(0),
    spentMicros: bigint("spent_micros", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("accounts_pending").on(table.syncAfter, table.id).where(sql`${table.needsSync} = true`),
    check("accounts_sync_failures_nonnegative", sql`${table.syncFailures} >= 0`),
    check("accounts_spent_nonnegative", sql`${table.spentMicros} >= 0`),
  ],
);
export const billingGrants = billingSchema.table(
  "grants",
  {
    id: text("id").primaryKey(),
    account: uuid("account")
      .notNull()
      .references(() => billingAccounts.id),
    amount: bigint("amount", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
  },
  (table) => [index("grants_account").on(table.account)],
);
export const billingCheckouts = billingSchema.table(
  "checkouts",
  {
    id: text("id").primaryKey(),
    account: uuid("account")
      .notNull()
      .references(() => billingAccounts.id),
    amountCents: integer("amount_cents").notNull(),
    session: text("session").unique(),
    payment: text("payment").unique(),
    refunded: integer("refunded").notNull().default(0),
    disputed: boolean("disputed").notNull().default(false),
  },
  (table) => [
    check("checkouts_amount_positive", sql`${table.amountCents} > 0`),
    check("checkouts_refund_valid", sql`${table.refunded} >= 0 AND ${table.refunded} <= ${table.amountCents}`),
    index("checkouts_account").on(table.account),
  ],
);
export const billingPaymentChanges = billingSchema.table(
  "payment_changes",
  {
    payment: text("payment").primaryKey(),
    refunded: integer("refunded").notNull().default(0),
    disputed: boolean("disputed").notNull().default(false),
  },
  (table) => [check("payment_changes_refund_nonnegative", sql`${table.refunded} >= 0`)],
);
export const billingAttempts = billingSchema.table(
  "attempts",
  {
    id: text("id").primaryKey(),
    account: uuid("account")
      .notNull()
      .references(() => billingAccounts.id),
    model: text("model").notNull(),
    generation: text("generation").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    chargeMicros: bigint("charge_micros", { mode: "number" }),
    reconcileAfter: timestamp("reconcile_after", { withTimezone: true }).notNull().defaultNow(),
    reconcileFailures: integer("reconcile_failures").notNull().default(0),
  },
  (table) => [
    index("attempts_account").on(table.account, table.createdAt),
    index("attempts_pending")
      .on(table.reconcileAfter, table.createdAt)
      .where(sql`${table.chargeMicros} IS NULL AND ${table.generation} IS NOT NULL`),
    check("attempts_reconcile_failures_nonnegative", sql`${table.reconcileFailures} >= 0`),
    check(
      "attempts_usage_nonnegative",
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.chargeMicros} >= 0`,
    ),
  ],
);
