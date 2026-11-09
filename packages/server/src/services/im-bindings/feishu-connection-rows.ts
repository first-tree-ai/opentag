import type { ImBindingConnectionFailure } from "@opentag/shared";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, imBindings } from "../../db/schema/index.js";

/** One binding the Feishu connection scan may open, with the generation its attempts are judged under. */
export interface FeishuConnectionCandidate {
  imBindingId: string;
  credentialGeneration: number;
}

/** `active` Feishu bindings of Agents that still exist, in keyset pages for the connection scan. */
export function listFeishuConnectionCandidates(
  database: DatabaseClient,
  afterId: string | undefined,
  limit: number,
): Promise<FeishuConnectionCandidate[]> {
  return database
    .select({ imBindingId: imBindings.id, credentialGeneration: imBindings.credentialGeneration })
    .from(imBindings)
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .where(
      and(
        eq(imBindings.provider, "feishu"),
        eq(imBindings.status, "active"),
        ne(agents.status, "deleted"),
        ...(afterId ? [gt(imBindings.id, afterId)] : []),
      ),
    )
    .orderBy(asc(imBindings.id))
    .limit(limit);
}

/** The claim one maintenance attempt ran under; its results may only land while that claim holds. */
export interface FeishuConnectionFence {
  imBindingId: string;
  credentialGeneration: number;
  ownerInstanceId: string;
  epoch: number;
}

/** The binding is still `active` at the attempt's generation, and the attempt's claim still holds it. */
function heldBy(fence: FeishuConnectionFence) {
  return and(
    eq(imBindings.id, fence.imBindingId),
    eq(imBindings.provider, "feishu"),
    eq(imBindings.status, "active"),
    eq(imBindings.credentialGeneration, fence.credentialGeneration),
    eq(imBindings.connectionOwnerInstanceId, fence.ownerInstanceId),
    eq(imBindings.connectionFencingEpoch, fence.epoch),
  );
}

/**
 * Stops a Feishu binding whose App Feishu keeps refusing. The binding leaves the connection scan as
 * `error`, keeping the reason in `last_error_code`, until a reauthorization or replacement activates
 * it again. Like a Slack reauthorization requirement, this advances the credential generation, so
 * readiness and grants observed under the old one cannot be reused.
 *
 * Fenced on the claim that observed the last refusal: a binding reauthorized meanwhile, or claimed by
 * another instance after this lease lapsed, is neither stopped nor stripped of its newer lease.
 * Returns the Agent whose binding stopped, or nothing for a stale result.
 */
export async function stopFeishuConnection(
  database: DatabaseClient,
  fence: FeishuConnectionFence,
  errorCode: string,
  now: Date,
): Promise<string | undefined> {
  const [updated] = await database
    .update(imBindings)
    .set({
      status: "error",
      lastErrorCode: errorCode.slice(0, 120),
      credentialGeneration: sql`${imBindings.credentialGeneration} + 1`,
      connectionOwnerInstanceId: null,
      connectionLeaseExpiresAt: null,
      observedConnectedAt: null,
      observedAt: now,
      updatedAt: now,
    })
    .where(heldBy(fence))
    .returning({ agentId: imBindings.agentId });
  return updated?.agentId;
}

/**
 * Records why a maintenance attempt failed, under the same fence, so a late failure cannot restore a
 * reason that reauthorization cleared or overwrite another instance's. False for a stale result.
 */
export async function recordFeishuConnectionFailure(
  database: DatabaseClient,
  fence: FeishuConnectionFence,
  errorCode: string,
  now: Date,
): Promise<boolean> {
  const updated = await database
    .update(imBindings)
    .set({ lastErrorCode: errorCode.slice(0, 120), updatedAt: now })
    .where(heldBy(fence))
    .returning({ id: imBindings.id });
  return updated.length > 0;
}

const CONNECTION_FAILURES: Readonly<Record<string, ImBindingConnectionFailure>> = {
  FEISHU_CREDENTIAL_INVALID: "credentials_rejected",
  FEISHU_APP_UNAVAILABLE: "app_unavailable",
  FEISHU_CONNECTION_REJECTED: "connection_rejected",
  FEISHU_BOT_IDENTITY_MISMATCH: "bot_mismatch",
};

/** The public reason for a binding the connection manager stopped; nothing for any other state. */
export function connectionFailureOf(
  status: string,
  lastErrorCode: string | null,
): { connectionFailure?: ImBindingConnectionFailure } {
  const failure = status === "error" && lastErrorCode ? CONNECTION_FAILURES[lastErrorCode] : undefined;
  return failure ? { connectionFailure: failure } : {};
}
