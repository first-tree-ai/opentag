import {
  AGENT_RUNTIME_PROVIDERS,
  type AgentRuntimeProvider,
  type ImCliProvider,
  type ImCliReadinessStatus,
  type IntegrationCredentialExecutionReason,
  type IntegrationCredentialExecutionStatus,
  RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_PROTOCOL_V1,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_PROVIDER_CLI_ARTIFACT_TTL_MS,
  RUNTIME_PROVIDER_CLI_CREDENTIAL_TTL_MS,
  type RuntimeClientCapabilities,
  type RuntimeImCliReadinessCollection,
  type RuntimeNegotiatedCapabilities,
  type RuntimeProtocolVersion,
  type RuntimeProviderReadinessCollection,
  runtimeFrameByteLength,
} from "@opentag/shared";
import WebSocket from "ws";
import type { ServiceLogger } from "../observability/service-logger.js";

export class RuntimeRegistrySendError extends Error {
  constructor(
    readonly code: "frame_too_large" | "instance_replaced" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeRegistrySendError";
  }
}

export interface ProviderCliArtifactObservation {
  agentId: string;
  integrationId: string;
  observedAt: number;
  provider: ImCliProvider;
  credentialGeneration: number;
  requestId: string;
  status: Exclude<ImCliReadinessStatus, "install">;
}

export interface ProviderCliCredentialObservation {
  agentId: string;
  integrationId: string;
  observedAt: number;
  provider: ImCliProvider;
  credentialGeneration: number;
  reason?: IntegrationCredentialExecutionReason;
  requestId: string;
  status: IntegrationCredentialExecutionStatus;
}

export interface RuntimeConnectionEntry {
  active?: boolean;
  capabilities?: RuntimeClientCapabilities;
  capabilitiesUpdatedAt?: number;
  computerId: string;
  installationId: string;
  connectionId?: string;
  instanceId: string;
  lastHeartbeatAt: number;
  protocolVersion?: RuntimeProtocolVersion;
  providerReadiness?: RuntimeProviderReadinessCollection;
  providerReadinessObservedAt?: number;
  providerReadinessProviders?: readonly AgentRuntimeProvider[];
  imCliReadiness?: RuntimeImCliReadinessCollection;
  imCliReadinessObservedAt?: number;
  preparationRequestId?: string;
  preparationRuntimeProvider?: AgentRuntimeProvider;
  preparationProviders?: readonly ImCliProvider[];
  /** Kept after a fallback until a matching result or a fresh compatible observation arrives. */
  preparationQuarantine?: boolean;
  providerCliArtifact?: ProviderCliArtifactObservation[];
  providerCliCredential?: ProviderCliCredentialObservation[];
  negotiatedCapabilities?: RuntimeNegotiatedCapabilities;
  socket: WebSocket;
}

export interface ConnectionRegistryOptions {
  logger?: ServiceLogger;
}

export class ConnectionRegistry {
  readonly #entries = new Map<string, RuntimeConnectionEntry>();
  readonly #registrationTails = new Map<string, Promise<void>>();
  readonly #logger?: ServiceLogger;

  constructor(options: ConnectionRegistryOptions = {}) {
    this.#logger = options.logger;
  }

  async register(entry: RuntimeConnectionEntry, persist: () => Promise<void>, publish?: () => void): Promise<void> {
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
      publish?.();
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
    const current = this.#entries.get(computerId);
    return current?.active === false ? undefined : current?.instanceId;
  }

  installationId(computerId: string): string | undefined {
    const current = this.#entries.get(computerId);
    return current?.active === false ? undefined : current?.installationId;
  }

  supportsCapability(computerId: string, instanceId: string, capability: string): boolean {
    const current = this.#entries.get(computerId);
    return (
      current?.instanceId === instanceId &&
      current.active !== false &&
      current.negotiatedCapabilities?.[capability] !== undefined
    );
  }

  capabilityVersion(computerId: string, instanceId: string, capability: string, now = Date.now()): number | undefined {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId || current.active === false) return undefined;
    const negotiated = current.negotiatedCapabilities?.[capability];
    if (negotiated !== undefined) return negotiated;
    if (
      capability === RUNTIME_CAPABILITY.imCredentialGrant &&
      now - (current.capabilitiesUpdatedAt ?? Number.NEGATIVE_INFINITY) <= RUNTIME_CLIENT_CAPABILITY_TTL_MS &&
      current.capabilities?.imCredentialGrant === 1
    ) {
      return 1;
    }
    return undefined;
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
      current.active !== false &&
      now - (current.capabilitiesUpdatedAt ?? Number.NEGATIVE_INFINITY) <= RUNTIME_CLIENT_CAPABILITY_TTL_MS &&
      current.capabilities?.[capability] === 1
    );
  }

  providerReadiness(
    computerId: string,
    now = Date.now(),
  ): readonly { observation: RuntimeProviderReadinessCollection[number]; observedAt: number }[] {
    const current = this.#entries.get(computerId);
    if (current?.active === false) return [];
    const observedAt = current?.providerReadinessObservedAt;
    if (current?.providerReadinessProviders) {
      if (
        !current.providerReadiness ||
        observedAt === undefined ||
        (!preparationIsSealed(current) && now - observedAt > RUNTIME_CLIENT_CAPABILITY_TTL_MS)
      ) {
        return [];
      }
      return current.providerReadiness.map((observation) => ({ observation: { ...observation }, observedAt }));
    }
    return [];
  }

  supportsProvider(computerId: string, instanceId: string, provider: AgentRuntimeProvider, now = Date.now()): boolean {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId || current.active === false) return false;
    if (!current.providerReadinessProviders) return false;
    if (!current.providerReadinessProviders.includes(provider)) return false;
    return this.providerReadiness(computerId, now).some(
      ({ observation }) => observation.provider === provider && observation.status === "ready",
    );
  }

  imCliReadiness(
    computerId: string,
    now = Date.now(),
  ): readonly { observation: RuntimeImCliReadinessCollection[number]; observedAt: number }[] {
    const current = this.#entries.get(computerId);
    const observedAt = current?.imCliReadinessObservedAt;
    if (
      !current ||
      current.active === false ||
      !current.imCliReadiness ||
      observedAt === undefined ||
      (!preparationIsSealed(current) && now - observedAt > RUNTIME_CLIENT_CAPABILITY_TTL_MS)
    ) {
      return [];
    }
    return current.imCliReadiness.map((observation) => ({ observation: { ...observation }, observedAt }));
  }

  supportsImCli(computerId: string, provider: ImCliProvider, now = Date.now()): boolean {
    return this.imCliReadiness(computerId, now).some(
      ({ observation }) => observation.provider === provider && observation.status === "ready",
    );
  }

  /**
   * Fences one Server-owned preparation operation and immediately replaces old pass states with
   * checking. Generic heartbeats remain useful for liveness and refresh this operation's TTL, but
   * cannot complete it or restore a pre-operation ready snapshot.
   */
  beginPreparation(
    computerId: string,
    instanceId: string,
    requestId: string,
    runtimeProvider: AgentRuntimeProvider,
    providers: readonly ImCliProvider[],
    now = Date.now(),
  ): boolean {
    const current = this.#currentWritable(computerId, instanceId);
    if (!current || providers.length === 0) return false;
    current.preparationRequestId = requestId;
    current.preparationRuntimeProvider = runtimeProvider;
    current.preparationProviders = [...providers];
    delete current.preparationQuarantine;
    current.providerReadinessProviders = canonicalRuntimeProviders([
      ...(current.providerReadinessProviders ?? []),
      runtimeProvider,
    ]);
    current.providerReadiness = upsertRuntimeReadiness(current.providerReadiness, {
      provider: runtimeProvider,
      status: "checking",
    });
    current.providerReadinessObservedAt = now;
    current.imCliReadiness = providers.map((provider) => ({ provider, status: "checking" }));
    current.imCliReadinessObservedAt = now;
    return true;
  }

  /**
   * Accepts only the latest result for the exact live Computer instance. A quarantined fallback
   * keeps the fence identity so a matching result can still apply, while stale ready heartbeats
   * cannot overwrite it.
   */
  completePreparation(
    computerId: string,
    instanceId: string,
    result: {
      requestId: string;
      runtime: RuntimeProviderReadinessCollection[number];
      providers: RuntimeImCliReadinessCollection;
    },
    now = Date.now(),
    options: { quarantine?: boolean } = {},
  ): boolean {
    const current = this.#currentWritable(computerId, instanceId);
    if (
      !current ||
      current.preparationRequestId !== result.requestId ||
      current.preparationRuntimeProvider !== result.runtime.provider ||
      !sameProviders(
        current.preparationProviders,
        result.providers.map((observation) => observation.provider),
      )
    ) {
      return false;
    }
    current.providerReadiness = upsertRuntimeReadiness(current.providerReadiness, result.runtime);
    current.providerReadinessObservedAt = now;
    current.imCliReadiness = result.providers.map((observation) => ({ ...observation }));
    current.imCliReadinessObservedAt = now;
    if (options.quarantine) {
      current.preparationQuarantine = true;
      return true;
    }
    clearPreparationFence(current);
    return true;
  }

  providerCliArtifactReadiness(
    computerId: string,
    now = Date.now(),
  ): readonly { observation: ProviderCliArtifactObservation; observedAt: number }[] {
    const current = this.#entries.get(computerId);
    if (!current || current.active === false || !current.providerCliArtifact) return [];
    return current.providerCliArtifact.flatMap((observation) =>
      observation.status !== "unavailable" && now - observation.observedAt > RUNTIME_PROVIDER_CLI_ARTIFACT_TTL_MS
        ? []
        : [{ observation: { ...observation }, observedAt: observation.observedAt }],
    );
  }

  providerCliCredentialReadiness(
    computerId: string,
    now = Date.now(),
  ): readonly { observation: ProviderCliCredentialObservation; observedAt: number }[] {
    const current = this.#entries.get(computerId);
    if (!current || current.active === false || !current.providerCliCredential) return [];
    return current.providerCliCredential.flatMap((observation) => {
      if (observation.status === "needs_attention") {
        return [{ observation: { ...observation }, observedAt: observation.observedAt }];
      }
      if (now - observation.observedAt > RUNTIME_PROVIDER_CLI_CREDENTIAL_TTL_MS) {
        return [];
      }
      return [{ observation: { ...observation }, observedAt: observation.observedAt }];
    });
  }

  setProviderCliArtifactObservation(
    computerId: string,
    instanceId: string,
    observation: Omit<ProviderCliArtifactObservation, "observedAt">,
    now = Date.now(),
  ): boolean {
    const current = this.#currentWritable(computerId, instanceId);
    if (!current) return false;
    const next: ProviderCliArtifactObservation = { ...observation, observedAt: now };
    current.providerCliArtifact = upsertProviderCliObservation(
      current.providerCliArtifact,
      next,
      artifactObservationKey,
    );
    return true;
  }

  setProviderCliCredentialObservation(
    computerId: string,
    instanceId: string,
    observation: Omit<ProviderCliCredentialObservation, "observedAt">,
    now = Date.now(),
  ): boolean {
    const current = this.#currentWritable(computerId, instanceId);
    if (!current) return false;
    const next: ProviderCliCredentialObservation = { ...observation, observedAt: now };
    current.providerCliCredential = upsertProviderCliObservation(
      current.providerCliCredential,
      next,
      credentialObservationKey,
    );
    return true;
  }

  #currentWritable(computerId: string, instanceId: string): RuntimeConnectionEntry | undefined {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId || current.active === false) return undefined;
    return current;
  }

  async send(computerId: string, instanceId: string, frame: unknown): Promise<void> {
    const current = this.#entries.get(computerId);
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
    imCliReadiness?: RuntimeImCliReadinessCollection,
  ): boolean {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId || current.socket !== socket || current.active === false) {
      return false;
    }
    current.lastHeartbeatAt = now;
    if (capabilities) {
      current.capabilities = { ...capabilities };
      current.capabilitiesUpdatedAt = now;
    }
    applyHeartbeatReadiness(current, now, providerReadiness, imCliReadiness);
    return true;
  }

  activate(computerId: string, instanceId: string, socket: WebSocket): boolean {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId || current.socket !== socket) return false;
    current.active = true;
    return true;
  }

  remove(computerId: string, instanceId: string, socket: WebSocket): boolean {
    if (!this.isCurrent(computerId, instanceId, socket)) {
      return false;
    }
    return this.#entries.delete(computerId);
  }

  terminateStale(cutoff: number, onSweep?: (count: number) => void): number {
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.lastHeartbeatAt < cutoff) {
        entry.socket.terminate();
        count += 1;
      }
    }
    if (count > 0) {
      try {
        if (onSweep) {
          onSweep(count);
        } else {
          this.#logger?.warn({ count, cutoff }, "Stale runtime connection sweep terminated connections");
        }
      } catch {
        // Logging must never prevent stale connection termination.
      }
    }
    return count;
  }

  async closeComputer(computerId: string): Promise<boolean> {
    await (this.#registrationTails.get(computerId) ?? Promise.resolve());
    const entry = this.#entries.get(computerId);
    if (!entry) return false;
    this.#entries.delete(computerId);
    entry.socket.close(4002, "Machine credential rotated or revoked");
    return true;
  }

  closeAll(): void {
    for (const entry of this.#entries.values()) {
      entry.socket.close(1001, "Server shutting down");
    }
  }
}

function canonicalRuntimeProviders(providers: readonly AgentRuntimeProvider[]): readonly AgentRuntimeProvider[] {
  const included = new Set(providers);
  return AGENT_RUNTIME_PROVIDERS.filter((provider) => included.has(provider));
}

function upsertRuntimeReadiness(
  observations: RuntimeProviderReadinessCollection | undefined,
  next: RuntimeProviderReadinessCollection[number],
): RuntimeProviderReadinessCollection {
  const byProvider = new Map((observations ?? []).map((observation) => [observation.provider, observation]));
  byProvider.set(next.provider, { ...next });
  return AGENT_RUNTIME_PROVIDERS.flatMap((provider) => {
    const observation = byProvider.get(provider);
    return observation ? [{ ...observation }] : [];
  });
}

function sameProviders(left: readonly ImCliProvider[] | undefined, right: readonly ImCliProvider[]): boolean {
  return (
    left !== undefined && left.length === right.length && left.every((provider, index) => provider === right[index])
  );
}

function preparationIsSealed(current: RuntimeConnectionEntry): boolean {
  return current.preparationRequestId !== undefined;
}

function clearPreparationFence(current: RuntimeConnectionEntry): void {
  delete current.preparationRequestId;
  delete current.preparationRuntimeProvider;
  delete current.preparationProviders;
  delete current.preparationQuarantine;
}

function refreshPreparationTtl(current: RuntimeConnectionEntry, now: number): void {
  if (current.providerReadiness) current.providerReadinessObservedAt = now;
  if (current.imCliReadiness) current.imCliReadinessObservedAt = now;
}

function hasRelevantFreshNonReady(
  current: RuntimeConnectionEntry,
  providerReadiness?: RuntimeProviderReadinessCollection,
  imCliReadiness?: RuntimeImCliReadinessCollection,
): boolean {
  const runtimeProvider = current.preparationRuntimeProvider;
  if (
    providerReadiness?.some(
      (observation) => observation.provider === runtimeProvider && observation.status !== "ready",
    ) === true
  ) {
    return true;
  }
  return (
    imCliReadiness?.some(
      (observation) =>
        current.preparationProviders?.includes(observation.provider) === true && observation.status !== "ready",
    ) === true
  );
}

function shouldHoldPreparationReadiness(
  current: RuntimeConnectionEntry,
  providerReadiness?: RuntimeProviderReadinessCollection,
  imCliReadiness?: RuntimeImCliReadinessCollection,
): boolean {
  if (!preparationIsSealed(current)) return false;
  if (current.preparationQuarantine !== true) return true;
  if (providerReadiness === undefined && imCliReadiness === undefined) return true;
  return !hasRelevantFreshNonReady(current, providerReadiness, imCliReadiness);
}

function applyHeartbeatReadiness(
  current: RuntimeConnectionEntry,
  now: number,
  providerReadiness?: RuntimeProviderReadinessCollection,
  imCliReadiness?: RuntimeImCliReadinessCollection,
): void {
  if (shouldHoldPreparationReadiness(current, providerReadiness, imCliReadiness)) {
    refreshPreparationTtl(current, now);
    return;
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
  if (current.preparationQuarantine === true && (providerReadiness !== undefined || imCliReadiness !== undefined)) {
    clearPreparationFence(current);
  }
}

function artifactObservationKey(observation: ProviderCliArtifactObservation): string {
  return `${observation.agentId}:${observation.integrationId}:${observation.provider}`;
}

function credentialObservationKey(observation: ProviderCliCredentialObservation): string {
  return `${observation.agentId}:${observation.integrationId}:${observation.provider}`;
}

function upsertProviderCliObservation<T extends { credentialGeneration: number }>(
  existing: T[] | undefined,
  next: T,
  keyOf: (observation: T) => string,
): T[] {
  const key = keyOf(next);
  const observations = [...(existing ?? [])].filter((observation) => keyOf(observation) !== key);
  const previous = existing?.find((observation) => keyOf(observation) === key);
  if (previous && previous.credentialGeneration > next.credentialGeneration) return existing ?? [];
  observations.push(next);
  return observations;
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
