import { type RunBudgetTimer, runBudgetTimer, scheduleUnrefTimeout } from "./run-budget-timer.js";

const MINUTE_MS = 60_000;

/** A warning needs time to act on, and a share of the Run so it does not arrive at the very start of a short one. */
const MAX_LEAD_MS = 5 * MINUTE_MS;
const LEAD_SHARE = 0.1;
const MIN_LEAD_MS = MINUTE_MS;

/** How long before the limit to warn; undefined when the Run is too short for a warning to help. */
export function runLimitNoticeLeadMs(remainingMs: number): number | undefined {
  const lead = Math.min(MAX_LEAD_MS, remainingMs * LEAD_SHARE);
  return lead < MIN_LEAD_MS ? undefined : lead;
}

export function runLimitNotice(leadMs: number): string {
  return [
    `[openTag notice] This Run reaches its duration limit in about ${Math.round(leadMs / MINUTE_MS)} min. It will then be stopped, with any background work still running, and you get no extra time.`,
    "Save what you need, and tell whoever is waiting if the work will not finish. Your next Run is told what happened.",
  ].join("\n");
}

/** Failing to warn must not disturb the Run: the limit still applies, and the next Run is told. */
export function scheduleRunLimitNotice(
  remainingMs: number | undefined,
  notify: (text: string) => Promise<void>,
): RunBudgetTimer | undefined {
  const leadMs = remainingMs === undefined ? undefined : runLimitNoticeLeadMs(remainingMs);
  if (remainingMs === undefined || leadMs === undefined) return undefined;
  // Pauses with the Run budget while the Provider waits for a quota reset.
  return runBudgetTimer(
    scheduleUnrefTimeout,
    Date.now,
    remainingMs - leadMs,
    () => void notify(runLimitNotice(leadMs)).catch(() => undefined),
  );
}
