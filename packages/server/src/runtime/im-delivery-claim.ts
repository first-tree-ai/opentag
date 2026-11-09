import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { imMessageDeliveries } from "../db/schema/index.js";
import type { ClaimLease } from "./im-delivery-custody.js";
import type { DeliveryAttempt, ImDeliveryFailurePhase, WorkerClaim } from "./im-delivery-worker.types.js";

/**
 * The marker a delivery carries while a worker is dispatching it. The claim lives in
 * `last_error_code`, prefixed so it is distinguishable from a failure code, and its lease is
 * `next_attempt_at`: a claim whose lease has lapsed is a crashed worker's, and any worker may
 * take the row again. Everything that must recognise an in-flight dispatch reads this prefix.
 */
export const DISPATCH_CLAIM_PREFIX = "IM_DELIVERY_CLAIM_";

export function dispatchClaimToken(): string {
  return `${DISPATCH_CLAIM_PREFIX}${randomUUID().replaceAll("-", "").toUpperCase()}`;
}

export function claimPhase(claim: WorkerClaim): ImDeliveryFailurePhase {
  return claim.kind === "pending" ? "deliver" : claim.kind === "steer" ? "steer" : "recover";
}
/** The claim already carries its identity, so a timeout is attributed even when the operation never loads a row. */
export function claimAttempt(claim: WorkerClaim, phase: ImDeliveryFailurePhase): DeliveryAttempt {
  return {
    deliveryId: claim.id,
    agentId: claim.agentId,
    computerId: claim.computerId,
    attemptCount: claim.attemptCount,
    phase,
    previousErrorCode: claim.previousErrorCode,
    ...("claimToken" in claim ? { claimToken: claim.claimToken } : {}),
  };
}

export function maintainDeliveryClaimLease(
  database: DatabaseClient,
  attempt: DeliveryAttempt,
  options: { now: () => number; leaseMs: number; renewMs: number; onLost?: () => void },
): ClaimLease {
  const claimToken = attempt.claimToken;
  const recovery = attempt.phase === "recover";
  if (!claimToken && !recovery) throw new Error("IM_DELIVERY_CLAIM_TOKEN_MISSING");
  const ownership = and(
    eq(imMessageDeliveries.id, attempt.deliveryId),
    ...(recovery
      ? [
          eq(imMessageDeliveries.state, "accepted"),
          eq(imMessageDeliveries.attemptCount, attempt.attemptCount),
          isNull(imMessageDeliveries.reportedAt),
          isNull(imMessageDeliveries.lastErrorCode),
        ]
      : [
          inArray(imMessageDeliveries.state, ["pending", "expired"]),
          eq(imMessageDeliveries.lastErrorCode, claimToken ?? ""),
        ]),
  );
  let active = true;
  let lost = false;
  let renewal = Promise.resolve();
  const lose = () => {
    if (lost) return;
    lost = true;
    options.onLost?.();
  };
  const renew = () => {
    renewal = renewal
      .then(async () => {
        if (!active || lost) return;
        const [renewed] = await database
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(options.now() + options.leaseMs) })
          .where(ownership)
          .returning({ id: imMessageDeliveries.id });
        if (!renewed) lose();
      })
      .catch(lose);
  };
  const timer = setInterval(renew, options.renewMs);
  timer.unref();
  return {
    assertOwned: async () => {
      await renewal;
      if (lost) return false;
      const [owned] = await database
        .select({ id: imMessageDeliveries.id })
        .from(imMessageDeliveries)
        .where(ownership)
        .limit(1);
      if (!owned) lose();
      return !lost;
    },
    stop: async () => {
      active = false;
      clearInterval(timer);
      await renewal;
    },
  };
}
