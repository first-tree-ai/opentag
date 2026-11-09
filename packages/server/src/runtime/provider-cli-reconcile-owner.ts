import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeProvider,
  type ImCliProvider,
  PROVIDER_CLI_VALIDATION_RETRY_REASONS,
  type ProviderCliArtifactPublicReason,
  type ProviderCliArtifactStatusFrame,
  ProviderCliArtifactStatusFrameSchema,
  type ProviderCliCancelFrame,
  type ProviderCliExpectedIdentity,
  type ProviderCliPrewarmResultFrame,
  ProviderCliPrewarmResultFrameSchema,
  type ProviderCliRequirementFrame,
  type ProviderCliValidationGrantFrame,
  type ProviderCliValidationResultFrame,
  ProviderCliValidationResultFrameSchema,
  type ProviderCliValidationResultReason,
  type ProviderCliValidationRetryReason,
  type ProviderCliValidationRunFrame,
  providerCliArtifactFailureIsManual,
  publicProviderCliArtifactReason,
  RUNTIME_CAPABILITY,
  RUNTIME_CREDENTIAL_CHECK_INTERVAL_MS,
  RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
  RUNTIME_PROVIDER_CLI_VALIDATION_GRANT_TTL_MS,
  RUNTIME_PROVIDER_CLI_VALIDATION_MAX_RETRIES,
  type RuntimeCredentialFailureHint,
  RuntimeCredentialFailureHintSchema,
  type RuntimeSelfCheckReport,
  RuntimeSelfCheckReportSchema,
} from "@opentag/shared";
import type { ConnectionRegistry } from "./connection-registry.js";
import { ProviderCliPreparationOwner } from "./provider-cli-preparation-owner.js";
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
   * Server-issued runtime-credential validation run for proxy-mode connections. Absent means the
   * deployment cannot issue validation authority, so proxy-mode validation stays needs_attention.
   */
  issueRuntimeValidationRun?(input: {
    agentId: string;
    computerId: string;
    instanceId: string;
    connectionId?: string;
    credentialGeneration: number;
    integrationId: string;
    provider: ImCliProvider;
  }): Promise<{ validationRunId: string; expiresAt: number } | undefined>;
  /** Cloud connections never receive legacy raw grant material. Defaults to `local` when absent. */
  computerKind?(computerId: string): Promise<"local" | "cloud" | undefined>;
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
  forceCredentialCheck: boolean;
  nextCredentialCheckAt: number;
  hintNotBefore?: number;
  grantExpiresAt?: number;
  credentialCheckDeadlineAt?: number;
  /** Set while a busy Computer holds a check: re-sent grants share this one budget. */
  busyCheckDeadlineAt?: number;
  cooldownUntil?: number;
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
  readonly #preparation: ProviderCliPreparationOwner;
  readonly #random: () => number;
  readonly #registry: ConnectionRegistry;
  readonly #inflightFresh = new Map<string, Promise<void>>();
  readonly #grantIssues = new Map<string, Promise<void>>();
  readonly #inflightPrepare = new Map<string, Promise<void>>();
  readonly #requests = new Map<string, CurrentRequest>();
  readonly #requestGates = new Map<string, Promise<void>>();
  readonly #agentReconcileSeq = new Map<string, number>();
  readonly #observedGeneration = new Map<string, number>();
  readonly #transitionEpoch = new Map<string, number>();
  readonly #tasks = new Set<Promise<void>>();
  #credentialTimer?: ReturnType<typeof setTimeout>;
  #credentialPump?: Promise<void>;
  readonly #manualCheckNotBefore = new Map<string, number>();
  #closing: Promise<void> | undefined;
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
    this.#preparation = new ProviderCliPreparationOwner(registry, bindings, {
      now: this.#now,
      timeoutMs: options.preparationTimeoutMs,
    });
    this.#random = options.random ?? Math.random;
  }

  businessOptions(): RuntimeBusinessOptions {
    return {
      parse: (input) => {
        const selfCheck = RuntimeSelfCheckReportSchema.safeParse(input);
        if (selfCheck.success) return selfCheck.data;
        const hint = RuntimeCredentialFailureHintSchema.safeParse(input);
        if (hint.success) return hint.data;
        const artifact = ProviderCliArtifactStatusFrameSchema.safeParse(input);
        if (artifact.success) return artifact.data;
        const preparation = ProviderCliPrewarmResultFrameSchema.safeParse(input);
        if (preparation.success) return preparation.data;
        const result = ProviderCliValidationResultFrameSchema.safeParse(input);
        return result.success ? result.data : undefined;
      },
      laneKey: (frame) => {
        if (frame.type === "runtime:self-check:report")
          return `self-check:${(frame as RuntimeSelfCheckReport).selfCheckId}`;
        if (frame.type === "runtime:credential-failure")
          return `credential-hint:${(frame as RuntimeCredentialFailureHint).integrationId}`;
        const typed = frame as
          | ProviderCliArtifactStatusFrame
          | ProviderCliPrewarmResultFrame
          | ProviderCliValidationResultFrame;
        if (typed.type === "provider-cli:prewarm:result") return `provider-cli:prewarm:${typed.requestId}`;
        return `provider-cli:${typed.integrationId}:${typed.credentialGeneration}`;
      },
      handle: (frame, context) =>
        this.#closed
          ? Promise.resolve(undefined)
          : this.#track(
              this.#handle(
                frame as
                  | RuntimeSelfCheckReport
                  | RuntimeCredentialFailureHint
                  | ProviderCliArtifactStatusFrame
                  | ProviderCliPrewarmResultFrame
                  | ProviderCliValidationResultFrame,
                context,
              ),
            ),
      failureResult: () => undefined,
      overloadResult: () => undefined,
    };
  }

  async onComputerRegistered(input: { computerId: string; installationId: string; instanceId: string }): Promise<void> {
    if (this.#closed) return;
    return this.#track(this.#registerComputer(input));
  }

  async #registerComputer(input: { computerId: string; installationId: string; instanceId: string }): Promise<void> {
    const agentSeq = new Map(this.#agentReconcileSeq);
    await this.#resetComputer(input.computerId);
    await this.#preparation.inspect(input);
    await this.#requestSelfCheck(input.computerId, input.instanceId);
    if (this.#closed) return;
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

  async onActiveBindingChanged(input: { agentId: string; computerId: string }): Promise<void> {
    if (this.#closed) return;
    return this.#track(this.#activeBindingChanged(input));
  }

  async #activeBindingChanged(input: { agentId: string; computerId: string }): Promise<void> {
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
    if (this.#closed) throw new Error("The Computer preparation owner is closed");
    for (const [scope, until] of this.#manualCheckNotBefore)
      if (until <= this.#now()) this.#manualCheckNotBefore.delete(scope);
    const key = `${input.computerId}:${input.agentId}`;
    if (this.#selfCheckingComputer(input.computerId) && (this.#manualCheckNotBefore.get(key) ?? 0) > this.#now())
      return;
    const existing = this.#inflightPrepare.get(key);
    if (existing) return existing;
    if (this.#selfCheckingComputer(input.computerId)) this.#manualCheckNotBefore.set(key, this.#now() + 30_000);
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
    const selfChecking = this.#selfCheckingComputer(input.computerId);
    if (selfChecking) {
      await this.#requestSelfCheck(input.computerId, instanceId);
    }
    await this.#preparation.prepare({ ...input, installationId, instanceId }, async (signal) => {
      const retried = await this.#retryActiveRequirements(
        {
          agentId: input.agentId,
          computerId: input.computerId,
          installationId,
          instanceId,
        },
        signal,
      );
      return retried || selfChecking;
    });
  }

  async onAgentPlacementChanged(input: {
    agentId: string;
    previousComputerId?: string;
    computerId?: string;
    runtimeProvider?: AgentRuntimeProvider;
  }): Promise<void> {
    if (this.#closed) return;
    return this.#track(this.#agentPlacementChanged(input));
  }

  async #agentPlacementChanged(input: {
    agentId: string;
    previousComputerId?: string;
    computerId?: string;
    runtimeProvider?: AgentRuntimeProvider;
  }): Promise<void> {
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
    if (this.#closed || this.#selfCheckingComputer(input.computerId)) return;
    const key = `${input.computerId}:${input.agentId}`;
    const existing = this.#inflightFresh.get(key);
    if (existing) return existing;
    const task = this.#refreshActiveReadiness(input).finally(() => {
      if (this.#inflightFresh.get(key) === task) this.#inflightFresh.delete(key);
    });
    this.#inflightFresh.set(key, task);
    await task;
  }

  async ensureLegacyReadinessForComputer(computerId: string): Promise<void> {
    if (this.#closed || this.#selfCheckingComputer(computerId)) return;
    const key = `${computerId}:all`;
    const existing = this.#inflightFresh.get(key);
    if (existing) return existing;
    const task = this.#refreshActiveReadiness({ computerId }).finally(() => {
      if (this.#inflightFresh.get(key) === task) this.#inflightFresh.delete(key);
    });
    this.#inflightFresh.set(key, task);
    await task;
  }

  onCredentialFailure(input: { agentId: string; bindingId: string; credentialGeneration: string }): void {
    for (const current of this.#requests.values()) {
      if (
        current.agentId !== input.agentId ||
        current.integrationId !== input.bindingId ||
        String(current.credentialGeneration) !== input.credentialGeneration.split(":")[0] ||
        !this.#selfCheckingComputer(current.computerId) ||
        (current.hintNotBefore ?? 0) > this.#now()
      )
        continue;
      current.hintNotBefore = this.#now() + 30_000;
      void this.#track(this.#recheckCredential(current)).catch(() =>
        this.#failCredential(current, "provider_unreachable"),
      );
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    if (this.#credentialTimer) clearTimeout(this.#credentialTimer);
    this.#credentialTimer = undefined;
    this.#manualCheckNotBefore.clear();
    const preparation = this.#preparation.close();
    for (const key of [...this.#requests.keys()]) void this.#retireRequest(key);
    this.#closing = this.#drain(preparation);
    return this.#closing;
  }

  async #drain(preparation: Promise<void>): Promise<void> {
    await Promise.allSettled([
      preparation,
      ...this.#inflightFresh.values(),
      ...this.#inflightPrepare.values(),
      ...this.#requestGates.values(),
    ]);
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
    this.#inflightFresh.clear();
    this.#inflightPrepare.clear();
  }

  #track(operation: Promise<void>): Promise<void> {
    this.#tasks.add(operation);
    void operation.then(
      () => this.#tasks.delete(operation),
      () => this.#tasks.delete(operation),
    );
    return operation;
  }

  async #dispatchRequirement(
    computerId: string,
    installationId: string,
    instanceId: string,
    requirement: ProviderCliRequirementSnapshot,
    options: { force?: boolean; resetBudget?: boolean; retry?: boolean; signal?: AbortSignal } = {},
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
    options: { force?: boolean; resetBudget?: boolean; retry?: boolean; signal?: AbortSignal },
    transition: number,
    seq: number,
  ): Promise<void> {
    options.signal?.throwIfAborted();
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
      !options.resetBudget,
    );
    if (existing && existing.requestId !== current.requestId) {
      await this.#sendCancel(existing);
      options.signal?.throwIfAborted();
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
    reuseCredential: boolean,
  ): CurrentRequest {
    if (existing?.retryTimer) {
      clearTimeout(existing.retryTimer);
      existing.retryTimer = undefined;
      existing.artifactRetryPending = false;
    }
    const retained = this.#registry
      .providerCliCredentialReadiness(computerId, this.#now())
      .find(
        ({ observation }) =>
          observation.agentId === requirement.agentId &&
          observation.integrationId === requirement.integrationId &&
          observation.credentialGeneration === requirement.credentialGeneration &&
          (observation.status === "ready" || observation.status === "needs_attention"),
      );
    const reusable =
      reuseCredential &&
      this.#selfCheckingComputer(computerId) &&
      retained &&
      this.#now() - retained.observedAt < RUNTIME_CREDENTIAL_CHECK_INTERVAL_MS;
    const current: CurrentRequest = {
      agentId: requirement.agentId,
      artifactRepairStopped: prior?.artifactRepairStopped ?? false,
      artifactRetryAttempt: prior?.artifactRetryAttempt ?? 0,
      artifactRetryPending: false,
      computerId,
      credentialGeneration: requirement.credentialGeneration,
      expectedIdentity: requirement.expectedIdentity,
      grantConsumed: false,
      forceCredentialCheck: !reusable,
      nextCredentialCheckAt: (reusable ? retained.observedAt : this.#now()) + RUNTIME_CREDENTIAL_CHECK_INTERVAL_MS,
      cooldownUntil: existing?.cooldownUntil,
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
    this.#armCredentialTimer();
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
    options: { force?: boolean; resetBudget?: boolean; retry?: boolean; signal?: AbortSignal },
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

  async #retryActiveRequirements(
    input: {
      agentId: string;
      computerId: string;
      installationId: string;
      instanceId: string;
    },
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (
      !this.#registry.supportsCapability(input.computerId, input.instanceId, RUNTIME_CAPABILITY.providerCliReconcile)
    ) {
      return false;
    }
    const seq = this.#beginAgentReconcile(input.computerId, input.agentId);
    const requirements = (await this.#bindings.listActiveProviderCliRequirements(input.computerId)).filter(
      (requirement) => requirement.agentId === input.agentId,
    );
    signal?.throwIfAborted();
    if (!this.#isAgentReconcileCurrent(input.computerId, input.agentId, seq)) return false;
    if (!this.#connectionMatches(input.computerId, input.instanceId, input.installationId)) return false;
    if (requirements.length === 0) return false;
    for (const requirement of requirements) {
      await this.#dispatchRequirement(input.computerId, input.installationId, input.instanceId, requirement, {
        resetBudget: true,
        signal,
      });
    }
    return true;
  }

  async #handle(
    frame:
      | ProviderCliArtifactStatusFrame
      | ProviderCliPrewarmResultFrame
      | ProviderCliValidationResultFrame
      | RuntimeSelfCheckReport
      | RuntimeCredentialFailureHint,
    context: RuntimeBusinessContext,
  ): Promise<undefined> {
    if (frame.type === "runtime:self-check:report") return this.#handleSelfCheckReport(frame, context);
    if (frame.type === "runtime:credential-failure") {
      const current = this.#requests.get(requestKey(context.computerId, frame.integrationId));
      if (
        context.negotiatedCapabilities?.[RUNTIME_CAPABILITY.selfCheckHeartbeat] !== 1 ||
        !current ||
        current.instanceId !== context.instanceId ||
        current.agentId !== frame.agentId ||
        current.credentialGeneration !== frame.credentialGeneration ||
        (current.hintNotBefore ?? 0) > this.#now()
      )
        return undefined;
      current.hintNotBefore = this.#now() + 30_000;
      await this.#recheckCredential(current);
      return undefined;
    }
    if (frame.type === "provider-cli:prewarm:result") {
      this.#preparation.complete(context.computerId, context.instanceId, frame);
      if (frame.providers !== undefined && this.#selfCheckingComputer(context.computerId)) {
        await this.#requestSelfCheck(context.computerId, context.instanceId);
      }
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

  #handleSelfCheckReport(frame: RuntimeSelfCheckReport, context: RuntimeBusinessContext): undefined {
    if (context.negotiatedCapabilities?.[RUNTIME_CAPABILITY.selfCheckHeartbeat] === 1) {
      const accepted = this.#registry.recordSelfCheck(
        context.computerId,
        context.instanceId,
        context.connectionId,
        frame,
        context.receivedAt,
        context.receivedMonotonicAt,
      );
      if (accepted)
        for (const current of this.#requests.values()) {
          if (
            current.computerId !== context.computerId ||
            !current.forceCredentialCheck ||
            !this.#artifactIsReady(current)
          )
            continue;
          void this.#issueGrant(current).catch(() => this.#failCredential(current, "provider_unreachable"));
        }
    }
    return undefined;
  }

  async #handleValidation(
    current: CurrentRequest | undefined,
    frame: ProviderCliValidationResultFrame,
    context: RuntimeBusinessContext,
  ): Promise<undefined> {
    if (!this.#acceptsGrantResult(current, frame, context)) return undefined;
    if (frame.status === "retrying") {
      if (this.#selfCheckingComputer(current.computerId)) {
        if (frame.reason === "validation_busy") {
          this.#resendBusyCheck(current);
          return undefined;
        }
        this.#failCredential(
          current,
          frame.reason === "rate_limited" ? "rate_limited" : "provider_unreachable",
          frame.reason === "validation_expired",
        );
        return undefined;
      }
      return this.#handleRetryingValidation(current, frame, context);
    }
    current.forceCredentialCheck = false;
    current.credentialCheckDeadlineAt = undefined;
    current.busyCheckDeadlineAt = undefined;
    current.grantConsumed = true;
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
    this.#armCredentialTimer();
    return undefined;
  }

  /**
   * The Computer runs one validation process, so bindings checked together answer busy. Nothing
   * reached the provider, so this says nothing about the credential: send it again within the same
   * budget, and let the deadline settle it as a timeout if the Computer stays busy.
   */
  #resendBusyCheck(current: CurrentRequest): void {
    current.busyCheckDeadlineAt = current.credentialCheckDeadlineAt ?? this.#now() + this.#grantTtlMs;
    this.#armTimer(
      current,
      () => {
        void this.#issueGrant(current).catch(() => this.#failCredential(current, "provider_unreachable"));
      },
      this.#jitteredDelay(500),
    );
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
    const key = requestKey(current.computerId, current.integrationId);
    const previous = this.#grantIssues.get(key);
    const task = this.#track(
      Promise.resolve(previous)
        .catch(() => undefined)
        .then(() => this.#performIssueGrant(current)),
    ).finally(() => {
      if (current.grantIssue === task) current.grantIssue = undefined;
      if (this.#grantIssues.get(key) === task) this.#grantIssues.delete(key);
    });
    current.grantIssue = task;
    this.#grantIssues.set(key, task);
    await task;
  }

  async #performIssueGrant(current: CurrentRequest): Promise<void> {
    if (this.#requests.get(requestKey(current.computerId, current.integrationId)) !== current) return;
    if (this.#shouldSkipGrant(current)) return;
    const episodeDeadline = current.busyCheckDeadlineAt ?? this.#now() + this.#grantTtlMs;
    if (!this.#artifactIsReady(current)) return;
    if (this.#selfCheckingComputer(current.computerId)) {
      current.credentialCheckDeadlineAt = episodeDeadline;
      this.#armCredentialTimer();
    }
    const computerKind = (await this.#bindings.computerKind?.(current.computerId)) ?? "local";
    if (this.#closed || this.#requests.get(requestKey(current.computerId, current.integrationId)) !== current) return;
    const proxyMode = this.#proxyMode(current.computerId, current.instanceId);
    if (computerKind === "cloud" && !proxyMode) {
      // Cloud never falls back to raw provider material; without proxy negotiation there is no
      // safe validation path, so the credential execution stays needs_attention.
      this.#stopGrantRepair(current, "upgrade_required");
      return;
    }
    const frame = proxyMode
      ? await this.#issueProxyValidationRun(current)
      : await this.#issueLegacyValidationGrant(current);
    if (!frame) return;
    if (this.#selfCheckingComputer(current.computerId) && current.credentialCheckDeadlineAt !== episodeDeadline) return;
    await this.#sendValidationGrant(current, frame, episodeDeadline);
  }

  async #sendValidationGrant(
    current: CurrentRequest,
    frame: Omit<ProviderCliValidationRunFrame, "requestId"> | Omit<ProviderCliValidationGrantFrame, "requestId">,
    episodeDeadline: number,
  ): Promise<void> {
    const requestId = randomUUID();
    const expiresAt = this.#selfCheckingComputer(current.computerId)
      ? Math.min(Date.parse(frame.expiresAt), episodeDeadline)
      : Date.parse(frame.expiresAt);
    if (expiresAt <= this.#now()) {
      this.#failCredential(current, "provider_unreachable", true);
      return;
    }
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
    const outbound = { ...frame, requestId, expiresAt: new Date(expiresAt).toISOString() };
    this.#armCredentialTimer();
    try {
      await this.#registry.send(current.computerId, current.instanceId, outbound);
    } catch {
      current.grantConsumed = true;
      this.#scheduleGrantRetry(current, "provider_unreachable");
    }
  }

  #proxyMode(computerId: string, instanceId: string): boolean {
    return (
      this.#registry.capabilityVersion(computerId, instanceId, RUNTIME_CAPABILITY.runtimeCredential, this.#now()) ===
        1 &&
      this.#registry.capabilityVersion(computerId, instanceId, RUNTIME_CAPABILITY.providerProxy, this.#now()) === 1
    );
  }

  /** Proxy mode: the Server issues a single-use validation run; no material crosses the wire. */
  async #issueProxyValidationRun(
    current: CurrentRequest,
  ): Promise<Omit<ProviderCliValidationRunFrame, "requestId"> | undefined> {
    const issueRun = this.#bindings.issueRuntimeValidationRun;
    if (!issueRun) {
      this.#stopGrantRepair(current, "upgrade_required");
      return undefined;
    }
    const connectionId = this.#registry.currentConnectionId(current.computerId, current.instanceId);
    const run = await issueRun({
      agentId: current.agentId,
      computerId: current.computerId,
      instanceId: current.instanceId,
      ...(connectionId ? { connectionId } : {}),
      credentialGeneration: current.credentialGeneration,
      integrationId: current.integrationId,
      provider: current.provider,
    });
    if (this.#requests.get(requestKey(current.computerId, current.integrationId)) !== current) return undefined;
    if (!this.#artifactIsReady(current)) return undefined;
    if (!run) {
      this.#stopGrantRepair(current, "identity_mismatch");
      return undefined;
    }
    return {
      type: "provider-cli:validation:run",
      requirementRequestId: current.requestId,
      provider: current.provider,
      agentId: current.agentId,
      integrationId: current.integrationId,
      credentialGeneration: current.credentialGeneration,
      expectedIdentity: current.expectedIdentity,
      validationRunId: run.validationRunId,
      expiresAt: new Date(Math.min(run.expiresAt, this.#now() + this.#grantTtlMs)).toISOString(),
    };
  }

  /** Legacy Local-only path: raw material for a non-proxy connection that explicitly allows it. */
  async #issueLegacyValidationGrant(
    current: CurrentRequest,
  ): Promise<Omit<ProviderCliValidationGrantFrame, "requestId"> | undefined> {
    const material = await this.#bindings.issueIntegrationCliValidationGrant({
      agentId: current.agentId,
      computerId: current.computerId,
      installationId: current.installationId,
      credentialGeneration: current.credentialGeneration,
      integrationId: current.integrationId,
      provider: current.provider,
    });
    if (this.#requests.get(requestKey(current.computerId, current.integrationId)) !== current) return undefined;
    if (!material) return undefined;
    if (!this.#artifactIsReady(current)) return undefined;
    if (!expectedIdentitiesMatch(current.expectedIdentity, material.expectedIdentity)) {
      this.#stopGrantRepair(current, "identity_mismatch");
      return undefined;
    }
    return {
      type: "provider-cli:validation:grant",
      requirementRequestId: current.requestId,
      provider: current.provider,
      agentId: current.agentId,
      integrationId: current.integrationId,
      credentialGeneration: current.credentialGeneration,
      expectedIdentity: material.expectedIdentity,
      grant: material.grant,
      expiresAt: new Date(this.#now() + this.#grantTtlMs).toISOString(),
    };
  }

  #stopGrantRepair(current: CurrentRequest, reason: "upgrade_required" | "identity_mismatch"): void {
    current.forceCredentialCheck = false;
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
        reason,
      },
      this.#now(),
    );
  }

  #grantPending(current: CurrentRequest): boolean {
    return Boolean(current.grantRequestId && !current.grantConsumed && (current.grantExpiresAt ?? 0) > this.#now());
  }

  #shouldSkipGrant(current: CurrentRequest): boolean {
    if ((current.cooldownUntil ?? 0) > this.#now()) return true;
    if (this.#selfCheckingComputer(current.computerId) && current.forceCredentialCheck) {
      return this.#grantPending(current);
    }
    if (current.grantRepairStopped) return true;
    if (this.#grantPending(current)) return true;
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
    if (this.#selfCheckingComputer(current.computerId)) {
      this.#failCredential(current, reason);
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

  #selfCheckingComputer(computerId: string): boolean {
    const instanceId = this.#registry.currentInstanceId(computerId);
    return Boolean(
      instanceId && this.#registry.supportsCapability(computerId, instanceId, RUNTIME_CAPABILITY.selfCheckHeartbeat),
    );
  }

  async #requestSelfCheck(computerId: string, instanceId: string): Promise<void> {
    const request = this.#registry.requestSelfCheck(computerId, instanceId, this.#now());
    if (request) await this.#registry.send(computerId, instanceId, request);
  }

  #failCredential(current: CurrentRequest, reason: "rate_limited" | "provider_unreachable", timedOut = false): void {
    if (this.#requests.get(requestKey(current.computerId, current.integrationId)) !== current) return;
    current.credentialCheckDeadlineAt = undefined;
    current.busyCheckDeadlineAt = undefined;
    if (reason === "rate_limited") current.cooldownUntil = this.#now() + RUNTIME_CREDENTIAL_CHECK_INTERVAL_MS;
    current.grantConsumed = true;
    current.forceCredentialCheck = false;
    current.grantRepairStopped = true;
    // A check that could not reach the provider cannot overturn a verdict the provider already gave.
    const previous = matchObservation(
      this.#registry.providerCliCredentialReadiness(current.computerId, this.#now()),
      current.snapshot,
    );
    if (
      previous?.status === "needs_attention" &&
      previous.reason &&
      previous.reason !== "provider_unreachable" &&
      previous.reason !== "rate_limited"
    ) {
      this.#armCredentialTimer();
      return;
    }
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
        timedOut,
      },
      this.#now(),
    );
    this.#armCredentialTimer();
  }

  async #recheckCredential(current: CurrentRequest): Promise<void> {
    if (this.#closed || !this.#connectionMatches(current.computerId, current.instanceId, current.installationId))
      return;
    if (current.grantIssue || (current.cooldownUntil ?? 0) > this.#now()) {
      current.nextCredentialCheckAt = Math.max(
        this.#now() + RUNTIME_CREDENTIAL_CHECK_INTERVAL_MS,
        current.cooldownUntil ?? 0,
      );
      return;
    }
    if (current.grantRequestId && !current.grantConsumed && (current.grantExpiresAt ?? 0) > this.#now()) return;
    current.nextCredentialCheckAt = this.#now() + RUNTIME_CREDENTIAL_CHECK_INTERVAL_MS;
    current.busyCheckDeadlineAt = undefined;
    current.forceCredentialCheck = true;
    current.grantRepairStopped = false;
    current.grantRequestId = undefined;
    current.grantConsumed = false;
    current.grantRetryAttempt = 0;
    await this.#issueGrant(current);
  }

  #armCredentialTimer(): void {
    if (this.#credentialTimer) clearTimeout(this.#credentialTimer);
    this.#credentialTimer = undefined;
    if (this.#closed) return;
    const due = [...this.#requests.values()]
      .filter((current) => this.#selfCheckingComputer(current.computerId))
      .flatMap((current) => [
        current.nextCredentialCheckAt,
        ...(current.credentialCheckDeadlineAt ? [current.credentialCheckDeadlineAt] : []),
        ...(current.grantRequestId && !current.grantConsumed && current.grantExpiresAt ? [current.grantExpiresAt] : []),
      ]);
    if (!due.length) return;
    this.#credentialTimer = setTimeout(
      () => {
        this.#credentialTimer = undefined;
        if (this.#credentialPump || this.#closed) return;
        const pump = this.#track(this.#pollCredentialChecks());
        this.#credentialPump = pump;
        void pump
          .finally(() => {
            if (this.#credentialPump === pump) this.#credentialPump = undefined;
            this.#armCredentialTimer();
          })
          .catch(() => undefined);
      },
      Math.max(1, Math.min(...due) - this.#now()),
    );
    this.#credentialTimer.unref();
  }

  async #pollCredentialChecks(): Promise<void> {
    for (const current of this.#requests.values()) {
      if (!this.#selfCheckingComputer(current.computerId)) continue;
      if (current.credentialCheckDeadlineAt !== undefined && current.credentialCheckDeadlineAt <= this.#now())
        this.#failCredential(current, "provider_unreachable", true);
      if (current.grantRequestId && !current.grantConsumed && (current.grantExpiresAt ?? Infinity) <= this.#now()) {
        this.#failCredential(current, "provider_unreachable", true);
      }
      if (current.nextCredentialCheckAt <= this.#now()) {
        try {
          await this.#recheckCredential(current);
        } catch {
          this.#failCredential(current, "provider_unreachable");
        }
      }
    }
  }

  async #refreshActiveReadiness(input: { agentId?: string; computerId: string }): Promise<void> {
    if (this.#closed) return;
    const seq = new Map(this.#agentReconcileSeq);
    const instanceId = this.#registry.currentInstanceId(input.computerId);
    if (!instanceId) return;
    const installationId = this.#registry.installationId(input.computerId);
    if (!installationId) return;
    const now = this.#now();
    const requirements = (await this.#bindings.listActiveProviderCliRequirements(input.computerId)).filter(
      (requirement) => input.agentId === undefined || requirement.agentId === input.agentId,
    );
    if (!this.#connectionMatches(input.computerId, instanceId, installationId)) return;
    if (requirements.length === 0) {
      if (input.agentId) await this.#retireAgentOnComputer(input.agentId, input.computerId);
      return;
    }
    if (!this.#registry.supportsCapability(input.computerId, instanceId, RUNTIME_CAPABILITY.providerCliReconcile)) {
      return;
    }
    const artifacts = this.#registry.providerCliArtifactReadiness(input.computerId, now);
    const credentials = this.#registry.providerCliCredentialReadiness(input.computerId, now);
    for (const requirement of requirements) {
      if (!this.#agentReconcileUnchanged(input.computerId, requirement.agentId, seq)) continue;
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
    this.#preparation.reset(computerId);
    await Promise.all(
      [...this.#requests]
        .filter(([, current]) => current.computerId === computerId)
        .map(([key]) => this.#retireRequest(key)),
    );
  }

  async #retireRequest(key: string): Promise<void> {
    const current = this.#requests.get(key);
    this.#bumpTransition(key);
    if (current) this.#dropRequest(current);
    if (current) void this.#track(this.#sendCancel(current));
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
