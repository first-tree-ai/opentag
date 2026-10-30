import { randomUUID } from "node:crypto";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  type agents,
  type computers,
  imMessageDeliveries,
  type sessionPlacements,
  type sessions,
} from "../db/schema/index.js";
import { outcomeAttrs, setActiveSpanAttributes } from "../observability/index.js";
import { releaseImBatch } from "./im-delivery-batch.js";
import { ImDeliveryInputError, rejectInvalidImDelivery } from "./im-delivery-content.js";
import { isCloudReadinessRetry } from "./im-delivery-ready-wakeup.js";
import { cappedRetryDelayMs, deliveryRetryDelayMs, operationTimeoutExhausted } from "./im-delivery-retry.js";
import type {
  DeliveryAttempt,
  ImDeliveryDiagnosticContext,
  ImDeliveryDiagnosticReporter,
  RuntimeDeliveryWorkerMetric,
} from "./im-delivery-worker.types.js";
import type { PostgresRuntimeCustodyStore } from "./runtime-custody-store.js";

/**
 * Every transition that gives up on a claimed delivery attempt, in one place: backoff, dispatch
 * release, terminal rejection, and the settlement of custody whose report can no longer arrive.
 *
 * The worker owns claiming and dispatching. Keeping the failure transitions here keeps one retry
 * and termination policy across the dispatch, steer, and recovery paths instead of a per-path copy.
 * Nothing in this module invents a report for a Turn that could still report, and no write here
 * touches a row that a newer attempt has already claimed.
 */

const BOUNDED_CODE = /^IM_DELIVERY_[A-Z0-9_]{1,100}$/;

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

/**
 * Record one failed attempt: bounded backoff from the attempt counter plus the placement
 * Computer's silence, or — for a dispatch that already spent the whole runtime budget on the same
 * frozen input — a terminal rejection instead of another attempt.
 */
export async function recordDeliveryFailure(
  deps: DeliveryFailureDeps,
  attempt: DeliveryAttempt,
  code: string,
  retryDelayMs?: number,
): Promise<void> {
  const bounded = BOUNDED_CODE.test(code) ? code : "IM_DELIVERY_FAILED";
  setActiveSpanAttributes(outcomeAttrs("failed", bounded));
  if (bounded === "IM_DELIVERY_OPERATION_TIMEOUT" && operationTimeoutExhausted(attempt.attemptCount)) {
    // The same input is offered to the same runtime with the same deadline every time, so another
    // attempt is not progress. `rejectDelivery` is the existing terminal settlement.
    if (await rejectDelivery(deps, attempt.deliveryId, "retry_exhausted", attempt.claimToken)) {
      deps.onDiagnostic("IM_DELIVERY_RETRY_EXHAUSTED", diagnosticContext(attempt));
      return;
    }
  }
  const delayMs = retryDelayMs ?? deliveryRetryDelayMs(attempt.attemptCount, attempt.offlineMs);
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
  // One line per failure run, not one per attempt: a repeated code adds nothing an operator can act on.
  if (attempt.previousErrorCode !== bounded) deps.onDiagnostic(bounded, diagnosticContext(attempt));
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
        nextAttemptAt: new Date(deps.now() + deliveryRetryDelayMs(attempt.attemptCount, attempt.offlineMs)),
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
    if (attempt.previousErrorCode !== bounded) deps.onDiagnostic(bounded, diagnosticContext(attempt));
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
  if (!EXPECTED_RECOVERY_CODES.has(code) && attempt.previousErrorCode !== code)
    deps.onDiagnostic(code, diagnosticContext(attempt));
  deps.onMetric({ name: "retry", value: 1 });
}

/**
 * Settle owed custody whose report can no longer arrive, exactly as the Cloud owner settles an
 * unreportable accepted Turn: an `unknown` report with `may_have_occurred` evidence. It writes
 * `reported_at`, so the row leaves the work predicate and the retry loop ends here.
 */
export async function settleUnreportableTurn(
  deps: DeliveryFailureDeps,
  row: {
    delivery: typeof imMessageDeliveries.$inferSelect;
    session: typeof sessions.$inferSelect;
    placement: typeof sessionPlacements.$inferSelect;
    agent: typeof agents.$inferSelect;
    computer: typeof computers.$inferSelect;
  },
): Promise<boolean> {
  const turnId = row.delivery.turnId;
  const ownerInstanceId = row.delivery.reportOwnerInstanceId;
  if (!turnId || !ownerInstanceId) return false;
  const body = {
    type: "turn:report" as const,
    requestId: randomUUID(),
    deliveryId: row.delivery.id,
    turnId,
    sessionId: row.session.id,
    agentId: row.agent.id,
    placementGeneration: row.placement.generation,
    outcome: "unknown" as const,
    executionEffects: "may_have_occurred" as const,
    errorReason: "turn_state_unknown" as const,
    traceSummary: { droppedEvents: 0, lastSequence: 0 },
  };
  const report: TurnReportRequest = { ...body, resultHash: computeTurnResultHash(body) };
  const status = await deps.custody.recordTurn(report, {
    computerId: row.computer.id,
    installationId: row.computer.currentInstallationId,
    instanceId: ownerInstanceId,
    signal: new AbortController().signal,
  });
  if (status !== "recorded" && status !== "already_recorded") return false;
  deps.onDiagnostic("IM_DELIVERY_TURN_STATE_UNKNOWN", {
    phase: "recover",
    deliveryId: row.delivery.id,
    agentId: row.agent.id,
    computerId: row.computer.id,
    attemptCount: row.delivery.attemptCount,
  });
  return true;
}
