import type { RuntimeApprovalRequest } from "@opentag/shared";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { computers } from "./computers.js";
import { imBindings } from "./im-bindings.js";

export const runtimeApprovals = pgTable(
  "runtime_approvals",
  {
    id: uuid("id").primaryKey(),
    serverInstanceId: uuid("server_instance_id").notNull(),
    computerId: uuid("computer_id")
      .notNull()
      .references(() => computers.id, { onDelete: "cascade" }),
    instanceId: uuid("instance_id").notNull(),
    connectionId: text("connection_id").notNull(),
    imBindingId: uuid("im_binding_id")
      .notNull()
      .references(() => imBindings.id, { onDelete: "cascade" }),
    request: jsonb("request").$type<RuntimeApprovalRequest>().notNull(),
    authority: jsonb("authority")
      .$type<{
        approverExternalId: string;
        provider: "slack" | "feishu";
        generation: number;
        installationId?: string;
        channelId: string;
        threadKey: string | null;
        externalMessageId: string;
        configRevision: number;
      }>()
      .notNull(),
    status: text("status").$type<"pending" | "accept" | "decline" | "applied" | "stale">().notNull().default("pending"),
    messageId: text("message_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("runtime_approvals_dispatch_idx").on(table.serverInstanceId, table.status, table.expiresAt)],
);
