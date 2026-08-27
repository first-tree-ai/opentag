import type { AgentSummary, WorkspaceComputerSummary } from "@opentag/shared/browser";
import type { OnboardingProvider } from "./flow.js";
import { normalizeOnboardingProviders } from "./provider-readiness.js";

export interface RuntimeFactsInput {
  readonly agents: readonly AgentSummary[];
  readonly computers: readonly WorkspaceComputerSummary[];
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
 * An older Server that omits the negotiated projection remains unavailable;
 * an online Computer is never promoted to a runnable Provider locally.
 */
export interface RuntimeFactsAdapter {
  load(input: RuntimeFactsInput): Promise<RuntimeFactsResult>;
}

export const productionRuntimeFactsAdapter: RuntimeFactsAdapter = {
  async load({ computers }) {
    if (!computers.some((computer) => computer.providerReadiness !== undefined)) {
      return { kind: "unavailable" };
    }
    return { kind: "available", providers: normalizeOnboardingProviders(computers) };
  },
};
