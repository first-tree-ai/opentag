import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

export const computerPlatform = pgEnum("computer_platform", ["darwin", "linux", "win32"]);
export const computerConnectCodeMode = pgEnum("computer_connect_code_mode", ["create", "repair"]);

/**
 * The Account-owned Computer. `current_installation_id` is the local installation identity the Client
 * last exchanged or repaired with; it stays a bare identifier so replacing an installation never
 * requires a referential rewrite.
 */
export const computers = pgTable(
  "computers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerAccountId: uuid("owner_account_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    currentInstallationId: uuid("current_installation_id").notNull(),
    displayName: text("display_name").notNull(),
    platform: computerPlatform("platform").notNull(),
    arch: text("arch").notNull(),
    clientVersion: text("client_version").notNull(),
    currentInstanceId: uuid("current_instance_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("computers_owner_account_id_idx").on(table.ownerAccountId),
    uniqueIndex("computers_current_installation_id_unique").on(table.currentInstallationId),
  ],
);

export const computerCredentials = pgTable(
  "computer_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    computerId: uuid("computer_id")
      .notNull()
      .references(() => computers.id, { onDelete: "restrict" }),
    secretHash: text("secret_hash").notNull().unique(),
    issuedByUserId: uuid("issued_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("computer_credentials_active_computer_unique")
      .on(table.computerId)
      .where(sql`${table.revokedAt} is null`),
    index("computer_credentials_computer_issued_idx").on(table.computerId, table.issuedAt),
    check(
      "computer_credentials_revocation_pair",
      sql`(${table.revokedByUserId} is null) = (${table.revokedAt} is null)`,
    ),
    check(
      "computer_credentials_revoked_after_issued",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.issuedAt}`,
    ),
  ],
);

export const computerConnectCodes = pgTable(
  "computer_connect_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    issuedByAccountId: uuid("issued_by_account_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    mode: computerConnectCodeMode("mode").notNull(),
    targetComputerId: uuid("target_computer_id").references(() => computers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedComputerId: uuid("consumed_computer_id").references(() => computers.id, { onDelete: "restrict" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("computer_connect_codes_issued_by_account_created_idx").on(table.issuedByAccountId, table.createdAt),
    index("computer_connect_codes_target_computer_id_idx").on(table.targetComputerId),
    index("computer_connect_codes_consumed_computer_id_idx").on(table.consumedComputerId),
    check("computer_connect_codes_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "computer_connect_codes_consumption_pair",
      sql`(${table.consumedComputerId} is null) = (${table.consumedAt} is null)`,
    ),
    check(
      "computer_connect_codes_revocation_pair",
      sql`(${table.revokedByUserId} is null) = (${table.revokedAt} is null)`,
    ),
    check(
      "computer_connect_codes_terminal_state",
      sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
    check(
      "computer_connect_codes_repair_target_pair",
      sql`(${table.mode} = 'create') = (${table.targetComputerId} is null)`,
    ),
  ],
);
