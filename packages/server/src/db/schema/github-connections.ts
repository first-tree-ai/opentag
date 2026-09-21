import type { GitHubOAuthContext, GitHubRepositoryBinding } from "@opentag/shared";
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import { users } from "./auth.js";

export const githubConnectionStatus = pgEnum("github_connection_status", [
  "pending",
  "active",
  "reauthorization_required",
  "revoked",
  "superseded",
]);

export const githubConnectionRefreshStatus = pgEnum("github_connection_refresh_status", ["idle", "claimed", "unknown"]);

/**
 * One row is one OpenTag Account's current-or-historical connection to one GitHub App on one GitHub
 * host. The current row is unique per (account_id, github_host, app_id); revoked/superseded rows are
 * retained history and never hold secrets.
 *
 * Lifecycle groupings enforced as SQL checks: secret pairs (credential ciphertext/key ID, token
 * expiries, encrypted OAuth slot/key ID) are null together or present together; active rows carry
 * the full identity/credential/expiry/next-recheck set; terminal states clear every secret and
 * temporary flow; the refresh claim fields form one CAS group whose attempt and deadline pair up
 * even while idle; and an OAuth state hash always pairs with its nonsecret flow context, with the
 * encrypted PKCE slot only ever hanging off an in-flight flow.
 */
export const githubConnections = pgTable(
  "github_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    githubHost: text("github_host").notNull(),
    /** The GitHub App's numeric ID (not its client ID), as a decimal string. */
    appId: text("app_id").notNull(),
    githubUserId: text("github_user_id"),
    githubLogin: text("github_login"),
    status: githubConnectionStatus("status").notNull().default("pending"),

    bindingsSchemaVersion: integer("bindings_schema_version").notNull().default(1),
    repositoryBindings: jsonb("repository_bindings")
      .$type<GitHubRepositoryBinding[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    credentialCiphertext: text("credential_ciphertext"),
    credentialKeyId: text("credential_key_id"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),

    authorizationVersion: bigint("authorization_version", { mode: "bigint" }).notNull().default(sql`1`),
    credentialGeneration: bigint("credential_generation", { mode: "bigint" }).notNull().default(sql`0`),

    refreshAttemptId: uuid("refresh_attempt_id"),
    refreshClaimUntil: timestamp("refresh_claim_until", { withTimezone: true }),
    refreshStatus: githubConnectionRefreshStatus("refresh_status").notNull().default("idle"),

    oauthStateHash: text("oauth_state_hash"),
    oauthContextCiphertext: text("oauth_context_ciphertext"),
    oauthContextKeyId: text("oauth_context_key_id"),
    oauthContext: jsonb("oauth_context").$type<GitHubOAuthContext>(),

    recheckGeneration: bigint("recheck_generation", { mode: "bigint" }).notNull().default(sql`0`),
    recheckRequired: boolean("recheck_required").notNull().default(false),
    nextRecheckAt: timestamp("next_recheck_at", { withTimezone: true }),

    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("github_connections_current_unique")
      .on(table.accountId, table.githubHost, table.appId)
      .where(sql`${table.status} in ('pending', 'active', 'reauthorization_required')`),
    uniqueIndex("github_connections_oauth_state_unique")
      .on(table.oauthStateHash)
      .where(sql`${table.oauthStateHash} is not null`),
    index("github_connections_recheck_due_idx").on(table.nextRecheckAt).where(sql`${table.status} = 'active'`),
    index("github_connections_account_idx").on(table.accountId),
    check("github_connections_host_nonempty", sql`char_length(${table.githubHost}) between 1 and 255`),
    check("github_connections_app_id_decimal", sql`${table.appId} ~ '^[1-9][0-9]*$'`),
    check(
      "github_connections_user_id_decimal",
      sql`${table.githubUserId} is null or ${table.githubUserId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "github_connections_login_bounds",
      sql`${table.githubLogin} is null or char_length(${table.githubLogin}) between 1 and 100`,
    ),
    check("github_connections_identity_pair", sql`(${table.githubUserId} is null) = (${table.githubLogin} is null)`),
    check(
      "github_connections_credential_pair",
      sql`(${table.credentialCiphertext} is null) = (${table.credentialKeyId} is null)`,
    ),
    check(
      "github_connections_oauth_secret_pair",
      sql`(${table.oauthContextCiphertext} is null) = (${table.oauthContextKeyId} is null)`,
    ),
    check(
      "github_connections_token_expiry_pair",
      sql`(${table.accessExpiresAt} is null) = (${table.refreshExpiresAt} is null)`,
    ),
    check(
      "github_connections_credential_expiry_pair",
      sql`(${table.credentialCiphertext} is null) = (${table.accessExpiresAt} is null)`,
    ),
    check(
      "github_connections_versions_nonnegative",
      sql`${table.authorizationVersion} >= 0 and ${table.credentialGeneration} >= 0 and ${table.recheckGeneration} >= 0`,
    ),
    check("github_connections_bindings_schema_version", sql`${table.bindingsSchemaVersion} >= 1`),
    check(
      "github_connections_bindings_array_bounded",
      sql`jsonb_typeof(${table.repositoryBindings}) = 'array' and pg_column_size(${table.repositoryBindings}) <= 262144`,
    ),
    check(
      "github_connections_oauth_context_object",
      sql`${table.oauthContext} is null or jsonb_typeof(${table.oauthContext}) = 'object'`,
    ),
    check(
      "github_connections_refresh_claim_group",
      sql`(${table.refreshStatus} = 'claimed') = (${table.refreshAttemptId} is not null and ${table.refreshClaimUntil} is not null)`,
    ),
    check(
      "github_connections_refresh_attempt_pair",
      sql`(${table.refreshAttemptId} is null) = (${table.refreshClaimUntil} is null)`,
    ),
    check(
      "github_connections_refresh_unknown_requires_reauthorization",
      sql`${table.refreshStatus} <> 'unknown' or ${table.status} = 'reauthorization_required'`,
    ),
    check(
      "github_connections_oauth_flow_pair",
      sql`(${table.oauthStateHash} is null) = (${table.oauthContext} is null)`,
    ),
    check(
      "github_connections_oauth_secret_requires_flow",
      sql`${table.oauthContextCiphertext} is null or ${table.oauthStateHash} is not null`,
    ),
    check(
      "github_connections_active_shape",
      sql`${table.status} <> 'active' or (
        ${table.githubUserId} is not null and
        ${table.credentialCiphertext} is not null and
        ${table.nextRecheckAt} is not null
      )`,
    ),
    check(
      "github_connections_pending_shape",
      sql`${table.status} <> 'pending' or (
        ${table.githubUserId} is null and
        ${table.credentialCiphertext} is null and
        ${table.nextRecheckAt} is null and
        ${table.refreshStatus} = 'idle'
      )`,
    ),
    check(
      "github_connections_reauthorization_shape",
      sql`${table.status} <> 'reauthorization_required' or (
        ${table.githubUserId} is not null and
        ${table.credentialCiphertext} is null and
        ${table.nextRecheckAt} is null and
        ${table.refreshStatus} <> 'claimed'
      )`,
    ),
    check(
      "github_connections_terminal_shape",
      sql`${table.status} not in ('revoked', 'superseded') or (
        ${table.credentialCiphertext} is null and
        ${table.oauthStateHash} is null and
        ${table.oauthContextCiphertext} is null and
        ${table.oauthContext} is null and
        ${table.refreshAttemptId} is null and
        ${table.refreshClaimUntil} is null and
        ${table.refreshStatus} = 'idle' and
        ${table.nextRecheckAt} is null
      )`,
    ),
  ],
);

export const githubConnectionsRelations = relations(githubConnections, ({ one }) => ({
  account: one(users, { fields: [githubConnections.accountId], references: [users.id] }),
}));
