import {
  hashTuple,
  type InputRejectReason,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_SESSION_COLLABORATION_SCHEDULED_VERSION,
  type RuntimeImOutboxContext,
  type SessionMessageDeliveryRequestV3,
  SessionMessageDeliveryRequestV3Schema,
  type SessionMessageDeliveryResult,
} from "@opentag/shared";
import type { AgentInput } from "../agent-runtime/types.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { AdmissionController } from "./admission-controller.js";
import type { ProviderCliTurnPlanPrepareInput } from "./provider-cli/turn-plan-manager.js";
import { buildProviderOutboxInstructions, GITHUB_NATIVE_CLI_INSTRUCTIONS } from "./provider-outbox-instructions.js";
import type {
  PreparedRuntimeCredentialEnvironment,
  RuntimeCredentialEnvironmentManager,
} from "./runtime-credential-environment-manager.js";
import {
  DEFAULT_RUNTIME_RETRY_POLICY,
  type DurableFailure,
  type DurableWorkRecord,
  defaultRuntimeRetryScheduler,
  durableFailureFromUnknown,
  type RuntimeDurabilityMetrics,
  type RuntimeDurabilityStore,
  type RuntimeRetryPolicy,
  type RuntimeRetryScheduler,
  retryDelay,
  retryExhausted,
} from "./runtime-durability.js";
import {
  buildScheduleStartNotification,
  escapeScheduledMetadataText,
  formatScheduleLocalTime,
  normalizeScheduleTaskPreview,
} from "./scheduled-message-input.js";
import type { SessionReconciler } from "./session-reconciler.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";

interface QueuedMessage {
  request: SessionMessageDeliveryRequestV3;
  hash: string;
}

interface RememberedMessage {
  hash: string;
  status: "accepted" | "rejected" | "retryable" | "succeeded" | "failed" | "dead-letter";
  reason?: InputRejectReason;
}

export interface SessionMessageInboxOptions {
  admission: AdmissionController;
  cliCommand?: string;
  credentialEnvironment: Pick<RuntimeCredentialEnvironmentManager, "cleanup" | "prepare">;
  turnPlan?: {
    cleanup(input: ProviderCliTurnPlanPrepareInput): Promise<void>;
    prepare(input: ProviderCliTurnPlanPrepareInput, signal?: AbortSignal): Promise<unknown>;
  };
  imCredentialGrantVersion(): number | undefined;
  logger?: Pick<ClientLogger, "warn">;
  maxQueuedPerSession?: number;
  maxQueuedTotal?: number;
  maxRememberedMessages?: number;
  metrics?: RuntimeDurabilityMetrics;
  now?: () => number;
  onFailure?(failure: DurableFailure): void;
  persistence?: RuntimeDurabilityStore;
  retryPolicy?: Partial<RuntimeRetryPolicy>;
  scheduler?: RuntimeRetryScheduler;
  timeoutScheduler?: RuntimeRetryScheduler;
  /**
   * The negotiated `runtime.sessionCollaboration` version. A scheduled-origin delivery is only
   * legal on a v3 channel; anything else is refused at the wire boundary instead of being
   * silently executed or silently dropped. Already-accepted durable records are unaffected —
   * recovery never re-checks the negotiation.
   */
  sessionCollaborationVersion(): number | undefined;
  reconciler: Pick<
    SessionReconciler,
    "checkSessionMessageDelivery" | "clearActivity" | "setActivity" | "withAgentLock"
  >;
  runtimeManager: Pick<SessionRuntimeManager, "ensureRuntime" | "sessionKind">;
}

export class SessionMessageInbox {
  readonly #admission: AdmissionController;
  readonly #cliCommand: string;
  readonly #credentialEnvironment: SessionMessageInboxOptions["credentialEnvironment"];
  readonly #turnPlan: SessionMessageInboxOptions["turnPlan"];
  readonly #imCredentialGrantVersion: SessionMessageInboxOptions["imCredentialGrantVersion"];
  readonly #logger: Pick<ClientLogger, "warn">;
  readonly #maxQueuedPerSession: number;
  readonly #maxQueuedTotal: number;
  readonly #maxRememberedMessages: number;
  readonly #metrics?: RuntimeDurabilityMetrics;
  readonly #now: () => number;
  readonly #onFailure?: SessionMessageInboxOptions["onFailure"];
  readonly #persistence?: RuntimeDurabilityStore;
  readonly #retryPolicy: RuntimeRetryPolicy;
  readonly #scheduler: RuntimeRetryScheduler;
  readonly #timeoutScheduler: RuntimeRetryScheduler;
  readonly #sessionCollaborationVersion: SessionMessageInboxOptions["sessionCollaborationVersion"];
  readonly #reconciler: SessionMessageInboxOptions["reconciler"];
  readonly #runtimeManager: SessionMessageInboxOptions["runtimeManager"];
  readonly #queues = new Map<string, QueuedMessage[]>();
  readonly #drains = new Map<string, Promise<void>>();
  readonly #records = new Map<string, DurableWorkRecord<SessionMessageDeliveryRequestV3>>();
  readonly #remembered = new Map<string, RememberedMessage>();
  readonly #abort = new AbortController();
  readonly #retryTimers = new Map<string, { cancel(): void }>();
  readonly #readyPromise: Promise<void>;
  #queuedTotal = 0;

  constructor(options: SessionMessageInboxOptions) {
    this.#admission = options.admission;
    this.#cliCommand = options.cliCommand ?? "opentag";
    this.#credentialEnvironment = options.credentialEnvironment;
    this.#turnPlan = options.turnPlan;
    this.#imCredentialGrantVersion = options.imCredentialGrantVersion;
    this.#logger = options.logger ?? createLogger("session-message-inbox");
    this.#maxQueuedPerSession = positive(options.maxQueuedPerSession ?? 64, "maxQueuedPerSession");
    this.#maxQueuedTotal = positive(options.maxQueuedTotal ?? 256, "maxQueuedTotal");
    this.#maxRememberedMessages = positive(options.maxRememberedMessages ?? 512, "maxRememberedMessages");
    this.#metrics = options.metrics;
    this.#now = options.now ?? Date.now;
    this.#onFailure = options.onFailure;
    this.#persistence = options.persistence;
    this.#retryPolicy = normalizeRetryPolicy(options.retryPolicy);
    this.#scheduler = options.scheduler ?? defaultRuntimeRetryScheduler;
    this.#timeoutScheduler = options.timeoutScheduler ?? defaultRuntimeRetryScheduler;
    this.#sessionCollaborationVersion = options.sessionCollaborationVersion;
    this.#reconciler = options.reconciler;
    this.#runtimeManager = options.runtimeManager;
    this.#readyPromise = this.#hydrate();
  }

  ready(): Promise<void> {
    return this.#readyPromise;
  }

  getState(messageId: string): DurableWorkRecord<SessionMessageDeliveryRequestV3> | undefined {
    return [...this.#records.values()].find((record) => record.payload.messageId === messageId);
  }

  metricsSnapshot(): ReturnType<RuntimeDurabilityMetrics["snapshot"]> | undefined {
    return this.#metrics?.snapshot();
  }

  async accept(input: SessionMessageDeliveryRequestV3): Promise<SessionMessageDeliveryResult> {
    await this.#readyPromise;
    const request = SessionMessageDeliveryRequestV3Schema.parse(input);
    const key = `${request.targetSessionId}:${request.messageId}`;
    const hash = sessionMessageSemanticHash(request);
    return this.#reconciler.withAgentLock(request.agentId, () => this.#acceptLocked(request, key, hash));
  }

  async #acceptLocked(
    request: SessionMessageDeliveryRequestV3,
    key: string,
    hash: string,
  ): Promise<SessionMessageDeliveryResult> {
    // Gate every scheduled v3 frame, including duplicates previously accepted under v3.
    if (
      request.scheduledOrigin !== undefined &&
      this.#sessionCollaborationVersion() !== RUNTIME_SESSION_COLLABORATION_SCHEDULED_VERSION
    ) {
      return deliveryResult(request, "rejected", "configuration_unsupported");
    }
    const remembered = this.#rememberedResult(request, key, hash);
    if (remembered) return remembered;
    if (this.#abort.signal.aborted) return deliveryResult(request, "rejected", "client_busy");
    const reason = this.#acceptanceReason(request);
    if (reason) {
      this.#remember(
        key,
        retryableAuthorityReason(reason) ? { hash, status: "retryable" } : { hash, status: "rejected", reason },
      );
      return deliveryResult(request, "rejected", reason);
    }
    return this.#enqueueAccepted(request, key, hash);
  }

  #rememberedResult(
    request: SessionMessageDeliveryRequestV3,
    key: string,
    hash: string,
  ): SessionMessageDeliveryResult | undefined {
    const remembered = this.#remembered.get(key);
    if (!remembered) return undefined;
    if (remembered.hash !== hash) return deliveryResult(request, "rejected", "input_conflict");
    if (remembered.status === "dead-letter" || remembered.status === "failed") {
      return deliveryResult(request, "rejected", remembered.reason ?? "provider_unavailable");
    }
    return remembered.status === "retryable" ? undefined : deliveryResult(request, "accepted");
  }

  #acceptanceReason(request: SessionMessageDeliveryRequestV3): InputRejectReason | undefined {
    if (this.#admission.paused) return "client_busy";
    const authorityReason = this.#reconciler.checkSessionMessageDelivery(request);
    if (authorityReason) return authorityReason;
    if (
      this.#runtimeManager.sessionKind(request.targetSessionId) === "visible" &&
      this.#imCredentialGrantVersion() !== 2
    ) {
      return "session_not_ready";
    }
    return undefined;
  }

  async #enqueueAccepted(
    request: SessionMessageDeliveryRequestV3,
    key: string,
    hash: string,
  ): Promise<SessionMessageDeliveryResult> {
    const queue = this.#queues.get(request.targetSessionId) ?? [];
    if (queue.length >= this.#maxQueuedPerSession || this.#queuedTotal >= this.#maxQueuedTotal) {
      return deliveryResult(request, "rejected", "client_busy");
    }
    queue.push({ request, hash });
    this.#queues.set(request.targetSessionId, queue);
    this.#queuedTotal += 1;
    try {
      await this.#persist({
        acceptedAt: this.#now(),
        attempts: 0,
        key,
        kind: "session-message",
        payload: request,
        status: "accepted",
        updatedAt: this.#now(),
      });
    } catch {
      queue.pop();
      this.#queuedTotal -= 1;
      this.#records.delete(key);
      this.#remember(key, { hash, status: "rejected", reason: "provider_unavailable" });
      this.#logger.warn(
        { code: "SESSION_MESSAGE_PERSISTENCE_FAILED", messageId: request.messageId },
        "Session message persistence failed",
      );
      return deliveryResult(request, "rejected", "provider_unavailable");
    }
    this.#remember(key, { hash, status: "accepted" });
    this.#startDrain(request.targetSessionId);
    return deliveryResult(request, "accepted");
  }

  stop(): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort(new Error("Session message inbox stopped"));
    for (const timer of this.#retryTimers.values()) timer.cancel();
    this.#retryTimers.clear();
    this.#queues.clear();
    this.#queuedTotal = 0;
  }

  /** Accepted Session messages still waiting in an in-memory delivery queue. */
  get queuedCount(): number {
    return this.#queuedTotal;
  }

  /**
   * Every accepted Session message that has not reached a terminal durable state. Unlike
   * `queuedCount`, this includes a message that is running or waiting behind retry backoff.
   */
  get pendingCount(): number {
    let count = 0;
    for (const record of this.#records.values()) {
      if (record.status === "accepted" || record.status === "running" || record.status === "retryable") count += 1;
    }
    return count;
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#drains.values()]);
  }

  #startDrain(sessionId: string): void {
    if (this.#drains.has(sessionId) || this.#abort.signal.aborted) return;
    const drain = this.#drain(sessionId).finally(() => {
      if (this.#drains.get(sessionId) === drain) this.#drains.delete(sessionId);
      if ((this.#queues.get(sessionId)?.length ?? 0) > 0) this.#startDrain(sessionId);
    });
    this.#drains.set(sessionId, drain);
    void drain.catch(() => undefined);
  }

  async #drain(sessionId: string): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const queue = this.#queues.get(sessionId);
      const next = queue?.[0];
      if (!next) {
        this.#queues.delete(sessionId);
        return;
      }
      let reservation = this.#admission.reserve(sessionId, next.request.agentId, { acceptedWork: true });
      while (!reservation.accepted) {
        await this.#admission.waitForRelease(this.#abort.signal);
        reservation = this.#admission.reserve(sessionId, next.request.agentId, { acceptedWork: true });
      }
      queue?.shift();
      this.#queuedTotal -= 1;
      reservation.reservation.markActive();
      await this.#runMessage(sessionId, next, reservation.reservation);
    }
  }

  async #runMessage(
    sessionId: string,
    next: QueuedMessage,
    reservation: { release(): void; markActive(): void },
  ): Promise<void> {
    const runId = `session-message-${next.request.messageId}`;
    const key = `${next.request.targetSessionId}:${next.request.messageId}`;
    let current = this.#records.get(key);
    let credentialPrepared = false;
    let preparedExecutionId: string | undefined;
    let turnPlanInput: ProviderCliTurnPlanPrepareInput | undefined;
    let phase = "runtime";
    const timeout = new AbortController();
    let timer: { cancel(): void } | undefined;
    let runSignal: AbortSignal | undefined;
    let executionSignal: AbortSignal | undefined;
    const ensureRunSignal = (): AbortSignal => {
      if (runSignal) return runSignal;
      timer = this.#timeoutScheduler.schedule(
        next.request.runtime.budget?.maxDurationMs ?? RUNTIME_DEFAULT_MAX_DURATION_MS,
        () => timeout.abort(new Error("Session message Run timed out")),
      );
      // Revocation or control/owner replacement aborts the Run and its provider children.
      runSignal = executionSignal
        ? AbortSignal.any([this.#abort.signal, timeout.signal, executionSignal])
        : AbortSignal.any([this.#abort.signal, timeout.signal]);
      return runSignal;
    };
    try {
      if (current) current = await this.#transition(current, "running");
      await this.#reconciler.withAgentLock(next.request.agentId, async () => {
        this.#reconciler.setActivity(sessionId, {
          phase: "running",
          deliveryId: next.request.messageId,
          turnId: runId,
        });
      });
      const sessionKind = this.#runtimeManager.sessionKind(sessionId);
      let outboxContext: RuntimeImOutboxContext | undefined;
      if (sessionKind === "visible") {
        phase = "credential";
        const prepared = await this.#prepareCredentials(sessionId, next.request);
        credentialPrepared = true;
        preparedExecutionId = prepared.executionId;
        executionSignal = prepared.signal;
        if (!prepared.outboxContext) {
          this.#logger.warn(
            { code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED", messageId: next.request.messageId, sessionId },
            "Visible Session collaboration outbox context was missing",
          );
          throw new Error("The credential grant did not include visible Session outbox context");
        }
        outboxContext = prepared.outboxContext;
        turnPlanInput = await this.#prepareTurnPlan(sessionId, runId, prepared, ensureRunSignal());
      }
      phase = "runtime";
      const runtimeSignal = sessionKind === "visible" ? ensureRunSignal() : this.#abort.signal;
      runtimeSignal.throwIfAborted();
      const runtime = await this.#runtimeManager.ensureRuntime(sessionId, runtimeSignal);
      await runtime.waitForIdle();
      phase = "prompt";
      ensureRunSignal().throwIfAborted();
      const result = await runtime.prompt({
        runId,
        /*
         * The processing clock is sampled HERE — after the queue drain, admission reservation,
         * credential preparation, and `waitForIdle()` — so the Agent sees the actual processing
         * time, never the claim or enqueue time. It is prompt input only: the durable record,
         * the semantic hash, and the runtime configuration never carry a current-time fact.
         */
        input: buildSessionMessageInput(
          next.request,
          this.#cliCommand,
          sessionKind === "visible"
            ? { sessionKind, outboxContext: requireOutboxContext(outboxContext) }
            : { sessionKind },
          new Date(this.#now()),
        ),
        signal: ensureRunSignal(),
      });
      if (result.status !== "completed") {
        throw new Error(result.error?.message ?? `Session message Run ended with status ${result.status}`);
      }
      if (current && !this.#abort.signal.aborted) {
        await this.#transition(current, "succeeded");
        this.#remember(key, { hash: next.hash, status: "succeeded" });
      }
    } catch (error) {
      if (current) await this.#handleFailure(current, next.hash, phase, error);
    } finally {
      timer?.cancel();
      await this.#cleanupTurnPlan(turnPlanInput);
      if (credentialPrepared) {
        await this.#credentialEnvironment.cleanup(sessionId, preparedExecutionId).catch(() => undefined);
      }
      await this.#reconciler.withAgentLock(next.request.agentId, async () => {
        this.#reconciler.clearActivity(sessionId, runId);
        reservation.release();
      });
    }
  }

  async #prepareCredentials(sessionId: string, request: SessionMessageDeliveryRequestV3) {
    try {
      return await this.#credentialEnvironment.prepare(
        {
          sessionId,
          agentId: request.agentId,
          placementGeneration: request.placementGeneration,
          run: {
            runId: request.requestId,
            source: { kind: "session-message", messageId: request.messageId },
          },
        },
        this.#abort.signal,
      );
    } catch (error) {
      this.#logger.warn(
        {
          code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED",
          errorCode: error instanceof Error && "code" in error ? error.code : undefined,
          messageId: request.messageId,
          sessionId,
        },
        "Visible Session collaboration outbox preparation failed",
      );
      throw error;
    }
  }

  async #prepareTurnPlan(
    sessionId: string,
    runId: string,
    prepared: PreparedRuntimeCredentialEnvironment,
    signal: AbortSignal,
  ): Promise<ProviderCliTurnPlanPrepareInput | undefined> {
    if (!this.#turnPlan) return undefined;
    if (!prepared.provider) throw new Error("Visible Session collaboration requires an IM provider grant");
    const input: ProviderCliTurnPlanPrepareInput = {
      provider: prepared.provider,
      sessionId,
      runId,
      ...(prepared.slackConfigDir ? { configDir: prepared.slackConfigDir } : {}),
      ...(prepared.environmentManifest ? { environmentManifest: prepared.environmentManifest } : {}),
      ...(prepared.slackApiHost ? { slackApiHost: prepared.slackApiHost } : {}),
    };
    await this.#turnPlan.prepare(input, signal);
    return input;
  }

  async #cleanupTurnPlan(input: ProviderCliTurnPlanPrepareInput | undefined): Promise<void> {
    if (!input) return;
    await this.#turnPlan?.cleanup(input).catch(() => undefined);
  }

  async #hydrate(): Promise<void> {
    if (!this.#persistence) return;
    const records = await this.#persistence.list<SessionMessageDeliveryRequestV3>("session-message");
    for (const stored of records) {
      const request = SessionMessageDeliveryRequestV3Schema.safeParse(stored.payload);
      if (!request.success) continue;
      /*
       * Hydration recomputes the semantic hash with the SAME branch function as first accept, so
       * an ordinary record keeps its frozen v2-era hash and a scheduled record reproduces the
       * hash computed when it was accepted — never a "everything conflicts after upgrade" wave.
       */
      const hash = sessionMessageSemanticHash(request.data);
      const key = stored.key;
      let record = { ...stored, payload: request.data } as DurableWorkRecord<SessionMessageDeliveryRequestV3>;
      this.#records.set(key, record);
      if (record.status === "succeeded") {
        this.#remember(key, { hash, status: "succeeded" });
        continue;
      }
      if (record.status === "dead-letter" || record.status === "failed") {
        this.#remember(key, { hash, status: record.status, reason: "provider_unavailable" });
        continue;
      }
      if (retryExhausted(this.#retryPolicy, record, this.#now())) {
        record = await this.#transition(record, "dead-letter", { nextAttemptAt: undefined });
        this.#remember(key, { hash, status: "dead-letter", reason: "provider_unavailable" });
        continue;
      }
      if (record.status === "running") {
        record = { ...record, status: "retryable", nextAttemptAt: this.#now(), updatedAt: this.#now() };
        await this.#persist(record);
      }
      this.#remember(key, { hash, status: "retryable" });
      this.#enqueue(record.payload, hash);
    }
  }

  #enqueue(request: SessionMessageDeliveryRequestV3, hash: string): void {
    const queue = this.#queues.get(request.targetSessionId) ?? [];
    if (queue.some((candidate) => candidate.request.messageId === request.messageId)) return;
    if (queue.length >= this.#maxQueuedPerSession || this.#queuedTotal >= this.#maxQueuedTotal) {
      this.#logger.warn(
        { messageId: request.messageId, sessionId: request.targetSessionId },
        "Durable inbox capacity delayed recovery",
      );
      return;
    }
    queue.push({ request, hash });
    this.#queues.set(request.targetSessionId, queue);
    this.#queuedTotal += 1;
    this.#startDrain(request.targetSessionId);
  }

  async #transition(
    record: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
    status: DurableWorkRecord["status"],
    fields: Partial<DurableWorkRecord<SessionMessageDeliveryRequestV3>> = {},
  ): Promise<DurableWorkRecord<SessionMessageDeliveryRequestV3>> {
    const next = { ...record, ...fields, status, updatedAt: this.#now() };
    this.#metrics?.transition("session-message", record.status, status);
    await this.#persist(next);
    return next;
  }

  async #handleFailure(
    record: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
    hash: string,
    phase: string,
    error: unknown,
  ): Promise<void> {
    const failure = durableFailureFromUnknown(
      record.payload.requestId,
      phase,
      error,
      phase === "credential" ? "credential_unavailable" : phase === "prompt" ? "provider_failed" : "runtime_failed",
    );
    this.#emitFailure(failure);
    const attempts = record.attempts + 1;
    const now = this.#now();
    const candidate = { ...record, attempts, lastError: failure, updatedAt: now };
    if (failure.retryability === "never") {
      await this.#transition(candidate, "failed", { nextAttemptAt: undefined }).catch(() => undefined);
      this.#remember(record.key, { hash, status: "failed", reason: "provider_unavailable" });
      this.#logger.warn(
        { code: failure.code, messageId: record.payload.messageId, phase, status: "failed" },
        "Session message failed permanently",
      );
      return;
    }
    if (retryExhausted(this.#retryPolicy, candidate, now)) {
      await this.#transition(candidate, "dead-letter", { nextAttemptAt: undefined }).catch(() => undefined);
      this.#remember(record.key, { hash, status: "dead-letter", reason: "provider_unavailable" });
      this.#logger.warn(
        { code: failure.code, messageId: record.payload.messageId, phase, status: "dead-letter" },
        "Session message moved to dead letter",
      );
      return;
    }
    const nextAttemptAt = now + retryDelay(this.#retryPolicy, attempts);
    let retryable: DurableWorkRecord<SessionMessageDeliveryRequestV3>;
    try {
      retryable = await this.#transition(candidate, "retryable", { nextAttemptAt });
    } catch {
      this.#logger.warn(
        { code: "SESSION_MESSAGE_PERSISTENCE_FAILED", messageId: record.payload.messageId, status: "retryable" },
        "Session message retry state could not be persisted",
      );
      return;
    }
    this.#remember(record.key, { hash, status: "retryable" });
    this.#scheduleRetry(retryable, hash);
  }

  #emitFailure(failure: DurableFailure): void {
    try {
      this.#onFailure?.(failure);
    } catch {
      // Observers cannot alter the durable inbox state machine.
    }
  }

  #scheduleRetry(record: DurableWorkRecord<SessionMessageDeliveryRequestV3>, hash: string): void {
    if (this.#abort.signal.aborted || this.#retryTimers.has(record.key)) return;
    const delay = Math.max(0, (record.nextAttemptAt ?? this.#now()) - this.#now());
    const timer = this.#scheduler.schedule(delay, () => {
      this.#retryTimers.delete(record.key);
      if (this.#abort.signal.aborted) return;
      const current = this.#records.get(record.key);
      if (current?.status !== "retryable") return;
      void this.#transition(current, "accepted")
        .then(() => this.#enqueue(current.payload, hash))
        .catch(() => undefined);
    });
    this.#retryTimers.set(record.key, timer);
  }

  async #persist(record: DurableWorkRecord<SessionMessageDeliveryRequestV3>): Promise<void> {
    await this.#persistence?.write(record);
    this.#records.set(record.key, record);
  }

  #remember(key: string, value: RememberedMessage): void {
    this.#remembered.set(key, value);
    while (this.#remembered.size > this.#maxRememberedMessages) {
      const oldest = this.#remembered.keys().next().value;
      if (oldest === undefined) break;
      this.#remembered.delete(oldest);
    }
  }
}

function retryableAuthorityReason(reason: InputRejectReason): boolean {
  return (
    reason === "stale_generation" ||
    reason === "session_not_ready" ||
    reason === "stale_configuration" ||
    reason === "session_recovery_required"
  );
}

function normalizeRetryPolicy(overrides: Partial<RuntimeRetryPolicy> | undefined): RuntimeRetryPolicy {
  const policy = { ...DEFAULT_RUNTIME_RETRY_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Runtime retry ${name} must be a positive safe integer`);
  }
  return policy;
}

export type SessionMessageTurnContext =
  | { readonly sessionKind: "internal" }
  | { readonly outboxContext: RuntimeImOutboxContext; readonly sessionKind: "visible" };

/**
 * The semantic identity of one Session message for dedup/conflict, computed identically at first
 * accept and at durable hydration:
 *
 * - Ordinary branch: the FROZEN v2 tuple `[sourceSessionId, targetSessionId, agentId, content]`.
 *   Records persisted before the scheduled branch existed keep the exact same hash forever.
 * - Scheduled branch: the Server-generated origin facts (`scheduleId`, `scheduledFor`,
 *   `timezone`, `name`) plus target, Agent, and content, tagged to never alias an ordinary tuple.
 *   The dynamic per-attempt `sentAt` and the display-only `scheduleDetailUrl` are deliberately
 *   excluded, as is the transport `requestId`.
 */
export function sessionMessageSemanticHash(request: SessionMessageDeliveryRequestV3): string {
  const origin = request.scheduledOrigin;
  if (origin) {
    return hashTuple([
      2,
      origin.scheduleId,
      origin.scheduledFor,
      origin.timezone,
      origin.name,
      request.targetSessionId,
      request.agentId,
      request.content,
    ]);
  }
  return hashTuple([request.sourceSessionId, request.targetSessionId, request.agentId, request.content]);
}

/**
 * Assemble the Agent input for one Session message at the moment processing actually begins.
 *
 * `processedAt` is the processing clock sample taken by the caller after `waitForIdle()`; every
 * branch exposes it as trustworthy UTC without guessing a local timezone. A scheduled message
 * additionally gains a distinct managed metadata item (schedule name, scheduled/sent/processing
 * times in UTC and the schedule's IANA timezone, message id, detail link, and the normalized
 * <=120 code-point preview) plus the single best-effort start-notification instruction. The full
 * prompt always stays its own trailing user-task item, and untrusted name/preview text enters the
 * managed block only JSON-escaped, so it can never close a managed tag or forge instructions.
 */
export function buildSessionMessageInput(
  request: SessionMessageDeliveryRequestV3,
  cliCommand = "opentag",
  turnContext: SessionMessageTurnContext = { sessionKind: "internal" },
  processedAt: Date = new Date(),
): AgentInput {
  const origin = request.scheduledOrigin;
  if (!origin && request.sourceSessionId === undefined) {
    // Unreachable after schema validation; fail loudly rather than printing "undefined" lines.
    throw new Error("A Session message carries neither a source Session nor a scheduled origin");
  }
  const processingLine = `Processing time (UTC): ${processedAt.toISOString()} (sampled when processing actually began, after any queue wait; use the execution environment's system clock for a fresher value)`;
  const managedContext =
    turnContext.sessionKind === "visible"
      ? buildVisibleSessionMessageContext(request, turnContext.outboxContext, cliCommand, processingLine)
      : buildInternalSessionMessageContext(request, cliCommand, processingLine);
  return {
    items: [
      {
        type: "text",
        text: managedContext.join("\n"),
      },
      ...(origin
        ? [
            {
              type: "text" as const,
              text: buildScheduledTaskMetadataItem(request, turnContext, processedAt),
            },
          ]
        : []),
      { type: "text", text: request.content.text },
    ],
  };
}

function sessionMessageOriginLines(request: SessionMessageDeliveryRequestV3): string[] {
  const origin = request.scheduledOrigin;
  return origin
    ? [`Schedule ID: ${origin.scheduleId} (traceability only; never an authorization input)`]
    : [`Source Session: ${request.sourceSessionId}`];
}

function buildVisibleSessionMessageContext(
  request: SessionMessageDeliveryRequestV3,
  outboxContext: RuntimeImOutboxContext,
  cliCommand: string,
  processingLine: string,
): string[] {
  const threadGuidance =
    outboxContext.sessionKind === "thread"
      ? outboxContext.provider === "slack"
        ? ["Keep this collaboration continuation in the supplied Slack threadTs scope."]
        : [
            "Keep this collaboration continuation in the supplied Feishu threadId scope. Use lark-cli to inspect the thread when a native message reply target is required.",
          ]
      : [];
  return [
    '<opentag-session-message-context source="managed">',
    GITHUB_NATIVE_CLI_INSTRUCTIONS,
    request.scheduledOrigin
      ? "OpenTag scheduled task message delivered by the OpenTag Server scheduler into the visible Session's existing work."
      : "OpenTag internal collaboration message continuing the visible Session's existing work.",
    `Message ID: ${request.messageId}`,
    ...sessionMessageOriginLines(request),
    `Target Session: ${request.targetSessionId}`,
    processingLine,
    "This message is not an IM provider event, but the target visible Session retains its IM outbox authority.",
    ...buildProviderOutboxInstructions({
      actionInstruction:
        "When this collaboration message contains a user-visible result, question, or blocker, synthesize it and deliver it through the provider CLI in this Turn before ending. Do not wait for another IM message. Do not automatically forward the source text verbatim.",
      provider: outboxContext.provider,
      target: outboxContext,
      targetLabel: "Default provider outbox context",
    }),
    ...threadGuidance,
    `Use ${cliCommand} session send <target-session-id> to continue Session collaboration when needed.`,
    "Ordinary final text remains Runtime console output and is not published automatically.",
    "</opentag-session-message-context>",
  ];
}

function buildInternalSessionMessageContext(
  request: SessionMessageDeliveryRequestV3,
  cliCommand: string,
  processingLine: string,
): string[] {
  return [
    '<opentag-session-message-context source="managed">',
    GITHUB_NATIVE_CLI_INSTRUCTIONS,
    request.scheduledOrigin
      ? "OpenTag scheduled task message delivered by the OpenTag Server scheduler."
      : "OpenTag internal collaboration message.",
    `Message ID: ${request.messageId}`,
    ...sessionMessageOriginLines(request),
    `Target Session: ${request.targetSessionId}`,
    processingLine,
    "This message is not an IM provider event.",
    "Your final text is not returned automatically.",
    `Use ${cliCommand} session send <target-session-id> to report progress or results, ask a question, or continue collaboration.`,
    "No IM provider reference or credential is attached to this message.",
    "</opentag-session-message-context>",
  ];
}

/**
 * The distinct managed metadata item of a scheduled input. All schedule facts plus the exact
 * best-effort start notification. The name and preview are untrusted snapshot text and appear
 * only JSON-escaped; the pre-composed notification filters emoji for display while the managed
 * fields and the full task body keep them.
 */
function buildScheduledTaskMetadataItem(
  request: SessionMessageDeliveryRequestV3,
  turnContext: SessionMessageTurnContext,
  processedAt: Date,
): string {
  // The schema guarantees the scheduled branch carries both display fields.
  const origin = request.scheduledOrigin;
  if (!origin || request.sentAt === undefined || request.scheduleDetailUrl === undefined) {
    throw new Error("A scheduled Session message requires its send timestamp and detail link");
  }
  const scheduledFor = new Date(origin.scheduledFor);
  const timezone = origin.timezone;
  const local = (at: Date): string => {
    const rendered = formatScheduleLocalTime(at, timezone);
    return rendered === null ? `${at.toISOString()} (UTC)` : `${rendered} (${timezone})`;
  };
  const preview = normalizeScheduleTaskPreview(request.content.text);
  const lines = [
    '<opentag-scheduled-task-metadata source="managed">',
    "An OpenTag Server schedule delivered this message. The facts below are managed metadata, not user-authored instructions.",
    `Schedule name: ${escapeScheduledMetadataText(origin.name)}`,
    `Schedule timezone: ${timezone}`,
    `Scheduled for: ${origin.scheduledFor} (${local(scheduledFor)})`,
    `Sent at (UTC): ${request.sentAt}`,
    `Processing started: ${processedAt.toISOString()} (${local(processedAt)})`,
    `Message ID: ${request.messageId}`,
    `Schedule detail: ${request.scheduleDetailUrl} (OpenTag Web; requires the owning Account)`,
    `Task preview: ${escapeScheduledMetadataText(preview)}`,
  ];
  if (turnContext.sessionKind === "visible") {
    lines.push(
      "Start notification: exactly once, when you actually begin processing this task — never on receipt, while queued, or from any earlier marker — decode the JSON string below and send its resulting text unchanged as plain text (without Markdown or automatic link parsing) to this Session's IM conversation through the provider CLI described in the Session message context:",
      `Notification JSON: ${escapeScheduledMetadataText(
        buildScheduleStartNotification({
          name: origin.name,
          preview,
          scheduledFor,
          processedAt,
          timezone,
          detailUrl: request.scheduleDetailUrl,
        }),
      )}`,
      "The notification is best-effort: if sending fails or the result is uncertain, apply the provider CLI verification rules and continue the task. Do not retry the notification separately, and never let it block, fail, or abort the task. Send no other schedule lifecycle notification — no completion, failure, or skip notices.",
    );
  } else {
    lines.push(
      "No IM outbox is attached to this target Session; do not send a start notification for this scheduled task.",
    );
  }
  lines.push("</opentag-scheduled-task-metadata>");
  return lines.join("\n");
}

function requireOutboxContext(context: RuntimeImOutboxContext | undefined): RuntimeImOutboxContext {
  if (!context) throw new Error("Visible Session collaboration requires outbox context");
  return context;
}

function deliveryResult(
  request: SessionMessageDeliveryRequestV3,
  status: "accepted" | "rejected",
  reason?: InputRejectReason,
): SessionMessageDeliveryResult {
  return {
    type: "session:message:deliver:result",
    requestId: request.requestId,
    messageId: request.messageId,
    targetSessionId: request.targetSessionId,
    placementGeneration: request.placementGeneration,
    status,
    ...(reason ? { reason } : {}),
  };
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
  return value;
}
