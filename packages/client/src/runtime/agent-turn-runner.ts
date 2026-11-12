import { randomUUID } from "node:crypto";
import {
  computeRuntimeImMessageSemanticHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  ProviderFailureReasonSchema,
  RUNTIME_CAPABILITY,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  type RuntimeApprovalDecision,
  type RuntimeApprovalResult,
  type RuntimeImSteerRequest,
  type RuntimeImSteerResult,
  redactForLog,
  redactSensitive,
  type SessionMessageDeliveryRequestV3,
  type TurnActivityResult,
  type TurnFailureReason,
  type TurnOutgoingReplySnapshot,
  type TurnReportHashInput,
  type TurnReportRequest,
} from "@opentag/shared";
import { AgentProviderError, AgentRuntimeError } from "../agent-runtime/errors.js";
import type {
  AgentInput,
  AgentRunConfiguration,
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentSteerOutcome,
  AgentSteerReceipt,
  JsonValue,
} from "../agent-runtime/types.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { AgentRuntimeProviderUnavailableError } from "./agent-runtime-provider-registry.js";
import type { BackgroundWorkLedgers } from "./background-work-ledger.js";
import {
  beginChannelTurn,
  type ChannelActivityStore,
  endChannelTurn,
  isChannelOutbox,
} from "./channel-idle-compaction.js";
import { ImCredentialEnvironmentError } from "./im-credential-environment-manager.js";
import type { ImResourceFetcher } from "./im-resource-fetcher.js";
import {
  acknowledgedSteers,
  buildContinuationNotice,
  type Interruption,
  MAX_AUTOMATIC_RETRIES,
  MAX_RECORDED_STEERS,
  nextRetry,
  recoverableFailure,
  retryDelayMs,
  retryLimit,
  type TurnRetryRecord,
  type TurnRetryStore,
  trackRunTime,
} from "./interruption-retry.js";
import {
  budgetTurnReportHashInput,
  emptyCompleteOutgoingReplies,
  feishuOutgoingReplyScope,
  snapshotOutgoingReplies,
  unavailableOutgoingReplies,
} from "./provider-cli/outgoing-reply-report.js";
import type { ProviderCliOutgoingReplyCollectResult } from "./provider-cli/outgoing-reply-store.js";
import { ProviderCliTurnPlanError } from "./provider-cli/turn-plan.js";
import type { ProviderCliTurnPlanPrepareInput } from "./provider-cli/turn-plan-manager.js";
import { providerLaunchConfiguration, providerSupportsMcpGateway } from "./provider-launch-configuration.js";
import { buildProviderOutboxInstructions } from "./provider-outbox-instructions.js";
import { runBudgetTimer, scheduleUnrefTimeout } from "./run-budget-timer.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import type {
  PreparedMcpGatewayLaunch,
  PreparedRuntimeCredentialEnvironment,
  PreparedWebToolsLaunch,
  RuntimeCredentialEnvironmentManager,
} from "./runtime-credential-environment-manager.js";
import type { SessionBindingStore } from "./session-binding-store.js";
import { conversationIdentity } from "./session-message-run.js";
import {
  ClientRuntimeProviderStartError,
  type SessionRuntimeManager,
  SessionRuntimeNotPreparedError,
} from "./session-runtime-manager.js";
import { TurnTraceBuffer } from "./trace-buffer.js";
import { TurnActivityReporter } from "./turn-activity-reporter.js";
import type { LiveTurnOwner, TurnCustodyOwner } from "./turn-custody-owner.js";
import type { TurnReportOwner } from "./turn-report-owner.js";
import { abortExpiredTurn, remainingBudgetMs, turnTimeoutMs } from "./turn-timeout.js";

export { turnTimeoutMs } from "./turn-timeout.js";

export interface AgentTurnOutgoingReplyCollector {
  collect(input: {
    readonly sessionId: string;
    readonly runId: string;
  }): Promise<ProviderCliOutgoingReplyCollectResult>;
  cleanup(input: { readonly sessionId: string; readonly runId: string }): Promise<void>;
}

export interface AgentTurnRunnerOptions {
  /** What the Session's earlier Runs left to tell it; a Run reads it first and reports its limit there. */
  backgroundWork?: Pick<BackgroundWorkLedgers, "forSession">;
  readonly bindingStore: SessionBindingStore;
  readonly connection: Pick<RuntimeConnection, "send"> & {
    capabilityVersion?(capability: string): number | undefined;
  };
  readonly custody: Pick<TurnCustodyOwner, "markReporting" | "recordResult">;
  /** Without one, Channel Sessions never compact on idle. */
  readonly channelActivity?: Pick<ChannelActivityStore, "beginTurn" | "recordActivity">;
  readonly logger?: ClientLogger;
  readonly now?: () => number;
  readonly onRuntimeEvent?: (event: AgentRuntimeEvent) => Promise<void> | void;
  readonly reportOwner: TurnReportOwner;
  /** @deprecated Attachments are read on demand through the provider CLI. Never called. */
  readonly resourceFetcher?: ImResourceFetcher;
  readonly runtimeManager: SessionRuntimeManager;
  readonly credentialEnvironment: Pick<RuntimeCredentialEnvironmentManager, "cleanup" | "prepare">;
  readonly turnPlan?: {
    cleanup(input: ProviderCliTurnPlanPrepareInput): Promise<void>;
    prepare(input: ProviderCliTurnPlanPrepareInput, signal?: AbortSignal): Promise<unknown>;
  };
  readonly outgoingReplies?: AgentTurnOutgoingReplyCollector;
  /**
   * Relays a turn failure to the error tracker. Given every failure without exception: deciding which
   * of them describe a defect is the reporter's job, not this runner's, so the taxonomy can change
   * without touching the execution path.
   */
  readonly agentErrorReporter?: AgentTurnErrorReporter;
  /**
   * Durable input of accepted Turns. When present, a recoverable failure (timeout, HTTP 429) gets
   * one automatic retry in place, and an orderly shutdown leaves the Turn unresolved for the
   * restarted daemon instead of reporting it cancelled.
   */
  readonly retries?: Pick<TurnRetryStore, "appendSteer" | "removeSteer" | "update">;
  /** Whether a Turn interrupted by shutdown can be retried after restart (`runtime.sessionRecovery`). */
  readonly restartRetryAvailable?: () => boolean;
  /** The owner of Session messages steered into a Turn; an in-place retry carries them along. */
  readonly sessionMessages?: {
    /** The message's input for a retry, built once the retry's credentials are prepared. */
    input(message: SessionMessageDeliveryRequestV3, processedAt: Date): AgentInput;
    /** Resolves once the message's outcome is durable. */
    settle(message: SessionMessageDeliveryRequestV3, outcome: AgentSteerOutcome): Promise<void>;
    /** Whether this runtime's conversation durably holds the message, so a retry need not repeat it. */
    inConversation?(message: SessionMessageDeliveryRequestV3, runId: string, runtime: AgentRuntime): boolean;
  };
}

export interface TurnStartOptions {
  /** Set when this start is the automatic retry of an interrupted Turn. */
  readonly continuation?: Interruption;
  readonly steers?: readonly RuntimeImSteerRequest[];
  readonly steerConversations?: Readonly<Record<string, string>>;
}

interface TurnAttempt {
  readonly completion: TurnCompletion;
  readonly turnPlanInput?: ProviderCliTurnPlanPrepareInput;
}

/**
 * One failed turn, as much of it as a reader needs to find the Agent it happened to.
 *
 * Only what the failure path already holds. The provider is deliberately absent: reading it means
 * asking the runtime manager, and a turn that failed before its runtime was prepared has no answer
 * to give — the reporter resolves it, where being unable to is not the execution path's problem.
 */
export interface AgentTurnFailure {
  readonly error: unknown;
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly errorReason?: TurnFailureReason | undefined;
  readonly outcome: TurnCompletion["outcome"];
}

/** Never throws and never awaited: a tracker that is slow or broken must not hold a turn open. */
export type AgentTurnErrorReporter = (failure: AgentTurnFailure) => void;

/** A message that joined a running Turn; a retry replays them in the order they arrived. */
type SteeredInput = RuntimeImSteerRequest | SessionMessageDeliveryRequestV3;

/** How long an automatic retry waits for steers still in flight before it gives up. */
const STEER_SETTLE_TIMEOUT_MS = 10_000;

interface RunningTurn {
  readonly abort: AbortController;
  readonly approvals: Map<string, string>;
  readonly owner: LiveTurnOwner;
  readonly reportVersion: number;
  phase: "starting" | "running" | "reporting";
  promise: Promise<void>;
  runtime?: AgentRuntime;
  expiresAt?: string;
  continuation?: Interruption;
  /** Negotiation is cleared on disconnect, and shutdown disconnects first: sample it at start. */
  readonly restartRetry: boolean;
  /** Steers not yet answered; each one settles and never rejects. */
  steering: Set<Promise<unknown>>;
  /** Session messages that joined the current attempt, with what the provider did with them. */
  joined: Map<string, { message: SessionMessageDeliveryRequestV3; receipt: AgentSteerReceipt }>;
  /** Session messages being steered: how to end each one's place in `steering`. */
  joining: Map<string, () => void>;
  /** When each steered message arrived, across IM and Session messages. */
  arrivals: Map<string, number>;
  /** Set once the Turn's outcome is decided; a message acknowledged later follows its own receipt. */
  finalized: boolean;
  /** Run time of the latest attempt that is not recorded yet. */
  unrecordedRunMs: number;
  /** Messages an earlier attempt held, replayed in the current attempt's input unless its conversation has them. */
  steers: readonly SteeredInput[];
  /** Which provider conversation durably holds each IM steer, by delivery. */
  steerConversations: Readonly<Record<string, string>>;
}

export interface TurnCompletion {
  readonly errorReason?: TurnFailureReason;
  readonly executionEffects: "completed" | "may_have_occurred" | "not_started";
  readonly finalText?: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "unknown";
  readonly usage?: TurnReportHashInput["usage"];
  /** When a used-up model quota is available again; sent only on Turn report v5. */
  readonly retryAt?: string;
}

interface TurnPhaseTimings {
  credentialPrepareMs?: number;
  turnPlanPrepareMs?: number;
  runtimeEnsureMs?: number;
  promptDurationMs?: number;
}

export class AgentTurnRunner {
  readonly #bindingStore: SessionBindingStore;
  readonly #connection: AgentTurnRunnerOptions["connection"];
  readonly #custody: Pick<TurnCustodyOwner, "markReporting" | "recordResult">;
  readonly #logger: ClientLogger;
  readonly #now: () => number;
  readonly #onRuntimeEvent?: AgentTurnRunnerOptions["onRuntimeEvent"];
  readonly #reportOwner: TurnReportOwner;
  readonly #runtimeManager: SessionRuntimeManager;
  readonly #credentialEnvironment: AgentTurnRunnerOptions["credentialEnvironment"];
  readonly #turnPlan: AgentTurnRunnerOptions["turnPlan"];
  readonly #outgoingReplies: AgentTurnRunnerOptions["outgoingReplies"];
  readonly #agentErrorReporter: AgentTurnErrorReporter;
  readonly #retries: NonNullable<AgentTurnRunnerOptions["retries"]>;
  readonly #backgroundWork: AgentTurnRunnerOptions["backgroundWork"];
  readonly #channelActivity: AgentTurnRunnerOptions["channelActivity"];
  readonly #sessionMessages: NonNullable<AgentTurnRunnerOptions["sessionMessages"]>;
  readonly #restartRetryAvailable: () => boolean;
  readonly #turns = new Map<string, RunningTurn>();
  #stopped = false;
  readonly #activity: TurnActivityReporter;

  constructor(options: AgentTurnRunnerOptions) {
    this.#activity = new TurnActivityReporter({
      enabled: () => options.connection.capabilityVersion?.(RUNTIME_CAPABILITY.turnActivity) === 1,
      send: (frame) => options.connection.send(frame, { priority: "trace", signal: AbortSignal.timeout(1_000) }),
      ...(options.now ? { now: options.now } : {}),
    });
    this.#bindingStore = options.bindingStore;
    this.#connection = options.connection;
    this.#custody = options.custody;
    this.#logger = options.logger ?? createLogger("turn");
    this.#now = options.now ?? Date.now;
    this.#onRuntimeEvent = options.onRuntimeEvent;
    this.#reportOwner = options.reportOwner;
    this.#runtimeManager = options.runtimeManager;
    this.#credentialEnvironment = options.credentialEnvironment;
    this.#turnPlan = options.turnPlan;
    this.#outgoingReplies = options.outgoingReplies;
    // Defaulted rather than optional so the failure path calls it unconditionally: a composition that
    // wants no tracker gets a runner that reports into nothing, not a second branch to get wrong.
    this.#agentErrorReporter = options.agentErrorReporter ?? (() => undefined);
    this.#retries = options.retries ?? NO_TURN_RETRIES;
    this.#backgroundWork = options.backgroundWork;
    this.#channelActivity = options.channelActivity;
    this.#sessionMessages = options.sessionMessages ?? NO_SESSION_MESSAGES;
    this.#restartRetryAvailable = options.restartRetryAvailable ?? (() => false);
  }

  handleActivityResult(result: TurnActivityResult): void {
    this.#activity.acknowledge(result);
  }

  get activeCount(): number {
    return this.#turns.size;
  }

  start(owner: LiveTurnOwner, options: TurnStartOptions = {}): void {
    if (this.#stopped || this.#turns.has(owner.turnId)) return;
    const abort = new AbortController();
    const turn: RunningTurn = {
      abort,
      approvals: new Map(),
      owner,
      // Negotiation is cleared on disconnect. Keep this Turn's report contract
      // until its durable report can be replayed after reconnection.
      reportVersion: this.#connection.capabilityVersion?.(RUNTIME_CAPABILITY.turnReport) ?? 1,
      phase: "starting",
      promise: Promise.resolve(),
      ...(options.continuation ? { continuation: options.continuation } : {}),
      restartRetry: this.#restartRetryAvailable(),
      steering: new Set(),
      joined: new Map(),
      joining: new Map(),
      arrivals: new Map(),
      finalized: false,
      unrecordedRunMs: 0,
      steers: options.steers ?? [],
      steerConversations: options.steerConversations ?? {},
    };
    turn.promise = this.#run(turn, abort.signal)
      .catch(
        /* v8 ignore next -- turn failures are reported through completion events, not this promise. */ () => undefined,
      )
      .finally(() => this.#turns.delete(owner.turnId));
    this.#turns.set(owner.turnId, turn);
  }

  async steer(request: RuntimeImSteerRequest): Promise<RuntimeImSteerResult> {
    const semanticHash = computeRuntimeImMessageSemanticHash(request);
    try {
      const receipt = await this.#bindingStore.getSteerReceipt(request, semanticHash);
      if (receipt) return steerResult(request, "steered");
    } catch {
      return steerResult(request, "rejected", "input_conflict");
    }

    const turn = this.#turns.get(request.expectedTurnId);
    if (!turn) return steerResult(request, "deferred", "turn_not_running");
    const owner = turn.owner;
    if (
      owner.request.deliveryId !== request.rootDeliveryId ||
      owner.request.sessionId !== request.sessionId ||
      owner.request.agentId !== request.agentId ||
      owner.request.placementGeneration !== request.placementGeneration
    ) {
      return steerResult(request, "rejected", "target_mismatch");
    }
    if (turn.phase === "starting") return steerResult(request, "retry", "turn_starting");
    const runtime = turn.runtime;
    if (turn.phase !== "running" || !runtime) {
      return steerResult(request, "deferred", "turn_not_running");
    }
    if (runtime.capabilities.steer !== "supported") {
      return steerResult(request, "deferred", "steer_unsupported");
    }
    if (runtime.state.phase !== "running" || runtime.state.activeRunId !== request.expectedTurnId) {
      return steerResult(request, "deferred", "turn_not_running");
    }

    turn.arrivals.set(steeredInputId(request), turn.arrivals.size);
    const steering = this.#steerRunningTurn(turn, runtime, request, semanticHash);
    turn.steering.add(steering);
    void steering.finally(() => turn.steering.delete(steering));
    return steering;
  }

  async #steerRunningTurn(
    turn: RunningTurn,
    runtime: AgentRuntime,
    request: RuntimeImSteerRequest,
    semanticHash: string,
  ): Promise<RuntimeImSteerResult> {
    // Every acknowledged steer must be in the Turn's retry input, so capture it before steering. A
    // full input or a storage failure leaves the message with the Server to deliver after this Turn.
    const capture = await this.#retries.appendSteer(request).catch(() => "failed" as const);
    if (capture === "full") return steerResult(request, "deferred", "steer_unsupported");
    if (capture !== "appended") return steerResult(request, "deferred", "turn_not_running");

    // Only a steer with a durable receipt transfers to this Turn; a retry replays exactly those, so a
    // capture whose steer or receipt failed (answered `deferred`) is dropped and stays with the Server.
    try {
      const receipt = await runtime.steer({
        expectedRunId: request.expectedTurnId,
        // Steer input assembles at the moment of the steer, so it carries its own UTC sample.
        input: buildAgentInput(request, undefined, turn.owner.request.runtime, new Date(this.#now())),
      });
      await this.#bindingStore.recordSteer(request, semanticHash);
      void receipt.inConversation?.then(() => this.#recordSteerInConversation(turn, runtime, request));
    } catch (error) {
      await this.#retries.removeSteer(request).catch(() => undefined);
      // The Turn already ended and nothing reached the provider, so the Server delivers it after this Turn.
      // Only a failure that may have reached the provider is unknown; that one fails with the Turn.
      if (steerNeverStarted(error)) return steerResult(request, "deferred", "turn_not_running");
      return steerResult(request, "deferred", "steer_state_unknown");
    }
    return steerResult(request, "steered");
  }

  /** Best effort: without it a retry repeats the steer, which it has always been allowed to. */
  async #recordSteerInConversation(
    turn: RunningTurn,
    runtime: AgentRuntime,
    request: RuntimeImSteerRequest,
  ): Promise<void> {
    const conversation = conversationIdentity(runtime.binding);
    if (!conversation) return;
    const steerConversations = { [request.deliveryId]: conversation };
    turn.steerConversations = { ...turn.steerConversations, ...steerConversations };
    await this.#retries
      .update(request.sessionId, request.expectedTurnId, (record) => ({
        ...record,
        steerConversations: { ...record.steerConversations, ...steerConversations },
      }))
      .catch(() => undefined);
  }

  /** What a retry must still repeat: a conversation that durably holds a message has it already. */
  #steersToRepeat(turn: RunningTurn, runtime: AgentRuntime): readonly SteeredInput[] {
    const conversation = conversationIdentity(runtime.binding);
    return turn.steers.filter((steer) =>
      steer.type === "im:steer"
        ? conversation === undefined || turn.steerConversations[steer.deliveryId] !== conversation
        : !this.#sessionMessages.inConversation?.(steer, turn.owner.turnId, runtime),
    );
  }

  /**
   * Hold a place in this running Turn for a Session message about to be steered into it. False leaves
   * the message queued: the Turn is not running here, or it holds as many as it can carry.
   */
  reserveSessionMessage(message: SessionMessageDeliveryRequestV3, turnId: string): boolean {
    const turn = this.#turns.get(turnId);
    if (!turn || turn.phase !== "running" || turn.owner.request.sessionId !== message.targetSessionId) return false;
    const held = turn.steers.filter((steer) => steer.type === "session:message:deliver").length;
    if (held + turn.joined.size + turn.joining.size >= MAX_RECORDED_STEERS) return false;
    turn.arrivals.set(steeredInputId(message), turn.arrivals.size);
    let done!: () => void;
    const steering = new Promise<void>((resolve) => {
      done = () => {
        turn.steering.delete(steering);
        resolve();
      };
    });
    turn.steering.add(steering);
    turn.joining.set(message.messageId, done);
    return true;
  }

  /** The reserved message was steered: an in-place retry of this Turn now carries it. */
  sessionMessageSteered(message: SessionMessageDeliveryRequestV3, turnId: string, receipt: AgentSteerReceipt): void {
    const turn = this.#turns.get(turnId);
    if (!turn || turn.finalized) {
      void receipt.outcome.then((outcome) => this.#sessionMessages.settle(message, outcome));
    } else {
      turn.joined.set(message.messageId, { message, receipt });
    }
    this.releaseSessionMessage(message, turnId);
  }

  /** The reserved message's place is over, whether it was steered or stays with the inbox. */
  releaseSessionMessage(message: SessionMessageDeliveryRequestV3, turnId: string): void {
    const turn = this.#turns.get(turnId);
    turn?.joining.get(message.messageId)?.();
    turn?.joining.delete(message.messageId);
  }

  async respondToApproval(request: RuntimeApprovalDecision): Promise<RuntimeApprovalResult> {
    const { type: _type, decision: _decision, ...identity } = request;
    const turn = this.#turns.get(request.turnId);
    const providerRequestId = turn?.approvals.get(request.requestId);
    if (
      !turn?.runtime ||
      providerRequestId === undefined ||
      turn.phase !== "running" ||
      turn.owner.request.sessionId !== request.sessionId ||
      turn.owner.request.deliveryId !== request.deliveryId ||
      turn.owner.request.placementGeneration !== request.placementGeneration ||
      !turn.expiresAt ||
      Date.parse(turn.expiresAt) <= this.#now()
    )
      return { ...identity, type: "approval:result", status: "stale" };
    turn.approvals.delete(request.requestId);
    try {
      await turn.runtime.respond({
        expectedRunId: request.turnId,
        requestId: providerRequestId,
        kind: "approval",
        decision: request.decision,
        scope: "run",
      });
      return { ...identity, type: "approval:result", status: "applied" };
    } catch {
      return { ...identity, type: "approval:result", status: "stale" };
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#activity.close();
    for (const turn of this.#turns.values()) turn.abort.abort("client_shutdown");
  }

  async settled(): Promise<void> {
    await Promise.all([...this.#turns.values()].map((turn) => turn.promise));
  }

  #observeTurn(
    turn: RunningTurn,
    runtime: AgentRuntime,
    trace: TurnTraceBuffer,
    onTerminal: () => void,
    onQuotaWait: (waiting: boolean) => void,
  ): () => void {
    const owner = turn.owner;
    return this.#runtimeManager.observe(owner.request.sessionId, async (event) => {
      trace.record(event);
      if (event.type === "quota_wait_changed" && event.runId === owner.turnId) onQuotaWait(event.waiting);
      if (event.type === "interaction_requested" && event.runId === owner.turnId)
        await this.#requestApproval(turn, runtime, event.request);
      if (event.type === "run_started" && event.runId === owner.turnId) {
        this.#activity.start(owner.request, owner.turnId);
        await this.#bindingStore.updateUnresolved(
          owner.request.agentId,
          owner.request.sessionId,
          owner.turnId,
          "running",
        );
        turn.phase = "running";
      }
      if (
        event.type === "run_completed" ||
        event.type === "run_failed" ||
        event.type === "run_aborted" ||
        event.type === "run_cancelled"
      ) {
        if (event.runId === owner.turnId) this.#activity.end(owner.turnId);
        onTerminal();
      }
      await this.#onRuntimeEvent?.(event);
    });
  }

  async #requestApproval(
    turn: RunningTurn,
    runtime: AgentRuntime,
    request: import("../agent-runtime/types.js").AgentInteractionRequest,
  ): Promise<void> {
    const owner = turn.owner;
    const details = request.details;
    const action =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details.command ?? details.permissions ?? details.grantRoot ?? details)
        : details;
    const description = [
      ...new Set([request.message, action ? describeApprovalAction(redactSensitive(action)) : undefined]),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (request.kind !== "approval" || description.length === 0 || description.length > 6000) {
      // Cancel unsupported dialogs and refuse requests without a reviewable action.
      const response =
        request.kind === "approval"
          ? { kind: "approval" as const, decision: "decline" as const }
          : { kind: "question" as const, decision: "cancel" as const };
      queueMicrotask(
        () =>
          void runtime
            .respond({ expectedRunId: owner.turnId, requestId: request.requestId, ...response })
            .catch(() => turn.abort.abort("interaction_unavailable")),
      );
      return;
    }
    const requestId = randomUUID();
    turn.approvals.set(requestId, request.requestId);
    await this.#connection.send({
      type: "approval:request",
      requestId,
      turnId: owner.turnId,
      deliveryId: owner.request.deliveryId,
      sessionId: owner.request.sessionId,
      placementGeneration: owner.request.placementGeneration,
      title: request.title.slice(0, 256),
      description: redactSensitive(description),
      ...(this.#connection.capabilityVersion?.(RUNTIME_CAPABILITY.approvalPresentation) === 1
        ? approvalCommandPresentation(details, request.message)
        : {}),
      expiresAt: turn.expiresAt,
    });
  }

  async #run(turn: RunningTurn, shutdownSignal: AbortSignal): Promise<void> {
    const owner = turn.owner;
    const fields = {
      agentId: owner.request.agentId,
      deliveryId: owner.request.deliveryId,
      sessionId: owner.request.sessionId,
      turnId: owner.turnId,
    };
    const trace = new TurnTraceBuffer({
      sender: this.#connection,
      sessionId: owner.request.sessionId,
      turnId: owner.turnId,
      placementGeneration: owner.request.placementGeneration,
      now: this.#now,
    });
    const attempt = await this.#attempts(turn, shutdownSignal, trace);
    // The interruption is durable; the restarted daemon runs the automatic retry.
    if (!attempt) return;
    const { completion, turnPlanInput } = attempt;
    await this.#settleSessionMessages(turn, completion);

    const traceSummary = await trace.finish();
    const outgoingReplies = await this.#collectOutgoingReplies(turnPlanInput, owner, turn.reportVersion >= 2);
    const reportInput = budgetTurnReportHashInput({
      deliveryId: owner.request.deliveryId,
      turnId: owner.turnId,
      sessionId: owner.request.sessionId,
      agentId: owner.request.agentId,
      placementGeneration: owner.request.placementGeneration,
      outcome: completion.outcome,
      executionEffects: completion.executionEffects,
      ...(completion.finalText ? { finalText: completion.finalText } : {}),
      ...(completion.errorReason ? { errorReason: completion.errorReason } : {}),
      // The report owner drops it below Turn report v5 or on any other reason.
      ...(completion.retryAt ? { retryAt: completion.retryAt } : {}),
      ...(completion.usage ? { usage: completion.usage } : {}),
      traceSummary,
      ...(outgoingReplies ? { outgoingReplies } : {}),
    });
    let report: TurnReportRequest;
    try {
      report = this.#reportOwner.create(reportInput, turn.reportVersion);
      await this.#custody.markReporting(owner.turnId, report);
    } catch {
      this.#logger.warn(fields, "Turn could not enter the reporting phase");
      // Receipts remain the only durable evidence if report persistence fails.
      return;
    }
    await this.#cleanupOutgoingReplies(turnPlanInput, owner.turnId);
    void this.#reportOwner
      .submit(report, (supersedingOutcome) =>
        this.#custody.recordResult(owner.turnId, report.resultHash, supersedingOutcome),
      )
      .catch((error: unknown) => {
        this.#logger.warn(
          {
            ...fields,
            reason: redactForLog(error instanceof Error ? error.message : "Unknown Turn Report submission failure"),
          },
          "Turn Report submission failed",
        );
      });
  }

  /**
   * Runs the Turn and, after a recoverable failure, its one automatic retry. Undefined means an
   * orderly stop left the retry to the restarted daemon, so nothing is reported now.
   */
  async #attempts(
    turn: RunningTurn,
    shutdownSignal: AbortSignal,
    trace: TurnTraceBuffer,
  ): Promise<TurnAttempt | undefined> {
    const fields = { sessionId: turn.owner.request.sessionId, turnId: turn.owner.turnId };
    let interruption = turn.continuation;
    // Outgoing-reply receipts of every attempt share the Turn's run id; collect them once at the end.
    let planInput: ProviderCliTurnPlanPrepareInput | undefined;
    for (;;) {
      const attempt = await this.#attempt(turn, shutdownSignal, trace, interruption);
      planInput = attempt.turnPlanInput ?? planInput;
      const next = await this.#nextRetry(turn, attempt.completion, shutdownSignal);
      // An in-place retry follows a model failure; a 429 or a start failure waits first, a Provider exit does
      // not. False when an orderly stop interrupts the wait.
      const ready = next && next !== "deferred" && (await waitUnlessAborted(retryDelayMs(next.reason), shutdownSignal));
      if (next === "deferred" || ready === false) {
        this.#logger.info({ ...fields, reason: attempt.completion.errorReason }, "Turn left for retry after restart");
        await trace.finish();
        return undefined;
      }
      if (!next || !(await this.#claimRetry(turn))) {
        return { completion: attempt.completion, ...(planInput ? { turnPlanInput: planInput } : {}) };
      }
      this.#logger.info({ ...fields, reason: next.reason }, "Turn automatic retry started");
      interruption = next;
    }
  }

  /** One provider attempt of the Turn; a retry runs it again with the continuation notice. */
  async #attempt(
    turn: RunningTurn,
    shutdownSignal: AbortSignal,
    trace: TurnTraceBuffer,
    interruption: Interruption | undefined,
  ): Promise<TurnAttempt> {
    const owner = turn.owner;
    const startedAt = this.#now();
    turn.phase = "starting";
    const fields = {
      agentId: owner.request.agentId,
      deliveryId: owner.request.deliveryId,
      sessionId: owner.request.sessionId,
      turnId: owner.turnId,
    };
    this.#logger.info(fields, "Turn started");
    const timeout = new AbortController();
    // The ingress deadline bounds only the first attempt; later ones get what is left of the Run's budget.
    const timeoutMs = interruption
      ? remainingBudgetMs(owner.request.runtime.budget?.maxDurationMs, await this.#ranMs(turn))
      : turnTimeoutMs(owner.request, startedAt);
    turn.expiresAt = new Date(startedAt + timeoutMs).toISOString();
    const budget = runBudgetTimer(scheduleUnrefTimeout, this.#now, timeoutMs, () => timeout.abort("turn_timeout"));
    const runTime = trackRunTime(this.#now, (ranMs) =>
      this.#retries.update(owner.request.sessionId, owner.turnId, (record) => withRunTime(record, ranMs)),
    );
    // Waiting in-process for a quota reset is not running: neither the budget nor the run time advances.
    const onQuotaWait = (waiting: boolean): void => {
      if (waiting) {
        budget.pause();
        runTime.pause();
        return;
      }
      budget.resume();
      runTime.resume();
      /* v8 ignore next -- a resumed budget always has an expiry. */
      if (budget.expiresAt !== undefined) turn.expiresAt = new Date(budget.expiresAt).toISOString();
    };
    if (!interruption) abortExpiredTurn(owner.request, startedAt, timeout);
    const expiredBeforeStart = timeout.signal.aborted;
    const signal = AbortSignal.any([shutdownSignal, timeout.signal]);
    let completion: TurnCompletion;
    let terminalObserved = false;
    let releaseObserver: () => void = () => undefined;
    let turnPlanInput: ProviderCliTurnPlanPrepareInput | undefined;
    let preparedExecutionId: string | undefined;
    let credentialPrepared = false;
    const channelTurn = { sessionId: owner.request.sessionId, channel: false };
    const phaseTimings: TurnPhaseTimings = {};
    try {
      signal.throwIfAborted();
      const started = await this.#startTurn(owner, signal, interruption !== undefined);
      credentialPrepared = true;
      preparedExecutionId = started.preparedExecutionId;
      channelTurn.channel = isChannelOutbox(started.credentials.outboxContext);
      phaseTimings.credentialPrepareMs = started.credentialPrepareMs;
      const turnPlanStartedAt = this.#now();
      turnPlanInput = await this.#prepareTurnPlanForRun(owner, turn, started.credentials, signal);
      phaseTimings.turnPlanPrepareMs = Math.max(0, this.#now() - turnPlanStartedAt);
      const runSignal = started.runSignal;
      runSignal.throwIfAborted();
      const ensureStartedAt = this.#now();
      const runtime = await this.#runtimeManager.ensureRuntime(owner.request.sessionId, runSignal);
      phaseTimings.runtimeEnsureMs = Math.max(0, this.#now() - ensureStartedAt);
      turn.runtime = runtime;
      releaseObserver = this.#observeTurn(
        turn,
        runtime,
        trace,
        () => {
          terminalObserved = true;
        },
        onQuotaWait,
      );
      const promptStartedAt = this.#now();
      const input = await this.#turnInput(turn, runtime, interruption);
      const result = await runtime.prompt({
        runId: owner.turnId,
        ...(await beginChannelTurn(
          this.#channelActivity,
          { ...channelTurn, retry: interruption !== undefined },
          this.#now(),
        )),
        ...(started.allowedUnixSockets ? { allowedUnixSockets: started.allowedUnixSockets } : {}),
        /*
         * The processing clock is sampled at actual input construction — after credential
         * preparation, at the last moment before the Run dispatch — never
         * at delivery receipt. It is prompt input only and never enters a persistent hash.
         */
        input,
        signal: runSignal,
        /*
         * Provider-specific launch facts are resolved only when this execution actually carries
         * one, so a runtime manager with nothing to inject is never consulted at all.
         */
        ...(started.webTools || started.mcpGateway ? this.#providerLaunchConfiguration(started, owner) : {}),
      });
      phaseTimings.promptDurationMs = Math.max(0, this.#now() - promptStartedAt);
      turn.phase = "reporting";
      completion = completionForResult(result, signal.reason);
      // A failure the provider returned rather than threw is still a failure the reporter judges.
      if (completion.outcome !== "completed")
        this.#reportFailure(owner, completion, returnedFailure(result, completion));
    } catch (error) {
      turn.phase = "reporting";
      completion = completionForError(error, signal.reason, expiredBeforeStart);
      this.#logger.warn(
        {
          ...fields,
          durationMs: Math.max(0, this.#now() - startedAt),
          ...phaseTimings,
          errorReason: completion.errorReason,
          ...errorFieldsForLog(error),
          outcome: completion.outcome,
        },
        "Turn failed",
      );
      this.#reportFailure(owner, completion, error);
      /* v8 ignore else -- a terminal event observed before the failure already recorded the outcome. */
      if (!terminalObserved) trace.turnCompleted(completion.outcome);
    } finally {
      this.#activity.end(owner.turnId);
      releaseObserver();
      await endChannelTurn(this.#channelActivity, channelTurn, this.#now());
      if (turnPlanInput) {
        /* v8 ignore next -- turn-plan teardown is best-effort. */
        await this.#turnPlan?.cleanup(turnPlanInput).catch(() => undefined);
      }
      if (credentialPrepared) {
        /* v8 ignore next -- credential teardown is best-effort. */
        await this.#credentialEnvironment.cleanup(owner.request.sessionId, preparedExecutionId).catch(() => undefined);
      }
      budget.cancel();
      turn.unrecordedRunMs = await runTime.finish();
    }
    await this.#recordRunLimit(owner.request.sessionId, completion);
    if (completion.outcome === "completed") {
      this.#logger.info(
        {
          ...fields,
          durationMs: Math.max(0, this.#now() - startedAt),
          ...phaseTimings,
          outcome: completion.outcome,
        },
        "Turn completed",
      );
    }
    return { completion, ...(turnPlanInput ? { turnPlanInput } : {}) };
  }

  /** A Turn's input, after what the Session's earlier Runs left to tell it. */
  async #turnInput(
    turn: RunningTurn,
    runtime: AgentRuntime,
    interruption: Interruption | undefined,
  ): Promise<AgentInput> {
    const { request } = turn.owner;
    const input = interruption
      ? buildRetryAgentInput(
          request,
          this.#steersToRepeat(turn, runtime),
          interruption,
          new Date(this.#now()),
          this.#sessionMessages.input,
        )
      : buildAgentInput(request, undefined, undefined, new Date(this.#now()));
    return (await this.#backgroundWork?.forSession(request.sessionId).prefix(input)) ?? input;
  }

  async #recordRunLimit(sessionId: string, completion: TurnCompletion): Promise<void> {
    if (completion.errorReason !== "turn_timeout") return;
    await this.#backgroundWork
      ?.forSession(sessionId)
      .recordRunLimit({ reason: "turn_timeout", at: new Date(this.#now()).toISOString() });
  }

  /**
   * Decide what follows a finished attempt. Returns the recorded
   * interruption for an in-process retry, `deferred` when an orderly shutdown leaves the retry to
   * the restarted daemon, or undefined when the outcome is reported as is.
   */
  async #nextRetry(
    turn: RunningTurn,
    completion: TurnCompletion,
    shutdownSignal: AbortSignal,
  ): Promise<Interruption | "deferred" | undefined> {
    if (completion.outcome === "completed") return undefined;
    const reason = recoverableFailure(completion.errorReason);
    if (!reason) return undefined;
    // A start failure is retried only when it provably ran nothing.
    /* v8 ignore next -- every start failure is classified not_started today; this keeps a future one that may have run from being replayed. */
    if (reason === "provider_start_failed" && completion.executionEffects !== "not_started") return undefined;
    const restart = reason === "client_shutdown" || shutdownSignal.aborted;
    if (restart && !turn.restartRetry) return undefined;
    const interruption: Interruption = { reason, at: new Date(this.#now()).toISOString() };
    let record: Awaited<ReturnType<TurnRetryStore["update"]>>;
    try {
      // The count is decided now: the backoff before a retry is not run time.
      record = await this.#retries.update(turn.owner.request.sessionId, turn.owner.turnId, (current) => {
        const ran = withRunTime(current, turn.unrecordedRunMs);
        if (restart) return { ...ran, interruption };
        const { count } = nextRetry({ count: ran.retries, ranMs: ran.retryRanMs }, retryLimit(reason));
        return { ...ran, retries: count, retryRanMs: 0, interruption };
      });
    } catch {
      return undefined;
    }
    if (!record) return undefined;
    // The restarted daemon counts a process interruption and decides whether the Turn resumes.
    if (restart) return "deferred";
    return record.retries > MAX_AUTOMATIC_RETRIES ? undefined : interruption;
  }

  /** What the Turn has actually run so far, across its attempts. */
  async #ranMs(turn: RunningTurn): Promise<number> {
    const { sessionId } = turn.owner.request;
    const record = await this.#retries
      .update(sessionId, turn.owner.turnId, (current) => current)
      .catch(() => undefined);
    return record?.ranMs ?? 0;
  }

  /** The retry starts: its interruption is done with. False leaves the failure reported. */
  async #claimRetry(turn: RunningTurn): Promise<boolean> {
    const { sessionId } = turn.owner.request;
    // No new steer joins once the attempt ended, but one in flight may still be acknowledged: its
    // capture and receipt must be durable before the retry input is read.
    if (!(await this.#steersSettled(turn))) {
      this.#logger.warn(
        { code: "TURN_RETRY_STEER_UNSETTLED", sessionId, turnId: turn.owner.turnId },
        "Turn automatic retry refused: a steer is still in flight",
      );
      return false;
    }
    await this.#returnUnstartedSessionMessages(turn);
    const spent = await this.#retries.update(sessionId, turn.owner.turnId, withoutInterruption).catch(() => undefined);
    if (!spent) return false;
    const steers = spent.steers.length === 0 ? [] : await this.#acknowledgedImSteers(turn, spent);
    if (!steers) return false;
    // Session messages share this Turn's count: every retry carries the ones an earlier attempt held
    // and the ones that joined this attempt. They are not counted themselves.
    const messages = [
      ...turn.steers.filter((steer) => steer.type === "session:message:deliver"),
      ...[...turn.joined.values()].map(({ message }) => message),
    ];
    turn.joined = new Map();
    const arrival = (input: SteeredInput) => turn.arrivals.get(steeredInputId(input)) ?? 0;
    turn.steers = [...steers, ...messages].sort((left, right) => arrival(left) - arrival(right));
    return true;
  }

  async #acknowledgedImSteers(
    turn: RunningTurn,
    spent: Pick<TurnRetryRecord, "steers">,
  ): Promise<RuntimeImSteerRequest[] | undefined> {
    const { agentId, sessionId } = turn.owner.request;
    // Only the binding that still holds this Turn can say which steers it owns. Without it an
    // acknowledged steer cannot be told from an unacknowledged one, so a retry could silently drop
    // input the Server settled with this Turn: report the failure instead.
    const binding = await this.#bindingStore.read(agentId, sessionId).catch(() => undefined);
    if (binding?.unresolvedTurn?.turnId !== turn.owner.turnId) {
      this.#logger.warn(
        { code: "TURN_RETRY_STEER_RECEIPTS_UNAVAILABLE", sessionId, turnId: turn.owner.turnId },
        "Turn automatic retry refused: steer receipts are unavailable",
      );
      return undefined;
    }
    return acknowledgedSteers(spent.steers, binding);
  }

  /** A message the provider never began goes back to the inbox's FIFO instead of into the retry. */
  async #returnUnstartedSessionMessages(turn: RunningTurn): Promise<void> {
    for (const [id, { message, receipt }] of [...turn.joined]) {
      if ((await receipt.outcome) !== "not_started") continue;
      turn.joined.delete(id);
      await this.#sessionMessages.settle(message, "not_started");
    }
  }

  /** Every Session message that joined the Turn ends with it. */
  async #settleSessionMessages(turn: RunningTurn, completion: TurnCompletion): Promise<void> {
    turn.finalized = true;
    const completed = completion.outcome === "completed";
    const settle = (message: SessionMessageDeliveryRequestV3, outcome: AgentSteerOutcome) =>
      this.#sessionMessages.settle(message, outcome);
    await Promise.allSettled([
      ...turn.steers.flatMap((steer) =>
        steer.type === "session:message:deliver" ? [settle(steer, completed ? "processed" : "interrupted")] : [],
      ),
      ...[...turn.joined.values()].map(async ({ message, receipt }) => {
        const outcome = await receipt.outcome;
        await settle(message, outcome === "processed" && !completed ? "interrupted" : outcome);
      }),
    ]);
  }

  async #steersSettled(turn: RunningTurn): Promise<boolean> {
    if (turn.steering.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), STEER_SETTLE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([Promise.all(turn.steering).then(() => true), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hand a turn that did not complete to the reporter, whichever way it failed: a value the
   * provider threw, or a result it returned. Every failure goes; which of them is a defect is the
   * reporter's judgement, so the invariant the docs state holds literally.
   */
  #reportFailure(owner: LiveTurnOwner, completion: TurnCompletion, error: unknown): void {
    this.#agentErrorReporter({
      error,
      agentId: owner.request.agentId,
      sessionId: owner.request.sessionId,
      turnId: owner.turnId,
      errorReason: completion.errorReason,
      outcome: completion.outcome,
    });
  }

  #providerLaunchConfiguration(
    launch: { webTools?: PreparedWebToolsLaunch; mcpGateway?: PreparedMcpGatewayLaunch },
    owner: LiveTurnOwner,
  ): { configuration?: AgentRunConfiguration } {
    const providerId = this.#runtimeManager.providerId(owner.request.sessionId);
    const fields = { agentId: owner.request.agentId, sessionId: owner.request.sessionId, turnId: owner.turnId };
    if (launch.mcpGateway) {
      // The Server granted MCP tools; say whether they reach the provider, since the Agent cannot.
      if (providerSupportsMcpGateway(providerId)) {
        this.#logger.info({ ...fields, providerId }, "MCP gateway delivered to the provider");
      } else {
        this.#logger.warn(
          { ...fields, providerId, code: "mcp_gateway_unsupported_provider" },
          "MCP gateway was granted but the provider cannot mount it; MCP tools are unavailable this turn",
        );
      }
    }
    return providerLaunchConfiguration(launch, providerId);
  }

  /**
   * Marks the Turn as starting, prepares the trusted execution, and links revocation /
   * control-owner replacement into the Run abort signal. The provider prompt only starts
   * after this returns (or after an accepted delivery the Server already holds).
   */
  async #startTurn(
    owner: LiveTurnOwner,
    signal: AbortSignal,
    retry = false,
  ): Promise<{
    credentials: PreparedRuntimeCredentialEnvironment;
    preparedExecutionId?: string;
    allowedUnixSockets?: readonly string[];
    runSignal: AbortSignal;
    webTools?: PreparedWebToolsLaunch;
    mcpGateway?: PreparedMcpGatewayLaunch;
    credentialPrepareMs: number;
  }> {
    // A retry keeps the phase it reached: the durable custody phase never moves backwards.
    if (!retry) {
      await this.#bindingStore.updateUnresolved(
        owner.request.agentId,
        owner.request.sessionId,
        owner.turnId,
        "starting",
      );
    }
    const credentialStartedAt = this.#now();
    const credentials = await this.#credentialEnvironment.prepare(
      {
        agentId: owner.request.agentId,
        placementGeneration: owner.request.placementGeneration,
        sessionId: owner.request.sessionId,
        run: {
          runId: owner.turnId,
          source: { kind: "delivery", deliveryId: owner.request.deliveryId, turnId: owner.turnId },
        },
      },
      signal,
    );
    const credentialPrepareMs = Math.max(0, this.#now() - credentialStartedAt);
    const runSignal = credentials.signal ? AbortSignal.any([signal, credentials.signal]) : signal;
    return {
      credentials,
      ...(credentials.executionId ? { preparedExecutionId: credentials.executionId } : {}),
      ...(credentials.allowedUnixSockets ? { allowedUnixSockets: credentials.allowedUnixSockets } : {}),
      runSignal,
      ...(credentials.web ? { webTools: credentials.web } : {}),
      ...(credentials.mcp ? { mcpGateway: credentials.mcp } : {}),
      credentialPrepareMs,
    };
  }

  async #prepareTurnPlanForRun(
    owner: LiveTurnOwner,
    turn: RunningTurn,
    credentials: PreparedRuntimeCredentialEnvironment,
    signal: AbortSignal,
  ): Promise<ProviderCliTurnPlanPrepareInput | undefined> {
    if (!this.#turnPlan || this.#runtimeManager.sessionKind(owner.request.sessionId) !== "visible") return undefined;
    if (!credentials.provider) throw new ImCredentialEnvironmentError("credential_provider_missing");
    const turnPlanInput: ProviderCliTurnPlanPrepareInput = {
      provider: credentials.provider,
      sessionId: owner.request.sessionId,
      runId: owner.turnId,
      ...outgoingReplyCapturePlan(credentials.provider, turn.reportVersion >= 2),
      ...(credentials.slackConfigDir ? { configDir: credentials.slackConfigDir } : {}),
      ...(credentials.environmentManifest ? { environmentManifest: credentials.environmentManifest } : {}),
      ...(credentials.slackApiHost ? { slackApiHost: credentials.slackApiHost } : {}),
    };
    await this.#turnPlan.prepare(turnPlanInput, signal);
    return turnPlanInput;
  }

  async #collectOutgoingReplies(
    turnPlanInput: ProviderCliTurnPlanPrepareInput | undefined,
    owner: LiveTurnOwner,
    includeInReport: boolean,
  ): Promise<TurnOutgoingReplySnapshot | undefined> {
    if (turnPlanInput?.provider !== "feishu" || !this.#outgoingReplies) return undefined;
    let collected: ProviderCliOutgoingReplyCollectResult;
    try {
      collected = await this.#outgoingReplies.collect({
        sessionId: turnPlanInput.sessionId,
        runId: owner.turnId,
      });
    } catch {
      this.#logger.debug({ code: "outgoing_reply_collect_failed" }, "Outgoing reply collection failed");
      return includeInReport ? unavailableOutgoingReplies() : undefined;
    }
    if (!includeInReport) return undefined;
    const scope = feishuOutgoingReplyScope(owner.request.content.providerRef);
    if (!scope) return emptyCompleteOutgoingReplies();
    try {
      return snapshotOutgoingReplies(collected, scope);
    } catch {
      return unavailableOutgoingReplies();
    }
  }

  async #cleanupOutgoingReplies(
    turnPlanInput: ProviderCliTurnPlanPrepareInput | undefined,
    runId: string,
  ): Promise<void> {
    if (turnPlanInput?.provider !== "feishu" || !this.#outgoingReplies) return;
    await this.#outgoingReplies.cleanup({ sessionId: turnPlanInput.sessionId, runId }).catch(() => undefined);
  }
}

function outgoingReplyCapturePlan(
  provider: ProviderCliTurnPlanPrepareInput["provider"],
  includeInReport: boolean,
): Pick<ProviderCliTurnPlanPrepareInput, "captureOutgoingReplies"> {
  return provider === "feishu" && includeInReport ? { captureOutgoingReplies: true } : {};
}

export function buildAgentInput(
  request: DirectImMessageDeliveryRequest | RuntimeImSteerRequest,
  supplementalContext?: string,
  rootRuntime?: EffectiveRuntimeSnapshot,
  processedAt: Date = new Date(),
): AgentInput {
  const runtime = request.type === "im:deliver" ? request.runtime : rootRuntime;
  if (!runtime) throw new Error("A steer input requires the root runtime snapshot");
  const sessionInstructions = runtime.instructions.session?.trim();
  const provider = request.content.providerRef.provider;
  const observer = request.replyRole === "observer";
  /*
   * Attention states only whether this message addresses the Agent; the reply decision rules live once
   * in the managed system prompt ("When to speak"). An observer copy never handles the task, so it gets
   * the fact plus the reply-role restriction instead of any reply guidance.
   */
  const attentionFact =
    request.attention === "direct"
      ? "This message addresses you (a DM or an @-mention)."
      : "This message does not address you; you are listening (an overheard channel message or a Thread follow-up).";
  const { attentionMeaning, actionInstruction } = observer
    ? {
        attentionMeaning: `${attentionFact} Treat it as ambient channel context only; the observer reply role below governs what this Session may do with it.`,
        actionInstruction:
          "Do not run a provider CLI mutation for this observer copy. The CLI and credentials remain available because they are Session capabilities, not reply-role authorization.",
      }
    : request.attention === "direct"
      ? {
          attentionMeaning: `${attentionFact} Reply by default; the narrow exceptions are in "When to speak".`,
          actionInstruction:
            "A reply, including the result after an approval decision or a failure or blocker update, reaches the IM participant only through the provider CLI before this Turn ends; your final text to OpenTag does not count as the reply.",
        }
      : {
          attentionMeaning: `${attentionFact} Stay silent by default; reply only when it is clearly meant for you, per "When to speak".`,
          actionInstruction:
            "Ending this Turn without any provider action is the expected outcome when the message is not meant for you. If it is, reply through the provider CLI before this Turn ends.",
        };
  const replyRoleMeaning = observer
    ? "A Thread Session owns the provider reply and the task execution for this same message. Use this Channel delivery only for ambient channel context; do not reply, react, or perform any other provider mutation for this message, and do not investigate, execute or repeat, delegate, or create artifacts for that task. Finish this observer Turn without tool calls or task work."
    : "This Session owns any reply to this message; whether to reply follows the attention above.";
  // Rebind the provider's native user-facing output to OpenTag's runtime console. Merely saying that
  // final text is not auto-sent is too weak when the provider treats its final channel as the reply.
  const context = [
    '<opentag-im-context source="managed">',
    "OpenTag managed runtime context (not user-authored).",
    `Session: ${request.sessionId}`,
    `Agent revision: ${runtime.revision.agent.sequence}/${runtime.revision.agent.id}`,
    `Session revision: ${runtime.revision.session.sequence}/${runtime.revision.session.id}`,
    /*
     * Trustworthy processing-time UTC for every ordinary IM/steer input. There is no schedule
     * timezone to render here and the Runtime never guesses the user's local zone; the Agent
     * uses the execution environment's system clock when it needs a fresher value.
     */
    `Processing time (UTC): ${processedAt.toISOString()} (sampled when this input was assembled for actual processing, after any queue wait)`,
    ...buildProviderOutboxInstructions({
      actionInstruction,
      provider,
      target: request.content.providerRef,
      targetLabel: "Current provider reference",
    }),
    `Attention: ${request.attention}`,
    `Attention meaning: ${attentionMeaning}`,
    `Reply role: ${observer ? "observer" : "owner"}`,
    `Reply role meaning: ${replyRoleMeaning}`,
    "Reply role constrains task execution and provider actions for this delivery; it does not change this Session's authority or credential availability.",
    ...(sessionInstructions ? ["Session instructions:", sessionInstructions] : []),
    "</opentag-im-context>",
  ].join("\n");
  const resourceContext = runtimeResourceContext(request);
  return {
    items: [
      { type: "text", text: context },
      { type: "text", text: request.content.text },
      ...(request.content.history?.length
        ? [
            {
              type: "text" as const,
              text: `Bounded prior IM history${request.content.historyTruncated ? " (truncated)" : ""}:\n${request.content.history
                .map((item) => `[${item.occurredAt}] ${JSON.stringify(item.providerRef)}: ${item.text}`)
                .join("\n")}`,
            },
          ]
        : []),
      ...(supplementalContext ? [{ type: "text" as const, text: supplementalContext }] : []),
      ...(resourceContext ? [{ type: "text" as const, text: resourceContext }] : []),
    ],
  };
}

/**
 * The input of an automatic retry: the continuation notice, then the original input, then any
 * messages that had been steered into the interrupted Turn.
 */
export function buildRetryAgentInput(
  request: DirectImMessageDeliveryRequest,
  steers: readonly SteeredInput[],
  interruption: Interruption,
  processedAt: Date = new Date(),
  sessionMessageInput: NonNullable<AgentTurnRunnerOptions["sessionMessages"]>["input"] = NO_SESSION_MESSAGES.input,
): AgentInput {
  const original = buildAgentInput(request, undefined, undefined, processedAt);
  const steered = steers.flatMap((steer): AgentInput["items"] => {
    if (steer.type === "im:steer") {
      return [
        {
          type: "text",
          text: `[${steer.content.providerRef.provider} message ${JSON.stringify(steer.content.providerRef)}]: ${steer.content.text}`,
        },
      ];
    }
    return [...sessionMessageInput(steer, processedAt).items];
  });
  return {
    items: [
      { type: "text", text: buildContinuationNotice(interruption) },
      ...original.items,
      ...(steered.length
        ? [
            {
              type: "text" as const,
              text: "Messages that arrived during the interrupted turn, in order (they may also be in your history):",
            },
            ...steered,
          ]
        : []),
    ],
  };
}

function steeredInputId(input: SteeredInput): string {
  return input.type === "im:steer" ? `im:${input.deliveryId}` : `session:${input.messageId}`;
}

/** Without an owner no Session message can be carried by a retry. */
const NO_SESSION_MESSAGES: NonNullable<AgentTurnRunnerOptions["sessionMessages"]> = {
  input: () => {
    throw new Error("A Session message joined the Turn without an owner to build its input");
  },
  settle: async () => undefined,
};

/** Without durable Turn input no automatic retry is possible. */
const NO_TURN_RETRIES: NonNullable<AgentTurnRunnerOptions["retries"]> = {
  appendSteer: async () => "appended",
  removeSteer: async () => undefined,
  update: async () => undefined,
};

/** Only an explicit refusal proves the input had no effect: others can come after the provider took it. */
function steerNeverStarted(error: unknown): boolean {
  return error instanceof AgentRuntimeError && error.code === "steer_not_sent";
}

function withRunTime(record: TurnRetryRecord, ranMs: number): TurnRetryRecord & { retryRanMs: number } {
  return { ...record, ranMs: (record.ranMs ?? 0) + ranMs, retryRanMs: (record.retryRanMs ?? 0) + ranMs };
}

function withoutInterruption(record: TurnRetryRecord): TurnRetryRecord {
  const { interruption: _interruption, ...rest } = record;
  return rest;
}

/**
 * Resolves true after the delay, or false as soon as the signal aborts. Callers pass a signal that
 * is not aborted yet: an in-process retry is never chosen after shutdown began.
 */
function waitUnlessAborted(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Older/frozen requests carry resource metadata only in the wire field, never in their text. */
function runtimeResourceContext(request: DirectImMessageDeliveryRequest | RuntimeImSteerRequest): string | undefined {
  const resources = request.content.resources;
  if (!resources?.length) return undefined;
  const omitted = "\n[Additional attachment metadata omitted; read the source message using providerRef.]";
  const budget = RUNTIME_DIRECT_TEXT_MAX_BYTES - Buffer.byteLength(omitted);
  let text =
    "Attachment metadata (OpenTag identifiers, not provider-native IDs). Use providerRef to read the source message for native resource IDs:\n";
  for (const resource of resources) {
    const line = `${JSON.stringify(resource)}\n`;
    if (Buffer.byteLength(text + line) > budget) return `${text}${omitted}`;
    text += line;
  }
  return text;
}

export function completionForResult(result: AgentRunResult, abortReason: unknown): TurnCompletion {
  if (abortReason === "client_shutdown") {
    return { outcome: "cancelled", executionEffects: "may_have_occurred", errorReason: "client_shutdown" };
  }
  if (abortReason === "turn_timeout") {
    return { outcome: "failed", executionEffects: "may_have_occurred", errorReason: "turn_timeout" };
  }
  if (result.status === "completed") {
    const finalText = result.output.filter((item) => item.type === "text").at(-1)?.text;
    if (finalText && Buffer.byteLength(finalText, "utf8") > RUNTIME_FINAL_TEXT_MAX_BYTES) {
      return { outcome: "failed", executionEffects: "completed", errorReason: "output_too_large" };
    }
    return {
      outcome: "completed",
      executionEffects: "completed",
      ...(finalText ? { finalText } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
  if (result.status === "aborted" || result.status === "cancelled") {
    return {
      outcome: "cancelled",
      executionEffects: "may_have_occurred",
      errorReason: "provider_failed",
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }
  if (result.error?.code === "provider_start_failed") {
    return { outcome: "failed", executionEffects: "not_started", errorReason: "provider_start_failed" };
  }
  return {
    outcome: result.error?.code === "provider_protocol_error" ? "unknown" : "failed",
    executionEffects: "may_have_occurred",
    errorReason: providerTurnFailureReason(result.error?.code),
    ...(result.error?.retryAt ? { retryAt: result.error.retryAt } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

/**
 * The failure a returned result carries, as the thing the reporter is given. A provider that
 * returned a failed result threw nothing, so the reported value is built from the result's own
 * error; a result the runner itself refused — an oversized final text, a run cut short by the
 * signal — carries none, and is described by the reason the runner classified it under.
 */
function returnedFailure(result: AgentRunResult, completion: TurnCompletion): Error {
  if (result.error) {
    const error = new Error(result.error.message);
    error.name = `AgentRunError:${result.error.code}`;
    return error;
  }
  // Every completion the runner refuses names its reason; nothing here is reached without one.
  return new Error(`Agent run ${result.status} was classified as ${completion.errorReason}`);
}

/** The specific pre-execution rejection code behind a typed Turn failure, for the Computer's log only. */
function errorFieldsForLog(error: unknown): { errorCode?: string } {
  if (error instanceof ImCredentialEnvironmentError || error instanceof ProviderCliTurnPlanError) {
    return { errorCode: error.code };
  }
  if (error instanceof SessionRuntimeNotPreparedError) {
    return { errorCode: error.code };
  }
  return {};
}

export function completionForError(error: unknown, abortReason: unknown, expiredBeforeStart = false): TurnCompletion {
  if (abortReason === "client_shutdown") {
    return { outcome: "cancelled", executionEffects: "may_have_occurred", errorReason: "client_shutdown" };
  }
  if (abortReason === "turn_timeout") {
    return {
      outcome: "failed",
      executionEffects: expiredBeforeStart ? "not_started" : "may_have_occurred",
      errorReason: "turn_timeout",
    };
  }
  if (error instanceof ImCredentialEnvironmentError && error.code === "im_connection_unavailable") {
    return { outcome: "failed", executionEffects: "not_started", errorReason: "im_connection_unavailable" };
  }
  if (error instanceof ImCredentialEnvironmentError || error instanceof ProviderCliTurnPlanError) {
    return { outcome: "failed", executionEffects: "not_started", errorReason: "tool_setup_failed" };
  }
  if (error instanceof AgentRuntimeProviderUnavailableError) {
    return {
      outcome: "failed",
      executionEffects: "not_started",
      errorReason: error.result.issues.some((issue) => issue.code === "credential_missing")
        ? "model_login_missing"
        : "provider_start_failed",
    };
  }
  if (error instanceof ClientRuntimeProviderStartError) {
    return { outcome: "failed", executionEffects: "not_started", errorReason: "provider_start_failed" };
  }
  if (error instanceof SessionRuntimeNotPreparedError) {
    // The runner accesses Session metadata and ensures its runtime before dispatching the prompt.
    return { outcome: "failed", executionEffects: "not_started", errorReason: "provider_start_failed" };
  }
  if (error instanceof AgentProviderError) return completionForProviderError(error);
  return { outcome: "unknown", executionEffects: "may_have_occurred", errorReason: "turn_state_unknown" };
}

function approvalCommandPresentation(details: JsonValue | undefined, message: string | undefined) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  if (typeof details.command !== "string" || details.command.length === 0) return {};
  return {
    commandPresentation: {
      command: redactSensitive(details.command),
      reason: message && message !== details.command ? redactSensitive(message) : "",
    },
  };
}

function describeApprovalAction(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(describeApprovalAction).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "threadId",
            "turnId",
            "itemId",
            "approvalId",
            "environmentId",
            "reason",
            "cwd",
            "commandActions",
            "availableDecisions",
            "proposedExecpolicyAmendment",
          ].includes(key),
      )
      .map(
        ([key, entry]) =>
          `${key.replaceAll(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ")}: ${key === "arguments" ? JSON.stringify(entry, null, 2) : describeApprovalAction(entry)}`,
      )
      .join("\n");
  }
  return String(value);
}

/**
 * A thrown provider error keeps the code it was thrown with, the same way a returned one does.
 *
 * Both shipped providers throw `provider_protocol_error` rather than returning it, so without this
 * branch a real protocol failure reached the reporter as the catch-all `turn_state_unknown` and the
 * taxonomy's own name for it was never filed. `provider_error` is a run the provider refused or
 * lost, which the reporter declines like any other `provider_failed`.
 */
function completionForProviderError(error: AgentProviderError): TurnCompletion {
  if (error.code === "provider_start_failed") {
    return { outcome: "failed", executionEffects: "not_started", errorReason: "provider_start_failed" };
  }
  if (error.code === "provider_protocol_error") {
    return { outcome: "unknown", executionEffects: "may_have_occurred", errorReason: "provider_protocol_error" };
  }
  return {
    outcome: "failed",
    executionEffects: "may_have_occurred",
    errorReason: providerTurnFailureReason(error.code),
  };
}

function steerResult(
  request: RuntimeImSteerRequest,
  status: RuntimeImSteerResult["status"],
  reason?: Exclude<RuntimeImSteerResult, { status: "steered" }>["reason"],
): RuntimeImSteerResult {
  const base = {
    type: "im:steer:result" as const,
    requestId: request.requestId,
    deliveryId: request.deliveryId,
    sessionId: request.sessionId,
    placementGeneration: request.placementGeneration,
    rootDeliveryId: request.rootDeliveryId,
    expectedTurnId: request.expectedTurnId,
  };
  if (status === "steered") return { ...base, status };
  return { ...base, status, reason: reason as never } as RuntimeImSteerResult;
}

function providerTurnFailureReason(code: unknown): TurnFailureReason {
  if (code === "provider_protocol_error") return "provider_protocol_error";
  return ProviderFailureReasonSchema.safeParse(code).data ?? "provider_failed";
}
