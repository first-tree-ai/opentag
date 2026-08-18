import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../db/client.js";
import { connectCodes, memberships, tenants, users } from "../db/schema/index.js";
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
    tenantDisplayName: z.string().trim().min(1),
    tenantSlug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]*$/),
  })
  .strict();

export type BootstrapAdminInput = z.input<typeof BootstrapAdminInputSchema>;

export interface BootstrapAdminResult {
  connectCode: string;
  expiresAt: Date;
  tenantId: string;
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
    const [tenant] = await transaction
      .insert(tenants)
      .values({ slug: validated.tenantSlug, displayName: validated.tenantDisplayName })
      .returning({ id: tenants.id });
    if (!user || !tenant) {
      throw new Error("Failed to create the initial account");
    }

    await transaction.insert(memberships).values({ tenantId: tenant.id, userId: user.id, role: "admin" });
    await transaction.insert(connectCodes).values({
      codeHash: hashSecret(connectCode),
      userId: user.id,
      issuerUserId: user.id,
      expiresAt,
    });

    return { connectCode, expiresAt, tenantId: tenant.id, userId: user.id };
  });
}
