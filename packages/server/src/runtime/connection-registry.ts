import {
  type AgentRuntimeProvider,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  RUNTIME_MAX_FRAME_BYTES,
  type RuntimeClientCapabilities,
  type RuntimeProviderReadinessCollection,
  runtimeFrameByteLength,
} from "@opentag/shared";
import WebSocket from "ws";

export class RuntimeRegistrySendError extends Error {
  constructor(
    readonly code: "frame_too_large" | "instance_replaced" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeRegistrySendError";
  }
}

export interface RuntimeConnectionEntry {
  capabilities?: RuntimeClientCapabilities;
  capabilitiesUpdatedAt?: number;
  computerId: string;
  instanceId: string;
  lastHeartbeatAt: number;
  providerReadiness?: RuntimeProviderReadinessCollection;
  providerReadinessObservedAt?: number;
  providerReadinessProviders?: readonly AgentRuntimeProvider[];
  socket: WebSocket;
  userId: string;
}

export class ConnectionRegistry {
  readonly #entries = new Map<string, RuntimeConnectionEntry>();
  readonly #registrationTails = new Map<string, Promise<void>>();

  async register(entry: RuntimeConnectionEntry, persist: () => Promise<void>): Promise<void> {
    const previousRegistration = this.#registrationTails.get(entry.computerId) ?? Promise.resolve();
    let releaseRegistration: (() => void) | undefined;
    const currentRegistration = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    this.#registrationTails.set(entry.computerId, currentRegistration);
    await previousRegistration;
    try {
      await persist();
      const previous = this.#entries.get(entry.computerId);
      this.#entries.set(entry.computerId, entry);
      if (previous && previous.socket !== entry.socket) {
        previous.socket.close(4001, "Replaced by a newer daemon instance");
      }
    } finally {
      releaseRegistration?.();
      if (this.#registrationTails.get(entry.computerId) === currentRegistration) {
        this.#registrationTails.delete(entry.computerId);
      }
    }
  }

  isCurrent(computerId: string, instanceId: string, socket: WebSocket): boolean {
    const current = this.#entries.get(computerId);
    return current?.instanceId === instanceId && current.socket === socket;
  }

  currentInstanceId(computerId: string): string | undefined {
    return this.#entries.get(computerId)?.instanceId;
  }

  supports(
    computerId: string,
    instanceId: string,
    capability: keyof RuntimeClientCapabilities,
    now = Date.now(),
  ): boolean {
    const current = this.#entries.get(computerId);
    return (
      current?.instanceId === instanceId &&
      now - (current.capabilitiesUpdatedAt ?? Number.NEGATIVE_INFINITY) <= RUNTIME_CLIENT_CAPABILITY_TTL_MS &&
      current.capabilities?.[capability] === 1
    );
  }

  providerReadiness(
    computerId: string,
    now = Date.now(),
  ): readonly { observation: RuntimeProviderReadinessCollection[number]; observedAt: number }[] {
    const current = this.#entries.get(computerId);
    const observedAt = current?.providerReadinessObservedAt;
    if (current?.providerReadinessProviders) {
      if (
        !current.providerReadiness ||
        observedAt === undefined ||
        now - observedAt > RUNTIME_CLIENT_CAPABILITY_TTL_MS
      ) {
        return [];
      }
      return current.providerReadiness.map((observation) => ({ observation: { ...observation }, observedAt }));
    }
    if (!current || !this.supports(computerId, current.instanceId, "imMessageTool", now)) return [];
    return [
      {
        observation: { provider: "codex", status: "ready" },
        observedAt: current.capabilitiesUpdatedAt ?? current.lastHeartbeatAt,
      },
    ];
  }

  supportsProvider(computerId: string, instanceId: string, provider: AgentRuntimeProvider, now = Date.now()): boolean {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId) return false;
    if (!current.providerReadinessProviders) {
      return provider === "codex" && this.supports(computerId, instanceId, "imMessageTool", now);
    }
    if (!current.providerReadinessProviders.includes(provider)) return false;
    return this.providerReadiness(computerId, now).some(
      ({ observation }) => observation.provider === provider && observation.status === "ready",
    );
  }

  async send(computerId: string, instanceId: string, frame: unknown): Promise<void> {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId) {
      throw new RuntimeRegistrySendError("instance_replaced", "The Computer instance is not current");
    }
    if (current.socket.readyState !== WebSocket.OPEN) {
      throw new RuntimeRegistrySendError("unavailable", "The Computer runtime socket is unavailable");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
    } catch {
      throw new RuntimeRegistrySendError("frame_too_large", "The runtime frame cannot be serialized");
    }
    if (runtimeFrameByteLength(serialized) > RUNTIME_MAX_FRAME_BYTES) {
      throw new RuntimeRegistrySendError("frame_too_large", "The runtime frame is too large");
    }
    const socket = current.socket;
    await new Promise<void>((resolve, reject) => {
      socket.send(serialized, (error) => {
        if (error) {
          reject(new RuntimeRegistrySendError("unavailable", "The runtime frame could not be sent"));
          return;
        }
        if (!this.isCurrent(computerId, instanceId, socket)) {
          reject(new RuntimeRegistrySendError("instance_replaced", "The Computer instance was replaced during send"));
          return;
        }
        resolve();
      });
    });
  }

  touch(
    computerId: string,
    instanceId: string,
    socket: WebSocket,
    now = Date.now(),
    capabilities?: RuntimeClientCapabilities,
    providerReadiness?: RuntimeProviderReadinessCollection,
  ): boolean {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId || current.socket !== socket) {
      return false;
    }
    current.lastHeartbeatAt = now;
    if (capabilities) {
      current.capabilities = { ...capabilities };
      current.capabilitiesUpdatedAt = now;
    }
    if (providerReadiness !== undefined) {
      if (providerReadiness.length > 0) {
        current.providerReadiness = providerReadiness.map((observation) => ({ ...observation }));
        current.providerReadinessObservedAt = now;
      } else {
        delete current.providerReadiness;
        delete current.providerReadinessObservedAt;
      }
    }
    return true;
  }

  remove(computerId: string, instanceId: string, socket: WebSocket): boolean {
    if (!this.isCurrent(computerId, instanceId, socket)) {
      return false;
    }
    return this.#entries.delete(computerId);
  }

  terminateStale(cutoff: number): void {
    for (const entry of this.#entries.values()) {
      if (entry.lastHeartbeatAt < cutoff) {
        entry.socket.terminate();
      }
    }
  }

  closeAll(): void {
    for (const entry of this.#entries.values()) {
      entry.socket.close(1001, "Server shutting down");
    }
  }
}
