import {
  computeDirectInputHash,
  computeLegacyDirectInputHash,
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
} from "@opentag/shared";
import type { agents, imMessageDeliveries, sessionPlacements, sessions } from "../db/schema/index.js";
import type { DeliveryAttempt } from "./im-delivery-worker.types.js";

/** Frozen layouts that historical clients pinned before the current direct-input hash. */
const LEGACY_LAYOUTS = ["0.1.0", "self-configuration"] as const;

/**
 * Returns the hash of a pinned direct dispatch that matches `expected`, trying the current layout and
 * then each frozen historical layout. Returns `undefined` when no layout reproduces `expected`, so the
 * caller's equality check rejects the pinned payload.
 */
export function matchPinnedDirectInputHash(
  request: DirectImMessageDeliveryRequest,
  expected: string | null,
): string | undefined {
  if (computeDirectInputHash(request) === expected) return expected;
  for (const layout of LEGACY_LAYOUTS) {
    try {
      if (computeLegacyDirectInputHash(request, layout) === expected) return expected;
    } catch {
      // A layout that cannot represent this request is not a match; try the next one.
    }
  }
  return undefined;
}

/** Verify the original dispatch identity without preparing new business or rewriting old hashes. */
export async function validateRecoveryPayload(
  row: {
    delivery: typeof imMessageDeliveries.$inferSelect;
    session: typeof sessions.$inferSelect;
    agent: typeof agents.$inferSelect;
    placement: typeof sessionPlacements.$inferSelect;
  },
  attempt: DeliveryAttempt,
  recordFailure: (attempt: DeliveryAttempt, code: string) => Promise<void>,
): Promise<boolean> {
  if (row.delivery.dispatchPayload === null) return true;
  const pinned = DirectImMessageDeliveryRequestSchema.safeParse(row.delivery.dispatchPayload);
  const pinnedInputHash = pinned.success
    ? matchPinnedDirectInputHash(pinned.data, row.delivery.dispatchInputHash)
    : undefined;
  if (
    !pinned.success ||
    pinned.data.deliveryId !== row.delivery.id ||
    pinned.data.imMessageId !== row.delivery.messageId ||
    pinned.data.sessionId !== row.session.id ||
    pinned.data.agentId !== row.agent.id ||
    pinned.data.placementGeneration !== row.placement.generation ||
    pinned.data.requestId !== row.delivery.dispatchRequestId ||
    pinnedInputHash !== row.delivery.dispatchInputHash ||
    pinnedInputHash !== row.delivery.inputHash
  ) {
    await recordFailure(attempt, "IM_DELIVERY_RECOVERY_PAYLOAD_INVALID");
    return false;
  }
  return true;
}
