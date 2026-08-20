import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

export const computerPlatform = pgEnum("computer_platform", ["darwin", "linux", "win32"]);

export const computers = pgTable(
  "computers",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    platform: computerPlatform("platform").notNull(),
    arch: text("arch").notNull(),
    clientVersion: text("client_version").notNull(),
    currentInstanceId: uuid("current_instance_id"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("computers_id_owner_user_id_unique").on(table.id, table.ownerUserId),
    index("computers_owner_user_id_idx").on(table.ownerUserId),
  ],
);
