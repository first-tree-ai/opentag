import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { users } from "./auth.js";

export const slackOAuthNonces = pgTable(
  "slack_oauth_nonces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nonceHash: text("nonce_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    intent: text("intent").notNull(),
    expectedBindingId: uuid("expected_binding_id"),
    expectedCredentialGeneration: bigint("expected_credential_generation", { mode: "number" }),
    sessionBindingHash: text("session_binding_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("slack_oauth_nonces_user_agent_idx").on(table.userId, table.agentId, table.createdAt),
    index("slack_oauth_nonces_expires_idx").on(table.expiresAt),
    check("slack_oauth_nonces_intent", sql`${table.intent} in ('create', 'reauthorize', 'replace')`),
    check("slack_oauth_nonces_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "slack_oauth_nonces_expected_binding_pair",
      sql`(${table.expectedBindingId} is null) = (${table.expectedCredentialGeneration} is null)`,
    ),
    check(
      "slack_oauth_nonces_generation_positive",
      sql`${table.expectedCredentialGeneration} is null or ${table.expectedCredentialGeneration} >= 1`,
    ),
  ],
);
