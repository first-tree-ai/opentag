import type { AgentSummary, TeamComputerSummary } from "@opentag/shared/browser";
import type { OnboardingProvider } from "./flow.js";

export interface RuntimeFactsInput {
  readonly teamId: string;
  readonly agents: readonly AgentSummary[];
  readonly computers: readonly TeamComputerSummary[];
}

export type RuntimeFactsResult =
  | { readonly kind: "available"; readonly providers: readonly OnboardingProvider[] }
  | { readonly kind: "unavailable" };

/**
 * The only Web seam for authoritative Computer + Provider runtime readiness.
 * The production implementation intentionally reports no fact until the
 * Server endpoint owned by #73 is available on main. An online Computer is
 * never promoted to a runnable Provider locally.
 */
export interface RuntimeFactsAdapter {
  load(input: RuntimeFactsInput): Promise<RuntimeFactsResult>;
}

export const productionRuntimeFactsAdapter: RuntimeFactsAdapter = {
  async load() {
    return { kind: "unavailable" };
  },
};
