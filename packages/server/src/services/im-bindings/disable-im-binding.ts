import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { imBindings, sessions, slackInstallations } from "../../db/schema/index.js";
import { markEndedDescendantsInactive } from "../sessions/session-closure.js";
import { TERMINAL_SETUP_STATES } from "./current-binding.js";

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
      // Preserve terminal history; an open authorization is atomically canceled with its secret.
      setupState: sql`case when ${imBindings.setupState}::text in ('awaiting_user', 'pending_activation', 'validating')
        then 'canceled'::feishu_setup_state else ${imBindings.setupState} end`,
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
  await transaction
    .update(sessions)
    .set({ endedAt: now, revision: sql`${sessions.revision} + 1` })
    .where(and(eq(sessions.imBindingId, imBindingId), isNull(sessions.endedAt)));
  await markEndedDescendantsInactive(transaction, { imBindingId });
  return true;
}

/**
 * What a released row looks like: no longer current, and stripped of everything a live connection or a
 * pending second attempt could use. `im_bindings_disabled_secret_shape` requires exactly these nulls.
 */
function releaseValues(now: Date) {
  return {
    status: "disabled" as const,
    disabledAt: now,
    encryptedSetupContext: null,
    setupOwnerInstanceId: null,
    setupOwnerHeartbeatAt: null,
    setupExpiresAt: null,
    connectionOwnerInstanceId: null,
    connectionLeaseExpiresAt: null,
    updatedAt: now,
  };
}

/**
 * The fence: a row that never activated and whose setup attempt already ended without activating it.
 *
 * `activated_at is null` with no issued credential is a row that never was a connection, so a
 * reauthorization attempt ended terminal on a working binding is left alone. No Session can exist
 * under that guard, because no credential was ever handed to a runtime. The credential generation
 * stays as it is: nothing was issued, so no grant or delivery needs fencing.
 */
function endedWithoutActivating() {
  return and(
    ne(imBindings.status, "disabled"),
    inArray(imBindings.setupState, [...TERMINAL_SETUP_STATES]),
    isNull(imBindings.activatedAt),
    isNull(imBindings.encryptedCredential),
  );
}

/**
 * Releases the current-binding slot of rows whose first setup attempt ended without activating them.
 *
 * A first-time setup inserts the row as `provisioning` before anything is authorized, and
 * `im_bindings_agent_current_unique` (`agent_id where status <> 'disabled'`) makes that row the
 * Agent's only slot. Readers that look at the raw row — the Slack configuration service and the two
 * Provider-immutability reads in activation — would otherwise refuse the other Provider with
 * `IM_BINDING_UNBIND_REQUIRED` and a new insert would collide on that index. Disabling the row gives
 * the slot back, and `im_bindings_feishu_app_current_unique` back with it.
 *
 * Callers pass the transaction that settles the attempt, so the terminal state and the release commit
 * together. The same fence is applied by the `0068_release_terminal_setup_slots` backfill to the rows
 * earlier binaries left behind.
 */
export async function releaseNeverActivatedSlots(
  executor: DatabaseClient | DatabaseTransaction,
  imBindingIds: readonly string[],
  now: Date,
): Promise<void> {
  if (imBindingIds.length === 0) return;
  await executor
    .update(imBindings)
    .set(releaseValues(now))
    .where(and(inArray(imBindings.id, [...imBindingIds]), endedWithoutActivating()));
}

/**
 * The same release for whichever row holds the Agent's slot, used by a writer that is about to take
 * the slot for another Provider. It covers a row the backfill could not: one an older binary writes
 * after the migration ran. The caller must already hold that row's lock, which the update takes.
 */
export async function releaseTerminalNeverActivatedSlotForAgent(
  executor: DatabaseClient | DatabaseTransaction,
  agentId: string,
  now: Date,
): Promise<void> {
  await executor
    .update(imBindings)
    .set(releaseValues(now))
    .where(and(eq(imBindings.agentId, agentId), endedWithoutActivating()));
}
