import { UserDisplayNameSchema } from "@opentag/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { users } from "../db/schema/index.js";
import { CONNECT_CODE_TTL_SECONDS, issueConnectCodeInTransaction } from "../services/auth/index.js";

export const BootstrapAdminInputSchema = z
  .object({
    connectCodeTtlSeconds: z.number().int().positive().default(CONNECT_CODE_TTL_SECONDS),
    displayName: UserDisplayNameSchema,
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();

export type BootstrapAdminInput = z.input<typeof BootstrapAdminInputSchema>;

export interface BootstrapAdminResult {
  connectCode: string;
  expiresAt: Date;
  userId: string;
}

export async function bootstrapInitialAdmin(
  database: DatabaseClient,
  input: BootstrapAdminInput,
  now = new Date(),
): Promise<BootstrapAdminResult> {
  const validated = BootstrapAdminInputSchema.parse(input);

  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(8621303412)`);
    const [existingUser] = await transaction.select({ id: users.id }).from(users).limit(1).for("update");
    if (existingUser) {
      throw new Error("Bootstrap has already been completed");
    }

    const [user] = await transaction
      .insert(users)
      .values({ email: validated.email, displayName: validated.displayName })
      .returning({ id: users.id });
    if (!user) {
      throw new Error("Failed to create the initial account");
    }

    const issued = await issueConnectCodeInTransaction(
      transaction,
      {
        issuerUserId: user.id,
        ttlSeconds: validated.connectCodeTtlSeconds,
        userId: user.id,
      },
      now,
    );

    return { connectCode: issued.code, expiresAt: issued.expiresAt, userId: user.id };
  });
}
