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
import {
  canonicalFailureCode,
  cappedRetryDelayMs,
  deliveryRetryDelayMs,
  OPERATION_TIMEOUT_CODE,
  operationTimeoutCode,
  operationTimeoutExhausted,
  operationTimeoutStreak,
} from "./im-delivery-retry.js";
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
 *
 * Invariant — one durable code per attempt, and the timeout streak is its own axis. The operation
 * timeout cap must count *consecutive* operation timeouts, not claims: `attempt_count` grows on every
 * claim, so a delivery that failed seven times for unrelated reasons would otherwise be terminalized
 * on its first timeout. There is no dedicated column, so the count rides in the existing
 * `last_error_code`: the canonical `IM_DELIVERY_OPERATION_TIMEOUT` for the first timeout and
 * `IM_DELIVERY_OPERATION_TIMEOUT_<n>` from the second on. A different *failure* code replaces it and
 * resets the streak; a dispatch release carries it forward, because releasing an unusable frozen
 * dispatch is a lifecycle step of the same input rather than a failed attempt. Diagnostics and the
 * alerting pipeline always see the canonical code, never the suffixed one.
 *
 * Invariant — never terminally reject a dispatch that may be executing. The Server persists the
 * dispatch correlation before the delivery frame leaves, so a correlated row can still produce a
 * Turn and a report; rejecting it would strand that report against a terminal row. Exhaustion
 * rejections therefore require `dispatch_request_id IS NULL` and are retried after the outcome
 * arrives, and an operation that never settles is abandoned instead of settled. The deadline also
 * owns the attempt's one failure record: an aborted operation must not write a second one.
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

export interface DeliveryFailureOptions {
  retryDelayMs?: number;
  /**
   * Whether this record may settle the delivery terminally. A timed-out operation can still settle
   * after the deadline, so the callback that runs *at* the deadline passes `false` and the terminal
   * decision waits for the outcome (see `settleExhaustedTimeoutRun`).
   */
  allowTerminal?: boolean;
}

/**
 * Record one failed attempt: bounded backoff from the attempt counter plus the placement
 * Computer's silence, or — for a dispatch that has now spent the whole runtime budget on the same
 * frozen input `MAX_OPERATION_TIMEOUT_ATTEMPTS` times in a row — a terminal rejection instead of
 * another attempt.
 */
export async function recordDeliveryFailure(
  deps: DeliveryFailureDeps,
  attempt: DeliveryAttempt,
  code: string,
  options: DeliveryFailureOptions = {},
): Promise<void> {
  const bounded = BOUNDED_CODE.test(code) ? code : "IM_DELIVERY_FAILED";
  setActiveSpanAttributes(outcomeAttrs("failed", bounded));
  const streak = bounded === OPERATION_TIMEOUT_CODE ? operationTimeoutStreak(attempt.previousErrorCode) + 1 : 0;
  if (streak > 0 && options.allowTerminal !== false && operationTimeoutExhausted(streak)) {
    // The same input is offered to the same runtime with the same deadline every time, so another
    // attempt is not progress. `rejectDelivery` is the existing terminal settlement; it refuses
    // while a dispatch correlation exists because that dispatch may still be executing.
    if (
      await rejectDelivery(deps, attempt.deliveryId, "retry_exhausted", attempt.claimToken, {
        requireNoDispatchCorrelation: true,
      })
    ) {
      deps.onDiagnostic("IM_DELIVERY_RETRY_EXHAUSTED", diagnosticContext(attempt));
      return;
    }
  }
  const durableCode = streak > 0 ? operationTimeoutCode(streak) : bounded;
  const delayMs = options.retryDelayMs ?? deliveryRetryDelayMs(attempt.attemptCount, attempt.offlineMs);
  const [updated] = await deps.database
    .update(imMessageDeliveries)
    .set({ lastErrorCode: durableCode, nextAttemptAt: new Date(deps.now() + delayMs) })
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
  const previousCode = attempt.previousErrorCode ? canonicalFailureCode(attempt.previousErrorCode) : undefined;
  if (previousCode !== bounded) deps.onDiagnostic(bounded, diagnosticContext(attempt));
  deps.onMetric({ name: "retry", value: 1 });
  if (isCloudReadinessRetry(bounded) && (!attempt.claimToken || !deps.readyRetryClaims.has(attempt.claimToken))) {
    // A ready event may have seen this row's claim marker before the backoff was recorded.
    // Recheck AFTER the write; a ready-triggered retry itself keeps normal bounded backoff.
    deps.recheckReady(attempt.deliveryId);
  }
}

/**
 * The timed-out operation has settled, so a terminal decision can no longer race a late acceptance:
 * settle the delivery once the durable timeout streak reached the cap. The observed streak code is
 * the ownership fence, so a newer claim or a recorded report wins.
 */
export async function settleExhaustedTimeoutRun(deps: DeliveryFailureDeps, attempt: DeliveryAttempt): Promise<boolean> {
  const [row] = await deps.database
    .select({ lastErrorCode: imMessageDeliveries.lastErrorCode })
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, attempt.deliveryId))
    .limit(1);
  const streak = operationTimeoutStreak(row?.lastErrorCode);
  if (!operationTimeoutExhausted(streak) || !row?.lastErrorCode) return false;
  const rejected = await rejectDelivery(deps, attempt.deliveryId, "retry_exhausted", row.lastErrorCode, {
    requireNoDispatchCorrelation: true,
  });
  if (!rejected) return false;
  deps.onDiagnostic("IM_DELIVERY_RETRY_EXHAUSTED", diagnosticContext(attempt));
  return true;
}

/**
 * Release a frozen dispatch so the input can be prepared again, without inventing a result.
 *
 * A release is not a failure, so it must not end the consecutive-timeout run of the input: the
 * stuck shape alternates "timeout on the frozen dispatch" and "release, prepare a fresh dispatch",
 * and resetting there would make the cap unreachable. The release reason still reaches the
 * diagnostic and the span; the durable counter keeps the streak code.
 */
export async function releaseDeliveryDispatch(
  deps: DeliveryFailureDeps,
  attempt: DeliveryAttempt,
  requestId: string,
  code: string,
): Promise<void> {
  const bounded = BOUNDED_CODE.test(code) ? code : "IM_DELIVERY_FAILED";
  setActiveSpanAttributes(outcomeAttrs("released", bounded));
  const streak = operationTimeoutStreak(attempt.previousErrorCode);
  const released = await deps.database.transaction(async (transaction) => {
    const [released] = await transaction
      .update(imMessageDeliveries)
      .set({
        executionOrigin: null,
        dispatchRequestId: null,
        dispatchInputHash: null,
        dispatchPayload: null,
        lastErrorCode: streak > 0 ? operationTimeoutCode(streak) : bounded,
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

export interface RejectOptions {
  /**
   * Refuse the rejection while a dispatch correlation exists. `RuntimeDomainOwner` persists that
   * correlation before it sends the frame, so a correlated row may already be executing: settling it
   * would strand a Turn that can still report. The correlation is cleared by the ordinary dispatch
   * release, after which the rejection is safe.
   */
  requireNoDispatchCorrelation?: boolean;
}

/** Terminally reject a pending input; the only path that clears a frozen dispatch and its batch. */
export async function rejectDelivery(
  deps: DeliveryFailureDeps,
  deliveryId: string,
  reason: string,
  ownershipFence?: string,
  options: RejectOptions = {},
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
          ...(ownershipFence ? [eq(imMessageDeliveries.lastErrorCode, ownershipFence)] : []),
          ...(options.requireNoDispatchCorrelation ? [isNull(imMessageDeliveries.dispatchRequestId)] : []),
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
