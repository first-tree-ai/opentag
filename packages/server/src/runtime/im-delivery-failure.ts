import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { imMessageDeliveries } from "../db/schema/index.js";
import { outcomeAttrs, setActiveSpanAttributes } from "../observability/index.js";
import { releaseImBatch } from "./im-delivery-batch.js";
import { ImDeliveryInputError, rejectInvalidImDelivery } from "./im-delivery-content.js";
import { isCloudReadinessRetry } from "./im-delivery-ready-wakeup.js";
import { cappedRetryDelayMs } from "./im-delivery-retry.js";
import type {
  DeliveryAttempt,
  ImDeliveryDiagnosticContext,
  ImDeliveryDiagnosticReporter,
  RuntimeDeliveryWorkerMetric,
} from "./im-delivery-worker.types.js";
import type { PostgresRuntimeCustodyStore } from "./runtime-custody-store.js";

/**
 * Every transition that gives up on a claimed delivery attempt, in one place: backoff, dispatch
 * release, terminal rejection. The worker owns claiming and dispatching; keeping these transitions
 * here gives each one the delivery identity a diagnostic needs, and keeps no write able to touch a
 * row that a newer attempt has already claimed.
 */

const BOUNDED_CODE = /^IM_DELIVERY_[A-Z0-9_]{1,100}$/;
const RETRY_DELAY_MS = 2_000;

/** Reconcile statuses that are expected waiting states, not operator-facing failures. */
export const EXPECTED_RECOVERY_CODES = new Set([
  "IM_DELIVERY_RECOVERY_BUSY",
  "IM_DELIVERY_RECOVERY_RUNNING",
  "IM_DELIVERY_RECOVERY_REPORTING",
]);

export interface DeliveryFailureDeps {
  database: DatabaseClient;
  now: () => number;
  onDiagnostic: ImDeliveryDiagnosticReporter;
  onMetric: (metric: RuntimeDeliveryWorkerMetric) => void;
  onDeliverySettled?: (deliveryId: string) => void;
  custody: Pick<PostgresRuntimeCustodyStore, "recordTurn">;
  /** Claim tokens already serving a Cloud readiness retry, which must not re-arm themselves. */
  readyRetryClaims: ReadonlySet<string>;
  recheckReady: (deliveryId: string) => void;
}

/** The identity and counters a diagnostic carries; never a message body or provider payload. */
export function diagnosticContext(attempt: DeliveryAttempt): ImDeliveryDiagnosticContext {
  return {
    phase: attempt.phase,
    deliveryId: attempt.deliveryId,
    agentId: attempt.agentId,
    computerId: attempt.computerId,
    attemptCount: attempt.attemptCount,
  };
}

/** Record one failed attempt and when the delivery becomes due again. */
export async function recordDeliveryFailure(
  deps: DeliveryFailureDeps,
  attempt: DeliveryAttempt,
  code: string,
  retryDelayMs?: number,
): Promise<void> {
  const bounded = BOUNDED_CODE.test(code) ? code : "IM_DELIVERY_FAILED";
  setActiveSpanAttributes(outcomeAttrs("failed", bounded));
  const delayMs = retryDelayMs ?? RETRY_DELAY_MS;
  const [updated] = await deps.database
    .update(imMessageDeliveries)
    .set({ lastErrorCode: bounded, nextAttemptAt: new Date(deps.now() + delayMs) })
    .where(
      and(
        eq(imMessageDeliveries.id, attempt.deliveryId),
        sql`${imMessageDeliveries.state} in ('pending', 'accepted', 'expired')`,
        ...(attempt.claimToken ? [eq(imMessageDeliveries.lastErrorCode, attempt.claimToken)] : []),
      ),
    )
    .returning({ id: imMessageDeliveries.id });
  if (!updated) return;
  deps.onDiagnostic(bounded, diagnosticContext(attempt));
  deps.onMetric({ name: "retry", value: 1 });
  if (isCloudReadinessRetry(bounded) && (!attempt.claimToken || !deps.readyRetryClaims.has(attempt.claimToken))) {
    // A ready event may have seen this row's claim marker before the backoff was recorded.
    // Recheck AFTER the write; a ready-triggered retry itself keeps normal bounded backoff.
    deps.recheckReady(attempt.deliveryId);
  }
}

/** Release a frozen dispatch so the input can be prepared again, without inventing a result. */
export async function releaseDeliveryDispatch(
  deps: DeliveryFailureDeps,
  attempt: DeliveryAttempt,
  requestId: string,
  code: string,
): Promise<void> {
  const bounded = BOUNDED_CODE.test(code) ? code : "IM_DELIVERY_FAILED";
  setActiveSpanAttributes(outcomeAttrs("released", bounded));
  const released = await deps.database.transaction(async (transaction) => {
    const [released] = await transaction
      .update(imMessageDeliveries)
      .set({
        executionOrigin: null,
        dispatchRequestId: null,
        dispatchInputHash: null,
        dispatchPayload: null,
        lastErrorCode: bounded,
        nextAttemptAt: new Date(deps.now() + RETRY_DELAY_MS),
      })
      .where(
        and(
          eq(imMessageDeliveries.id, attempt.deliveryId),
          inArray(imMessageDeliveries.state, ["pending", "expired"]),
          eq(imMessageDeliveries.dispatchRequestId, requestId),
          eq(imMessageDeliveries.lastErrorCode, attempt.claimToken ?? ""),
        ),
      )
      .returning({ id: imMessageDeliveries.id });
    if (released) await releaseImBatch(transaction, attempt.deliveryId);
    return released;
  });
  if (released) {
    deps.onDiagnostic(bounded, diagnosticContext(attempt));
    deps.onMetric({ name: "retry", value: 1 });
  }
}

export async function handleDeliveryFailure(
  deps: DeliveryFailureDeps,
  attempt: DeliveryAttempt,
  code: string,
  error: unknown,
): Promise<void> {
  if (error instanceof ImDeliveryInputError) {
    await rejectInvalidDeliveryInput(deps, attempt, error);
    return;
  }
  await recordDeliveryFailure(deps, attempt, code);
}

/** Terminally reject a pending input; the only path that clears a frozen dispatch and its batch. */
export async function rejectDelivery(
  deps: DeliveryFailureDeps,
  deliveryId: string,
  reason: string,
  claimToken?: string,
): Promise<boolean> {
  setActiveSpanAttributes(outcomeAttrs("terminal_rejected", reason));
  const rejected = await deps.database.transaction(async (transaction) => {
    const [rejected] = await transaction
      .update(imMessageDeliveries)
      .set({
        state: "terminal_rejected",
        executionOrigin: null,
        dispatchRequestId: null,
        dispatchInputHash: null,
        dispatchPayload: null,
        reason: reason.slice(0, 120),
        lastErrorCode: "IM_DELIVERY_TERMINAL",
      })
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          eq(imMessageDeliveries.state, "pending"),
          ...(claimToken ? [eq(imMessageDeliveries.lastErrorCode, claimToken)] : []),
        ),
      )
      .returning({ id: imMessageDeliveries.id });
    if (rejected) await releaseImBatch(transaction, deliveryId);
    return rejected;
  });
  if (rejected) deps.onDeliverySettled?.(deliveryId);
  return rejected !== undefined;
}

export async function rejectInvalidDeliveryInput(
  deps: DeliveryFailureDeps,
  attempt: DeliveryAttempt,
  error: ImDeliveryInputError,
): Promise<void> {
  setActiveSpanAttributes({
    "im.validation.code": error.code,
    "im.validation.paths": error.paths.join(","),
    "im.delivery.id": attempt.deliveryId,
  });
  const rejected = await rejectInvalidImDelivery(deps.database, attempt.deliveryId, error, attempt.claimToken ?? "");
  if (!rejected) return;
  deps.onDiagnostic(error.code, diagnosticContext(attempt));
  deps.onDeliverySettled?.(attempt.deliveryId);
}

/** A reconcile response is not a report; preserve custody until the actual report settles it. */
export async function deferRecoveryRetry(
  deps: DeliveryFailureDeps,
  attempt: DeliveryAttempt,
  attemptCount: number,
  code: string,
): Promise<void> {
  const [updated] = await deps.database
    .update(imMessageDeliveries)
    .set({ lastErrorCode: code, nextAttemptAt: new Date(deps.now() + cappedRetryDelayMs(attemptCount)) })
    .where(
      and(
        eq(imMessageDeliveries.id, attempt.deliveryId),
        eq(imMessageDeliveries.state, "accepted"),
        isNull(imMessageDeliveries.reportedAt),
        eq(imMessageDeliveries.attemptCount, attemptCount),
      ),
    )
    .returning({ id: imMessageDeliveries.id });
  if (!updated) return;
  setActiveSpanAttributes(outcomeAttrs("deferred", code));
  if (!EXPECTED_RECOVERY_CODES.has(code)) deps.onDiagnostic(code, diagnosticContext(attempt));
  deps.onMetric({ name: "retry", value: 1 });
}
