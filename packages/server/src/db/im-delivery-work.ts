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
