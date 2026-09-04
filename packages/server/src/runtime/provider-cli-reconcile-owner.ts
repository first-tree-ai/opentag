import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeProvider,
  IM_CLI_PROVIDERS,
  type ImCliProvider,
  PROVIDER_CLI_VALIDATION_RETRY_REASONS,
  type ProviderCliArtifactStatusFrame,
  ProviderCliArtifactStatusFrameSchema,
  type ProviderCliCancelFrame,
  type ProviderCliExpectedIdentity,
  type ProviderCliPrewarmFrame,
  type ProviderCliPrewarmResultFrame,
  ProviderCliPrewarmResultFrameSchema,
  type ProviderCliRequirementFrame,
  type ProviderCliValidationGrantFrame,
  type ProviderCliValidationResultFrame,
  ProviderCliValidationResultFrameSchema,
  type ProviderCliValidationResultReason,
  type ProviderCliValidationRetryReason,
  RUNTIME_CAPABILITY,
  RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
  RUNTIME_PROVIDER_CLI_VALIDATION_GRANT_TTL_MS,
  RUNTIME_PROVIDER_CLI_VALIDATION_MAX_RETRIES,
} from "@opentag/shared";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeBusinessContext, RuntimeBusinessOptions } from "./runtime-session.js";

export interface ProviderCliRequirementSnapshot {
  agentId: string;
  credentialGeneration: number;
  expectedIdentity: ProviderCliExpectedIdentity;
  integrationId: string;
  provider: ImCliProvider;
}

export interface IntegrationCliValidationGrantMaterial {
  expectedIdentity: ProviderCliExpectedIdentity;
  grant: ProviderCliValidationGrantFrame["grant"];
}

export interface ProviderCliReconcileBindingSource {
  issueIntegrationCliValidationGrant(input: {
    agentId: string;
    computerId: string;
    installationId: string;
    credentialGeneration: number;
    integrationId: string;
    provider: ImCliProvider;
  }): Promise<IntegrationCliValidationGrantMaterial | undefined>;
  listActiveProviderCliRequirements(computerId: string): Promise<readonly ProviderCliRequirementSnapshot[]>;
  /**
   * First-setup eligibility for the exact Computer: true while at least one active bound Agent has
   * no current messaging setup. Evaluated once per (re)registration; a missing or rejected
   * predicate fails safe to "no prewarm" and never affects active-binding reconcile.
   */
  shouldPrewarmOfficialProviderClis?(computerId: string): Promise<boolean>;
}

type ProviderCliArtifactReadiness = ReturnType<ConnectionRegistry["providerCliArtifactReadiness"]>;
type ProviderCliCredentialReadiness = ReturnType<ConnectionRegistry["providerCliCredentialReadiness"]>;

interface CurrentRequest {
  agentId: string;
  artifactRetryAttempt: number;
  /** True only while a bounded artifact re-dispatch timer is actually armed. */
  artifactRetryPending: boolean;
  computerId: string;
  installationId: string;
  credentialGeneration: number;
  expectedIdentity: ProviderCliExpectedIdentity;
  grantConsumed: boolean;
  grantExpiresAt?: number;
  grantRequestId?: string;
  grantRetryAttempt: number;
  instanceId: string;
  integrationId: string;
  provider: ImCliProvider;
  requestId: string;
  retryTimer?: ReturnType<typeof setTimeout>;
  snapshot: ProviderCliRequirementSnapshot;
}

const INTERNAL_RETRY_REASONS = new Set<string>(PROVIDER_CLI_VALIDATION_RETRY_REASONS);

function requestKey(computerId: string, integrationId: string): string {
  return `${computerId}:${integrationId}`;
}

function matchObservation<T extends { agentId: string; credentialGeneration: number; integrationId: string }>(
  items: readonly { observation: T }[],
  requirement: ProviderCliRequirementSnapshot,
): T | undefined {
  return items.find(
    ({ observation }) =>
      observation.agentId === requirement.agentId &&
      observation.integrationId === requirement.integrationId &&
      observation.credentialGeneration === requirement.credentialGeneration,
  )?.observation;
}

function isReconcileInFlight(
  artifact: { status: string } | undefined,
  credential: { status: string } | undefined,
): boolean {
  // "unavailable" is a terminal observation, never in-flight work; the caller handles a retained
  // unavailable artifact explicitly before consulting this check.
  if (artifact?.status === "checking") return true;
  return credential?.status === "checking" || credential?.status === "unconfirmed" || credential?.status === "retrying";
}

function isInternalRetryReason(
  reason: ProviderCliValidationResultReason | undefined,
): reason is ProviderCliValidationRetryReason {
  return reason !== undefined && INTERNAL_RETRY_REASONS.has(reason);
}

export class ProviderCliReconcileOwner {
  readonly #bindings: ProviderCliReconcileBindingSource;
  readonly #grantTtlMs: number;
  readonly #maxRetries: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #registry: ConnectionRegistry;
  readonly #inflightFresh = new Map<string, Promise<void>>();
  readonly #requests = new Map<string, CurrentRequest>();
  #closed = false;

  constructor(
    registry: ConnectionRegistry,
    bindings: ProviderCliReconcileBindingSource,
    options: { grantTtlMs?: number; maxRetries?: number; now?: () => number; random?: () => number } = {},
  ) {
    this.#registry = registry;
    this.#bindings = bindings;
    this.#grantTtlMs = options.grantTtlMs ?? RUNTIME_PROVIDER_CLI_VALIDATION_GRANT_TTL_MS;
    this.#maxRetries = options.maxRetries ?? RUNTIME_PROVIDER_CLI_VALIDATION_MAX_RETRIES;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const artifact = ProviderCliArtifactStatusFrameSchema.safeParse(input);
        if (artifact.success) return artifact.data;
        const preparation = ProviderCliPrewarmResultFrameSchema.safeParse(input);
        if (preparation.success) return preparation.data;
        const result = ProviderCliValidationResultFrameSchema.safeParse(input);
        return result.success ? result.data : undefined;
      },
      laneKey: (frame) => {
        const typed = frame as
          | ProviderCliArtifactStatusFrame
          | ProviderCliPrewarmResultFrame
          | ProviderCliValidationResultFrame;
        if (typed.type === "provider-cli:prewarm:result") return `provider-cli:prewarm:${typed.requestId}`;
        return `provider-cli:${typed.integrationId}:${typed.credentialGeneration}`;
      },
      handle: (frame, context) =>
        this.#handle(
          frame as ProviderCliArtifactStatusFrame | ProviderCliPrewarmResultFrame | ProviderCliValidationResultFrame,
          context,
        ),
      failureResult: () => undefined,
      overloadResult: () => undefined,
    };
  }

  async onComputerRegistered(input: { computerId: string; installationId: string; instanceId: string }): Promise<void> {
    if (this.#closed) return;
    await this.#resetComputer(input.computerId);
    await this.#dispatchSetupPrewarm(input, "inspect");
    const requirements = await this.#bindings.listActiveProviderCliRequirements(input.computerId);
    if (
      !this.#registry.supportsCapability(input.computerId, input.instanceId, RUNTIME_CAPABILITY.providerCliReconcile)
    ) {
      for (const requirement of requirements) {
        this.#registry.setProviderCliCredentialObservation(
          input.computerId,
          input.instanceId,
          {
            agentId: requirement.agentId,
            integrationId: requirement.integrationId,
            provider: requirement.provider,
            credentialGeneration: requirement.credentialGeneration,
            requestId: randomUUID(),
            status: "needs_attention",
            reason: "upgrade_required",
          },
          this.#now(),
        );
      }
      return;
    }
    for (const requirement of requirements) {
      await this.#dispatchRequirement(input.computerId, input.installationId, input.instanceId, requirement);
    }
  }

  /**
   * Sends one preparation request for both official Provider CLIs. Registration is inspect-only
   * because the foreground targeted connect remains the installer; placement onto an already
   * connected Computer uses ensure so that no stale ready observation can replace a real repair.
   * Active-binding requirements stay separate and never create continuing requirements for an
   * unselected Provider.
   */
  async #dispatchSetupPrewarm(
    input: {
      computerId: string;
      installationId: string;
      instanceId: string;
      runtimeProvider?: AgentRuntimeProvider;
    },
    mode: "ensure" | "inspect",
  ): Promise<boolean> {
    if (!this.#registry.supportsCapability(input.computerId, input.instanceId, RUNTIME_CAPABILITY.providerCliPrewarm)) {
      return false;
    }
    let shouldPrewarm = false;
    try {
      shouldPrewarm = (await this.#bindings.shouldPrewarmOfficialProviderClis?.(input.computerId)) === true;
    } catch {
      return false;
    }
    if (!shouldPrewarm) return false;
    const frame: ProviderCliPrewarmFrame = {
      type: "provider-cli:prewarm",
      requestId: randomUUID(),
      mode,
      ...(input.runtimeProvider ? { runtimeProvider: input.runtimeProvider } : {}),
      providers: [...IM_CLI_PROVIDERS],
    };
    if (
      mode === "ensure" &&
      input.runtimeProvider &&
      !this.#registry.beginPreparation(
        input.computerId,
        input.instanceId,
        frame.requestId,
        input.runtimeProvider,
        frame.providers,
        this.#now(),
      )
    ) {
      return false;
    }
    try {
      await this.#registry.send(input.computerId, input.instanceId, frame);
      return true;
    } catch {
      if (mode === "ensure" && input.runtimeProvider) {
        this.#registry.completePreparation(
          input.computerId,
          input.instanceId,
          {
            requestId: frame.requestId,
            runtime: { provider: input.runtimeProvider, status: "unavailable" },
            providers: frame.providers.map((provider) => ({ provider, status: "unavailable" })),
          },
          this.#now(),
        );
      }
      return false;
    }
  }

  async onActiveBindingChanged(input: { agentId: string; computerId: string }): Promise<void> {
    if (this.#closed) return;
    const instanceId = this.#registry.currentInstanceId(input.computerId);
    if (!instanceId) return;
    const installationId = this.#registry.installationId(input.computerId);
    if (!installationId) return;
    const requirements = await this.#bindings.listActiveProviderCliRequirements(input.computerId);
    const activeIds = new Set(requirements.map((requirement) => requirement.integrationId));
    for (const [key, current] of [...this.#requests]) {
      if (current.computerId === input.computerId && !activeIds.has(current.integrationId)) {
        await this.#retireRequest(key);
      }
    }
    if (!this.#registry.supportsCapability(input.computerId, instanceId, RUNTIME_CAPABILITY.providerCliReconcile)) {
      for (const requirement of requirements.filter((item) => item.agentId === input.agentId)) {
        this.#registry.setProviderCliCredentialObservation(
          input.computerId,
          instanceId,
          {
            agentId: requirement.agentId,
            integrationId: requirement.integrationId,
            provider: requirement.provider,
            credentialGeneration: requirement.credentialGeneration,
            requestId: randomUUID(),
            status: "needs_attention",
            reason: "upgrade_required",
          },
          this.#now(),
        );
      }
      return;
    }
    for (const requirement of requirements.filter((item) => item.agentId === input.agentId)) {
      await this.#dispatchRequirement(input.computerId, installationId, instanceId, requirement, { force: true });
    }
  }

  /** Starts the real idempotent preparation owned by an already-connected Computer. */
  async prepareComputer(input: {
    agentId: string;
    computerId: string;
    runtimeProvider: AgentRuntimeProvider;
  }): Promise<void> {
    if (this.#closed) return;
    const instanceId = this.#registry.currentInstanceId(input.computerId);
    const installationId = this.#registry.installationId(input.computerId);
    if (!instanceId || !installationId) throw new Error("The Computer runtime is not connected");
    const started = await this.#dispatchSetupPrewarm(
      {
        computerId: input.computerId,
        installationId,
        instanceId,
        runtimeProvider: input.runtimeProvider,
      },
      "ensure",
    );
    if (!started) throw new Error("The Computer preparation operation could not be started");
  }

  async onAgentPlacementChanged(input: {
    agentId: string;
    previousComputerId?: string;
    computerId?: string;
    runtimeProvider?: AgentRuntimeProvider;
  }): Promise<void> {
    if (this.#closed) return;
    if (input.previousComputerId && input.previousComputerId !== input.computerId) {
      await this.#retireAgentOnComputer(input.agentId, input.previousComputerId);
    }
    if (input.computerId) {
      if (input.runtimeProvider) {
        await this.prepareComputer({
          agentId: input.agentId,
          computerId: input.computerId,
          runtimeProvider: input.runtimeProvider,
        });
      }
      await this.onActiveBindingChanged({
        agentId: input.agentId,
        computerId: input.computerId,
      });
    }
  }

  async ensureActiveReadiness(input: { agentId: string; computerId: string }): Promise<void> {
    if (this.#closed) return;
    const key = `${input.computerId}:${input.agentId}`;
    const existing = this.#inflightFresh.get(key);
    if (existing) return existing;
    const task = this.#refreshActiveReadiness(input).finally(() => {
      if (this.#inflightFresh.get(key) === task) this.#inflightFresh.delete(key);
    });
    this.#inflightFresh.set(key, task);
    await task;
  }

  close(): void {
    this.#closed = true;
    this.#inflightFresh.clear();
    for (const key of [...this.#requests.keys()]) void this.#retireRequest(key);
  }

  async #dispatchRequirement(
    computerId: string,
    installationId: string,
    instanceId: string,
    requirement: ProviderCliRequirementSnapshot,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const key = requestKey(computerId, requirement.integrationId);
    const existing = this.#requests.get(key);
    if (
      !options.force &&
      existing &&
      existing.instanceId === instanceId &&
      existing.credentialGeneration === requirement.credentialGeneration &&
      existing.agentId === requirement.agentId
    ) {
      return;
    }
    await this.#retireRequest(key);
    const requestId = randomUUID();
    this.#requests.set(key, {
      agentId: requirement.agentId,
      artifactRetryAttempt: existing && options.force ? existing.artifactRetryAttempt : 0,
      artifactRetryPending: false,
      computerId,
      credentialGeneration: requirement.credentialGeneration,
      expectedIdentity: requirement.expectedIdentity,
      grantConsumed: false,
      grantRetryAttempt: 0,
      instanceId,
      installationId,
      integrationId: requirement.integrationId,
      provider: requirement.provider,
      requestId,
      snapshot: requirement,
    });
    this.#registry.setProviderCliArtifactObservation(
      computerId,
      instanceId,
      {
        agentId: requirement.agentId,
        integrationId: requirement.integrationId,
        provider: requirement.provider,
        credentialGeneration: requirement.credentialGeneration,
        requestId,
        status: "checking",
      },
      this.#now(),
    );
    this.#registry.setProviderCliCredentialObservation(
      computerId,
      instanceId,
      {
        agentId: requirement.agentId,
        integrationId: requirement.integrationId,
        provider: requirement.provider,
        credentialGeneration: requirement.credentialGeneration,
        requestId,
        status: "unconfirmed",
      },
      this.#now(),
    );
    const frame: ProviderCliRequirementFrame = {
      type: "provider-cli:requirement",
      operation: RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
      requestId,
      provider: requirement.provider,
      agentId: requirement.agentId,
      integrationId: requirement.integrationId,
      credentialGeneration: requirement.credentialGeneration,
      expectedIdentity: requirement.expectedIdentity,
    };
    try {
      await this.#registry.send(computerId, instanceId, frame);
    } catch {
      this.#scheduleArtifactRetry(this.#requests.get(key));
    }
  }

  async #handle(
    frame: ProviderCliArtifactStatusFrame | ProviderCliPrewarmResultFrame | ProviderCliValidationResultFrame,
    context: RuntimeBusinessContext,
  ): Promise<undefined> {
    if (frame.type === "provider-cli:prewarm:result") {
      this.#registry.completePreparation(context.computerId, context.instanceId, frame, this.#now());
      return undefined;
    }
    const current = this.#requests.get(requestKey(context.computerId, frame.integrationId));
    if (frame.type === "provider-cli:artifact:status") return this.#handleArtifact(current, frame, context);
    return this.#handleValidation(current, frame, context);
  }

  async #handleArtifact(
    current: CurrentRequest | undefined,
    frame: ProviderCliArtifactStatusFrame,
    context: RuntimeBusinessContext,
  ): Promise<undefined> {
    if (!this.#acceptsArtifact(current, frame, context)) return undefined;
    this.#registry.setProviderCliArtifactObservation(
      context.computerId,
      context.instanceId,
      {
        agentId: frame.agentId,
        integrationId: frame.integrationId,
        provider: frame.provider,
        credentialGeneration: frame.credentialGeneration,
        requestId: frame.requestId,
        status: frame.status,
      },
      this.#now(),
    );
    this.#invalidateCredentialOnArtifactFailure(frame, context);
    if (frame.status === "ready") await this.#issueGrant(current);
    if (frame.status === "unavailable") this.#scheduleArtifactRetry(current);
    return undefined;
  }

  #invalidateCredentialOnArtifactFailure(frame: ProviderCliArtifactStatusFrame, context: RuntimeBusinessContext): void {
    if (frame.status === "ready") return;
    // Credential execution readiness is evidence about one exact accepted
    // artifact selection. Any new check or artifact failure invalidates it
    // until a fresh validation grant succeeds.
    this.#registry.setProviderCliCredentialObservation(
      context.computerId,
      context.instanceId,
      {
        agentId: frame.agentId,
        integrationId: frame.integrationId,
        provider: frame.provider,
        credentialGeneration: frame.credentialGeneration,
        requestId: frame.requestId,
        status: "unconfirmed",
      },
      this.#now(),
    );
  }

  async #handleValidation(
    current: CurrentRequest | undefined,
    frame: ProviderCliValidationResultFrame,
    context: RuntimeBusinessContext,
  ): Promise<undefined> {
    if (!this.#acceptsGrantResult(current, frame, context)) return undefined;
    if (frame.status === "retrying") {
      if (isInternalRetryReason(frame.reason)) {
        await this.#scheduleInternalRetry(current, frame.reason);
        return undefined;
      }
      const reason =
        frame.reason === "rate_limited" || frame.reason === "provider_unreachable" ? frame.reason : undefined;
      this.#registry.setProviderCliCredentialObservation(
        context.computerId,
        context.instanceId,
        {
          agentId: frame.agentId,
          integrationId: frame.integrationId,
          provider: frame.provider,
          credentialGeneration: frame.credentialGeneration,
          requestId: frame.requestId,
          status: "retrying",
          ...(reason ? { reason } : {}),
        },
        this.#now(),
      );
      this.#scheduleGrantRetry(current, reason ?? "provider_unreachable");
      return undefined;
    }
    this.#registry.setProviderCliCredentialObservation(
      context.computerId,
      context.instanceId,
      {
        agentId: frame.agentId,
        integrationId: frame.integrationId,
        provider: frame.provider,
        credentialGeneration: frame.credentialGeneration,
        requestId: frame.requestId,
        status: frame.status,
        ...(frame.reason && !isInternalRetryReason(frame.reason) ? { reason: frame.reason } : {}),
      },
      this.#now(),
    );
    return undefined;
  }

  async #issueGrant(current: CurrentRequest): Promise<void> {
    if (current.grantRequestId && !current.grantConsumed && (current.grantExpiresAt ?? 0) > this.#now()) return;
    const material = await this.#bindings.issueIntegrationCliValidationGrant({
      agentId: current.agentId,
      computerId: current.computerId,
      installationId: current.installationId,
      credentialGeneration: current.credentialGeneration,
      integrationId: current.integrationId,
      provider: current.provider,
    });
    const stillCurrent = this.#requests.get(requestKey(current.computerId, current.integrationId));
    if (!material || stillCurrent !== current) return;
    if (!expectedIdentitiesMatch(current.expectedIdentity, material.expectedIdentity)) {
      this.#registry.setProviderCliCredentialObservation(
        current.computerId,
        current.instanceId,
        {
          agentId: current.agentId,
          integrationId: current.integrationId,
          provider: current.provider,
          credentialGeneration: current.credentialGeneration,
          requestId: current.requestId,
          status: "needs_attention",
        },
        this.#now(),
      );
      return;
    }
    const requestId = randomUUID();
    const expiresAt = this.#now() + this.#grantTtlMs;
    current.grantRequestId = requestId;
    current.grantExpiresAt = expiresAt;
    current.grantConsumed = false;
    this.#registry.setProviderCliCredentialObservation(
      current.computerId,
      current.instanceId,
      {
        agentId: current.agentId,
        integrationId: current.integrationId,
        provider: current.provider,
        credentialGeneration: current.credentialGeneration,
        requestId,
        status: "checking",
      },
      this.#now(),
    );
    const frame: ProviderCliValidationGrantFrame = {
      type: "provider-cli:validation:grant",
      requestId,
      requirementRequestId: current.requestId,
      provider: current.provider,
      agentId: current.agentId,
      integrationId: current.integrationId,
      credentialGeneration: current.credentialGeneration,
      expiresAt: new Date(expiresAt).toISOString(),
      expectedIdentity: material.expectedIdentity,
      grant: material.grant,
    };
    try {
      await this.#registry.send(current.computerId, current.instanceId, frame);
    } catch {
      current.grantRequestId = undefined;
    }
  }

  #scheduleGrantRetry(current: CurrentRequest, reason: "rate_limited" | "provider_unreachable"): void {
    if (current.grantRetryAttempt >= this.#maxRetries) {
      this.#registry.setProviderCliCredentialObservation(
        current.computerId,
        current.instanceId,
        {
          agentId: current.agentId,
          integrationId: current.integrationId,
          provider: current.provider,
          credentialGeneration: current.credentialGeneration,
          requestId: current.grantRequestId ?? current.requestId,
          status: "needs_attention",
          reason,
        },
        this.#now(),
      );
      return;
    }
    current.grantRetryAttempt += 1;
    current.grantConsumed = true;
    const delayMs = this.#jitteredDelay(1000 * 2 ** (current.grantRetryAttempt - 1));
    this.#armTimer(
      current,
      () => {
        void this.#issueGrant(current);
      },
      delayMs,
    );
  }

  async #scheduleInternalRetry(current: CurrentRequest, reason: ProviderCliValidationRetryReason): Promise<void> {
    current.grantConsumed = true;
    if (reason === "artifact_changed") {
      if (current.artifactRetryAttempt >= this.#maxRetries) {
        this.#registry.setProviderCliArtifactObservation(
          current.computerId,
          current.instanceId,
          {
            agentId: current.agentId,
            integrationId: current.integrationId,
            provider: current.provider,
            credentialGeneration: current.credentialGeneration,
            requestId: current.requestId,
            status: "unavailable",
          },
          this.#now(),
        );
        return;
      }
      current.artifactRetryAttempt += 1;
      await this.#dispatchRequirement(
        current.computerId,
        current.installationId,
        current.instanceId,
        current.snapshot,
        { force: true },
      );
      return;
    }
    if (current.grantRetryAttempt >= this.#maxRetries) {
      this.#registry.setProviderCliCredentialObservation(
        current.computerId,
        current.instanceId,
        {
          agentId: current.agentId,
          integrationId: current.integrationId,
          provider: current.provider,
          credentialGeneration: current.credentialGeneration,
          requestId: current.grantRequestId ?? current.requestId,
          status: "needs_attention",
        },
        this.#now(),
      );
      return;
    }
    current.grantRetryAttempt += 1;
    this.#armTimer(
      current,
      () => {
        void this.#issueGrant(current);
      },
      this.#jitteredDelay(reason === "validation_busy" ? 250 : 1000),
    );
  }

  #scheduleArtifactRetry(current: CurrentRequest | undefined): void {
    if (!current) return;
    if (current.artifactRetryAttempt >= this.#maxRetries) {
      current.artifactRetryPending = false;
      return;
    }
    current.artifactRetryAttempt += 1;
    current.artifactRetryPending = true;
    this.#armTimer(
      current,
      () => {
        current.artifactRetryPending = false;
        void this.#dispatchRequirement(
          current.computerId,
          current.installationId,
          current.instanceId,
          current.snapshot,
          { force: true },
        );
      },
      this.#jitteredDelay(1000 * 2 ** (current.artifactRetryAttempt - 1)),
    );
  }

  #jitteredDelay(baseMs: number): number {
    return Math.max(1, Math.round(baseMs * (0.75 + 0.5 * this.#random())));
  }

  #armTimer(current: CurrentRequest, callback: () => void, delayMs: number): void {
    if (current.retryTimer) clearTimeout(current.retryTimer);
    current.retryTimer = setTimeout(() => {
      current.retryTimer = undefined;
      callback();
    }, delayMs);
    current.retryTimer.unref();
  }

  #acceptsFence(
    current: CurrentRequest | undefined,
    frame: {
      agentId: string;
      credentialGeneration: number;
      integrationId: string;
      provider: ImCliProvider;
    },
    context: RuntimeBusinessContext,
  ): current is CurrentRequest {
    if (!current) return false;
    return (
      current.computerId === context.computerId &&
      current.instanceId === context.instanceId &&
      current.installationId === context.installationId &&
      current.agentId === frame.agentId &&
      current.integrationId === frame.integrationId &&
      current.provider === frame.provider &&
      current.credentialGeneration === frame.credentialGeneration
    );
  }

  #acceptsArtifact(
    current: CurrentRequest | undefined,
    frame: ProviderCliArtifactStatusFrame,
    context: RuntimeBusinessContext,
  ): current is CurrentRequest {
    return this.#acceptsFence(current, frame, context) && frame.requestId === current.requestId;
  }

  #acceptsGrantResult(
    current: CurrentRequest | undefined,
    frame: ProviderCliValidationResultFrame,
    context: RuntimeBusinessContext,
  ): current is CurrentRequest {
    if (!this.#acceptsFence(current, frame, context)) return false;
    if (frame.requestId !== current.grantRequestId) return false;
    if (current.grantConsumed) return false;
    if (
      (current.grantExpiresAt ?? 0) <= this.#now() &&
      !(frame.status === "retrying" && frame.reason === "validation_expired")
    ) {
      return false;
    }
    current.grantConsumed = true;
    return true;
  }

  async #refreshActiveReadiness(input: { agentId: string; computerId: string }): Promise<void> {
    if (this.#closed) return;
    const instanceId = this.#registry.currentInstanceId(input.computerId);
    if (!instanceId) return;
    const installationId = this.#registry.installationId(input.computerId);
    if (!installationId) return;
    const now = this.#now();
    const requirements = (await this.#bindings.listActiveProviderCliRequirements(input.computerId)).filter(
      (requirement) => requirement.agentId === input.agentId,
    );
    if (requirements.length === 0) {
      await this.#retireAgentOnComputer(input.agentId, input.computerId);
      return;
    }
    if (!this.#registry.supportsCapability(input.computerId, instanceId, RUNTIME_CAPABILITY.providerCliReconcile)) {
      return;
    }
    const artifacts = this.#registry.providerCliArtifactReadiness(input.computerId, now);
    const credentials = this.#registry.providerCliCredentialReadiness(input.computerId, now);
    for (const requirement of requirements) {
      await this.#refreshRequirement(input.computerId, installationId, instanceId, requirement, artifacts, credentials);
    }
  }

  async #refreshRequirement(
    computerId: string,
    installationId: string,
    instanceId: string,
    requirement: ProviderCliRequirementSnapshot,
    artifacts: ProviderCliArtifactReadiness,
    credentials: ProviderCliCredentialReadiness,
  ): Promise<void> {
    const artifact = matchObservation(artifacts, requirement);
    const credential = matchObservation(credentials, requirement);
    if (credential?.status === "needs_attention") return;
    if (artifact?.status === "ready" && credential?.status === "ready") return;
    const current = this.#requests.get(requestKey(computerId, requirement.integrationId));
    if (
      !current ||
      current.instanceId !== instanceId ||
      current.agentId !== requirement.agentId ||
      current.credentialGeneration !== requirement.credentialGeneration
    ) {
      await this.#dispatchRequirement(computerId, installationId, instanceId, requirement);
      return;
    }
    // A retained "unavailable" artifact observation is terminal, not in-flight work. While a
    // bounded retry is armed it is left alone; once the budget is exhausted the demand read is
    // the recovery path, restarting the requirement with a fresh bounded budget on the same
    // connection instead of waiting for a reconnect that may never come.
    if (artifact?.status === "unavailable") {
      if (current.artifactRetryPending) return;
      await this.#retireRequest(requestKey(computerId, requirement.integrationId));
      await this.#dispatchRequirement(computerId, installationId, instanceId, requirement);
      return;
    }
    if (isReconcileInFlight(artifact, credential)) return;
    if (artifact?.status === "ready" && !credential) {
      await this.#issueGrant(current);
      return;
    }
    await this.#dispatchRequirement(computerId, installationId, instanceId, requirement, { force: true });
  }

  async #retireAgentOnComputer(agentId: string, computerId: string): Promise<void> {
    await Promise.all(
      [...this.#requests]
        .filter(([, current]) => current.computerId === computerId && current.agentId === agentId)
        .map(([key]) => this.#retireRequest(key)),
    );
  }

  async #resetComputer(computerId: string): Promise<void> {
    await Promise.all(
      [...this.#requests]
        .filter(([, current]) => current.computerId === computerId)
        .map(([key]) => this.#retireRequest(key)),
    );
  }

  async #retireRequest(key: string): Promise<void> {
    const current = this.#requests.get(key);
    if (current?.retryTimer) clearTimeout(current.retryTimer);
    this.#requests.delete(key);
    if (current) await this.#sendCancel(current);
  }

  async #sendCancel(current: CurrentRequest): Promise<void> {
    const frame: ProviderCliCancelFrame = {
      type: "provider-cli:cancel",
      requestId: randomUUID(),
      requirementRequestId: current.requestId,
      provider: current.provider,
      agentId: current.agentId,
      integrationId: current.integrationId,
      credentialGeneration: current.credentialGeneration,
    };
    try {
      await this.#registry.send(current.computerId, current.instanceId, frame);
    } catch {
      return;
    }
  }
}

function expectedIdentitiesMatch(left: ProviderCliExpectedIdentity, right: ProviderCliExpectedIdentity): boolean {
  if (left.provider !== right.provider) return false;
  if (left.provider === "feishu" && right.provider === "feishu") {
    return left.appId === right.appId && left.botOpenId === right.botOpenId && left.teamBrand === right.teamBrand;
  }
  if (left.provider === "slack" && right.provider === "slack") {
    return left.teamId === right.teamId && left.botUserId === right.botUserId && left.botId === right.botId;
  }
  return false;
}
