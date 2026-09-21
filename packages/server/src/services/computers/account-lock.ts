import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";

export async function lockActiveAccount(transaction: DatabaseTransaction, accountId: string): Promise<void> {
  const [user] = await transaction
    .select({ id: users.id, suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1)
    .for("update");
  if (!user || user.suspendedAt) {
    throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
  }
}
