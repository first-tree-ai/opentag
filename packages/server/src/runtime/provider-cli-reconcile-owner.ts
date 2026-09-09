import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeProvider,
  IM_CLI_PROVIDERS,
  type ImCliProvider,
  PROVIDER_CLI_VALIDATION_RETRY_REASONS,
  type ProviderCliArtifactPublicReason,
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
  providerCliArtifactFailureIsManual,
  publicProviderCliArtifactReason,
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
  artifactRepairStopped: boolean;
  artifactRetryAttempt: number;
  /** True only while a bounded artifact re-dispatch timer is actually armed. */
  artifactRetryPending: boolean;
  computerId: string;
  installationId: string;
  credentialGeneration: number;
  expectedIdentity: ProviderCliExpectedIdentity;
  grantConsumed: boolean;
  grantExpiresAt?: number;
  grantIssue?: Promise<void>;
  grantRepairStopped: boolean;
  grantRequestId?: string;
  grantRetryAttempt: number;
  instanceId: string;
  integrationId: string;
  provider: ImCliProvider;
  requestId: string;
  retryTimer?: ReturnType<typeof setTimeout>;
  snapshot: ProviderCliRequirementSnapshot;
}

interface CurrentPreparation {
  computerId: string;
  instanceId: string;
  providers: readonly ImCliProvider[];
  requestId: string;
  runtimeProvider: AgentRuntimeProvider;
  timer?: ReturnType<typeof setTimeout>;
}

const INTERNAL_RETRY_REASONS = new Set<string>(PROVIDER_CLI_VALIDATION_RETRY_REASONS);
/** Covers the Client's bounded lock convergence and artifact download before failing closed. */
const DEFAULT_PROVIDER_CLI_PREPARATION_TIMEOUT_MS = 5 * 60_000;

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
  readonly #preparationTimeoutMs: number;
  readonly #random: () => number;
  readonly #registry: ConnectionRegistry;
  readonly #inflightFresh = new Map<string, Promise<void>>();
  readonly #inflightPrepare = new Map<string, Promise<void>>();
  readonly #preparations = new Map<string, CurrentPreparation>();
  readonly #requests = new Map<string, CurrentRequest>();
  readonly #requestGates = new Map<string, Promise<void>>();
  readonly #agentReconcileSeq = new Map<string, number>();
  readonly #observedGeneration = new Map<string, number>();
  readonly #transitionEpoch = new Map<string, number>();
  #closed = false;

  constructor(
    registry: ConnectionRegistry,
    bindings: ProviderCliReconcileBindingSource,
    options: {
      grantTtlMs?: number;
      maxRetries?: number;
      now?: () => number;
      /** Test hook: replaces the bounded ensure-fence fallback. */
      preparationTimeoutMs?: number;
      random?: () => number;
    } = {},
  ) {
    this.#registry = registry;
    this.#bindings = bindings;
    this.#grantTtlMs = options.grantTtlMs ?? RUNTIME_PROVIDER_CLI_VALIDATION_GRANT_TTL_MS;
    this.#maxRetries = options.maxRetries ?? RUNTIME_PROVIDER_CLI_VALIDATION_MAX_RETRIES;
    this.#now = options.now ?? Date.now;
    this.#preparationTimeoutMs = options.preparationTimeoutMs ?? DEFAULT_PROVIDER_CLI_PREPARATION_TIMEOUT_MS;
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
    const agentSeq = new Map(this.#agentReconcileSeq);
    await this.#resetComputer(input.computerId);
    await this.#dispatchSetupPrewarm(input, "inspect");
    const requirements = await this.#bindings.listActiveProviderCliRequirements(input.computerId);
    if (!this.#connectionMatches(input.computerId, input.instanceId, input.installationId)) return;
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
      if (!this.#agentReconcileUnchanged(input.computerId, requirement.agentId, agentSeq)) continue;
      await this.#dispatchRequirement(input.computerId, input.installationId, input.instanceId, requirement);
    }
  }

  /**
   * Sends one preparation request for both official Provider CLIs. Registration is inspect-only and
   * uses the exact v1 `{ type, requestId, providers }` frame so strict older Clients still accept it.
   * Placement and manual refresh use ensure plus a checking fence; v1 cannot guarantee a result, so
   * every begun fence has a server-owned bounded fallback. Active-binding requirements stay separate
   * and never create continuing requirements for an unselected Provider.
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
    const runtimeProvider = mode === "ensure" ? input.runtimeProvider : undefined;
    const frame: ProviderCliPrewarmFrame = {
      type: "provider-cli:prewarm",
      requestId: randomUUID(),
      providers: [...IM_CLI_PROVIDERS],
      ...(runtimeProvider ? { mode, runtimeProvider } : {}),
    };
    if (runtimeProvider) {
      this.#disarmPreparation(input.computerId);
      if (
        !this.#registry.beginPreparation(
          input.computerId,
          input.instanceId,
          frame.requestId,
          runtimeProvider,
          frame.providers,
          this.#now(),
        )
      ) {
        return false;
      }
      this.#armPreparationFallback({
        computerId: input.computerId,
        instanceId: input.instanceId,
        requestId: frame.requestId,
        runtimeProvider,
        providers: frame.providers,
      });
    }
    try {
      await this.#registry.send(input.computerId, input.instanceId, frame);
    } catch {
      if (runtimeProvider) {
        this.#disarmPreparation(input.computerId, frame.requestId);
        this.#failPreparation({
          computerId: input.computerId,
          instanceId: input.instanceId,
          requestId: frame.requestId,
          runtimeProvider,
          providers: frame.providers,
        });
      }
      return false;
    }
    return true;
  }

  async onActiveBindingChanged(input: { agentId: string; computerId: string }): Promise<void> {
    if (this.#closed) return;
    const seq = this.#beginAgentReconcile(input.computerId, input.agentId);
    const instanceId = this.#registry.currentInstanceId(input.computerId);
    if (!instanceId) return;
    const installationId = this.#registry.installationId(input.computerId);
    if (!installationId) return;
    const requirements = await this.#bindings.listActiveProviderCliRequirements(input.computerId);
    if (!this.#isAgentReconcileCurrent(input.computerId, input.agentId, seq)) return;
    if (!this.#connectionMatches(input.computerId, instanceId, installationId)) return;
    const activeIds = new Set(
      requirements
        .filter((requirement) => requirement.agentId === input.agentId)
        .map((requirement) => requirement.integrationId),
    );
    for (const [key, current] of [...this.#requests]) {
      if (
        current.computerId === input.computerId &&
        current.agentId === input.agentId &&
        !activeIds.has(current.integrationId)
      ) {
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
    const key = `${input.computerId}:${input.agentId}`;
    const existing = this.#inflightPrepare.get(key);
    if (existing) return existing;
    const task = this.#prepareComputer(input).finally(() => {
      if (this.#inflightPrepare.get(key) === task) this.#inflightPrepare.delete(key);
    });
    this.#inflightPrepare.set(key, task);
    await task;
  }

  async #prepareComputer(input: {
    agentId: string;
    computerId: string;
    runtimeProvider: AgentRuntimeProvider;
  }): Promise<void> {
    const instanceId = this.#registry.currentInstanceId(input.computerId);
    const installationId = this.#registry.installationId(input.computerId);
    if (!instanceId || !installationId) throw new Error("The Computer runtime is not connected");
    const startedPrewarm = await this.#dispatchSetupPrewarm(
      {
        computerId: input.computerId,
        installationId,
        instanceId,
        runtimeProvider: input.runtimeProvider,
      },
      "ensure",
    );
    const startedRetry = await this.#retryActiveRequirements({
      agentId: input.agentId,
      computerId: input.computerId,
      installationId,
      instanceId,
    });
    if (!startedPrewarm && !startedRetry) throw new Error("The Computer preparation operation could not be started");
  }

  async onAgentPlacementChanged(input: {
    agentId: string;
    previousComputerId?: string;
    computerId?: string;
    runtimeProvider?: AgentRuntimeProvider;
  }): Promise<void> {
    if (this.#closed) return;
    if (input.previousComputerId && input.previousComputerId !== input.computerId) {
      this.#beginAgentReconcile(input.previousComputerId, input.agentId);
      await this.#retireAgentOnComputer(input.agentId, input.previousComputerId);
    }
    if (!input.computerId) return;
    // Automatic first-setup ensure belongs to a real Computer change or first bind. A repeated
    // identical placement, including a replay with no previousComputerId, must not reset budgets.
    const hasEpisode = [...this.#requests.values()].some(
      (current) => current.computerId === input.computerId && current.agentId === input.agentId,
    );
    try {
      if (input.runtimeProvider && !hasEpisode) {
        await this.prepareComputer({
          agentId: input.agentId,
          computerId: input.computerId,
          runtimeProvider: input.runtimeProvider,
        });
      }
    } finally {
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
    this.#inflightPrepare.clear();
    for (const key of [...this.#requests.keys()]) void this.#retireRequest(key);
    for (const [computerId, current] of this.#preparations) {
      if (current.timer) clearTimeout(current.timer);
      this.#failPreparation({ ...current, computerId });
    }
    this.#preparations.clear();
  }

  async #dispatchRequirement(
    computerId: string,
    installationId: string,
    instanceId: string,
    requirement: ProviderCliRequirementSnapshot,
    options: { force?: boolean; resetBudget?: boolean; retry?: boolean } = {},
  ): Promise<void> {
    const key = requestKey(computerId, requirement.integrationId);
    const transition = this.#transitionOf(key);
    const seq = this.#currentAgentReconcile(computerId, requirement.agentId);
    await this.#withRequestGate(key, () =>
      this.#dispatchRequirementLocked(
        key,
        computerId,
        installationId,
        instanceId,
        requirement,
        options,
        transition,
        seq,
      ),
    );
  }

  async #dispatchRequirementLocked(
    key: string,
    computerId: string,
    installationId: string,
    instanceId: string,
    requirement: ProviderCliRequirementSnapshot,
    options: { force?: boolean; resetBudget?: boolean; retry?: boolean },
    transition: number,
    seq: number,
  ): Promise<void> {
    if (!this.#dispatchMayProceed(key, computerId, installationId, instanceId, requirement.agentId, transition, seq)) {
      return;
    }
    const observed = this.#observedGeneration.get(key) ?? 0;
    if (requirement.credentialGeneration < observed) return;
    const existing = this.#requests.get(key);
    const sameEpisode = this.#sameEpisode(existing, instanceId, requirement);
    if (options.retry && !sameEpisode) return;
    if (this.#shouldSkipDispatch(computerId, existing, sameEpisode, options)) return;
    if (!this.#dispatchMayProceed(key, computerId, installationId, instanceId, requirement.agentId, transition, seq)) {
      return;
    }
    const current = this.#installRequest(
      key,
      existing,
      sameEpisode && existing && !options.resetBudget ? existing : undefined,
      computerId,
      installationId,
      instanceId,
      requirement,
    );
    if (existing && existing.requestId !== current.requestId) {
      await this.#sendCancel(existing);
      if (!this.#dispatchStillOwns(key, current, transition)) return;
    }
    await this.#sendFreshRequirement(key, current, transition);
  }

  #installRequest(
    key: string,
    existing: CurrentRequest | undefined,
    prior: CurrentRequest | undefined,
    computerId: string,
    installationId: string,
    instanceId: string,
    requirement: ProviderCliRequirementSnapshot,
  ): CurrentRequest {
    if (existing?.retryTimer) {
      clearTimeout(existing.retryTimer);
      existing.retryTimer = undefined;
      existing.artifactRetryPending = false;
    }
    const current: CurrentRequest = {
      agentId: requirement.agentId,
      artifactRepairStopped: prior?.artifactRepairStopped ?? false,
      artifactRetryAttempt: prior?.artifactRetryAttempt ?? 0,
      artifactRetryPending: false,
      computerId,
      credentialGeneration: requirement.credentialGeneration,
      expectedIdentity: requirement.expectedIdentity,
      grantConsumed: false,
      grantRepairStopped: prior?.grantRepairStopped ?? false,
      grantRetryAttempt: prior?.grantRetryAttempt ?? 0,
      instanceId,
      installationId,
      integrationId: requirement.integrationId,
      provider: requirement.provider,
      requestId: randomUUID(),
      snapshot: requirement,
    };
    this.#requests.set(key, current);
    this.#observedGeneration.set(
      key,
      Math.max(this.#observedGeneration.get(key) ?? 0, requirement.credentialGeneration),
    );
    return current;
  }

  async #sendFreshRequirement(key: string, current: CurrentRequest, transition: number): Promise<void> {
    if (!this.#dispatchStillOwns(key, current, transition)) return;
    this.#registry.setProviderCliArtifactObservation(
      current.computerId,
      current.instanceId,
      {
        agentId: current.agentId,
        integrationId: current.integrationId,
        provider: current.provider,
        credentialGeneration: current.credentialGeneration,
        requestId: current.requestId,
        status: "checking",
      },
      this.#now(),
    );
    this.#registry.setProviderCliCredentialObservation(
      current.computerId,
      current.instanceId,
      {
        agentId: current.agentId,
        integrationId: current.integrationId,
        provider: current.provider,
        credentialGeneration: current.credentialGeneration,
        requestId: current.requestId,
        status: "unconfirmed",
      },
      this.#now(),
    );
    const frame: ProviderCliRequirementFrame = {
      type: "provider-cli:requirement",
      operation: RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
      requestId: current.requestId,
      provider: current.provider,
      agentId: current.agentId,
      integrationId: current.integrationId,
      credentialGeneration: current.credentialGeneration,
      expectedIdentity: current.expectedIdentity,
    };
    try {
      await this.#registry.send(current.computerId, current.instanceId, frame);
    } catch {
      if (this.#dispatchStillOwns(key, current, transition)) this.#scheduleArtifactRetry(current);
    }
  }

  #dispatchMayProceed(
    key: string,
    computerId: string,
    installationId: string,
    instanceId: string,
    agentId: string,
    transition: number,
    seq: number,
  ): boolean {
    return (
      !this.#closed &&
      this.#transitionOf(key) === transition &&
      this.#isAgentReconcileCurrent(computerId, agentId, seq) &&
      this.#connectionMatches(computerId, instanceId, installationId)
    );
  }

  #dispatchStillOwns(key: string, current: CurrentRequest, transition: number): boolean {
    return (
      !this.#closed &&
      this.#requests.get(key) === current &&
      this.#transitionOf(key) === transition &&
      this.#connectionMatches(current.computerId, current.instanceId, current.installationId)
    );
  }

  #sameEpisode(
    existing: CurrentRequest | undefined,
    instanceId: string,
    requirement: ProviderCliRequirementSnapshot,
  ): existing is CurrentRequest {
    return (
      existing !== undefined &&
      existing.instanceId === instanceId &&
      existing.credentialGeneration === requirement.credentialGeneration &&
      existing.agentId === requirement.agentId
    );
  }

  #shouldSkipDispatch(
    computerId: string,
    existing: CurrentRequest | undefined,
    sameEpisode: boolean,
    options: { force?: boolean; resetBudget?: boolean; retry?: boolean },
  ): boolean {
    if (!sameEpisode || !existing || options.resetBudget) return false;
    if (!options.force) return true;
    if (this.#episodeStopped(existing)) return true;
    return !options.retry && this.#shouldHoldForceRedispatch(computerId, existing);
  }

  #episodeStopped(current: CurrentRequest): boolean {
    return current.artifactRepairStopped || current.grantRepairStopped;
  }

  #shouldHoldForceRedispatch(computerId: string, current: CurrentRequest): boolean {
    if (current.artifactRetryPending || current.retryTimer) return true;
    const now = this.#now();
    const artifact = matchObservation(this.#registry.providerCliArtifactReadiness(computerId, now), current.snapshot);
    const credential = matchObservation(
      this.#registry.providerCliCredentialReadiness(computerId, now),
      current.snapshot,
    );
    if (isReconcileInFlight(artifact, credential)) return true;
    return artifact?.status === "ready" && credential?.status === "ready";
  }

  async #retryActiveRequirements(input: {
    agentId: string;
    computerId: string;
    installationId: string;
    instanceId: string;
  }): Promise<boolean> {
    if (
      !this.#registry.supportsCapability(input.computerId, input.instanceId, RUNTIME_CAPABILITY.providerCliReconcile)
    ) {
      return false;
    }
    const seq = this.#beginAgentReconcile(input.computerId, input.agentId);
    const requirements = (await this.#bindings.listActiveProviderCliRequirements(input.computerId)).filter(
      (requirement) => requirement.agentId === input.agentId,
    );
    if (!this.#isAgentReconcileCurrent(input.computerId, input.agentId, seq)) return false;
    if (!this.#connectionMatches(input.computerId, input.instanceId, input.installationId)) return false;
    if (requirements.length === 0) return false;
    for (const requirement of requirements) {
      await this.#dispatchRequirement(input.computerId, input.installationId, input.instanceId, requirement, {
        resetBudget: true,
      });
    }
    return true;
  }

  async #handle(
    frame: ProviderCliArtifactStatusFrame | ProviderCliPrewarmResultFrame | ProviderCliValidationResultFrame,
    context: RuntimeBusinessContext,
  ): Promise<undefined> {
    if (frame.type === "provider-cli:prewarm:result") {
      const completed = this.#registry.completePreparation(context.computerId, context.instanceId, frame, this.#now());
      if (completed) this.#disarmPreparation(context.computerId, frame.requestId);
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
    const reason =
      frame.status === "unavailable" &&
      this.#registry.capabilityVersion(
        context.computerId,
        context.instanceId,
        RUNTIME_CAPABILITY.providerCliReconcile,
      ) === 2
        ? publicProviderCliArtifactReason(frame.reason)
        : undefined;
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
        ...(reason ? { reason } : {}),
      },
      this.#now(),
    );
    this.#invalidateCredentialOnArtifactFailure(current, frame, context);
    if (frame.status === "ready") {
      current.artifactRepairStopped = false;
      if (current.artifactRetryPending) {
        current.artifactRetryPending = false;
        if (current.retryTimer) {
          clearTimeout(current.retryTimer);
          current.retryTimer = undefined;
        }
      }
      await this.#issueGrant(current);
    }
    if (frame.status === "unavailable") this.#settleOrRetryArtifact(current, reason);
    return undefined;
  }

  #settleOrRetryArtifact(current: CurrentRequest, reason: ProviderCliArtifactPublicReason | undefined): void {
    if (providerCliArtifactFailureIsManual({ reason, stage: "ensure" })) {
      current.artifactRepairStopped = true;
      current.artifactRetryPending = false;
      if (current.retryTimer) {
        clearTimeout(current.retryTimer);
        current.retryTimer = undefined;
      }
      return;
    }
    this.#scheduleArtifactRetry(current);
  }

  #invalidateCredentialOnArtifactFailure(
    current: CurrentRequest,
    frame: ProviderCliArtifactStatusFrame,
    context: RuntimeBusinessContext,
  ): void {
    if (frame.status === "ready") return;
    if (current.grantRequestId && !current.grantConsumed) current.grantConsumed = true;
    const credential = matchObservation(
      this.#registry.providerCliCredentialReadiness(context.computerId, this.#now()),
      current.snapshot,
    );
    // Terminal credential failures stay until an explicit new recovery; a repeated artifact
    // check must not launder needs_attention or retry exhaustion.
    if (credential?.status === "needs_attention" || current.grantRepairStopped) return;
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
    if (frame.status === "retrying") return this.#handleRetryingValidation(current, frame, context);
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
    if (frame.status === "ready") this.#endFailureEpisode(current);
    if (frame.status === "needs_attention") current.grantRepairStopped = true;
    return undefined;
  }

  async #handleRetryingValidation(
    current: CurrentRequest,
    frame: ProviderCliValidationResultFrame,
    context: RuntimeBusinessContext,
  ): Promise<undefined> {
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

  #endFailureEpisode(current: CurrentRequest): void {
    current.artifactRetryAttempt = 0;
    current.grantRetryAttempt = 0;
    current.artifactRepairStopped = false;
    current.grantRepairStopped = false;
    current.grantRequestId = undefined;
    current.grantConsumed = false;
    current.grantExpiresAt = undefined;
  }

  async #issueGrant(current: CurrentRequest): Promise<void> {
    if (current.grantIssue) return current.grantIssue;
    const task = this.#performIssueGrant(current).finally(() => {
      if (current.grantIssue === task) current.grantIssue = undefined;
    });
    current.grantIssue = task;
    await task;
  }

  async #performIssueGrant(current: CurrentRequest): Promise<void> {
    if (this.#requests.get(requestKey(current.computerId, current.integrationId)) !== current) return;
    if (this.#shouldSkipGrant(current)) return;
    if (!this.#artifactIsReady(current)) return;
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
    if (!this.#artifactIsReady(current)) return;
    if (!expectedIdentitiesMatch(current.expectedIdentity, material.expectedIdentity)) {
      current.grantRepairStopped = true;
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
      current.grantConsumed = true;
      this.#scheduleGrantRetry(current, "provider_unreachable");
    }
  }

  #shouldSkipGrant(current: CurrentRequest): boolean {
    if (current.grantRepairStopped) return true;
    if (current.grantRequestId && !current.grantConsumed && (current.grantExpiresAt ?? 0) > this.#now()) return true;
    if (current.grantRequestId && !current.grantConsumed && (current.grantExpiresAt ?? 0) <= this.#now()) {
      current.grantConsumed = true;
      this.#scheduleGrantRetry(current, "provider_unreachable");
      return true;
    }
    const credential = matchObservation(
      this.#registry.providerCliCredentialReadiness(current.computerId, this.#now()),
      current.snapshot,
    );
    if (credential?.status === "needs_attention") {
      current.grantRepairStopped = true;
      return true;
    }
    if (credential?.status === "ready") return true;
    return Boolean(current.retryTimer && !current.artifactRetryPending);
  }

  #artifactIsReady(current: CurrentRequest): boolean {
    return (
      matchObservation(this.#registry.providerCliArtifactReadiness(current.computerId, this.#now()), current.snapshot)
        ?.status === "ready"
    );
  }

  #scheduleGrantRetry(current: CurrentRequest, reason: "rate_limited" | "provider_unreachable"): void {
    if (current.grantRetryAttempt >= this.#maxRetries) {
      current.grantRepairStopped = true;
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
        current.artifactRepairStopped = true;
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
        { force: true, retry: true },
      );
      return;
    }
    if (current.grantRetryAttempt >= this.#maxRetries) {
      current.grantRepairStopped = true;
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
    if (current.artifactRepairStopped) return;
    if (current.artifactRetryPending) return;
    if (current.artifactRetryAttempt >= this.#maxRetries) {
      this.#settleTerminalArtifact(current);
      return;
    }
    current.artifactRetryAttempt += 1;
    this.#armTimer(
      current,
      () => {
        current.artifactRetryPending = false;
        if (this.#artifactIsReady(current)) return;
        void this.#dispatchRequirement(
          current.computerId,
          current.installationId,
          current.instanceId,
          current.snapshot,
          { force: true, retry: true },
        );
      },
      this.#jitteredDelay(1000 * 2 ** (current.artifactRetryAttempt - 1)),
    );
    current.artifactRetryPending = true;
  }

  #settleTerminalArtifact(current: CurrentRequest): void {
    current.artifactRepairStopped = true;
    current.artifactRetryPending = false;
    if (current.retryTimer) {
      clearTimeout(current.retryTimer);
      current.retryTimer = undefined;
    }
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
  }

  async #withRequestGate(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#requestGates.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(
      () => held,
      () => held,
    );
    this.#requestGates.set(key, next);
    try {
      await previous.catch(() => undefined);
      await work();
    } finally {
      release();
      if (this.#requestGates.get(key) === next) this.#requestGates.delete(key);
    }
  }

  #jitteredDelay(baseMs: number): number {
    return Math.max(1, Math.round(baseMs * (0.75 + 0.5 * this.#random())));
  }

  #armTimer(current: CurrentRequest, callback: () => void, delayMs: number): void {
    if (current.retryTimer) {
      clearTimeout(current.retryTimer);
      current.artifactRetryPending = false;
    }
    const key = requestKey(current.computerId, current.integrationId);
    current.retryTimer = setTimeout(() => {
      current.retryTimer = undefined;
      if (this.#requests.get(key) !== current) return;
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
    if (frame.status === "ready" && !this.#artifactIsReady(current)) return false;
    return true;
  }

  async #refreshActiveReadiness(input: { agentId: string; computerId: string }): Promise<void> {
    if (this.#closed) return;
    const seq = this.#currentAgentReconcile(input.computerId, input.agentId);
    const instanceId = this.#registry.currentInstanceId(input.computerId);
    if (!instanceId) return;
    const installationId = this.#registry.installationId(input.computerId);
    if (!installationId) return;
    const now = this.#now();
    const requirements = (await this.#bindings.listActiveProviderCliRequirements(input.computerId)).filter(
      (requirement) => requirement.agentId === input.agentId,
    );
    if (!this.#isAgentReconcileCurrent(input.computerId, input.agentId, seq)) return;
    if (!this.#connectionMatches(input.computerId, instanceId, installationId)) return;
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
    if (this.#episodeStopped(current)) return;
    // A retained unavailable observation is terminal. Demand reads must not retire it or refill
    // the budget; explicit retry / reconnect / generation change start a new recovery.
    if (artifact?.status === "unavailable") return;
    if (isReconcileInFlight(artifact, credential) || current.artifactRetryPending || current.retryTimer) return;
    if (current.grantRequestId) {
      await this.#issueGrant(current);
      return;
    }
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
    this.#disarmPreparation(computerId);
    await Promise.all(
      [...this.#requests]
        .filter(([, current]) => current.computerId === computerId)
        .map(([key]) => this.#retireRequest(key)),
    );
  }

  #armPreparationFallback(input: {
    computerId: string;
    instanceId: string;
    providers: readonly ImCliProvider[];
    requestId: string;
    runtimeProvider: AgentRuntimeProvider;
  }): void {
    this.#disarmPreparation(input.computerId);
    const timer = setTimeout(() => {
      const current = this.#preparations.get(input.computerId);
      if (!current || current.requestId !== input.requestId || current.timer !== timer) return;
      this.#preparations.delete(input.computerId);
      if (this.#closed) return;
      this.#failPreparation(input);
    }, this.#preparationTimeoutMs);
    timer.unref();
    this.#preparations.set(input.computerId, { ...input, timer });
  }

  #disarmPreparation(computerId: string, requestId?: string): void {
    const current = this.#preparations.get(computerId);
    if (!current) return;
    if (requestId !== undefined && current.requestId !== requestId) return;
    if (current.timer) clearTimeout(current.timer);
    this.#preparations.delete(computerId);
  }

  #failPreparation(input: {
    computerId: string;
    instanceId: string;
    providers: readonly ImCliProvider[];
    requestId: string;
    runtimeProvider: AgentRuntimeProvider;
  }): void {
    this.#registry.completePreparation(
      input.computerId,
      input.instanceId,
      {
        requestId: input.requestId,
        runtime: { provider: input.runtimeProvider, status: "unavailable" },
        providers: input.providers.map((provider) => ({ provider, status: "unavailable" })),
      },
      this.#now(),
      { quarantine: true },
    );
  }

  async #retireRequest(key: string): Promise<void> {
    const current = this.#requests.get(key);
    this.#bumpTransition(key);
    if (current) this.#dropRequest(current);
    if (!current) return;
    await this.#withRequestGate(key, async () => {
      await this.#sendCancel(current);
    });
  }

  #dropRequest(current: CurrentRequest): void {
    if (current.retryTimer) {
      clearTimeout(current.retryTimer);
      current.retryTimer = undefined;
    }
    current.artifactRetryPending = false;
    const key = requestKey(current.computerId, current.integrationId);
    if (this.#requests.get(key) === current) this.#requests.delete(key);
  }

  #bumpTransition(key: string): void {
    this.#transitionEpoch.set(key, this.#transitionOf(key) + 1);
  }

  #transitionOf(key: string): number {
    return this.#transitionEpoch.get(key) ?? 0;
  }

  #agentReconcileKey(computerId: string, agentId: string): string {
    return `${computerId}:${agentId}`;
  }

  #beginAgentReconcile(computerId: string, agentId: string): number {
    const key = this.#agentReconcileKey(computerId, agentId);
    const next = (this.#agentReconcileSeq.get(key) ?? 0) + 1;
    this.#agentReconcileSeq.set(key, next);
    return next;
  }

  #currentAgentReconcile(computerId: string, agentId: string): number {
    return this.#agentReconcileSeq.get(this.#agentReconcileKey(computerId, agentId)) ?? 0;
  }

  #isAgentReconcileCurrent(computerId: string, agentId: string, seq: number): boolean {
    return !this.#closed && this.#currentAgentReconcile(computerId, agentId) === seq;
  }

  #agentReconcileUnchanged(computerId: string, agentId: string, snapshot: ReadonlyMap<string, number>): boolean {
    const key = this.#agentReconcileKey(computerId, agentId);
    return (this.#agentReconcileSeq.get(key) ?? 0) === (snapshot.get(key) ?? 0);
  }

  #connectionMatches(computerId: string, instanceId: string, installationId: string): boolean {
    return (
      !this.#closed &&
      this.#registry.currentInstanceId(computerId) === instanceId &&
      this.#registry.installationId(computerId) === installationId
    );
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
