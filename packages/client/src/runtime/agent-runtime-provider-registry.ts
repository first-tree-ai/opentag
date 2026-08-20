import type { EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import type { AgentRuntimeFactory, AgentRuntimePolicy } from "../agent-runtime/types.js";

export interface AgentRuntimeProviderRegistration {
  readonly artifactIdentity: string;
  readonly factory: AgentRuntimeFactory;
  readonly policy: (snapshot: EffectiveRuntimeSnapshot) => AgentRuntimePolicy;
  readonly validate: (snapshot: EffectiveRuntimeSnapshot) => InputRejectReason | undefined;
  readonly verifyArtifact?: (signal?: AbortSignal) => Promise<void>;
}

export class AgentRuntimeProviderRegistry {
  readonly #providers = new Map<string, AgentRuntimeProviderRegistration>();
  readonly #ready = new Set<string>();
  readonly #probes = new Map<string, Promise<void>>();

  constructor(registrations: readonly AgentRuntimeProviderRegistration[] = []) {
    for (const registration of registrations) {
      const providerId = registration.factory.manifest.providerId;
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(providerId) || this.#providers.has(providerId)) {
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
    if (this.#ready.has(providerId)) return;
    await this.#probe(providerId, signal);
  }

  async refresh(providerId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#probe(providerId, signal);
      return true;
    } catch (error) {
      this.#ready.delete(providerId);
      if (signal?.aborted) throw error;
      return false;
    }
  }

  async #probe(providerId: string, signal?: AbortSignal): Promise<void> {
    const current = this.#probes.get(providerId);
    if (current) {
      await waitForProbe(current, signal);
      return;
    }
    const provider = this.#providers.get(providerId);
    if (!provider) throw new Error(`Agent Runtime provider is not registered: ${providerId}`);
    const probing = (async () => {
      signal?.throwIfAborted();
      const result = await provider.factory.probe({ signal });
      if (!result.ready) {
        throw new Error(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
      }
      await provider.verifyArtifact?.(signal);
      signal?.throwIfAborted();
      this.#ready.add(providerId);
    })().finally(() => {
      this.#probes.delete(providerId);
    });
    this.#probes.set(providerId, probing);
    return probing;
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
