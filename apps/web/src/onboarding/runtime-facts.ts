import type { AgentSummary, TeamComputerSummary } from "@opentag/shared/browser";
import type { OnboardingProvider } from "./flow.js";

export interface RuntimeFactsInput {
  readonly teamId: string;
  readonly agents: readonly AgentSummary[];
  readonly computers: readonly TeamComputerSummary[];
}

export type RuntimeProviderStatus = "checking" | "install" | "sign-in" | "ready" | "unavailable";

/**
 * The normalized readiness fact consumed by the page. `runtimeReady` remains
 * the only fact used by the flow; `status` only lets the page describe the
 * current action without inventing Provider readiness.
 */
export interface RuntimeProviderFact extends OnboardingProvider {
  readonly status?: RuntimeProviderStatus;
}

export type RuntimeFactsResult =
  | { readonly kind: "available"; readonly providers: readonly RuntimeProviderFact[] }
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
