import { randomUUID } from "node:crypto";

/**
 * The marker a delivery carries while a worker is dispatching it. The claim lives in
 * `last_error_code`, prefixed so it is distinguishable from a failure code, and its lease is
 * `next_attempt_at`: a claim whose lease has lapsed is a crashed worker's, and any worker may
 * take the row again. Everything that must recognise an in-flight dispatch reads this prefix.
 */
export const DISPATCH_CLAIM_PREFIX = "IM_DELIVERY_CLAIM_";

export function dispatchClaimToken(): string {
  return `${DISPATCH_CLAIM_PREFIX}${randomUUID().replaceAll("-", "").toUpperCase()}`;
}
