import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Better Auth's `session` model.
 *
 * The table is `auth_sessions` rather than `session`/`sessions` because `sessions` already carries the IM conversation
 * domain. Property names mirror Better Auth's field names so the Drizzle adapter resolves them without a `fields` map.
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("auth_sessions_token_unique").on(table.token),
    index("auth_sessions_user_id_idx").on(table.userId),
    index("auth_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/** Better Auth's `verification` model: short-lived challenge records reaped by expiry. */
export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("auth_verifications_identifier_idx").on(table.identifier),
    index("auth_verifications_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Records that one credential the previous revision issued has been exchanged, and for which session.
 *
 * A stateless refresh token has nothing to consume, so without this a replay — or a second tab whose request raced the
 * first — would mint another session, and every row but one would be live and invisible to the browser holding the
 * cookie. The token hash is the primary key, which makes the write itself the gate: one statement decides the winner,
 * so no lock is needed and no connection waits on one.
 *
 * The first writer wins, deliberately. Letting the last one win would mean the browser keeps whichever `Set-Cookie`
 * arrives last, which is not necessarily the row that survived — a browser could be left holding a deleted session.
 *
 * It exists only for the compatibility window and goes when legacy credentials do.
 */
export const accountLegacyUpgrades = pgTable("account_legacy_upgrades", {
  tokenHash: text("token_hash").primaryKey(),
  sessionToken: text("session_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
});
