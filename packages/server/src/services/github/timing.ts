/** Shared timing defaults for the GitHub connection persistence services. */

/** One connection carries at most one in-flight OAuth flow; it expires ten minutes after begin. */
export const GITHUB_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

/** Recheck within the maximum five-minute repository admission proof age. */
export const GITHUB_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/** A transiently failed recheck retries on a bounded five-minute delay. */
export const GITHUB_RECHECK_RETRY_DELAY_MS = 5 * 60 * 1000;

/** A claimed refresh lease expires two minutes after the claim if the worker never reports. */
export const GITHUB_REFRESH_CLAIM_TTL_MS = 2 * 60 * 1000;

export function githubWorkerBatchLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("GitHub worker batch size must be between 1 and 100");
  return limit;
}
