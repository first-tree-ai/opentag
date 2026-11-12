/**
 * The Run's duration budget as a timer that can stand still. A provider that waits in-process for a used-up quota
 * window to reset (`quota_wait_changed`) is not running, so its Run budget pauses until the wait ends.
 */
export interface RunBudgetTimer {
  /** When the budget runs out at the current pace; undefined while paused. */
  readonly expiresAt: number | undefined;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export type ScheduleTimeout = (delayMs: number, task: () => void) => { cancel(): void };

export const scheduleUnrefTimeout: ScheduleTimeout = (delayMs, task) => {
  const timer = setTimeout(task, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};

export function runBudgetTimer(
  schedule: ScheduleTimeout,
  now: () => number,
  budgetMs: number,
  onExpired: () => void,
): RunBudgetTimer {
  let remainingMs = budgetMs;
  let startedAt: number | undefined;
  let scheduled: { cancel(): void } | undefined;
  let done = false;
  const start = (): void => {
    startedAt = now();
    scheduled = schedule(remainingMs, () => {
      done = true;
      onExpired();
    });
  };
  start();
  return {
    get expiresAt() {
      return startedAt === undefined ? undefined : startedAt + remainingMs;
    },
    pause() {
      if (done || startedAt === undefined) return;
      scheduled?.cancel();
      remainingMs = Math.max(1, remainingMs - Math.max(0, now() - startedAt));
      startedAt = undefined;
    },
    resume() {
      if (done || startedAt !== undefined) return;
      start();
    },
    cancel() {
      done = true;
      scheduled?.cancel();
    },
  };
}
