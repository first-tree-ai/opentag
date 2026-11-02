import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

interface DeliveryWorkColumns {
  state: AnyPgColumn;
  reason: AnyPgColumn;
  reportedAt: AnyPgColumn;
  dispatchRequestId: AnyPgColumn;
  lastErrorCode: AnyPgColumn;
}

// These literals must match the partial index even with a generic prepared plan.
export function deliveryCandidatePredicate(d: DeliveryWorkColumns) {
  return sql`((${d.state} = 'pending' and ${d.reason} is null)
    or (${d.state} = 'accepted' and ${d.reportedAt} is null)
    or (${d.state} = 'expired' and ${d.dispatchRequestId} is not null))`;
}

export function deliveryCustodyPredicate(d: Omit<DeliveryWorkColumns, "reason">) {
  return sql`((${d.state} = 'accepted' and ${d.reportedAt} is null)
    or (${d.state} in ('pending', 'expired') and ${d.dispatchRequestId} is not null)
    or (${d.state} = 'pending' and ${d.lastErrorCode} like 'IM_DELIVERY_CLAIM_%'))`;
}

export function deliveryWorkPredicate(d: DeliveryWorkColumns) {
  // Keep one BooleanTest: expanding this OR can combine indexes full of historical entries.
  return sql`((${deliveryCandidatePredicate(d)} or ${deliveryCustodyPredicate(d)}) is true)`;
}

/**
 * The durable marker a parked dispatch carries in `last_error_code`.
 *
 * A correlated dispatch whose operation never settles is not terminally rejected (that would strand a
 * Turn that may still report) and must not be offered to the runtime again. Parking keeps the pending
 * state, `reason`, the dispatch correlation, and the unreported custody, and takes the row out of the
 * work set; only the ingress deadline still bounds it, and the TTL expiry path needs `reason is null`.
 * Deliberately not part of the partial-index predicates: parking is a row predicate, not an index.
 */
export const PARKED_DELIVERY_CODE = "IM_DELIVERY_PARKED";

/** Excludes a parked pending dispatch from the claim scans; an expired row resumes its normal path. */
export function notParkedPredicate(d: DeliveryWorkColumns) {
  return sql`not (${d.state} = 'pending' and coalesce(${d.lastErrorCode}, '') = ${PARKED_DELIVERY_CODE})`;
}

/** The same exclusion for a row already read, so the in-memory eligibility cannot disagree. */
export function parkedDelivery(row: { state: string; lastErrorCode: string | null }): boolean {
  return row.state === "pending" && row.lastErrorCode === PARKED_DELIVERY_CODE;
}
