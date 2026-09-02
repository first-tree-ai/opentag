import type { AgentRuntimeProvider, EffectiveRuntimeSnapshot, InputRejectReason } from "@opentag/shared";
import { isAgentRuntimeProviderId } from "../agent-runtime/provider-id.js";
import {
  AGENT_RUNTIME_CONTRACT_VERSION,
  type AgentHostedTools,
  type AgentRuntimeBinding,
  type AgentRuntimeFactory,
  type AgentRuntimePolicy,
  type AgentRuntimeProbeResult,
} from "../agent-runtime/types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("runtime-provider-registry");

export interface AgentRuntimeProviderRegistration {
  readonly artifactIdentity: string;
  readonly factory: AgentRuntimeFactory;
  readonly policy: (snapshot: EffectiveRuntimeSnapshot) => AgentRuntimePolicy;
  readonly requiresBindingReplacement?: (
    binding: AgentRuntimeBinding,
    hostedTools: AgentHostedTools | undefined,
  ) => boolean;
  readonly validate: (snapshot: EffectiveRuntimeSnapshot) => InputRejectReason | undefined;
  readonly verifyArtifact?: (signal?: AbortSignal) => Promise<void>;
}

interface ProviderProbe {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  settled: boolean;
  waiters: number;
}

export class AgentRuntimeProviderUnavailableError extends Error {
  constructor(
    readonly providerId: string,
    readonly result: AgentRuntimeProbeResult,
    options?: ErrorOptions,
  ) {
    const detail = result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ") || "not ready";
    super(`Agent Runtime provider is unavailable (${providerId}): ${detail}`, options);
    this.name = "AgentRuntimeProviderUnavailableError";
  }
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
      if (registration.factory.manifest.contractVersion !== AGENT_RUNTIME_CONTRACT_VERSION) {
        throw new Error(
          `Agent Runtime provider contract version is incompatible: ${providerId} requires ${AGENT_RUNTIME_CONTRACT_VERSION}`,
        );
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

  providerIds(): readonly AgentRuntimeProvider[] {
    return [...this.#providers.keys()] as AgentRuntimeProvider[];
  }

  artifactIdentity(providerId: string): string | undefined {
    return this.#providers.get(providerId)?.artifactIdentity;
  }

  isReady(providerId: string): boolean {
    return this.#ready.has(providerId);
  }

  invalidate(providerId: string, result?: AgentRuntimeProbeResult): void {
    this.#ready.delete(providerId);
    if (result) this.#probeResults.set(providerId, result);
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
      logger.debug(
        { code: "provider_refresh_failed", providerId, error: String(error) },
        "Agent Runtime provider refresh failed",
      );
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
          throw new AgentRuntimeProviderUnavailableError(providerId, result);
        }
        try {
          await provider.verifyArtifact?.(controller.signal);
        } catch (error) {
          logger.debug(
            {
              code: "provider_artifact_verification_failed",
              providerId,
              error: String(error),
            },
            "Agent Runtime provider artifact verification failed",
          );
          if (this.#probes.get(providerId) === record) {
            this.#probeResults.set(providerId, {
              ready: false,
              issues: [{ code: "temporarily_unavailable", message: "Provider artifact verification failed" }],
            });
          }
          throw new AgentRuntimeProviderUnavailableError(
            providerId,
            {
              ready: false,
              issues: [{ code: "temporarily_unavailable", message: "Provider artifact verification failed" }],
            },
            { cause: error },
          );
        }
        controller.signal.throwIfAborted();
        if (this.#probes.get(providerId) === record) this.#ready.add(providerId);
      })().finally(() => {
        record.settled = true;
        if (this.#probes.get(providerId) === record) this.#probes.delete(providerId);
      });
      void promise.catch((error: unknown) => {
        logger.debug(
          { code: "provider_probe_failed", providerId, error: String(error) },
          "Agent Runtime provider probe failed",
        );
      });
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
        /* v8 ignore else -- the registry still maps this probe while its last waiter unwinds. */
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
