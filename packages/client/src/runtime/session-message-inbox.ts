import {
  hashTuple,
  type InputRejectReason,
  RUNTIME_SESSION_COLLABORATION_SCHEDULED_VERSION,
  type RuntimeImOutboxContext,
  type SessionMessageDeliveryRequestV3,
  SessionMessageDeliveryRequestV3Schema,
  type SessionMessageDeliveryResult,
  SessionMessageRunOutcomeReasonSchema,
} from "@opentag/shared";
import type { AgentInput, AgentRuntime, AgentSteerOutcome, AgentSteerReceipt } from "../agent-runtime/types.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { AdmissionController } from "./admission-controller.js";
import {
  beginChannelTurn,
  type ChannelActivityStore,
  endChannelTurn,
  isChannelOutbox,
} from "./channel-idle-compaction.js";
import { ImCredentialEnvironmentError } from "./im-credential-environment-manager.js";
import {
  buildContinuationNotice,
  type Interruption,
  type InterruptionReason,
  nextRetry,
  RATE_LIMIT_RETRY_DELAY_MS,
  type RetryCount,
  recoverableFailure,
  sessionMessageKey,
  trackRunTime,
} from "./interruption-retry.js";
import type { ProviderCliTurnPlanPrepareInput } from "./provider-cli/turn-plan-manager.js";
import { providerLaunchConfiguration } from "./provider-launch-configuration.js";
import { buildProviderOutboxInstructions } from "./provider-outbox-instructions.js";
import type {
  PreparedRuntimeCredentialEnvironment,
  RuntimeCredentialEnvironmentManager,
} from "./runtime-credential-environment-manager.js";
import {
  type DurableFailure,
  type DurableWorkRecord,
  defaultRuntimeRetryScheduler,
  durableFailureFromUnknown,
  type RuntimeDurabilityMetrics,
  type RuntimeDurabilityStore,
  type RuntimeRetryScheduler,
} from "./runtime-durability.js";
import {
  escapeScheduledMetadataText,
  formatScheduleLocalTime,
  normalizeScheduleTaskPreview,
} from "./scheduled-message-input.js";
import type { SessionReconciler } from "./session-reconciler.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";
import { remainingBudgetMs } from "./turn-timeout.js";

interface QueuedMessage {
  request: SessionMessageDeliveryRequestV3;
  hash: string;
}

interface RememberedMessage {
  hash: string;
  status: "accepted" | "rejected" | "retryable" | "succeeded" | "failed" | "dead-letter";
  reason?: InputRejectReason;
}

/**
 * The owner of the Runs a Session message can be steered into. A message it accepts is carried by
 * that Run's in-place retry and settled through `SessionMessageInbox.settleJoined`.
 */
export interface JoinableRuns {
  /** Hold the message's place in the Run; false leaves it queued. */
  reserve(message: SessionMessageDeliveryRequestV3, runId: string): boolean;
  release(message: SessionMessageDeliveryRequestV3, runId: string): void;
  steered(message: SessionMessageDeliveryRequestV3, runId: string, receipt: AgentSteerReceipt): void;
}

export interface SessionMessageInboxOptions {
  admission: AdmissionController;
  /** Without one, Channel Sessions never compact on idle. */
  channelActivity?: Pick<ChannelActivityStore, "beginTurn" | "recordActivity">;
  cliCommand?: string;
  credentialEnvironment: Pick<RuntimeCredentialEnvironmentManager, "cleanup" | "prepare"> &
    Partial<Pick<RuntimeCredentialEnvironmentManager, "mode" | "outboxContextForSession">>;
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
  /**
   * Called when a message's Run reaches a terminal non-completed state (timeout, permanent
   * failure, or exhausted retries). The Server uses the report to notify an internal Session's
   * creator; it ignores reports for visible Sessions. The terminal inbox record carries a
   * `pending` outcome-report marker until this resolves, so it must resolve only once the report
   * is durable and reject otherwise; hydration calls it again for a still-pending record, so it
   * must be idempotent per message.
   */
  onRunOutcome?(outcome: SessionMessageRunOutcomeEvent): void | Promise<void>;
  persistence?: RuntimeDurabilityStore;
  /** Delay before the automatic retry of a rate-limited Run. */
  rateLimitRetryDelayMs?: number;
  scheduler?: RuntimeRetryScheduler;
  timeoutScheduler?: RuntimeRetryScheduler;
  /**
   * The negotiated `runtime.sessionCollaboration` version. A scheduled-origin delivery is only
   * legal on a v3-or-newer channel; anything else is refused at the wire boundary instead of being
   * silently executed or silently dropped. Already-accepted durable records are unaffected —
   * recovery never re-checks the negotiation.
   */
  sessionCollaborationVersion(): number | undefined;
  reconciler: Pick<
    SessionReconciler,
    "checkSessionMessageDelivery" | "clearActivity" | "setActivity" | "withAgentLock"
  >;
  runtimeManager: Pick<SessionRuntimeManager, "ensureRuntime" | "sessionKind"> &
    Partial<Pick<SessionRuntimeManager, "isPrepared" | "runtime">>;
  /** How often a message waiting behind a busy Session re-checks whether it can steer into the running Turn. */
  steerRetryMs?: number;
  /** Without one, a steered message follows its steer receipt alone. */
  joinableRuns?: JoinableRuns;
}

export interface SessionMessageRunOutcomeEvent {
  messageId: string;
  targetSessionId: string;
  agentId: string;
  placementGeneration: number;
  outcome: "timed_out" | "failed";
  reason: string;
}

/** The stable code a Run outcome report carries for a timed-out Session message. */
export const SESSION_MESSAGE_TURN_TIMEOUT_CODE = "turn_timeout";

export class SessionMessageInbox {
  readonly #admission: AdmissionController;
  readonly #channelActivity: SessionMessageInboxOptions["channelActivity"];
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
  readonly #onRunOutcome?: SessionMessageInboxOptions["onRunOutcome"];
  readonly #persistence?: RuntimeDurabilityStore;
  readonly #rateLimitRetryDelayMs: number;
  readonly #scheduler: RuntimeRetryScheduler;
  readonly #timeoutScheduler: RuntimeRetryScheduler;
  readonly #sessionCollaborationVersion: SessionMessageInboxOptions["sessionCollaborationVersion"];
  readonly #reconciler: SessionMessageInboxOptions["reconciler"];
  readonly #runtimeManager: SessionMessageInboxOptions["runtimeManager"];
  readonly #steerRetryMs: number;
  readonly #joinableRuns: JoinableRuns | undefined;
  /** Joined messages whose Turn ran out of retries; each keeps its queue place until its failure commits. */
  readonly #failingJoined = new Set<string>();
  /** Messages in a joinable Run: how to settle each one when that Run ends. */
  readonly #joined = new Map<string, (outcome: AgentSteerOutcome) => Promise<void>>();
  readonly #queues = new Map<string, QueuedMessage[]>();
  readonly #drains = new Map<string, Promise<void>>();
  /** Sessions whose queued messages wait for the Server to prepare them (e.g. after a restart). */
  readonly #awaitingPreparation = new Set<string>();
  readonly #records = new Map<string, DurableWorkRecord<SessionMessageDeliveryRequestV3>>();
  readonly #remembered = new Map<string, RememberedMessage>();
  readonly #abort = new AbortController();
  readonly #retryTimers = new Map<string, { cancel(): void }>();
  /** Steered messages waiting for the Run they joined to settle. */
  readonly #steerSettlements = new Set<Promise<void>>();
  readonly #readyPromise: Promise<void>;
  #queuedTotal = 0;

  constructor(options: SessionMessageInboxOptions) {
    this.#admission = options.admission;
    this.#channelActivity = options.channelActivity;
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
    this.#onRunOutcome = options.onRunOutcome;
    this.#persistence = options.persistence;
    this.#rateLimitRetryDelayMs = options.rateLimitRetryDelayMs ?? RATE_LIMIT_RETRY_DELAY_MS;
    this.#scheduler = options.scheduler ?? defaultRuntimeRetryScheduler;
    this.#timeoutScheduler = options.timeoutScheduler ?? defaultRuntimeRetryScheduler;
    this.#sessionCollaborationVersion = options.sessionCollaborationVersion;
    this.#reconciler = options.reconciler;
    this.#runtimeManager = options.runtimeManager;
    this.#steerRetryMs = positive(options.steerRetryMs ?? 1_000, "steerRetryMs");
    this.#joinableRuns = options.joinableRuns;
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
      (this.#sessionCollaborationVersion() ?? 0) < RUNTIME_SESSION_COLLABORATION_SCHEDULED_VERSION
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
        retryableRejection(reason) ? { hash, status: "retryable" } : { hash, status: "rejected", reason },
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
    if (remembered.status === "rejected" || remembered.status === "dead-letter" || remembered.status === "failed") {
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
    await Promise.allSettled([...this.#drains.values(), ...this.#steerSettlements]);
  }

  /**
   * Sessions with accepted messages that cannot run until the Server prepares the Session, with
   * the identity a `session:recover` request needs.
   */
  sessionsAwaitingPreparation(): Array<{ sessionId: string; agentId: string; placementGeneration: number }> {
    const sessions: Array<{ sessionId: string; agentId: string; placementGeneration: number }> = [];
    for (const sessionId of this.#awaitingPreparation) {
      const next = this.#queues.get(sessionId)?.[0];
      if (next)
        sessions.push({
          sessionId,
          agentId: next.request.agentId,
          placementGeneration: next.request.placementGeneration,
        });
    }
    return sessions;
  }

  /** The Session was prepared: its waiting messages may run now. */
  sessionPrepared(sessionId: string): void {
    if (!this.#awaitingPreparation.delete(sessionId)) return;
    this.#startDrain(sessionId);
  }

  /**
   * The Server refused to prepare the Session (for example it ended): every message waiting for it
   * fails terminally with `reason`, and its creator is notified as for any failed Run.
   */
  async failAwaitingPreparation(sessionId: string, reason: string): Promise<void> {
    if (!this.#awaitingPreparation.delete(sessionId)) return;
    const queue = this.#queues.get(sessionId) ?? [];
    this.#queues.delete(sessionId);
    this.#queuedTotal -= queue.length;
    for (const next of queue) {
      const record = this.#records.get(`${next.request.targetSessionId}:${next.request.messageId}`);
      if (!record) continue;
      await this.#failTerminally(record, next.hash, "runtime", {
        code: reason,
        category: "unavailable",
        retryability: "never",
        phase: "transport",
        requestId: record.payload.requestId,
        message: "The Session could not be prepared for this message",
      });
    }
  }

  #startDrain(sessionId: string): void {
    if (this.#drains.has(sessionId) || this.#abort.signal.aborted || this.#awaitingPreparation.has(sessionId)) return;
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
      if (await this.#holdFailingJoined(next)) continue;
      // Waiting for the Server to prepare the Session is not a failure: after a restart nothing has
      // prepared it yet. The message runs once a ready reconcile arrives.
      if (this.#runtimeManager.isPrepared && !this.#runtimeManager.isPrepared(sessionId)) {
        this.#awaitingPreparation.add(sessionId);
        return;
      }
      let reservation = this.#admission.reserve(sessionId, next.request.agentId, { acceptedWork: true });
      while (!reservation.accepted) {
        // A busy Session usually has a running Turn: the message joins it instead of waiting for it to end.
        if (await this.#steerIntoRunningTurn(sessionId, next)) break;
        await this.#waitForReleaseOrSteerRetry();
        reservation = this.#admission.reserve(sessionId, next.request.agentId, { acceptedWork: true });
      }
      queue?.shift();
      this.#queuedTotal -= 1;
      if (!reservation.accepted) continue;
      reservation.reservation.markActive();
      await this.#runMessage(sessionId, next, reservation.reservation);
    }
  }

  async #waitForReleaseOrSteerRetry(): Promise<void> {
    const retry = new AbortController();
    const timer = this.#timeoutScheduler.schedule(this.#steerRetryMs, () => retry.abort());
    try {
      await this.#admission.waitForRelease(AbortSignal.any([this.#abort.signal, retry.signal]));
    } catch (error) {
      if (this.#abort.signal.aborted) throw error;
    } finally {
      timer.cancel();
    }
  }

  /**
   * Steers an accepted message into the Session's running Turn when its runtime accepts input
   * mid-Turn. The running Turn already holds the Session's credentials and IM outbox target; any
   * refusal leaves the message queued as before. An accepted steer is not yet a delivery: the record
   * stays `running` until the joined Run settles and the runtime reports what became of the input.
   */
  async #steerIntoRunningTurn(sessionId: string, next: QueuedMessage): Promise<boolean> {
    const target = this.#steerTarget(sessionId);
    if (!target) return false;
    const { runId } = target;
    if (this.#joinableRuns && !this.#joinableRuns.reserve(next.request, runId)) return false;
    const key = sessionMessageKey(next.request);
    let record = this.#records.get(key);
    let receipt: AgentSteerReceipt;
    try {
      receipt = await target.runtime.steer({
        expectedRunId: runId,
        // A message redelivered after an interruption says so: the Agent may have handled it already.
        input: withContinuation(
          buildSessionMessageInput(next.request, this.#cliCommand, target.turnContext, new Date(this.#now())),
          record?.interruption,
        ),
      });
    } catch {
      this.#joinableRuns?.release(next.request, runId);
      return false;
    }
    if (record) record = await this.#recordSteered(record, runId);
    this.#remember(key, { hash: next.hash, status: "accepted" });
    if (this.#joinableRuns) {
      if (record) this.#joinRun(record, next.hash);
      this.#joinableRuns.steered(next.request, runId, receipt);
    } else if (record) {
      this.#trackSteered(record, next.hash, receipt.outcome);
    }
    return true;
  }

  #trackMessageRunTime(key: string): { finish(): Promise<number> } {
    return trackRunTime(this.#now, async (ranMs) => {
      const record = this.#records.get(key);
      if (record) await this.#persist(withRunTime(record, ranMs));
    });
  }

  /** The Session's running Run, when its runtime can take input now and its target is known. */
  #steerTarget(
    sessionId: string,
  ): { runtime: AgentRuntime; runId: string; turnContext: SessionMessageTurnContext } | undefined {
    const lookup = this.#runtimeManager.runtime;
    if (!lookup) return undefined;
    let runtime: AgentRuntime;
    try {
      runtime = lookup.call(this.#runtimeManager, sessionId);
    } catch {
      return undefined;
    }
    const runId = runtime.state.activeRunId;
    if (runtime.capabilities.steer !== "supported" || runtime.state.phase !== "running" || !runId) return undefined;
    const turnContext = this.#liveTurnContext(sessionId);
    return turnContext ? { runtime, runId, turnContext } : undefined;
  }

  async #recordSteered(
    record: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
    runId: string,
  ): Promise<DurableWorkRecord<SessionMessageDeliveryRequestV3>> {
    try {
      // A restart before the joined Run settles recovers a `running` record like any interrupted Run.
      // It shares the Run's retry count from here; if that Run ends first it runs on its own, afresh.
      return await this.#transition(record, "running", {
        attempts: 0,
        interruption: undefined,
        joinedRunId: runId,
        retryRanMs: undefined,
      });
    } catch {
      // The record stays `accepted` on disk, so a restart redelivers it; this process still settles it.
      this.#logger.warn(
        { code: "SESSION_MESSAGE_STEER_PERSISTENCE_FAILED", messageId: record.payload.messageId },
        "Steered Session message custody could not be recorded",
      );
      return record;
    }
  }

  /** What the Session's live execution needs to name this message's target, if it can. */
  #liveTurnContext(sessionId: string): SessionMessageTurnContext | undefined {
    if (this.#runtimeManager.sessionKind(sessionId) !== "visible") return { sessionKind: "internal" };
    const outboxContext = this.#credentialEnvironment.outboxContextForSession?.(sessionId);
    return outboxContext ? { sessionKind: "visible", outboxContext } : undefined;
  }

  /** The message's input inside an in-place retry of the Run it joined. */
  joinedRunInput(message: SessionMessageDeliveryRequestV3, processedAt: Date): AgentInput {
    const turnContext = this.#liveTurnContext(message.targetSessionId);
    if (!turnContext) throw new Error("The retried Run has no outbox context for its Session message");
    return buildSessionMessageInput(message, this.#cliCommand, turnContext, processedAt);
  }

  /**
   * A Turn's retries ran out at startup: the messages steered into it share its count, so they fail with
   * it instead of running again. One whose failure cannot be written yet stays queued and is not run: the
   * drain keeps trying before anything else. Never waits for that, so a full disk cannot hold up startup.
   */
  async failJoinedRun(runId: string): Promise<void> {
    for (const record of [...this.#records.values()]) {
      if (record.joinedRunId !== runId || record.status !== "retryable") continue;
      if (await this.#settleJoinedFailure(record.key)) continue;
      this.#failingJoined.add(record.key);
      // Not waiting for the Session to be prepared: nothing about failing it needs the Session.
      this.#awaitingPreparation.delete(record.payload.targetSessionId);
      this.#startDrain(record.payload.targetSessionId);
    }
  }

  /** A joined message whose Turn ran out of retries never runs: it waits here for its failure to commit. */
  async #holdFailingJoined(next: QueuedMessage): Promise<boolean> {
    const key = sessionMessageKey(next.request);
    if (!this.#failingJoined.has(key)) return false;
    if (!(await this.#settleJoinedFailure(key))) await this.#waitForReleaseOrSteerRetry();
    return true;
  }

  /** True once the message's failure is durable and reported, and only then is it out of the queue. */
  async #settleJoinedFailure(key: string): Promise<boolean> {
    const record = this.#records.get(key);
    if (!record) return true;
    const messageId = record.payload.messageId;
    const failure = interruptedFailure(record.payload.requestId, "daemon_crash");
    const terminal = await this.#transition(
      { ...record, attempts: record.attempts + 1, lastError: failure, updatedAt: this.#now() },
      "failed",
      { nextAttemptAt: undefined, ...this.#pendingOutcomeReport() },
    ).catch(() => undefined);
    if (!terminal) {
      this.#logger.warn(
        { code: "SESSION_MESSAGE_PERSISTENCE_FAILED", messageId, status: "failed" },
        "Session message failure could not be recorded; it stays queued and is not run",
      );
      return false;
    }
    this.#failingJoined.delete(key);
    const sessionId = record.payload.targetSessionId;
    const queue = (this.#queues.get(sessionId) ?? []).filter((queued) => queued.request.messageId !== messageId);
    this.#queuedTotal -= (this.#queues.get(sessionId)?.length ?? 0) - queue.length;
    if (queue.length > 0) this.#queues.set(sessionId, queue);
    else this.#queues.delete(sessionId);
    this.#remember(key, {
      hash: sessionMessageSemanticHash(record.payload),
      status: "failed",
      reason: "provider_unavailable",
    });
    await this.#publishRunOutcome(terminal, "failed", failure.code);
    return true;
  }

  /** The Run this message joined ended; resolves once the message's outcome is durable. */
  settleJoined(message: SessionMessageDeliveryRequestV3, outcome: AgentSteerOutcome): Promise<void> {
    const key = sessionMessageKey(message);
    const settle = this.#joined.get(key);
    this.#joined.delete(key);
    return settle?.(outcome) ?? Promise.resolve();
  }

  #joinRun(record: DurableWorkRecord<SessionMessageDeliveryRequestV3>, hash: string): void {
    let resolve!: (outcome: AgentSteerOutcome) => void;
    const outcome = new Promise<AgentSteerOutcome>((done) => {
      resolve = done;
    });
    const settlement = this.#trackSteered(record, hash, outcome);
    this.#joined.set(record.key, (settled) => {
      resolve(settled);
      return settlement;
    });
  }

  #trackSteered(
    record: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
    hash: string,
    steerOutcome: Promise<AgentSteerOutcome>,
  ): Promise<void> {
    const settlement = untilAborted(steerOutcome, this.#abort.signal)
      // Once stopped, the `running` record is recovered on the next start instead.
      .then((outcome) => (outcome ? this.#settleSteered(record, hash, outcome) : undefined))
      .finally(() => this.#steerSettlements.delete(settlement));
    this.#steerSettlements.add(settlement);
    return settlement;
  }

  /**
   * Resolves a steered message once its joined Run settled:
   * - `processed`: delivered.
   * - `not_started`: the provider never began it, so it returns to the FIFO and is delivered again.
   * - `interrupted`: the Run it joined ended without completing and has no further in-place retry to
   *   carry it, so it fails permanently.
   */
  async #settleSteered(
    joined: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
    hash: string,
    outcome: AgentSteerOutcome,
  ): Promise<void> {
    // A retry that carried the message spent its attempt on the record since it joined.
    const record = this.#records.get(joined.key) ?? joined;
    const messageId = record.payload.messageId;
    if (outcome === "interrupted") {
      await this.#handleFailure(record, hash, "prompt", steerInterruptedFailure(record.payload.requestId));
      return;
    }
    const status = outcome === "processed" ? "succeeded" : "accepted";
    let next = record;
    try {
      next = await this.#transition(record, status, { joinedRunId: undefined });
    } catch {
      this.#logger.warn(
        { code: "SESSION_MESSAGE_STEER_PERSISTENCE_FAILED", messageId, outcome },
        "Steered Session message outcome could not be recorded",
      );
    }
    this.#remember(record.key, { hash, status });
    if (outcome === "not_started") this.#enqueue(next.payload, hash);
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
    const channelTurn = { sessionId, channel: false };
    let preparedExecutionId: string | undefined;
    let turnPlanInput: ProviderCliTurnPlanPrepareInput | undefined;
    let phase = "runtime";
    const timeout = new AbortController();
    let timer: { cancel(): void } | undefined;
    let runSignal: AbortSignal | undefined;
    let executionSignal: AbortSignal | undefined;
    let runTime: { finish(): Promise<number> } | undefined;
    const settleRunTime = async () => {
      // Once per Run: a returned failure reaches this again on its way to the failure path.
      if (!runTime) return;
      const ranMs = await runTime.finish();
      runTime = undefined;
      // Recorded by the write that follows; the record may hold newer run time than `current`.
      const latest = this.#records.get(key) ?? current;
      if (latest) current = withRunTime(latest, ranMs);
    };
    const ensureRunSignal = (): AbortSignal => {
      if (runSignal) return runSignal;
      timer = this.#timeoutScheduler.schedule(
        remainingBudgetMs(next.request.runtime.budget?.maxDurationMs, current?.ranMs ?? 0),
        () => timeout.abort(new Error("Session message Run timed out")),
      );
      if (current) runTime = this.#trackMessageRunTime(key);
      // Revocation or control/owner replacement aborts the Run and its provider children.
      runSignal = executionSignal
        ? AbortSignal.any([this.#abort.signal, timeout.signal, executionSignal])
        : AbortSignal.any([this.#abort.signal, timeout.signal]);
      return runSignal;
    };
    try {
      // The interruption this Run retries is for its notice only; what ends this Run is recorded anew.
      const continuation = current?.interruption;
      if (current) {
        current = await this.#transition(current, "running", { interruption: undefined, joinedRunId: undefined });
      }
      await this.#reconciler.withAgentLock(next.request.agentId, async () => {
        this.#reconciler.setActivity(sessionId, {
          phase: "running",
          deliveryId: next.request.messageId,
          turnId: runId,
        });
      });
      const sessionKind = this.#runtimeManager.sessionKind(sessionId);
      let outboxContext: RuntimeImOutboxContext | undefined;
      let allowedUnixSockets: readonly string[] | undefined;
      phase = "credential";
      const prepared = await this.#prepareCredentials(sessionId, next.request, sessionKind);
      if (prepared) {
        credentialPrepared = true;
        preparedExecutionId = prepared.executionId;
        allowedUnixSockets = prepared.allowedUnixSockets;
        executionSignal = prepared.signal;
      }
      if (sessionKind === "visible") {
        this.#requirePreparedOutbox(prepared, next.request);
        outboxContext = prepared.outboxContext;
        turnPlanInput = await this.#prepareTurnPlan(sessionId, runId, prepared, ensureRunSignal());
      }
      phase = "runtime";
      const runtimeSignal = credentialPrepared ? ensureRunSignal() : this.#abort.signal;
      runtimeSignal.throwIfAborted();
      const runtime = await this.#runtimeManager.ensureRuntime(sessionId, runtimeSignal);
      await runtime.waitForIdle();
      phase = "prompt";
      ensureRunSignal().throwIfAborted();
      channelTurn.channel = isChannelOutbox(outboxContext);
      const result = await runtime.prompt({
        runId,
        allowedUnixSockets,
        ...(await beginChannelTurn(
          this.#channelActivity,
          { ...channelTurn, retry: Boolean(continuation) },
          this.#now(),
        )),
        /*
         * The processing clock is sampled HERE — after the queue drain, admission reservation,
         * credential preparation, and `waitForIdle()` — so the Agent sees the actual processing
         * time, never the claim or enqueue time. It is prompt input only: the durable record,
         * the semantic hash, and the runtime configuration never carry a current-time fact.
         */
        input: withContinuation(
          buildSessionMessageInput(
            next.request,
            this.#cliCommand,
            turnContext(sessionKind, outboxContext),
            new Date(this.#now()),
          ),
          continuation,
        ),
        signal: ensureRunSignal(),
        ...sessionMessageLaunchConfiguration(prepared, runtime),
      });
      await settleRunTime();
      if (result.status !== "completed") throw runFailure(result);
      if (current && !this.#abort.signal.aborted) {
        await this.#transition(current, "succeeded");
        this.#remember(key, { hash: next.hash, status: "succeeded" });
      }
    } catch (error) {
      // Only the Run budget timer counts as a timeout; daemon stop and revocation keep their
      // existing recovery semantics.
      const timedOut = timeout.signal.aborted && !this.#abort.signal.aborted && executionSignal?.aborted !== true;
      await settleRunTime();
      if (current) await this.#handleFailure(current, next.hash, phase, error, timedOut);
    } finally {
      timer?.cancel();
      await endChannelTurn(this.#channelActivity, channelTurn, this.#now());
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

  #requirePreparedOutbox(
    prepared: PreparedRuntimeCredentialEnvironment | undefined,
    request: SessionMessageDeliveryRequestV3,
  ): asserts prepared is PreparedRuntimeCredentialEnvironment & { outboxContext: RuntimeImOutboxContext } {
    if (!prepared?.outboxContext) {
      this.#logger.warn(
        {
          code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED",
          messageId: request.messageId,
          sessionId: request.targetSessionId,
        },
        "Visible Session collaboration outbox context was missing",
      );
      throw new Error("The credential grant did not include visible Session outbox context");
    }
  }

  async #prepareCredentials(
    sessionId: string,
    request: SessionMessageDeliveryRequestV3,
    sessionKind: "visible" | "internal",
  ) {
    if (sessionKind === "internal" && this.#credentialEnvironment.mode !== "proxy") return undefined;
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
      if (
        sessionKind === "internal" &&
        error instanceof ImCredentialEnvironmentError &&
        (error.code === "execution_rejected" || error.code === "proxy_negotiation_unavailable")
      ) {
        this.#logger.warn(
          {
            code: "SESSION_MESSAGE_PLATFORM_SERVICES_UNAVAILABLE",
            reason: error.code,
            messageId: request.messageId,
            sessionId,
          },
          "Internal Session message has no platform execution; managed services are unavailable",
        );
        return undefined;
      }
      this.#logger.warn(
        {
          code: "SESSION_MESSAGE_OUTBOX_PREPARATION_FAILED",
          errorCode: error instanceof Error && "code" in error ? error.code : undefined,
          messageId: request.messageId,
          sessionId,
        },
        "Session message execution preparation failed",
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
    const unpublished: DurableWorkRecord<SessionMessageDeliveryRequestV3>[] = [];
    for (const stored of records) {
      const pending = await this.#hydrateRecord(stored);
      if (pending) unpublished.push(pending);
    }
    for (const record of unpublished) {
      const { outcome, code } = terminalRunOutcome(record);
      await this.#publishRunOutcome(record, outcome, code);
    }
  }

  /** Restore one durable record; returns it when its terminal outcome still needs a report. */
  async #hydrateRecord(
    stored: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
  ): Promise<DurableWorkRecord<SessionMessageDeliveryRequestV3> | undefined> {
    const request = SessionMessageDeliveryRequestV3Schema.safeParse(stored.payload);
    if (!request.success) return undefined;
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
      return undefined;
    }
    if (record.status === "dead-letter" || record.status === "failed") {
      this.#remember(key, { hash, status: record.status, reason: "provider_unavailable" });
      // The terminal fact committed but its report never reached the reporter (for example a
      // crash in between): re-derive it. Records without the marker predate it and are not
      // backfilled; the Run is never rerun either way.
      return record.outcomeReport === "pending" ? record : undefined;
    }
    if (record.status === "running") {
      // The daemon stopped while this message's Run was in flight: a crash leaves no reason behind, an
      // orderly stop of its own Run records `client_shutdown`.
      const interruption: Interruption = {
        reason: recoverableFailure(record.interruption?.reason) ?? "daemon_crash",
        at: record.interruption?.at ?? new Date(this.#now()).toISOString(),
      };
      // A message steered into a Turn shares that Turn's count, so it is not counted here.
      const retry = record.joinedRunId ? undefined : nextRetry(messageRetryCount(record));
      if (retry?.exhausted) {
        const failure = interruptedFailure(record.payload.requestId, interruption.reason);
        record = await this.#transition({ ...record, attempts: retry.count, lastError: failure }, "failed", {
          nextAttemptAt: undefined,
          ...this.#pendingOutcomeReport(),
        });
        this.#remember(key, { hash, status: "failed", reason: "provider_unavailable" });
        return record;
      }
      record = {
        ...record,
        ...(retry ? messageRetryFields(retry) : {}),
        interruption,
        status: "retryable",
        nextAttemptAt: this.#now(),
        updatedAt: this.#now(),
      };
      await this.#persist(record);
    }
    this.#remember(key, { hash, status: "retryable" });
    this.#enqueue(record.payload, hash);
    return undefined;
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
    timedOut = false,
  ): Promise<void> {
    const reported = durableFailureFromUnknown(
      record.payload.requestId,
      phase,
      error,
      phase === "credential" ? "credential_unavailable" : phase === "prompt" ? "provider_failed" : "runtime_failed",
    );
    const failure: DurableFailure = timedOut
      ? { ...reported, code: SESSION_MESSAGE_TURN_TIMEOUT_CODE, retryability: "never" }
      : reported;
    this.#emitFailure(failure);
    const now = this.#now();
    if (this.#abort.signal.aborted) {
      // An orderly daemon stop: keep the record `running` with the reason, for the restarted daemon.
      const interruption: Interruption = { reason: "client_shutdown", at: new Date(now).toISOString() };
      await this.#persist({ ...record, interruption, updatedAt: now }).catch(() => undefined);
      return;
    }
    const reason = timedOut ? undefined : recoverableFailure(failure.code);
    const retry = reason && nextRetry(messageRetryCount(record));
    if (reason && retry && !retry.exhausted) {
      const interruption: Interruption = { reason, at: new Date(now).toISOString() };
      const delay = reason === "provider_rate_limited" ? this.#rateLimitRetryDelayMs : 0;
      let retryable: DurableWorkRecord<SessionMessageDeliveryRequestV3>;
      try {
        retryable = await this.#transition(
          { ...record, ...messageRetryFields(retry), lastError: failure, interruption, updatedAt: now },
          "retryable",
          { nextAttemptAt: now + delay },
        );
      } catch {
        this.#logger.warn(
          { code: "SESSION_MESSAGE_PERSISTENCE_FAILED", messageId: record.payload.messageId, status: "retryable" },
          "Session message retry state could not be persisted",
        );
        return;
      }
      this.#remember(record.key, { hash, status: "retryable" });
      this.#scheduleRetry(retryable, hash);
      return;
    }
    await this.#failTerminally(record, hash, phase, failure, timedOut);
  }

  /**
   * A failure that is not recoverable, or the failure of the one automatic retry: terminal, and
   * the creator gets a Run outcome notice. The terminal status and the notice intent commit in one
   * record write.
   */
  async #failTerminally(
    record: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
    hash: string,
    phase: string,
    failure: DurableFailure,
    timedOut = false,
  ): Promise<void> {
    const candidate = { ...record, attempts: record.attempts + 1, lastError: failure, updatedAt: this.#now() };
    const terminal = await this.#transition(candidate, "failed", {
      nextAttemptAt: undefined,
      ...this.#pendingOutcomeReport(),
    }).catch(() => undefined);
    this.#remember(record.key, { hash, status: "failed", reason: "provider_unavailable" });
    this.#logger.warn(
      { code: failure.code, messageId: record.payload.messageId, phase, status: "failed" },
      "Session message failed permanently",
    );
    await this.#publishRunOutcome(terminal ?? candidate, timedOut ? "timed_out" : "failed", failure.code);
  }

  #pendingOutcomeReport(): Pick<DurableWorkRecord, "outcomeReport"> {
    return this.#onRunOutcome ? { outcomeReport: "pending" } : {};
  }

  /**
   * Hand a terminal Run outcome to the durable reporter, then mark the inbox record `published`.
   * A failure leaves the marker `pending`, so the next hydration hands it over again; the reporter
   * and the Server's UUIDv5 notice identity make that repeat harmless. The inbox state machine
   * never depends on reporting.
   */
  async #publishRunOutcome(
    record: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
    outcome: "timed_out" | "failed",
    code: string,
  ): Promise<void> {
    if (!this.#onRunOutcome) return;
    const request = record.payload;
    try {
      await this.#onRunOutcome({
        messageId: request.messageId,
        targetSessionId: request.targetSessionId,
        agentId: request.agentId,
        placementGeneration: request.placementGeneration,
        outcome,
        reason: SessionMessageRunOutcomeReasonSchema.safeParse(code).success ? code : "run_failed",
      });
    } catch {
      this.#warnRunOutcomeFailed(request.messageId);
      return;
    }
    if (record.outcomeReport !== "pending" || this.#records.get(record.key) !== record) return;
    await this.#persist({ ...record, outcomeReport: "published", updatedAt: this.#now() }).catch(() =>
      this.#logger.warn(
        { code: "SESSION_MESSAGE_PERSISTENCE_FAILED", messageId: request.messageId, status: record.status },
        "Session message outcome handoff could not be marked; it is handed over again on restart",
      ),
    );
  }

  #warnRunOutcomeFailed(messageId: string): void {
    this.#logger.warn(
      { code: "SESSION_MESSAGE_OUTCOME_REPORT_FAILED", messageId },
      "Session message Run outcome could not be queued for reporting",
    );
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

/** The report a committed terminal record implies, matching what `#handleFailure` reported. */
function terminalRunOutcome(record: DurableWorkRecord<SessionMessageDeliveryRequestV3>): {
  outcome: "timed_out" | "failed";
  code: string;
} {
  const code = record.lastError?.code ?? "retry_exhausted";
  return { outcome: code === SESSION_MESSAGE_TURN_TIMEOUT_CODE ? "timed_out" : "failed", code };
}

function messageRetryCount(record: DurableWorkRecord<SessionMessageDeliveryRequestV3>): RetryCount {
  return { count: record.attempts, ranMs: record.retryRanMs ?? 0 };
}

function messageRetryFields(retry: { count: number }): { attempts: number; retryRanMs: number } {
  return { attempts: retry.count, retryRanMs: 0 };
}

function withRunTime(
  record: DurableWorkRecord<SessionMessageDeliveryRequestV3>,
  ranMs: number,
): DurableWorkRecord<SessionMessageDeliveryRequestV3> {
  return { ...record, ranMs: (record.ranMs ?? 0) + ranMs, retryRanMs: (record.retryRanMs ?? 0) + ranMs };
}

function interruptedFailure(requestId: string, reason: InterruptionReason): DurableFailure {
  return {
    code: reason === "daemon_crash" ? "run_interrupted" : reason,
    category: "unavailable",
    retryability: "never",
    phase: "provider",
    requestId,
    message: "The automatic retry of this Session message was interrupted as well",
  };
}

function turnContext(
  sessionKind: "visible" | "internal",
  outboxContext: RuntimeImOutboxContext | undefined,
): SessionMessageTurnContext {
  return sessionKind === "visible"
    ? { sessionKind, outboxContext: requireOutboxContext(outboxContext) }
    : { sessionKind: "internal" };
}

/** A non-completed Run as an error that keeps the provider's code (e.g. `provider_rate_limited`). */
function runFailure(result: { status: string; error?: { code?: string; message?: string } }): Error {
  const error = new Error(result.error?.message ?? `Session message Run ended with status ${result.status}`);
  return result.error?.code ? Object.assign(error, { code: result.error.code }) : error;
}

/** Prefix the continuation notice when this Run is the automatic retry of an interrupted Run. */
function withContinuation(input: AgentInput, interruption: DurableWorkRecord["interruption"]): AgentInput {
  const reason = recoverableFailure(interruption?.reason);
  if (!interruption || !reason) return input;
  return {
    items: [{ type: "text", text: buildContinuationNotice({ reason, at: interruption.at }) }, ...input.items],
  };
}

function steerInterruptedFailure(requestId: string): DurableFailure {
  return {
    code: "session_message_steer_interrupted",
    category: "dependency",
    retryability: "never",
    phase: "provider",
    requestId,
    message: "The Run ended after the provider may have started this steered Session message",
  };
}

/** Resolves with the promise's value, or with `undefined` once the signal aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** A rejection the same message can still overcome, so a replay is evaluated again. */
function retryableRejection(reason: InputRejectReason): boolean {
  return (
    reason === "client_busy" ||
    reason === "stale_generation" ||
    reason === "session_not_ready" ||
    reason === "stale_configuration" ||
    reason === "session_recovery_required"
  );
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
 * <=120 code-point preview). The full prompt always stays its own trailing user-task item, and
 * untrusted name/preview text enters the managed block only JSON-escaped, so it can never close a
 * managed tag or forge instructions.
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
 * The distinct managed metadata item of a scheduled input. The name and preview are untrusted
 * snapshot text and appear only JSON-escaped. The scheduled message goes to the Agent only: the
 * Server, not the Agent, reports a failed or missed occurrence to the conversation.
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
      "Post to this Session's IM conversation only if this task produces something the conversation should see; a run with nothing to report stays silent. Send no schedule lifecycle notice: no start, completion, failure, or skip message. openTag reports a failed Run to the conversation itself.",
    );
  } else {
    lines.push("No IM outbox is attached to this target Session.");
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

function sessionMessageLaunchConfiguration(
  prepared: PreparedRuntimeCredentialEnvironment | undefined,
  runtime: AgentRuntime,
) {
  if (!prepared?.web && !prepared?.mcp) return {};
  return providerLaunchConfiguration({ webTools: prepared.web, mcpGateway: prepared.mcp }, runtime.manifest.providerId);
}
