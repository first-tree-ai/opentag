import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { imBindings, sessions, slackInstallations } from "../../db/schema/index.js";

/**
 * The atomic disable every IM authorization teardown shares. It clears the effective credential,
 * setup attempt context and owner, and connection leases, terminates active chat Sessions, and
 * advances the credential generation: disabling is an authorization mutation, so the conservative
 * authorization epoch moves even though the credential is erased. Terminal repeated operations are
 * idempotent — a second disable matches nothing and changes nothing. An unused Slack installation
 * is released in the same transaction.
 */
export async function disableImBindingInTransaction(
  transaction: DatabaseTransaction,
  imBindingId: string,
  now: Date,
  expectedGeneration?: number,
  releaseUnusedSlackInstallation = true,
): Promise<boolean> {
  const disabled = await transaction
    .update(imBindings)
    .set({
      status: "disabled",
      encryptedCredential: null,
      encryptedSetupContext: null,
      setupOwnerInstanceId: null,
      setupOwnerHeartbeatAt: null,
      setupExpiresAt: null,
      connectionOwnerInstanceId: null,
      connectionLeaseExpiresAt: null,
      credentialGeneration: sql`${imBindings.credentialGeneration} + 1`,
      disabledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(imBindings.id, imBindingId),
        ne(imBindings.status, "disabled"),
        ...(expectedGeneration === undefined ? [] : [eq(imBindings.credentialGeneration, expectedGeneration)]),
      ),
    )
    .returning({ id: imBindings.id, slackInstallationId: imBindings.slackInstallationId });
  if (disabled.length === 0) return false;
  await transaction
    .update(sessions)
    .set({ endedAt: now, revision: sql`${sessions.revision} + 1` })
    .where(and(eq(sessions.imBindingId, imBindingId), isNull(sessions.endedAt)));
  const installationId = disabled[0]?.slackInstallationId;
  if (installationId && releaseUnusedSlackInstallation) {
    const [installation] = await transaction
      .select({ id: slackInstallations.id, status: slackInstallations.status })
      .from(slackInstallations)
      .where(eq(slackInstallations.id, installationId))
      .limit(1)
      .for("update");
    if (installation && installation.status !== "disabled") {
      const [remainingRoute] = await transaction
        .select({ id: imBindings.id })
        .from(imBindings)
        .where(
          and(
            eq(imBindings.slackInstallationId, installationId),
            eq(imBindings.provider, "slack"),
            ne(imBindings.status, "disabled"),
          ),
        )
        .limit(1);
      if (!remainingRoute) {
        await transaction
          .update(slackInstallations)
          .set({
            status: "disabled",
            encryptedCredential: null,
            credentialGeneration: sql`${slackInstallations.credentialGeneration} + 1`,
            disabledAt: now,
            updatedAt: now,
          })
          .where(and(eq(slackInstallations.id, installationId), ne(slackInstallations.status, "disabled")));
      }
    }
  }
  return true;
}
