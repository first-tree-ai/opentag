import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { computerConnectCodes, computerCredentials, computers } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { lockActiveAccount } from "./account-lock.js";

/** Revoke access without changing the Computer identity, Agent bindings, or local files. */
export async function disconnectComputerAccess(
  database: DatabaseClient,
  accountId: string,
  computerId: string,
  now: () => Date,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await lockActiveAccount(transaction, accountId);
    const revokedAt = now();
    const [computer] = await transaction
      .select({ kind: computers.kind })
      .from(computers)
      .where(and(eq(computers.id, computerId), eq(computers.ownerAccountId, accountId), isNull(computers.deletedAt)))
      .limit(1)
      .for("update");
    if (!computer) {
      throw new AuthServiceError("COMPUTER_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
    }
    if (computer.kind !== "local") {
      throw new AuthServiceError(
        "COMPUTER_NOT_DISCONNECTABLE",
        "deterministic",
        "Only a Local Computer can be disconnected",
        409,
      );
    }
    await transaction
      .update(computerCredentials)
      .set({ revokedByUserId: accountId, revokedAt })
      .where(and(eq(computerCredentials.computerId, computerId), isNull(computerCredentials.revokedAt)));
    // Redemption also locks Account first. Even an already-started redemption must observe this
    // revocation; an old code can never regain access after a later successful repair.
    await transaction
      .update(computerConnectCodes)
      .set({ revokedByUserId: accountId, revokedAt })
      .where(
        and(
          eq(computerConnectCodes.targetComputerId, computerId),
          isNull(computerConnectCodes.consumedAt),
          isNull(computerConnectCodes.revokedAt),
        ),
      );
    await transaction
      .update(computers)
      .set({ disconnectedAt: revokedAt, currentInstanceId: null, connectedAt: null, updatedAt: revokedAt })
      .where(eq(computers.id, computerId));
  });
}
