import type {
  ComputerConnectionStatus,
  ComputerProviderReadiness,
  RuntimeProviderReadinessObservation,
} from "@opentag/shared";

export interface ProviderReadinessSource {
  providerReadiness(
    computerId: string,
    now: number,
  ): { observation: RuntimeProviderReadinessObservation; observedAt: number } | undefined;
}

export function projectComputerProviderReadiness(
  computerId: string,
  connectionStatus: ComputerConnectionStatus,
  observedAt: Date,
  source?: ProviderReadinessSource,
): ComputerProviderReadiness {
  if (connectionStatus === "offline") {
    return { provider: "codex", status: "unavailable", observedAt: null };
  }
  const snapshot = source?.providerReadiness(computerId, observedAt.getTime());
  if (!snapshot) return { provider: "codex", status: "checking", observedAt: null };
  return {
    provider: "codex",
    status: snapshot.observation.status,
    observedAt: new Date(snapshot.observedAt).toISOString(),
  };
}
