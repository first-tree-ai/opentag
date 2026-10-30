import { RUNTIME_MAX_DURATION_MS } from "@opentag/shared";

const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 30_000;
const OFFLINE_RETRY_DIVISOR = 8;
const OFFLINE_RETRY_MAX_DELAY_MS = 30 * 60_000;

/**
 * Capped exponential backoff derived from a delivery's existing `attemptCount`, for failures that
 * may persist across many attempts. `attemptCount` is the post-claim attempt number:
 * 1 -> 2 s, 2 -> 4 s, … capped at 30 s.
 */
export function cappedRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(0, Math.trunc(attemptCount) - 1), 20);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}

/**
 * The retry delay for a delivery that cannot progress right now. The exponential attempt schedule is
 * the floor; a placement Computer with no live runtime adds a linear term in how long it has been
 * silent (`offlineMs`), so a permanently offline Computer is retried at a falling rate instead of a
 * fixed one (#821). The same term resets by itself on reconnect, because `computers.last_seen_at` is
 * rewritten by registration and every heartbeat, so the first retry after a reconnect is due again
 * within the 2 s floor. Pass `Number.POSITIVE_INFINITY` for a Computer that was never seen.
 */
export function deliveryRetryDelayMs(attemptCount: number, offlineMs = 0): number {
  const offline = Math.floor(Math.max(0, offlineMs) / OFFLINE_RETRY_DIVISOR);
  return Math.min(Math.max(cappedRetryDelayMs(attemptCount), offline), OFFLINE_RETRY_MAX_DELAY_MS);
}

/**
 * A frozen dispatch that exhausts the whole operation budget this many times cannot progress: the
 * same input is offered to the same runtime with the same deadline, and every attempt ends in the
 * same timeout (#1079). The cap is deliberately small because one attempt already costs the full
 * 30 s budget; 8 attempts is ~6 min of runtime time.
 */
export const MAX_OPERATION_TIMEOUT_ATTEMPTS = 8;

export function operationTimeoutExhausted(attemptCount: number): boolean {
  return attemptCount >= MAX_OPERATION_TIMEOUT_ATTEMPTS;
}

/** A report written as the execution window closes must still be accepted. */
export const ACCEPTED_REPORT_GRACE_MS = 60 * 60_000;

/**
 * The last instant at which a Turn Report can still be truthful for an accepted delivery: the
 * platform maximum runtime from acceptance, plus the grace. Mirrors the Cloud report-acceptance
 * cutoff, so both execution origins settle an unreportable Turn the same way. This is a cutoff on
 * report acceptance, not evidence that no Turn ran.
 */
export function acceptedReportDeadlineMs(acceptedAtMs: number): number {
  return acceptedAtMs + RUNTIME_MAX_DURATION_MS + ACCEPTED_REPORT_GRACE_MS;
}
