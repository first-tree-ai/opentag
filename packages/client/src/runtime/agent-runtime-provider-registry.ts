import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import { isAgentRuntimeProviderId } from "../agent-runtime/provider-id.js";
import type { AgentRuntimeFactory, AgentRuntimePolicy, AgentRuntimeProbeResult } from "../agent-runtime/types.js";

export interface AgentRuntimeProviderRegistration {
  readonly artifactIdentity: string;
  readonly factory: AgentRuntimeFactory;
  readonly policy: (snapshot: EffectiveRuntimeSnapshot) => AgentRuntimePolicy;
  readonly validate: (snapshot: EffectiveRuntimeSnapshot) => InputRejectReason | undefined;
  readonly verifyArtifact?: (signal?: AbortSignal) => Promise<void>;
}

interface ProviderProbe {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  settled: boolean;
  waiters: number;
}

export class AgentRuntimeProviderRegistry {
  readonly #providers = new Map<string, AgentRuntimeProviderRegistration>();
  readonly #ready = new Set<string>();
  readonly #probeResults = new Map<string, AgentRuntimeProbeResult>();
  readonly #probes = new Map<string, ProviderProbe>();

  constructor(registrations: readonly AgentRuntimeProviderRegistration[] = []) {
    for (const registration of registrations) {
      const providerId = registration.factory.manifest.providerId;
      if (!isAgentRuntimeProviderId(providerId) || this.#providers.has(providerId)) {
        throw new Error(`Agent Runtime provider registration is invalid or duplicated: ${providerId}`);
      }
      if (!/^[0-9a-f]{64}$/.test(registration.artifactIdentity)) {
        throw new Error(`Agent Runtime provider artifact identity is invalid: ${providerId}`);
      }
      this.#providers.set(providerId, Object.freeze({ ...registration }));
    }
  }

  registration(providerId: string): AgentRuntimeProviderRegistration | undefined {
    return this.#providers.get(providerId);
  }

  artifactIdentity(providerId: string): string | undefined {
    return this.#providers.get(providerId)?.artifactIdentity;
  }

  isReady(providerId: string): boolean {
    return this.#ready.has(providerId);
  }

  probeResult(providerId: string): AgentRuntimeProbeResult | undefined {
    return this.#probeResults.get(providerId);
  }

  validate(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
    const configured = this.validateConfiguration(snapshot);
    if (configured) return configured;
    if (!this.#ready.has(snapshot.provider)) return "provider_unavailable";
    return undefined;
  }

  validateConfiguration(snapshot: EffectiveRuntimeSnapshot): InputRejectReason | undefined {
    const provider = this.#providers.get(snapshot.provider);
    if (!provider) return "configuration_unsupported";
    return provider.validate(snapshot);
  }

  async ensureReady(providerId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#ready.has(providerId)) return;
    await this.#probe(providerId, signal);
  }

  async refresh(providerId: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    try {
      await this.#probe(providerId, signal);
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#ready.delete(providerId);
      return false;
    }
  }

  async #probe(providerId: string, signal?: AbortSignal): Promise<void> {
    let probe = this.#probes.get(providerId);
    if (!probe) {
      const provider = this.#providers.get(providerId);
      if (!provider) throw new Error(`Agent Runtime provider is not registered: ${providerId}`);
      this.#probeResults.delete(providerId);
      const controller = new AbortController();
      let record!: ProviderProbe;
      const promise = (async () => {
        const result = await provider.factory.probe({ signal: controller.signal });
        if (this.#probes.get(providerId) === record) this.#probeResults.set(providerId, result);
        if (!result.ready) {
          throw new Error(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
        }
        try {
          await provider.verifyArtifact?.(controller.signal);
        } catch (error) {
          if (this.#probes.get(providerId) === record) {
            this.#probeResults.set(providerId, {
              ready: false,
              issues: [{ code: "temporarily_unavailable", message: "Provider artifact verification failed" }],
            });
          }
          throw error;
        }
        controller.signal.throwIfAborted();
        if (this.#probes.get(providerId) === record) this.#ready.add(providerId);
      })().finally(() => {
        record.settled = true;
        if (this.#probes.get(providerId) === record) this.#probes.delete(providerId);
      });
      void promise.catch(() => undefined);
      record = { controller, promise, settled: false, waiters: 0 };
      probe = record;
      this.#probes.set(providerId, probe);
    }
    probe.waiters += 1;
    try {
      await waitForProbe(probe.promise, signal);
    } finally {
      probe.waiters -= 1;
      if (probe.waiters === 0 && !probe.settled) {
        probe.controller.abort(new Error(`Agent Runtime provider probe has no waiters: ${providerId}`));
        if (this.#probes.get(providerId) === probe) this.#probes.delete(providerId);
      }
    }
  }
}

async function waitForProbe(probe: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return probe;
  signal.throwIfAborted();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([probe, aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
