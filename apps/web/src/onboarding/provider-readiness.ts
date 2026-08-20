import type { ComputerProviderReadinessCollection } from "@opentag/shared/browser";
import type { OnboardingProvider } from "./flow.js";

export interface OnboardingReadinessComputer {
  readonly id: string;
  readonly providerReadiness?: ComputerProviderReadinessCollection;
}

export function normalizeOnboardingProviders(
  computers: readonly OnboardingReadinessComputer[],
): readonly OnboardingProvider[] {
  return computers.flatMap((computer) =>
    (computer.providerReadiness ?? []).map((observation) => ({
      computerId: computer.id,
      provider: observation.provider,
      runtimeReady: observation.status === "ready",
    })),
  );
}
