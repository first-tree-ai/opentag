import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { imMessageDeliveries } from "../../db/schema/index.js";

/** Custody states that must settle before an active Session can leave its Computer. */
export function unresolvedSessionCustody() {
  return or(
    eq(imMessageDeliveries.state, "pending"),
    and(eq(imMessageDeliveries.state, "accepted"), isNull(imMessageDeliveries.reportedAt)),
    and(eq(imMessageDeliveries.state, "expired"), isNotNull(imMessageDeliveries.dispatchRequestId)),
  );
}
