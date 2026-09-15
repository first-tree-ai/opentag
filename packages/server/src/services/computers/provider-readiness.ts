import {
  type AgentRuntimeProvider,
  type ComputerConnectionStatus,
  type ComputerImCliReadinessCollection,
  type ComputerProviderReadinessCollection,
  IM_CLI_PROVIDERS,
  type ProviderCliArtifactPublicReason,
  publicProviderCliArtifactReason,
  type RuntimeImCliReadinessObservation,
  type RuntimeProviderReadinessObservation,
} from "@opentag/shared";
import { SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS } from "../runtime-config/index.js";

function artifactPublicReason(observation: object): ProviderCliArtifactPublicReason | undefined {
  if (!("reason" in observation) || typeof observation.reason !== "string") return undefined;
  return publicProviderCliArtifactReason(observation.reason);
}

export interface ProviderReadinessSource {
  providerReadiness(
    computerId: string,
    now: number,
  ): readonly { observation: RuntimeProviderReadinessObservation; observedAt: number }[];
  /**
   * Providers the current Computer connection negotiated. Omitted or undefined keeps the
   * historical checking fallback. A returned list fences unnegotiated Providers as unavailable
   * with no probe timestamp, even if a stale observation is still present.
   */
  providerReadinessProviders?(computerId: string, now: number): readonly AgentRuntimeProvider[] | undefined;
  imCliReadiness?(
    computerId: string,
    now: number,
  ): readonly { observation: RuntimeImCliReadinessObservation; observedAt: number }[];
  providerCliArtifactReadiness?(
    computerId: string,
    now: number,
  ): readonly {
    observation: {
      provider: RuntimeImCliReadinessObservation["provider"];
      reason?: ProviderCliArtifactPublicReason;
      status: RuntimeImCliReadinessObservation["status"];
    };
    observedAt: number;
  }[];
}

export function projectComputerImCliReadiness(
  computerId: string,
  connectionStatus: ComputerConnectionStatus,
  observedAt: Date,
  source?: ProviderReadinessSource,
): ComputerImCliReadinessCollection {
  if (connectionStatus === "offline") {
    return IM_CLI_PROVIDERS.map((provider) => ({ provider, status: "unavailable", observedAt: null }));
  }
  const artifacts = source?.providerCliArtifactReadiness?.(computerId, observedAt.getTime()) ?? [];
  const generic = source?.imCliReadiness?.(computerId, observedAt.getTime()) ?? [];
  const artifactByProvider = new Map(artifacts.map((snapshot) => [snapshot.observation.provider, snapshot]));
  const genericByProvider = new Map(generic.map((snapshot) => [snapshot.observation.provider, snapshot]));
  // Missing observations stay absent: the sources already apply their freshness TTL, so a missing
  // Provider report is a fact for the caller to present as waiting, never a synthesized checking.
  return IM_CLI_PROVIDERS.flatMap((provider) => {
    const snapshot = artifactByProvider.get(provider) ?? genericByProvider.get(provider);
    if (!snapshot) return [];
    const reason =
      snapshot.observation.status === "unavailable" ? artifactPublicReason(snapshot.observation) : undefined;
    return [
      {
        provider,
        status: snapshot.observation.status,
        observedAt: new Date(snapshot.observedAt).toISOString(),
        ...(reason ? { reason } : {}),
      },
    ];
  });
}

export function projectComputerProviderReadiness(
  computerId: string,
  connectionStatus: ComputerConnectionStatus,
  observedAt: Date,
  source?: ProviderReadinessSource,
): ComputerProviderReadinessCollection {
  if (connectionStatus === "offline") {
    return SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS.map((provider) => ({
      provider,
      status: "unavailable",
      observedAt: null,
    }));
  }
  const now = observedAt.getTime();
  const snapshots = source?.providerReadiness(computerId, now) ?? [];
  const byProvider = new Map(snapshots.map((snapshot) => [snapshot.observation.provider, snapshot]));
  const negotiated = source?.providerReadinessProviders?.(computerId, now);
  const negotiatedSet = negotiated ? new Set(negotiated) : undefined;
  return SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS.map((provider) => {
    if (negotiatedSet && !negotiatedSet.has(provider)) {
      return { provider, status: "unavailable" as const, observedAt: null };
    }
    const snapshot = byProvider.get(provider);
    return snapshot
      ? {
          provider,
          status: snapshot.observation.status,
          observedAt: new Date(snapshot.observedAt).toISOString(),
        }
      : { provider, status: "checking" as const, observedAt: null };
  });
}
