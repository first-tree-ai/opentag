import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users, workspaces } from "./auth.js";

export const adminInvitations = pgTable(
  "admin_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("admin_invitations_workspace_created_idx").on(table.workspaceId, table.createdAt),
    check("admin_invitations_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "admin_invitations_acceptance_pair",
      sql`(${table.acceptedByUserId} is null) = (${table.acceptedAt} is null)`,
    ),
    check("admin_invitations_revocation_pair", sql`(${table.revokedByUserId} is null) = (${table.revokedAt} is null)`),
    check(
      "admin_invitations_terminal_state",
      sql`not (${table.acceptedAt} is not null and ${table.revokedAt} is not null)`,
    ),
  ],
);
