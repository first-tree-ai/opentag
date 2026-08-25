import {
  type AgentRuntimeProvider,
  type ImCliProvider,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_V1,
  RUNTIME_PROTOCOL_V2,
  type RuntimeClientCapabilities,
  type RuntimeImCliReadinessCollection,
  type RuntimeNegotiatedCapabilities,
  type RuntimeProtocolVersion,
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
  active?: boolean;
  capabilities?: RuntimeClientCapabilities;
  capabilitiesUpdatedAt?: number;
  computerId: string;
  workspaceComputerId: string;
  workspaceId: string;
  connectionId?: string;
  instanceId: string;
  lastHeartbeatAt: number;
  protocolVersion?: RuntimeProtocolVersion;
  providerReadiness?: RuntimeProviderReadinessCollection;
  providerReadinessObservedAt?: number;
  providerReadinessProviders?: readonly AgentRuntimeProvider[];
  imCliReadiness?: RuntimeImCliReadinessCollection;
  imCliReadinessObservedAt?: number;
  negotiatedCapabilities?: RuntimeNegotiatedCapabilities;
  socket: WebSocket;
}

export class ConnectionRegistry {
  readonly #entries = new Map<string, RuntimeConnectionEntry>();
  readonly #registrationTails = new Map<string, Promise<void>>();

  async register(entry: RuntimeConnectionEntry, persist: () => Promise<void>, publish?: () => void): Promise<void> {
    const previousRegistration = this.#registrationTails.get(entry.workspaceComputerId) ?? Promise.resolve();
    let releaseRegistration: (() => void) | undefined;
    const currentRegistration = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    this.#registrationTails.set(entry.workspaceComputerId, currentRegistration);
    await previousRegistration;
    try {
      await persist();
      const previous = this.#entries.get(entry.workspaceComputerId);
      this.#entries.set(entry.workspaceComputerId, entry);
      if (previous && previous.socket !== entry.socket) {
        previous.socket.close(4001, "Replaced by a newer daemon instance");
      }
      publish?.();
    } finally {
      releaseRegistration?.();
      if (this.#registrationTails.get(entry.workspaceComputerId) === currentRegistration) {
        this.#registrationTails.delete(entry.workspaceComputerId);
      }
    }
  }

  isCurrent(workspaceComputerId: string, instanceId: string, socket: WebSocket): boolean {
    const current = this.#entries.get(workspaceComputerId);
    return current?.instanceId === instanceId && current.socket === socket;
  }

  currentInstanceId(workspaceComputerId: string): string | undefined {
    const current = this.#entries.get(workspaceComputerId);
    return current?.active === false ? undefined : current?.instanceId;
  }

  supportsCapability(workspaceComputerId: string, instanceId: string, capability: string): boolean {
    const current = this.#entries.get(workspaceComputerId);
    return (
      current?.instanceId === instanceId &&
      current.active !== false &&
      current.negotiatedCapabilities?.[capability] !== undefined
    );
  }

  supports(
    workspaceComputerId: string,
    instanceId: string,
    capability: keyof RuntimeClientCapabilities,
    now = Date.now(),
  ): boolean {
    const current = this.#entries.get(workspaceComputerId);
    return (
      current?.instanceId === instanceId &&
      current.active !== false &&
      now - (current.capabilitiesUpdatedAt ?? Number.NEGATIVE_INFINITY) <= RUNTIME_CLIENT_CAPABILITY_TTL_MS &&
      current.capabilities?.[capability] === 1
    );
  }

  providerReadiness(
    workspaceComputerId: string,
    now = Date.now(),
  ): readonly { observation: RuntimeProviderReadinessCollection[number]; observedAt: number }[] {
    const current = this.#entries.get(workspaceComputerId);
    if (current?.active === false) return [];
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
    return [];
  }

  supportsProvider(
    workspaceComputerId: string,
    instanceId: string,
    provider: AgentRuntimeProvider,
    now = Date.now(),
  ): boolean {
    const current = this.#entries.get(workspaceComputerId);
    if (!current || current.instanceId !== instanceId || current.active === false) return false;
    if (!current.providerReadinessProviders) return false;
    if (!current.providerReadinessProviders.includes(provider)) return false;
    return this.providerReadiness(workspaceComputerId, now).some(
      ({ observation }) => observation.provider === provider && observation.status === "ready",
    );
  }

  imCliReadiness(
    workspaceComputerId: string,
    now = Date.now(),
  ): readonly { observation: RuntimeImCliReadinessCollection[number]; observedAt: number }[] {
    const current = this.#entries.get(workspaceComputerId);
    const observedAt = current?.imCliReadinessObservedAt;
    if (
      !current ||
      current.active === false ||
      !current.imCliReadiness ||
      observedAt === undefined ||
      now - observedAt > RUNTIME_CLIENT_CAPABILITY_TTL_MS
    ) {
      return [];
    }
    return current.imCliReadiness.map((observation) => ({ observation: { ...observation }, observedAt }));
  }

  supportsImCli(workspaceComputerId: string, provider: ImCliProvider, now = Date.now()): boolean {
    return this.imCliReadiness(workspaceComputerId, now).some(
      ({ observation }) => observation.provider === provider && observation.status === "ready",
    );
  }

  async send(workspaceComputerId: string, instanceId: string, frame: unknown): Promise<void> {
    const current = this.#entries.get(workspaceComputerId);
    if (!current || current.instanceId !== instanceId) {
      throw new RuntimeRegistrySendError("instance_replaced", "The Computer instance is not current");
    }
    if (current.active === false) {
      throw new RuntimeRegistrySendError("unavailable", "The Computer runtime registration is not active");
    }
    if (current.socket.readyState !== WebSocket.OPEN) {
      throw new RuntimeRegistrySendError("unavailable", "The Computer runtime socket is unavailable");
    }
    let outbound = frame;
    if ((current.protocolVersion ?? RUNTIME_PROTOCOL_V1) === RUNTIME_PROTOCOL_V2) {
      try {
        outbound = withConnectionId(frame, current.connectionId);
      } catch {
        throw new RuntimeRegistrySendError("instance_replaced", "The runtime connection fence is unavailable");
      }
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(outbound);
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
        if (!this.isCurrent(workspaceComputerId, instanceId, socket)) {
          reject(new RuntimeRegistrySendError("instance_replaced", "The Computer instance was replaced during send"));
          return;
        }
        resolve();
      });
    });
  }

  touch(
    workspaceComputerId: string,
    instanceId: string,
    socket: WebSocket,
    now = Date.now(),
    capabilities?: RuntimeClientCapabilities,
    providerReadiness?: RuntimeProviderReadinessCollection,
    imCliReadiness?: RuntimeImCliReadinessCollection,
  ): boolean {
    const current = this.#entries.get(workspaceComputerId);
    if (!current || current.instanceId !== instanceId || current.socket !== socket || current.active === false) {
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
    if (imCliReadiness !== undefined) {
      if (imCliReadiness.length > 0) {
        current.imCliReadiness = imCliReadiness.map((observation) => ({ ...observation }));
        current.imCliReadinessObservedAt = now;
      } else {
        delete current.imCliReadiness;
        delete current.imCliReadinessObservedAt;
      }
    }
    return true;
  }

  activate(workspaceComputerId: string, instanceId: string, socket: WebSocket): boolean {
    const current = this.#entries.get(workspaceComputerId);
    if (!current || current.instanceId !== instanceId || current.socket !== socket) return false;
    current.active = true;
    return true;
  }

  remove(workspaceComputerId: string, instanceId: string, socket: WebSocket): boolean {
    if (!this.isCurrent(workspaceComputerId, instanceId, socket)) {
      return false;
    }
    return this.#entries.delete(workspaceComputerId);
  }

  terminateStale(cutoff: number): void {
    for (const entry of this.#entries.values()) {
      if (entry.lastHeartbeatAt < cutoff) {
        entry.socket.terminate();
      }
    }
  }

  async closeEnrollment(workspaceComputerId: string): Promise<boolean> {
    await (this.#registrationTails.get(workspaceComputerId) ?? Promise.resolve());
    const entry = this.#entries.get(workspaceComputerId);
    if (!entry) return false;
    this.#entries.delete(workspaceComputerId);
    entry.socket.close(4002, "Machine credential rotated or revoked");
    return true;
  }

  closeAll(): void {
    for (const entry of this.#entries.values()) {
      entry.socket.close(1001, "Server shutting down");
    }
  }
}

function withConnectionId(frame: unknown, connectionId?: string): unknown {
  if (!connectionId || !frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new Error("A v2 runtime frame requires a connection fence");
  }
  const record = frame as Readonly<Record<string, unknown>>;
  if (record.connectionId !== undefined && record.connectionId !== connectionId) {
    throw new Error("The runtime frame carries a stale connection fence");
  }
  return { ...record, connectionId };
}
