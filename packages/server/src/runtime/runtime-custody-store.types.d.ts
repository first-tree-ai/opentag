import type { DirectImMessageDeliveryRequest } from "@opentag/shared";

export interface RuntimeCustodyStoreDispatchRelease {
  releaseDeliveryDispatch(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    disposition: "retry" | "deferred",
  ): Promise<"released" | "already_released" | "conflict">;
}
