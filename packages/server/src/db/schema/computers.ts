import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users, workspaces } from "./auth.js";

export const computerPlatform = pgEnum("computer_platform", ["darwin", "linux", "win32"]);
export const computerConnectCodeMode = pgEnum("computer_connect_code_mode", ["create", "repair"]);

export const computers = pgTable(
  "computers",
  {
    id: uuid("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [],
);

export const workspaceComputers = pgTable(
  "workspace_computers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    computerId: uuid("computer_id")
      .notNull()
      .references(() => computers.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    platform: computerPlatform("platform").notNull(),
    arch: text("arch").notNull(),
    clientVersion: text("client_version").notNull(),
    enrolledByUserId: uuid("enrolled_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    currentInstanceId: uuid("current_instance_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("workspace_computers_workspace_id_id_unique").on(table.workspaceId, table.id),
    uniqueIndex("workspace_computers_active_workspace_computer_unique")
      .on(table.workspaceId, table.computerId)
      .where(sql`${table.revokedAt} is null`),
    index("workspace_computers_active_workspace_idx").on(table.workspaceId).where(sql`${table.revokedAt} is null`),
    index("workspace_computers_computer_id_idx").on(table.computerId),
    check(
      "workspace_computers_revocation_pair",
      sql`(${table.revokedByUserId} is null) = (${table.revokedAt} is null)`,
    ),
    check(
      "workspace_computers_revoked_after_enrolled",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.enrolledAt}`,
    ),
  ],
);

/**
 * Account-owned Computer projection. Named `account_computers` because the thin `computers` table occupies the final
 * name until that identity table is dropped.
 */
export const accountComputers = pgTable(
  "account_computers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerAccountId: uuid("owner_account_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    currentInstallationId: uuid("current_installation_id")
      .notNull()
      .references(() => computers.id, { onDelete: "restrict" }),
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
    index("account_computers_owner_account_id_idx").on(table.ownerAccountId),
    index("account_computers_current_installation_id_idx").on(table.currentInstallationId),
  ],
);

export const workspaceComputerCredentials = pgTable(
  "workspace_computer_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceComputerId: uuid("workspace_computer_id")
      .notNull()
      .references(() => workspaceComputers.id, { onDelete: "restrict" }),
    secretHash: text("secret_hash").notNull().unique(),
    issuedByUserId: uuid("issued_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workspace_computer_credentials_active_enrollment_unique")
      .on(table.workspaceComputerId)
      .where(sql`${table.revokedAt} is null`),
    index("workspace_computer_credentials_enrollment_issued_idx").on(table.workspaceComputerId, table.issuedAt),
    check(
      "workspace_computer_credentials_revocation_pair",
      sql`(${table.revokedByUserId} is null) = (${table.revokedAt} is null)`,
    ),
    check(
      "workspace_computer_credentials_revoked_after_issued",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.issuedAt}`,
    ),
  ],
);

export const computerCredentials = pgTable(
  "computer_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    computerId: uuid("computer_id")
      .notNull()
      .references(() => accountComputers.id, { onDelete: "restrict" }),
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
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique(),
    issuedByUserId: uuid("issued_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issuedByAccountId: uuid("issued_by_account_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    mode: computerConnectCodeMode("mode").notNull(),
    targetComputerId: uuid("target_computer_id").references(() => accountComputers.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedWorkspaceComputerId: uuid("consumed_workspace_computer_id"),
    consumedComputerId: uuid("consumed_computer_id").references(() => accountComputers.id, { onDelete: "restrict" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.consumedWorkspaceComputerId],
      foreignColumns: [workspaceComputers.workspaceId, workspaceComputers.id],
      name: "computer_connect_codes_workspace_enrollment_fk",
    }).onDelete("restrict"),
    index("computer_connect_codes_workspace_created_idx").on(table.workspaceId, table.createdAt),
    index("computer_connect_codes_target_computer_id_idx").on(table.targetComputerId),
    index("computer_connect_codes_consumed_computer_id_idx").on(table.consumedComputerId),
    check("computer_connect_codes_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "computer_connect_codes_consumption_pair",
      sql`(${table.consumedWorkspaceComputerId} is null) = (${table.consumedAt} is null)`,
    ),
    check(
      "computer_connect_codes_revocation_pair",
      sql`(${table.revokedByUserId} is null) = (${table.revokedAt} is null)`,
    ),
    check(
      "computer_connect_codes_terminal_state",
      sql`not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
    check("computer_connect_codes_issued_by_account_pair", sql`${table.issuedByAccountId} = ${table.issuedByUserId}`),
    check(
      "computer_connect_codes_consumed_computer_identity",
      sql`${table.consumedComputerId} is not distinct from ${table.consumedWorkspaceComputerId}`,
    ),
    check(
      "computer_connect_codes_consumed_computer_pair",
      sql`(${table.consumedComputerId} is null) = (${table.consumedAt} is null)`,
    ),
    check(
      "computer_connect_codes_repair_target_pair",
      sql`(${table.mode} = 'create') = (${table.targetComputerId} is null)`,
    ),
  ],
);
