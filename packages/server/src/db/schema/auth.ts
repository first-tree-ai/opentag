import { relations, sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Email is stored lowercased, and one address identifies at most one Account. That is enforced by the identity
 * resolver, which serializes on the address before deciding whether to create or attach. A case-insensitive unique
 * index backs it up for any writer that skips the resolver, and lands once no pre-resolver revision is still serving.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  displayName: text("display_name").notNull(),
  image: text("image"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  ...timestamps,
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("workspaces_name_unique").on(sql`lower(${table.name})`)],
);

export const workspaceAdminGrants = pgTable(
  "workspace_admin_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workspace_admin_grants_active_workspace_user_unique")
      .on(table.workspaceId, table.userId)
      .where(sql`${table.revokedAt} is null`),
    /**
     * The next two indexes bind Account and Workspace one to one, in both directions, so that a
     * Workspace is a shadow of exactly one Account rather than a scope anything could have to choose
     * between or share. `workspace_id = ?` therefore means "belongs to this Account", which is what
     * every management read already assumes.
     *
     * They are the pair to drop, and only them, if a Workspace ever has to hold several Admins again.
     * The composite index above survives that relaxation and states the property that still holds: one
     * active grant per Workspace and Account pair.
     */
    uniqueIndex("workspace_admin_grants_active_user_unique").on(table.userId).where(sql`${table.revokedAt} is null`),
    uniqueIndex("workspace_admin_grants_active_workspace_unique")
      .on(table.workspaceId)
      .where(sql`${table.revokedAt} is null`),
    index("workspace_admin_grants_active_user_workspace_idx")
      .on(table.userId, table.workspaceId)
      .where(sql`${table.revokedAt} is null`),
    index("workspace_admin_grants_workspace_granted_idx").on(table.workspaceId, table.grantedAt),
    check(
      "workspace_admin_grants_revocation_pair",
      sql`(${table.revokedByUserId} is null) = (${table.revokedAt} is null)`,
    ),
    check(
      "workspace_admin_grants_revoked_after_granted",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.grantedAt}`,
    ),
  ],
);

export const accountCliLoginCodes = pgTable(
  "account_cli_login_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issuedByUserId: uuid("issued_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("account_cli_login_codes_user_created_idx").on(table.userId, table.createdAt),
    check("account_cli_login_codes_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  workspaceAdminGrants: many(workspaceAdminGrants),
}));

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  adminGrants: many(workspaceAdminGrants),
}));

export const workspaceAdminGrantsRelations = relations(workspaceAdminGrants, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceAdminGrants.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceAdminGrants.userId], references: [users.id] }),
}));
