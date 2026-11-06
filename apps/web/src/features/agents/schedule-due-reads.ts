/**
 * Decides which due schedule rows still deserve a summary read on a minute tick.
 *
 * Kept free of React and of the API client so the ordering rule below is directly testable.
 */

/** Reads allowed for one due occurrence before it is treated as settled. */
export const DUE_READ_ATTEMPTS = 3;

export interface DueObservation {
  /** Occurrence the row's read budget belongs to. */
  nextTriggerAt: string;
  /** Reads already issued for that occurrence, including ones that failed. */
  attempts: number;
  /** Minute tick (`now`) that issued the last read. */
  tick: number;
}

export interface DueRow {
  id: string;
  enabled: boolean;
  nextTriggerAt: string | null;
}

/** A budget only survives while the row still refers to the occurrence it was spent on. */
function carriedBudget(row: DueRow, observations: ReadonlyMap<string, DueObservation>): DueObservation | undefined {
  if (row.nextTriggerAt === null) return undefined;
  const seen = observations.get(row.id);
  return seen?.nextTriggerAt === row.nextTriggerAt ? seen : undefined;
}

/** Whether this row may issue a read now, and the budget to record if it does. */
function readOutcome(row: DueRow, now: number, carried: DueObservation | undefined): DueObservation | null {
  if (row.nextTriggerAt === null || !row.enabled || Date.parse(row.nextTriggerAt) > now) return null;
  const attempts = carried?.attempts ?? 0;
  // At most one read per minute tick: a response settles the tick it was issued for, so the effect
  // re-running on new data cannot chain reads back to back inside the same minute.
  if (attempts >= DUE_READ_ATTEMPTS || carried?.tick === now) return null;
  return { nextTriggerAt: row.nextTriggerAt, attempts: attempts + 1, tick: now };
}

/**
 * A due response can keep the pre-scan `nextTriggerAt`: the scheduler scans every five seconds, so a
 * read that lands first still reports the occurrence that just passed. Settling on that single read
 * would freeze the row at "Was due N minutes ago" for the rest of the session, which is the symptom
 * this refresh exists to remove. Each occurrence therefore gets a small, bounded read budget that
 * starts over when the observed timestamp advances, and stops once the budget is spent — so an
 * unchanged past occurrence never polls forever.
 *
 * A failed read keeps its budget, because the attempt is charged when it is issued rather than when
 * it succeeds; the remaining attempts stay available under the same cap.
 */
export function planDueReads(
  rows: readonly DueRow[],
  now: number,
  observations: ReadonlyMap<string, DueObservation>,
): { next: Map<string, DueObservation>; read: boolean } {
  const next = new Map<string, DueObservation>();
  let read = false;
  for (const row of rows) {
    const carried = carriedBudget(row, observations);
    const wanted = readOutcome(row, now, carried);
    if (wanted !== null) {
      next.set(row.id, wanted);
      read = true;
    } else if (carried !== undefined) {
      // Keep an unfinished budget so a paused row or an advanced occurrence is not recharged,
      // and drop entries whose row left the list.
      next.set(row.id, carried);
    }
  }
  return { next, read };
}
