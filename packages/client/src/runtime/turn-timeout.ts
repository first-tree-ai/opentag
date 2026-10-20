import { type DirectImMessageDeliveryRequest, RUNTIME_DEFAULT_MAX_DURATION_MS } from "@opentag/shared";

/** Message retention can shorten execution, but cannot replace the default runtime budget. */
export function turnTimeoutMs(request: DirectImMessageDeliveryRequest, now: number): number {
  const budget = request.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS;
  const remaining = request.deadlineAt ? Date.parse(request.deadlineAt) - now : budget;
  return Math.max(1, Math.min(budget, remaining));
}

export function abortExpiredTurn(
  request: DirectImMessageDeliveryRequest,
  now: number,
  controller: AbortController,
): void {
  if (request.deadlineAt && Date.parse(request.deadlineAt) <= now) controller.abort("turn_timeout");
}
