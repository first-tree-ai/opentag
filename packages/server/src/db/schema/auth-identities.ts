import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/**
 * Provider identities. This is also Better Auth's `account` model: `provider` carries `providerId`, `subject` carries
 * `accountId`, and the token/password columns exist because Better Auth writes them for providers that return them.
 * `email` predates Better Auth and is ours alone; the library neither reads nor writes it.
 */
export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_identities_provider_subject_unique").on(table.provider, table.issuer, table.subject),
    uniqueIndex("auth_identities_user_provider_unique").on(table.userId, table.provider, table.issuer),
    // Better Auth resolves an account by (issuer, accountId) and expects that pair to be unique on its own.
    uniqueIndex("auth_identities_issuer_subject_unique").on(table.issuer, table.subject),
    index("auth_identities_user_id_idx").on(table.userId),
  ],
);
