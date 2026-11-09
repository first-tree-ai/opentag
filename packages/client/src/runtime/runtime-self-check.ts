import {
  type AgentRuntimeProvider,
  IM_CLI_PROVIDERS,
  RUNTIME_CAPABILITY,
  type RuntimeImCliReadinessCollection,
  type RuntimeImCliReadinessObservation,
  type RuntimeProviderReadinessCollection,
  type RuntimeProviderReadinessObservation,
  type RuntimeSelfCheckReport,
  type ServerWelcomeFrame,
} from "@opentag/shared";
import type { RuntimeConnection } from "./runtime-connection.js";

export function publishSelfCheck(
  connection: RuntimeConnection,
  selfCheckId: string,
  sequence: number,
  checkedAt: string,
  problems: RuntimeSelfCheckReport["problems"],
  providerReadiness: RuntimeProviderReadinessCollection,
  imCliReadiness: RuntimeImCliReadinessCollection,
  now: number,
): Promise<void> {
  if (!connection.supportsCapability(RUNTIME_CAPABILITY.selfCheckHeartbeat)) return Promise.resolve();
  return connection.send(
    {
      type: "runtime:self-check:report",
      requestId: crypto.randomUUID(),
      selfCheckId,
      sequence,
      checkedAt,
      problems,
      providerReadiness: providerReadiness.map((observation) => ({
        ...observation,
        status:
          problems.some((problem) => problem.part === "runtime") || observation.status === "checking"
            ? "unavailable"
            : observation.status,
      })),
      imCliReadiness: imCliReadiness.map((observation) => ({
        ...observation,
        status:
          problems.some((problem) => problem.part === "messaging_cli") || observation.status === "checking"
            ? "unavailable"
            : observation.status,
      })),
    },
    { priority: "control", deadline: now + 10_000 },
  );
}

export class HeartbeatAcknowledgements {
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #acknowledged = new Set<string>();
  constructor(
    readonly scheduler: {
      setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
      clearTimeout(timer: ReturnType<typeof setTimeout>): void;
    },
    readonly terminate: () => void,
  ) {}
  track(requestId: string, timeoutMs: number): boolean {
    if (this.#pending.size >= 3) return false;
    this.#pending.set(requestId, this.scheduler.setTimeout(this.terminate, timeoutMs));
    return true;
  }
  isPending(requestId: string): boolean {
    return this.#pending.has(requestId);
  }
  wasAcknowledged(requestId: string): boolean {
    return this.#acknowledged.has(requestId);
  }
  acknowledge(requestId: string): void {
    const timer = this.#pending.get(requestId);
    if (timer !== undefined) this.scheduler.clearTimeout(timer);
    this.#pending.delete(requestId);
    this.#acknowledged.add(requestId);
    if (this.#acknowledged.size > 16) this.#acknowledged.delete(this.#acknowledged.values().next().value as string);
  }
  clear(): void {
    for (const timer of this.#pending.values()) this.scheduler.clearTimeout(timer);
    this.#pending.clear();
  }
}

export function currentImCliReadiness(
  values: ReadonlyMap<
    RuntimeImCliReadinessObservation["provider"],
    { observation: RuntimeImCliReadinessObservation; expiresAt: number }
  >,
  now: number,
): RuntimeImCliReadinessCollection {
  return IM_CLI_PROVIDERS.flatMap((provider) => {
    const current = values.get(provider);
    return current && now <= current.expiresAt ? [{ ...current.observation }] : [];
  });
}
export function currentProviderReadiness(
  providers: readonly AgentRuntimeProvider[],
  values: ReadonlyMap<AgentRuntimeProvider, { observation: RuntimeProviderReadinessObservation; expiresAt: number }>,
  leases: ReadonlyMap<AgentRuntimeProvider, { observation: RuntimeProviderReadinessObservation }>,
  now: number,
): RuntimeProviderReadinessCollection {
  return providers.flatMap((provider) => {
    const lease = leases.get(provider);
    if (lease) return [{ ...lease.observation }];
    const current = values.get(provider);
    return current && now <= current.expiresAt ? [{ ...current.observation }] : [];
  });
}
export function heartbeatProviderReadiness(
  policy: ServerWelcomeFrame,
  read: (providers: readonly AgentRuntimeProvider[]) => RuntimeProviderReadinessCollection,
) {
  return policy.providerReadiness ? { providerReadiness: read(policy.providerReadiness.providers) } : {};
}
