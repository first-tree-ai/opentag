import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { accountComputers } from "../../db/schema/index.js";

/** Returns the stable Computer id for a Workspace enrollment. Missing projections fail closed. */
export async function projectedComputerId(
  transaction: DatabaseTransaction,
  workspaceComputerId: string,
): Promise<string> {
  const [row] = await transaction
    .select({ id: accountComputers.id })
    .from(accountComputers)
    .where(eq(accountComputers.id, workspaceComputerId))
    .limit(1);
  if (!row) {
    throw new Error("The account-owned Computer projection is missing");
  }
  return row.id;
}
