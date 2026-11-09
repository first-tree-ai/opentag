import { imAttrs } from "./attributes.js";
import { withRootSpan } from "./otel-helpers.js";
import { updateCurrentPerformanceContext } from "./performance-logger.js";

export type DeliveryClaim =
  | { id: string; kind: "pending"; claimToken: string }
  | { id: string; kind: "steer"; claimToken: string; rootDeliveryId: string; expectedTurnId: string }
  | { id: string; kind: "recovery" }
  | undefined;

export async function traceDeliveryClaim<T extends DeliveryClaim>(
  claim: T,
  dispatch: (claim: NonNullable<T>) => Promise<void>,
): Promise<void> {
  if (!claim) return;
  const record = claim as Record<string, unknown>;
  updateCurrentPerformanceContext({
    deliveryId: claim.id,
    ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
    ...(typeof record.computerId === "string" ? { computerId: record.computerId } : {}),
    ...("expectedTurnId" in claim ? { turnId: claim.expectedTurnId } : {}),
  });
  const name =
    claim.kind === "pending"
      ? "im.delivery.dispatch"
      : claim.kind === "steer"
        ? "im.delivery.steer"
        : "im.delivery.recover";
  await withRootSpan(name, imAttrs({ deliveryId: claim.id }), () => dispatch(claim));
}
