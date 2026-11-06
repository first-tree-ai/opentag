import { type DirectImMessageDeliveryRequest, RUNTIME_DEFAULT_MAX_DURATION_MS } from "@opentag/shared";

/** Message retention can shorten execution, but cannot replace the default runtime budget. */
export function turnTimeoutMs(request: DirectImMessageDeliveryRequest, now: number): number {
  const budget = request.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS;
  const remaining = request.deadlineAt ? Date.parse(request.deadlineAt) - now : budget;
  return Math.max(1, Math.min(budget, remaining));
}

/**
 * What is left of the Run's duration limit, which counts actual running time across retries and
 * resumes. The ingress deadline bounds only the first attempt.
 */
export function remainingBudgetMs(maxDurationMs: number | undefined, ranMs: number): number {
  return Math.max(1, (maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS) - ranMs);
}

export function abortExpiredTurn(
  request: DirectImMessageDeliveryRequest,
  now: number,
  controller: AbortController,
): void {
  if (request.deadlineAt && Date.parse(request.deadlineAt) <= now) controller.abort("turn_timeout");
}
