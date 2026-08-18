import { relations, sql } from "drizzle-orm";
import { index, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const membershipRole = pgEnum("membership_role", ["admin", "member"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_unique").on(sql`lower(${table.email})`)],
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("teams_slug_unique").on(sql`lower(${table.slug})`)],
);

export const memberships = pgTable(
  "memberships",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId], name: "memberships_team_user_pk" }),
    index("memberships_user_id_idx").on(table.userId),
  ],
);

export const connectCodes = pgTable(
  "connect_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuerUserId: uuid("issuer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("connect_codes_user_id_idx").on(table.userId)],
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const teamsRelations = relations(teams, ({ many }) => ({ memberships: many(memberships) }));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  team: one(teams, { fields: [memberships.teamId], references: [teams.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));
