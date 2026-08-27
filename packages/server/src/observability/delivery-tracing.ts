import { imAttrs } from "./attributes.js";
import { withRootSpan } from "./otel-helpers.js";

export type DeliveryClaim =
  | { id: string; kind: "pending"; claimToken: string }
  | { id: string; kind: "steer"; claimToken: string; rootDeliveryId: string; expectedTurnId: string }
  | { id: string; kind: "recovery" }
  | undefined;

export async function traceDeliveryClaim(
  claim: DeliveryClaim,
  dispatch: (claim: Exclude<DeliveryClaim, undefined>) => Promise<void>,
): Promise<void> {
  if (!claim) return;
  const name =
    claim.kind === "pending"
      ? "im.delivery.dispatch"
      : claim.kind === "steer"
        ? "im.delivery.steer"
        : "im.delivery.recover";
  await withRootSpan(name, imAttrs({ deliveryId: claim.id }), () => dispatch(claim));
}
