import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { accountComputers } from "../../db/schema/index.js";

/** Returns the stable Computer id when the account-owned projection row already exists. */
export async function projectedComputerId(
  transaction: DatabaseTransaction,
  workspaceComputerId: string,
): Promise<string | undefined> {
  const [row] = await transaction
    .select({ id: accountComputers.id })
    .from(accountComputers)
    .where(eq(accountComputers.id, workspaceComputerId))
    .limit(1);
  return row?.id;
}
