import type {
  ComputerConnectionStatus,
  ComputerImCliReadinessCollection,
  ComputerProviderReadinessCollection,
  RuntimeImCliReadinessObservation,
  RuntimeProviderReadinessObservation,
} from "@opentag/shared";
import { SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS } from "../runtime-config/index.js";

export interface ProviderReadinessSource {
  providerReadiness(
    computerId: string,
    now: number,
  ): readonly { observation: RuntimeProviderReadinessObservation; observedAt: number }[];
  imCliReadiness?(
    computerId: string,
    now: number,
  ): readonly { observation: RuntimeImCliReadinessObservation; observedAt: number }[];
}

export function projectComputerImCliReadiness(
  computerId: string,
  connectionStatus: ComputerConnectionStatus,
  observedAt: Date,
  source?: ProviderReadinessSource,
): ComputerImCliReadinessCollection {
  const providers = ["feishu", "slack"] as const;
  if (connectionStatus === "offline") {
    return providers.map((provider) => ({ provider, status: "unavailable", observedAt: null }));
  }
  const snapshots = source?.imCliReadiness?.(computerId, observedAt.getTime()) ?? [];
  const byProvider = new Map(snapshots.map((snapshot) => [snapshot.observation.provider, snapshot]));
  return providers.map((provider) => {
    const snapshot = byProvider.get(provider);
    return snapshot
      ? {
          provider,
          status: snapshot.observation.status,
          observedAt: new Date(snapshot.observedAt).toISOString(),
        }
      : { provider, status: "checking", observedAt: null };
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
  const snapshots = source?.providerReadiness(computerId, observedAt.getTime()) ?? [];
  const byProvider = new Map(snapshots.map((snapshot) => [snapshot.observation.provider, snapshot]));
  return SERVER_ADMITTED_AGENT_RUNTIME_PROVIDERS.map((provider) => {
    const snapshot = byProvider.get(provider);
    return snapshot
      ? {
          provider,
          status: snapshot.observation.status,
          observedAt: new Date(snapshot.observedAt).toISOString(),
        }
      : { provider, status: "checking", observedAt: null };
  });
}
