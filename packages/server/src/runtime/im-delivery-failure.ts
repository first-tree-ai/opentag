import { randomUUID } from "node:crypto";
import { computeTurnResultHash, type TurnReportRequest } from "@opentag/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { agents, computers, imBindings, imMessageDeliveries, sessionPlacements, sessions } from "../db/schema/index.js";
import { outcomeAttrs, setActiveSpanAttributes } from "../observability/index.js";
import { releaseImBatch } from "./im-delivery-batch.js";
import { ImDeliveryInputError, rejectInvalidImDelivery } from "./im-delivery-content.js";
import { isCloudReadinessRetry } from "./im-delivery-ready-wakeup.js";
import { lockSteeredRecoverySessions, type SessionEnsurer } from "./im-delivery-recovery.js";
import {
  acceptedReportDeadlineMs,
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
import { type PostgresRuntimeCustodyStore, writeTerminalReport } from "./runtime-custody-store.js";

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
 *
 * What these transitions do not cover, so that nothing here reads as a total bound: an operation
 * that never settles keeps its correlated dispatch and is reclaimed again on the retry schedule; a
 * superseded placement that already carries a retained `result_hash` is refused by both settlement
 * paths; and a crash between a claim and its failure record loses the consecutive-timeout count.
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
 * The `unknown` report body both overdue settlements write: the Turn may have run, and no report can
 * be truthful any more. `placementGeneration` is the generation the Turn is settled under — the
 * current placement for a reconcilable custody, the delivery's own historical one for a superseded
 * placement — so the report never claims a placement the dispatch did not have.
 */
function unknownTurnReport(input: {
  delivery: typeof imMessageDeliveries.$inferSelect;
  session: typeof sessions.$inferSelect;
  agent: typeof agents.$inferSelect;
  placementGeneration: number;
}): TurnReportRequest | undefined {
  const { delivery } = input;
  if (!delivery.turnId || !delivery.reportOwnerInstanceId) return undefined;
  const body = {
    type: "turn:report" as const,
    requestId: randomUUID(),
    deliveryId: delivery.id,
    turnId: delivery.turnId,
    sessionId: input.session.id,
    agentId: input.agent.id,
    placementGeneration: input.placementGeneration,
    outcome: "unknown" as const,
    executionEffects: "may_have_occurred" as const,
    errorReason: "turn_state_unknown" as const,
    traceSummary: { droppedEvents: 0, lastSequence: 0 },
  };
  return { ...body, resultHash: computeTurnResultHash(body) };
}

export interface UnreportableTurnSettlement {
  phase?: ImDeliveryDiagnosticContext["phase"];
  /**
   * Maintenance only: recheck the complete maintenance authority — the same Session-ended,
   * inactive-binding, deleted-Agent and cutoff conditions that selected the row — inside the report
   * transaction, so a reactivated authority cannot lose to the synthetic report.
   */
  requireAbsentAuthority?: boolean;
}

/**
 * Settle accepted custody whose report can no longer arrive, on a placement generation that is
 * still current, exactly as the Cloud owner settles an unreportable accepted Turn: an `unknown`
 * report with `may_have_occurred` evidence. It writes `reported_at` through the same custody fence a
 * real report uses, so the row leaves the work predicate.
 *
 * This covers the shapes it is called for; it is not a bound on every accepted row. A superseded
 * placement generation is refused by that fence and settles through `settleSupersededPlacement`
 * instead, and a rollover that already carries a retained `result_hash` is refused by both.
 */
export async function settleUnreportableTurn(
  deps: Pick<DeliveryFailureDeps, "custody" | "onDiagnostic">,
  row: {
    delivery: typeof imMessageDeliveries.$inferSelect;
    session: typeof sessions.$inferSelect;
    placement: typeof sessionPlacements.$inferSelect;
    agent: typeof agents.$inferSelect;
    computer: typeof computers.$inferSelect;
  },
  options: UnreportableTurnSettlement = {},
): Promise<boolean> {
  const ownerInstanceId = row.delivery.reportOwnerInstanceId;
  if (!ownerInstanceId) return false;
  const report = unknownTurnReport({
    delivery: row.delivery,
    session: row.session,
    agent: row.agent,
    placementGeneration: row.placement.generation,
  });
  if (!report) return false;
  const status = await deps.custody.recordTurn(
    report,
    {
      computerId: row.computer.id,
      installationId: row.computer.currentInstallationId,
      instanceId: ownerInstanceId,
      signal: new AbortController().signal,
    },
    { ...(options.requireAbsentAuthority ? { requireAbsentAuthority: true } : {}) },
  );
  if (status !== "recorded" && status !== "already_recorded") return false;
  deps.onDiagnostic("IM_DELIVERY_TURN_STATE_UNKNOWN", {
    phase: options.phase ?? "recover",
    deliveryId: row.delivery.id,
    agentId: row.agent.id,
    computerId: row.computer.id,
    attemptCount: row.delivery.attemptCount,
  });
  return true;
}

/** The `reason` a superseded-placement settlement records; see `settleSupersededPlacement`. */
export const PLACEMENT_SUPERSEDED_REASON = "placement_superseded";

/**
 * Settle accepted Local custody whose placement generation was superseded, so the row leaves the
 * retry loop instead of waiting for a report its own fence can never accept.
 *
 * A rollover makes `delivery.placement_generation` differ from `session_placements.generation`, and
 * `recordTurn`'s fence requires all three generations to agree, so `settleUnreportableTurn` cannot
 * reach these rows (measured: it returns `false` and writes nothing). This path writes the same
 * `unknown` / `may_have_occurred` / `turn_state_unknown` body, keeps the delivery's own historical
 * generation, and records `reason = placement_superseded`. It never re-anchors or rewrites the
 * generation, and it does not touch `recordTurn` or `placementMatches`.
 *
 * Fences, evaluated under `select … for update` in one transaction: accepted, unreported,
 * `result_hash is null`, past `acceptedReportDeadlineMs` (the same helper every overdue settlement
 * uses), a superseded generation, no live claim marker, and Local custody. `report_owner_instance_id`
 * is deliberately not consulted: a superseded generation cannot report regardless of which instance
 * is live now, which is what distinguishes this case from the absent-runtime one.
 *
 * Idempotence: the `reported_at is null` gate plus the row lock make it exactly once; a concurrent
 * genuine report either lands first (the gate then skips the row) or is refused by `recordTurn`'s
 * placement fence with `stale_generation`, so the settlement is never overwritten.
 *
 * `reason` consumers audited before introducing the value, and why `placement_superseded` is inert
 * for each: the delivery batch reserve/settle/release paths (state-gated to pending/expired/steered,
 * or equality on `batch_pending`/`batch_initial`/`steer_state_unknown`); `im-delivery-custody`
 * (`duplicate_pending` equality on pending rows); the janitor's TTL pass (`state = 'pending'` and
 * `reason is null`) and its steer recovery (reads the *target* through state, `reported_at`, and
 * `turn_report`; a settled target actually becomes eligible for the existing child requeue); the
 * ready wakeup, selector, and pending-head query (`reason is null` on pending); the worker's steer
 * rewiring (`batch_pending` equality) and pending claims (`reason is null`); the Cloud coordinator
 * (reads `reason` only for pending, `reported_at` for accepted); the custody store's
 * `steer_state_unknown` equality on terminal rows; failure reactions (attention/pending/expired/
 * terminal/steered disjuncts, none of which an accepted reported row matches); the IM queue policy
 * (`duplicate_pending`); the message inbox (pending gates and its own expired reasons); the Cloud
 * overview and Runner service (pending only); the task history projection, its summary status, and
 * the web task features (all read `reason` only when `state = 'expired'`, and the DTO types it as an
 * arbitrary nullable string). Delivery retention reads `state`, `reported_at`, `steered_at`, and
 * `expires_at` only, so a settled row stays removable.
 */
export async function settleSupersededPlacement(
  deps: Pick<DeliveryFailureDeps, "database" | "now" | "onDiagnostic"> & {
    /** Session authority the steered-child requeue already uses on every terminal report. */
    sessions: SessionEnsurer;
    onDeliverySettled?: (deliveryId: string) => void;
  },
  deliveryId: string,
): Promise<boolean> {
  const settled = await deps.database.transaction(async (transaction) => {
    const [row] = await transaction
      .select({
        delivery: imMessageDeliveries,
        session: sessions,
        placement: sessionPlacements,
        agent: agents,
        computer: computers,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(and(eq(imMessageDeliveries.id, deliveryId), eq(imMessageDeliveries.state, "accepted")))
      .limit(1)
      .for("update", { of: imMessageDeliveries });
    if (!row) return undefined;
    const { delivery } = row;
    // Lock order matches `recordTurn`: the recovery Sessions before this row's placement and delivery
    // locks, which `requeueSteeredDeliveries` below relies on.
    if (delivery.turnId !== null) await lockSteeredRecoverySessions(transaction, [deliveryId]);
    const overdue =
      delivery.acceptedAt !== null && deps.now() >= acceptedReportDeadlineMs(delivery.acceptedAt.getTime());
    if (
      !overdue ||
      delivery.reportedAt !== null ||
      delivery.resultHash !== null ||
      row.computer.kind !== "local" ||
      delivery.placementGeneration === row.placement.generation ||
      delivery.lastErrorCode?.startsWith("IM_DELIVERY_CLAIM_")
    )
      return undefined;
    const report = unknownTurnReport({
      delivery,
      session: row.session,
      agent: row.agent,
      placementGeneration: delivery.placementGeneration,
    });
    if (!report) return undefined;
    const terminalizedIds = await writeTerminalReport(transaction, report, new Date(deps.now()), deps.sessions, {
      reason: PLACEMENT_SUPERSEDED_REASON,
    });
    return terminalizedIds ? { row, terminalizedIds } : undefined;
  });
  if (!settled) return false;
  deps.onDiagnostic("IM_DELIVERY_TURN_STATE_UNKNOWN", {
    phase: "maintenance",
    deliveryId: settled.row.delivery.id,
    agentId: settled.row.agent.id,
    computerId: settled.row.computer.id,
    attemptCount: settled.row.delivery.attemptCount,
  });
  deps.onDeliverySettled?.(settled.row.delivery.id);
  for (const childId of settled.terminalizedIds) deps.onDeliverySettled?.(childId);
  return true;
}
