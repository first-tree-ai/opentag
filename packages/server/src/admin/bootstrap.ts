import { TeamNameSchema } from "@opentag/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { connectCodes, memberships, teams, users } from "../db/schema/index.js";
import { generateSecret, hashSecret } from "../services/auth/security.js";

export const BootstrapAdminInputSchema = z
  .object({
    connectCodeTtlSeconds: z
      .number()
      .int()
      .positive()
      .default(15 * 60),
    displayName: z.string().trim().min(1),
    email: z.string().trim().toLowerCase().email(),
    teamDisplayName: z.string().trim().min(1),
    teamName: z.string().trim().toLowerCase().pipe(TeamNameSchema),
  })
  .strict();

export type BootstrapAdminInput = z.input<typeof BootstrapAdminInputSchema>;

export interface BootstrapAdminResult {
  connectCode: string;
  expiresAt: Date;
  teamId: string;
  userId: string;
}

export async function bootstrapInitialAdmin(
  database: DatabaseClient,
  input: BootstrapAdminInput,
  now = new Date(),
): Promise<BootstrapAdminResult> {
  const validated = BootstrapAdminInputSchema.parse(input);
  const connectCode = generateSecret(24);
  const expiresAt = new Date(now.getTime() + validated.connectCodeTtlSeconds * 1000);

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
    const [team] = await transaction
      .insert(teams)
      .values({ name: validated.teamName, displayName: validated.teamDisplayName })
      .returning({ id: teams.id });
    if (!user || !team) {
      throw new Error("Failed to create the initial account");
    }

    await transaction.insert(memberships).values({ teamId: team.id, userId: user.id, role: "admin" });
    await transaction.insert(connectCodes).values({
      codeHash: hashSecret(connectCode),
      userId: user.id,
      issuerUserId: user.id,
      expiresAt,
    });

    return { connectCode, expiresAt, teamId: team.id, userId: user.id };
  });
}
