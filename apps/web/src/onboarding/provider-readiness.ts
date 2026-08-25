import type { ComputerProviderReadinessCollection } from "@opentag/shared/browser";
import type { OnboardingProvider } from "./flow.js";

export interface OnboardingReadinessComputer {
  readonly computerId: string;
  readonly providerReadiness?: ComputerProviderReadinessCollection;
}

export function normalizeOnboardingProviders(
  computers: readonly OnboardingReadinessComputer[],
): readonly (OnboardingProvider & {
  readonly status: ComputerProviderReadinessCollection[number]["status"];
})[] {
  return computers.flatMap((computer) =>
    (computer.providerReadiness ?? []).map((observation) => ({
      computerId: computer.computerId,
      provider: observation.provider,
      runtimeReady: observation.status === "ready",
      status: observation.status,
    })),
  );
}
