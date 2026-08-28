import {
  computeRuntimeImMessageSemanticHash,
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  type RuntimeImSteerRequest,
  type RuntimeImSteerResult,
  type TurnFailureReason,
  type TurnReportHashInput,
  type TurnReportRequest,
} from "@opentag/shared";
import type { AgentInput, AgentRunResult, AgentRuntime, AgentRuntimeEvent } from "../agent-runtime/types.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import { AgentRuntimeProviderUnavailableError } from "./agent-runtime-provider-registry.js";
import {
  ImCredentialEnvironmentError,
  type ImCredentialEnvironmentManager,
} from "./im-credential-environment-manager.js";
import type { ImResourceFetcher } from "./im-resource-fetcher.js";
import { buildProviderOutboxInstructions } from "./provider-outbox-instructions.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import type { SessionBindingStore } from "./session-binding-store.js";
import { ClientRuntimeProviderStartError, type SessionRuntimeManager } from "./session-runtime-manager.js";
import { TurnTraceBuffer } from "./trace-buffer.js";
import type { LiveTurnOwner, TurnCustodyOwner } from "./turn-custody-owner.js";
import type { TurnReportOwner } from "./turn-report-owner.js";

export interface AgentTurnRunnerOptions {
  readonly bindingStore: SessionBindingStore;
  readonly connection: Pick<RuntimeConnection, "send">;
  readonly custody: Pick<TurnCustodyOwner, "markReporting" | "recordResult">;
  readonly logger?: ClientLogger;
  readonly now?: () => number;
  readonly onRuntimeEvent?: (event: AgentRuntimeEvent) => Promise<void> | void;
  readonly reportOwner: TurnReportOwner;
  readonly resourceFetcher?: ImResourceFetcher;
  readonly runtimeManager: SessionRuntimeManager;
  readonly credentialEnvironment: Pick<ImCredentialEnvironmentManager, "cleanup" | "prepare">;
}

interface RunningTurn {
  readonly abort: AbortController;
  readonly owner: LiveTurnOwner;
  phase: "starting" | "running" | "reporting";
  promise: Promise<void>;
  runtime?: AgentRuntime;
}

export interface TurnCompletion {
  readonly errorReason?: TurnFailureReason;
  readonly executionEffects: "completed" | "may_have_occurred" | "not_started";
  readonly finalText?: string;
  readonly outcome: "completed" | "failed" | "cancelled" | "unknown";
  readonly usage?: TurnReportHashInput["usage"];
}

export class AgentTurnRunner {
  readonly #bindingStore: SessionBindingStore;
  readonly #connection: Pick<RuntimeConnection, "send">;
  readonly #custody: Pick<TurnCustodyOwner, "markReporting" | "recordResult">;
  readonly #logger: ClientLogger;
  readonly #now: () => number;
  readonly #onRuntimeEvent?: AgentTurnRunnerOptions["onRuntimeEvent"];
  readonly #reportOwner: TurnReportOwner;
  readonly #resourceFetcher?: ImResourceFetcher;
  readonly #runtimeManager: SessionRuntimeManager;
  readonly #credentialEnvironment: AgentTurnRunnerOptions["credentialEnvironment"];
  readonly #turns = new Map<string, RunningTurn>();
  #stopped = false;

  constructor(options: AgentTurnRunnerOptions) {
    this.#bindingStore = options.bindingStore;
    this.#connection = options.connection;
    this.#custody = options.custody;
    this.#logger = options.logger ?? createLogger("turn");
    this.#now = options.now ?? Date.now;
    this.#onRuntimeEvent = options.onRuntimeEvent;
    this.#reportOwner = options.reportOwner;
    this.#resourceFetcher = options.resourceFetcher;
    this.#runtimeManager = options.runtimeManager;
    this.#credentialEnvironment = options.credentialEnvironment;
  }

  get activeCount(): number {
    return this.#turns.size;
  }

  start(owner: LiveTurnOwner): void {
    if (this.#stopped || this.#turns.has(owner.turnId)) return;
    const abort = new AbortController();
    const turn: RunningTurn = {
      abort,
      owner,
      phase: "starting",
      promise: Promise.resolve(),
    };
    turn.promise = this.#run(turn, abort.signal)
      .catch(() => undefined)
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

    try {
      const cwd = this.#runtimeManager.cwd(request.sessionId);
      const supplementalContext = await this.#resourceFetcher?.fetchForTurn(request, cwd);
      if (
        turn.phase !== "running" ||
        runtime.state.phase !== "running" ||
        runtime.state.activeRunId !== request.expectedTurnId
      ) {
        return steerResult(request, "deferred", "turn_not_running");
      }
      await runtime.steer({
        expectedRunId: request.expectedTurnId,
        input: buildAgentInput(request, supplementalContext, owner.request.runtime),
      });
    } catch {
      return steerResult(request, "deferred", "steer_state_unknown");
    }

    try {
      await this.#bindingStore.recordSteer(request, semanticHash);
    } catch {
      return steerResult(request, "deferred", "steer_state_unknown");
    }
    return steerResult(request, "steered");
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const turn of this.#turns.values()) turn.abort.abort("client_shutdown");
  }

  async settled(): Promise<void> {
    await Promise.all([...this.#turns.values()].map((turn) => turn.promise));
  }

  async #run(turn: RunningTurn, shutdownSignal: AbortSignal): Promise<void> {
    const owner = turn.owner;
    const startedAt = this.#now();
    const fields = {
      agentId: owner.request.agentId,
      deliveryId: owner.request.deliveryId,
      sessionId: owner.request.sessionId,
      turnId: owner.turnId,
    };
    this.#logger.info(fields, "Turn started");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort("turn_timeout"), turnTimeoutMs(owner.request, this.#now()));
    timer.unref();
    const signal = AbortSignal.any([shutdownSignal, timeout.signal]);
    const trace = new TurnTraceBuffer({
      sender: this.#connection,
      sessionId: owner.request.sessionId,
      turnId: owner.turnId,
      placementGeneration: owner.request.placementGeneration,
      now: this.#now,
    });
    let completion: TurnCompletion;
    let terminalObserved = false;
    let releaseObserver: () => void = () => undefined;
    try {
      await this.#bindingStore.updateUnresolved(
        owner.request.agentId,
        owner.request.sessionId,
        owner.turnId,
        "starting",
      );
      await this.#credentialEnvironment.prepare(owner.request, signal);
      const runtime = await this.#runtimeManager.ensureRuntime(owner.request.sessionId, signal);
      turn.runtime = runtime;
      const cwd = this.#runtimeManager.cwd(owner.request.sessionId);
      const supplementalContext = await this.#resourceFetcher?.fetchForTurn(owner.request, cwd);
      releaseObserver = this.#runtimeManager.observe(owner.request.sessionId, async (event) => {
        trace.record(event);
        if (event.type === "run_started" && event.runId === owner.turnId) {
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
          terminalObserved = true;
        }
        await this.#onRuntimeEvent?.(event);
      });
      const result = await runtime.prompt({
        runId: owner.turnId,
        input: buildAgentInput(owner.request, supplementalContext),
        signal,
      });
      turn.phase = "reporting";
      completion = completionForResult(result, signal.reason);
    } catch (error) {
      turn.phase = "reporting";
      completion = completionForError(error, signal.reason);
      this.#logger.warn(
        {
          ...fields,
          durationMs: Math.max(0, this.#now() - startedAt),
          errorReason: completion.errorReason,
          outcome: completion.outcome,
        },
        "Turn failed",
      );
      if (!terminalObserved) trace.turnCompleted(completion.outcome);
    } finally {
      releaseObserver();
      await this.#credentialEnvironment.cleanup(owner.request.sessionId).catch(() => undefined);
      clearTimeout(timer);
    }

    const traceSummary = await trace.finish();
    if (completion.outcome === "completed") {
      this.#logger.info(
        { ...fields, durationMs: Math.max(0, this.#now() - startedAt), outcome: completion.outcome },
        "Turn completed",
      );
    }
    const reportInput: TurnReportHashInput = {
      deliveryId: owner.request.deliveryId,
      turnId: owner.turnId,
      sessionId: owner.request.sessionId,
      agentId: owner.request.agentId,
      placementGeneration: owner.request.placementGeneration,
      outcome: completion.outcome,
      executionEffects: completion.executionEffects,
      ...(completion.finalText ? { finalText: completion.finalText } : {}),
      ...(completion.errorReason ? { errorReason: completion.errorReason } : {}),
      ...(completion.usage ? { usage: completion.usage } : {}),
      traceSummary,
    };
    let report: TurnReportRequest;
    try {
      report = this.#reportOwner.create(reportInput);
      await this.#custody.markReporting(owner.turnId, report);
    } catch {
      this.#logger.warn(fields, "Turn could not enter the reporting phase");
      return;
    }
    void this.#reportOwner
      .submit(report, () => this.#custody.recordResult(owner.turnId, report.resultHash))
      .catch(() => undefined);
  }
}

export function buildAgentInput(
  request: DirectImMessageDeliveryRequest | RuntimeImSteerRequest,
  supplementalContext?: string,
  rootRuntime?: EffectiveRuntimeSnapshot,
): AgentInput {
  const runtime = request.type === "im:deliver" ? request.runtime : rootRuntime;
  if (!runtime) throw new Error("A steer input requires the root runtime snapshot");
  const sessionInstructions = runtime.instructions.session?.trim() || "No additional Session instructions.";
  const provider = request.content.providerRef.provider;
  const attentionMeaning =
    request.attention === "direct"
      ? "A human explicitly addressed this Agent/Session. Handle the message normally, then choose whether to reply, react, send proactively, or take no provider action."
      : "This Agent overheard the message. Use the conversation context to choose whether to reply, react, send proactively, or take no action; by default avoid meaningless, duplicate, intrusive, or attention-seeking intervention.";
  const observer = request.replyRole === "observer";
  const replyRoleMeaning = observer
    ? "A Thread Session owns the provider reply for this same message. Use this Channel delivery only for ambient channel context; do not reply, react, or perform any other provider mutation for this message."
    : "This Session is the reply owner for this message. It may reply, react, send another provider message, or take no provider action.";
  // Rebind the provider's native user-facing output to OpenTag's runtime console. Merely saying that
  // final text is not auto-sent is too weak when the provider treats its final channel as the reply.
  const context = [
    '<opentag-im-context source="managed">',
    "OpenTag managed runtime context (not user-authored).",
    `Agent: ${request.agentId}`,
    `Session: ${request.sessionId}`,
    `Agent revision: ${runtime.revision.agent.sequence}/${runtime.revision.agent.id}`,
    `Session revision: ${runtime.revision.session.sequence}/${runtime.revision.session.id}`,
    ...buildProviderOutboxInstructions({
      actionInstruction: observer
        ? "Do not run a provider CLI mutation for this observer copy. The CLI and credentials remain available because they are Session capabilities, not reply-role authorization."
        : "If you choose to reply, react, or send proactively, run the provider CLI command before ending this Turn. Choosing to take no provider action remains valid.",
      provider,
      target: request.content.providerRef,
      targetLabel: "Current provider reference",
    }),
    `Attention: ${request.attention}`,
    `Attention meaning: ${attentionMeaning}`,
    "Attention does not change provider CLI or credential availability for this Turn.",
    `Reply role: ${observer ? "observer" : "owner"}`,
    `Reply role meaning: ${replyRoleMeaning}`,
    "Reply role constrains provider actions for this delivery; it does not change this Session's authority or credential availability.",
    "Session instructions:",
    sessionInstructions,
    "</opentag-im-context>",
  ].join("\n");
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
    ],
  };
}

export function turnTimeoutMs(request: DirectImMessageDeliveryRequest, now: number): number {
  const limits: number[] = [];
  if (request.runtime.budget?.maxDurationMs) limits.push(request.runtime.budget.maxDurationMs);
  if (request.deadlineAt) limits.push(Math.max(1, Date.parse(request.deadlineAt) - now));
  return Math.max(1, Math.min(...(limits.length > 0 ? limits : [RUNTIME_DEFAULT_MAX_DURATION_MS])));
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
    errorReason: result.error?.code === "provider_protocol_error" ? "provider_protocol_error" : "provider_failed",
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

export function completionForError(error: unknown, abortReason: unknown): TurnCompletion {
  if (abortReason === "client_shutdown") {
    return { outcome: "cancelled", executionEffects: "may_have_occurred", errorReason: "client_shutdown" };
  }
  if (abortReason === "turn_timeout") {
    return { outcome: "failed", executionEffects: "may_have_occurred", errorReason: "turn_timeout" };
  }
  if (error instanceof ImCredentialEnvironmentError) {
    return { outcome: "failed", executionEffects: "not_started", errorReason: "credential_unavailable" };
  }
  if (error instanceof AgentRuntimeProviderUnavailableError) {
    return {
      outcome: "failed",
      executionEffects: "not_started",
      errorReason: error.result.issues.some((issue) => issue.code === "credential_missing")
        ? "credential_unavailable"
        : "provider_start_failed",
    };
  }
  if (error instanceof ClientRuntimeProviderStartError) {
    return { outcome: "failed", executionEffects: "not_started", errorReason: "provider_start_failed" };
  }
  return { outcome: "unknown", executionEffects: "may_have_occurred", errorReason: "turn_state_unknown" };
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
