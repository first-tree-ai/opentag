const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * Capped exponential backoff derived from a delivery's existing `attemptCount`, for failures that
 * may persist across many attempts. `attemptCount` is the post-claim attempt number:
 * 1 -> 2 s, 2 -> 4 s, … capped at 30 s.
 */
export function cappedRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(0, Math.trunc(attemptCount) - 1), 20);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}
