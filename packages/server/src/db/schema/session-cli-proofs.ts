import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaceComputers } from "./computers.js";
import { sessions } from "./sessions.js";

export const sessionCliProofs = pgTable(
  "session_cli_proofs",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    proofId: uuid("proof_id").notNull().unique(),
    tokenHash: text("token_hash").notNull().unique(),
    workspaceComputerId: uuid("workspace_computer_id")
      .notNull()
      .references(() => workspaceComputers.id, { onDelete: "cascade" }),
    placementGeneration: bigint("placement_generation", { mode: "number" }).notNull(),
    connectionInstanceId: uuid("connection_instance_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("session_cli_proofs_token_hash_shape", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("session_cli_proofs_generation_positive", sql`${table.placementGeneration} >= 1`),
  ],
);
