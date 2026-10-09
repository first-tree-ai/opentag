import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CloudTokenRates } from "../../cloud-billing.js";
import { users } from "./auth.js";

// The application owns this schema; cloud metering and the private credit module share its ledger.
export const billingSchema = pgSchema("billing");
export const billingAccounts = billingSchema.table("accounts", {
  id: uuid("id")
    .primaryKey()
    .references(() => users.id, { onDelete: "restrict" }),
  planId: text("plan_id").notNull().default("standard"),
  blocked: boolean("blocked").notNull().default(false),
});
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
      .references(() => users.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id").notNull(),
    sessionId: uuid("session_id"),
    source: text("source").notNull(),
    gateway: text("gateway").notNull(),
    model: text("model").notNull(),
    rates: jsonb("rates").$type<CloudTokenRates>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    state: text("state").notNull().default("in_flight"),
    resolution: text("resolution"),
    resolutionReason: text("resolution_reason"),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }),
    cacheWriteInputTokens: bigint("cache_write_input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    pricedMicros: bigint("priced_micros", { mode: "number" }),
    debitedMicros: bigint("debited_micros", { mode: "number" }),
    reconcileAfter: timestamp("reconcile_after", { withTimezone: true }).notNull().defaultNow(),
    reconcileFailures: integer("reconcile_failures").notNull().default(0),
  },
  (table) => [
    index("attempts_account").on(table.account, table.createdAt),
    index("attempts_agent").on(table.account, table.agentId, table.createdAt),
    index("attempts_pending").on(table.reconcileAfter, table.createdAt).where(sql`${table.state} = 'pending_usage'`),
    check("attempts_source_valid", sql`${table.source} IN ('execution','connectivity_probe')`),
    check("attempts_state_valid", sql`${table.state} IN ('in_flight','pending_usage','finalized')`),
    check(
      "attempts_resolution_valid",
      sql`(${table.state} = 'finalized') = (${table.resolution} IS NOT NULL) AND (${table.resolution} IS NULL OR ${table.resolution} IN ('charged','no_charge','unbilled','written_off'))`,
    ),
    check(
      "attempts_usage_nonnegative",
      sql`((${table.inputTokens} IS NULL AND ${table.outputTokens} IS NULL AND ${table.cachedInputTokens} IS NULL AND ${table.cacheWriteInputTokens} IS NULL) OR (${table.inputTokens} IS NOT NULL AND ${table.outputTokens} IS NOT NULL AND ${table.cachedInputTokens} IS NOT NULL AND ${table.cacheWriteInputTokens} IS NOT NULL AND ${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.cachedInputTokens} >= 0 AND ${table.cacheWriteInputTokens} >= 0 AND ${table.cacheWriteInputTokens} <= ${table.inputTokens} - ${table.cachedInputTokens}))`,
    ),
    check(
      "attempts_debit_valid",
      sql`${table.pricedMicros} >= 0 AND ${table.debitedMicros} >= 0 AND ${table.debitedMicros} <= ${table.pricedMicros}`,
    ),
    check("attempts_reconcile_failures_nonnegative", sql`${table.reconcileFailures} >= 0`),
  ],
);
