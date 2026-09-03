/**
 * The reading of the Server's verdict on an issued connect code, shared so the onboarding wait and
 * the Agent-settings recovery panel can never disagree about what a verdict means.
 */

import type { ComputerConnectCodeStatus } from "@opentag/shared/browser";

export type ConnectCodeVerdict =
  | { readonly kind: "wait" }
  | { readonly kind: "expire" }
  | { readonly kind: "adopt"; readonly computerId: string; readonly redeemedAt: string };

/**
 * Pending keeps the wait; redeemed names the machine to adopt. Expired and revoked fail closed
 * through the same terminal the local expiry uses — neither ever names a Computer. The schema
 * itself guarantees a redemption carries its evidence, so nothing malformed reaches here.
 */
export function readConnectCodeVerdict(status: ComputerConnectCodeStatus): ConnectCodeVerdict {
  if (status.state === "pending") return { kind: "wait" };
  if (status.state === "redeemed") {
    return { kind: "adopt", computerId: status.computerId, redeemedAt: status.redeemedAt };
  }
  return { kind: "expire" };
}
