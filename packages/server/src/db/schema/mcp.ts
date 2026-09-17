import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { users } from "./auth.js";

export const mcpAuthKind = pgEnum("mcp_auth_kind", ["none", "bearer", "oauth"]);
export const mcpAuthorizationStatus = pgEnum("mcp_authorization_status", [
  "pending",
  "active",
  "expired",
  "revoked",
  "error",
]);
export const mcpProbeState = pgEnum("mcp_probe_state", ["pending", "succeeded", "failed"]);
/** The protocol era of the resolved origin, cached per authorization row because of URL overrides. */
export const mcpProtocolEra = pgEnum("mcp_protocol_era", ["modern", "legacy"]);
export const mcpClientRegistrationSource = pgEnum("mcp_client_registration_source", ["preregistered", "cimd", "dcr"]);

/**
 * RFC 9110 field-name token characters, lowercased. Enforced at the database layer so a header name
 * can never smuggle a CR/LF into an outbound request, and so `auth_header <> ''` always holds.
 *
 * Spelled with POSIX bracket classes rather than an explicit range: the range set contains both `'`
 * (which would close the SQL literal) and `\\r\\n` escapes (which the generator would emit as real
 * control characters), and a bracket class needs neither.
 */
const HTTP_FIELD_NAME_REGEX = "^[[:alnum:]!#$%&*+.^_`|~-]+$";
const NO_CR_OR_LF_REGEX = "[[:cntrl:]]";

/**
 * `auth_header` is stored lowercase, so every comparison against it is case-insensitive without a
 * `lower()` in SQL and two spellings of one header can never both be stored. The POSIX class above
 * is locale-aware and admits uppercase, hence the explicit equality rather than a range that would
 * need both `'` and `\r\n` escaped into the generated DDL.
 */
function lowercaseFieldNameCheck(column: string) {
  return sql`${sql.raw(column)} = lower(${sql.raw(column)})`;
}

/**
 * A shared Server definition. It holds no secret of any kind, which is what lets many Agents of one
 * Account mount and authorize the same definition independently. `default_auth_kind` is a prefill
 * for a new authorization — never a statement of what the Server requires — so two Agents may
 * authorize the same definition with different kinds.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    /** The MCP endpoint default; an Agent-level `url_override` may replace it for one Agent. */
    url: text("url").notNull(),
    defaultAuthKind: mcpAuthKind("default_auth_kind").notNull().default("oauth"),
    /** Only meaningful for `kind='bearer'`. Empty is forbidden; clearing is not a valid value here. */
    authHeader: text("auth_header").notNull().default("authorization"),
    /** The prefix sent before the stored secret; the empty string sends the secret verbatim. */
    authScheme: text("auth_scheme").notNull().default("Bearer"),
    extraHeaders: jsonb("extra_headers").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** Optimistic-concurrency token advanced only by a human edit; probes never touch it. */
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_servers_account_name_unique").on(table.accountId, sql`lower(${table.name})`),
    index("mcp_servers_account_idx").on(table.accountId),
    check("mcp_servers_revision_positive", sql`${table.revision} >= 1`),
    check("mcp_servers_name_bounds", sql`char_length(${table.name}) between 1 and 64`),
    check(
      "mcp_servers_description_bounds",
      sql`${table.description} is null or octet_length(${table.description}) <= 1024`,
    ),
    check(
      "mcp_servers_auth_header_token",
      sql`${table.authHeader} <> '' and ${table.authHeader} ~ ${sql.raw(`'${HTTP_FIELD_NAME_REGEX}'`)} and ${lowercaseFieldNameCheck("auth_header")}`,
    ),
    check("mcp_servers_auth_scheme_no_control", sql`${table.authScheme} !~ ${sql.raw(`'${NO_CR_OR_LF_REGEX}'`)}`),
    check(
      "mcp_servers_extra_headers_object",
      sql`jsonb_typeof(${table.extraHeaders}) = 'object' and pg_column_size(${table.extraHeaders}) <= 8192`,
    ),
  ],
);

/**
 * One Agent's mount of one Server, plus that Agent's own overrides of the shared definition.
 *
 * This table carries the only enable/disable switch in the feature: there is no Account-level MCP
 * surface, so there is no global switch to keep in step. A row survives the Agent's soft delete,
 * so every "how many Agents use this" decision joins `agents` and excludes `status='deleted'`.
 */
export const agentMcpServers = pgTable(
  "agent_mcp_servers",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Restrict, not cascade: deleting a definition with any mount is refused by the service. */
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(true),
    /** NULL inherits the shared definition; a value replaces it for this Agent only. */
    urlOverride: text("url_override"),
    authHeaderOverride: text("auth_header_override"),
    authSchemeOverride: text("auth_scheme_override"),
    /** NULL inherits; `{}` means this Agent sends no extra headers at all; a value replaces. */
    extraHeadersOverride: jsonb("extra_headers_override").$type<Record<string, string> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.mcpServerId] }),
    index("agent_mcp_servers_mcp_server_id_idx").on(table.mcpServerId),
    check(
      "agent_mcp_servers_auth_header_override_token",
      sql`${table.authHeaderOverride} is null or (
        ${table.authHeaderOverride} <> '' and ${table.authHeaderOverride} ~ ${sql.raw(`'${HTTP_FIELD_NAME_REGEX}'`)}
        and ${lowercaseFieldNameCheck("auth_header_override")}
      )`,
    ),
    check(
      "agent_mcp_servers_auth_scheme_override_no_control",
      sql`${table.authSchemeOverride} is null or ${table.authSchemeOverride} !~ ${sql.raw(`'${NO_CR_OR_LF_REGEX}'`)}`,
    ),
    check(
      "agent_mcp_servers_extra_headers_override_object",
      sql`${table.extraHeadersOverride} is null or (
        jsonb_typeof(${table.extraHeadersOverride}) = 'object'
        and pg_column_size(${table.extraHeadersOverride}) <= 8192
      )`,
    ),
    check(
      "agent_mcp_servers_url_override_bounds",
      sql`${table.urlOverride} is null or char_length(${table.urlOverride}) between 1 and 2048`,
    ),
  ],
);

/**
 * Exactly one authorization row per (Server, Agent): the mount decides which Agents exist, and this
 * decides what each of them presents. `kind='none'` is a real row with no credential, not an
 * absence, so the resolution chain is always one step and every credential has a place to keep its
 * own probe snapshot (the tool list differs per credential, hence per row).
 *
 * Deliberately carries no `account_id`, following the existing IM-binding precedent: the scoping
 * column is `agent_id`, and ownership is proven through `agents.created_by_user_id` and
 * `mcp_servers.account_id`. The one table that stays Account-scoped is `mcp_client_registrations`.
 */
export const mcpServerAuthorizations = pgTable(
  "mcp_server_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: mcpAuthKind("kind").notNull(),
    status: mcpAuthorizationStatus("status").notNull().default("pending"),
    /** Access + refresh sealed in one bound envelope; null while `kind='none'`. */
    ciphertext: text("ciphertext"),
    keyId: text("key_id"),
    scopes: text("scopes").array(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    /** The selected authorization server (issuer); null for `none` and unset `bearer` rows. */
    authorizationServer: text("authorization_server"),
    clientRegistrationId: uuid("client_registration_id").references(() => mcpClientRegistrations.id, {
      onDelete: "set null",
    }),
    /** The in-flight OAuth flow, reusing this row as the GitHub precedent does. */
    state: text("state"),
    stateExpiresAt: timestamp("state_expires_at", { withTimezone: true }),
    pkceCiphertext: text("pkce_ciphertext"),
    /**
     * The hash of the initiating browser's flow secret.
     *
     * The callback must present the secret this hash was derived from, which binds the flow to the
     * browser that started it. Without it the state alone would be enough to redeem a callback, and
     * the state travels in a URL that can be handed to anyone — the classic OAuth session fixation.
     */
    loginSessionHash: text("login_session_hash"),

    probeState: mcpProbeState("probe_state").notNull().default("pending"),
    probedAt: timestamp("probed_at", { withTimezone: true }),
    /** A bounded public code plus a short summary; never a raw upstream body. */
    probeError: text("probe_error"),

    /** Cached origin-era and the last successfully negotiated version; null forces re-detection. */
    protocolEra: mcpProtocolEra("protocol_era"),
    protocolVersion: text("protocol_version"),
    serverInfo: jsonb("server_info"),
    capabilities: jsonb("capabilities"),
    instructions: text("instructions"),
    tools: jsonb("tools"),
    toolsCount: integer("tools_count"),
    /** True means truncated *or* pagination stopped early; the snapshot is never the whole set. */
    toolsTruncated: boolean("tools_truncated").notNull().default(false),

    /** Refresh bookkeeping: a single-flight claim plus a generation fence on the write-back. */
    refreshGeneration: integer("refresh_generation").notNull().default(0),
    refreshClaimId: uuid("refresh_claim_id"),
    refreshClaimedAt: timestamp("refresh_claimed_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    /** An internal verdict code; never the primary code of a management-plane HTTP response. */
    failureCode: text("failure_code"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_server_authorizations_server_agent_unique").on(table.mcpServerId, table.agentId),
    /** The OAuth callback locates its row by state, so a live state is unique across the table. */
    uniqueIndex("mcp_server_authorizations_state_unique").on(table.state).where(sql`${table.state} is not null`),
    index("mcp_server_authorizations_agent_idx").on(table.agentId),
    index("mcp_server_authorizations_refresh_due_idx")
      .on(table.accessTokenExpiresAt)
      .where(sql`${table.kind} = 'oauth' and ${table.status} = 'active'`),
    check("mcp_server_authorizations_revision_positive", sql`${table.revision} >= 1`),
    check("mcp_server_authorizations_refresh_generation_nonnegative", sql`${table.refreshGeneration} >= 0`),
    check(
      "mcp_server_authorizations_tools_count_nonnegative",
      sql`${table.toolsCount} is null or ${table.toolsCount} >= 0`,
    ),
    check(
      "mcp_server_authorizations_instructions_bounds",
      sql`${table.instructions} is null or octet_length(${table.instructions}) <= 4096`,
    ),
    check(
      "mcp_server_authorizations_probe_error_bounds",
      sql`${table.probeError} is null or char_length(${table.probeError}) <= 400`,
    ),
    check("mcp_server_authorizations_credential_pair", sql`(${table.ciphertext} is null) = (${table.keyId} is null)`),
    /** `none` carries no credential at all; every other kind carries the sealed envelope. */
    check(
      "mcp_server_authorizations_none_has_no_credential",
      sql`${table.kind} <> 'none' or (${table.ciphertext} is null and ${table.keyId} is null)`,
    ),
    /**
     * A Bearer row in a state that claims to hold a credential must hold one. A `revoked`, `error`,
     * or `expired` row deliberately does not: revoking clears the key while keeping `kind`, so the UI
     * can still say "Bearer — reauthorization required" rather than losing what the method was. This
     * mirrors `oauth_shape` below, which already permits the terminal states to hold no envelope.
     */
    check(
      "mcp_server_authorizations_bearer_has_credential",
      sql`${table.kind} <> 'bearer' or (
        ${table.status} not in ('pending', 'active') or ${table.ciphertext} is not null
      )`,
    ),
    check(
      "mcp_server_authorizations_oauth_shape",
      sql`${table.kind} <> 'oauth' or (
        ${table.status} not in ('active', 'expired') or ${table.ciphertext} is not null
      )`,
    ),
    /**
     * A live flow keeps state, its deadline, the encrypted PKCE verifier, and the initiator binding
     * together. The binding is part of the shape rather than a nullable extra so a row cannot exist
     * that has a redeemable state but nobody who is allowed to redeem it.
     */
    check("mcp_server_authorizations_flow_shape", sql`(${table.state} is null) = (${table.stateExpiresAt} is null)`),
    check(
      "mcp_server_authorizations_flow_binding_shape",
      sql`(${table.state} is null) = (${table.loginSessionHash} is null)`,
    ),
    check(
      "mcp_server_authorizations_flow_requires_pkce",
      sql`${table.state} is null or (${table.kind} = 'oauth' and ${table.pkceCiphertext} is not null)`,
    ),
    check("mcp_server_authorizations_flow_is_pending", sql`${table.state} is null or ${table.status} = 'pending'`),
    check(
      "mcp_server_authorizations_refresh_claim_pair",
      sql`(${table.refreshClaimId} is null) = (${table.refreshClaimedAt} is null)`,
    ),
    check(
      "mcp_server_authorizations_refresh_claim_requires_oauth",
      sql`${table.refreshClaimId} is null or ${table.kind} = 'oauth'`,
    ),
    check(
      "mcp_server_authorizations_tools_object",
      sql`${table.tools} is null or (jsonb_typeof(${table.tools}) = 'array' and pg_column_size(${table.tools}) <= 262144)`,
    ),
  ],
);

/**
 * The client OpenTag registered with an authorization server on behalf of one Account, reused
 * across every Server and Agent of that Account that resolves to the same issuer.
 *
 * Rows are never deleted. The alternative — deleting when the last referencing Server disappears —
 * would need a cross-table reference count that is both expensive and easy to get wrong, to save a
 * row of a few dozen bytes. Line count is Accounts x issuers ever used. Registration credentials are
 * not portable across issuers, so the row is keyed by (Account, issuer).
 */
export const mcpClientRegistrations = pgTable(
  "mcp_client_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authorizationServer: text("authorization_server").notNull(),
    source: mcpClientRegistrationSource("source").notNull(),
    clientId: text("client_id").notNull(),
    /** `client_secret` or private key, sealed with its own AAD; null when the AS issues none. */
    ciphertext: text("ciphertext"),
    keyId: text("key_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_client_registrations_account_server_unique").on(table.accountId, table.authorizationServer),
    index("mcp_client_registrations_account_idx").on(table.accountId),
    check("mcp_client_registrations_credential_pair", sql`(${table.ciphertext} is null) = (${table.keyId} is null)`),
    check("mcp_client_registrations_client_id_bounds", sql`char_length(${table.clientId}) between 1 and 512`),
    check(
      "mcp_client_registrations_authorization_server_bounds",
      sql`char_length(${table.authorizationServer}) between 1 and 2048`,
    ),
  ],
);

export const mcpServersRelations = relations(mcpServers, ({ one, many }) => ({
  account: one(users, { fields: [mcpServers.accountId], references: [users.id] }),
  bindings: many(agentMcpServers),
  authorizations: many(mcpServerAuthorizations),
}));

export const agentMcpServersRelations = relations(agentMcpServers, ({ one }) => ({
  agent: one(agents, { fields: [agentMcpServers.agentId], references: [agents.id] }),
  mcpServer: one(mcpServers, { fields: [agentMcpServers.mcpServerId], references: [mcpServers.id] }),
}));

export const mcpServerAuthorizationsRelations = relations(mcpServerAuthorizations, ({ one }) => ({
  agent: one(agents, { fields: [mcpServerAuthorizations.agentId], references: [agents.id] }),
  mcpServer: one(mcpServers, { fields: [mcpServerAuthorizations.mcpServerId], references: [mcpServers.id] }),
  clientRegistration: one(mcpClientRegistrations, {
    fields: [mcpServerAuthorizations.clientRegistrationId],
    references: [mcpClientRegistrations.id],
  }),
}));

export const mcpClientRegistrationsRelations = relations(mcpClientRegistrations, ({ one, many }) => ({
  account: one(users, { fields: [mcpClientRegistrations.accountId], references: [users.id] }),
  authorizations: many(mcpServerAuthorizations),
}));
