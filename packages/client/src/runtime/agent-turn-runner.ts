import {
  type DirectImMessageDeliveryRequest,
  RUNTIME_FINAL_TEXT_MAX_BYTES,
  type TurnFailureReason,
  type TurnReportHashInput,
  type TurnReportRequest,
} from "@opentag/shared";
import type { AgentInput, AgentRunResult, AgentRuntimeEvent } from "../agent-runtime/types.js";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { ImResourceFetcher } from "./im-resource-fetcher.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import type { RuntimeToolHost } from "./runtime-tool-host.js";
import type { SessionBindingStore } from "./session-binding-store.js";
import type { SessionRuntimeManager } from "./session-runtime-manager.js";
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
  readonly toolHost: RuntimeToolHost;
}

interface RunningTurn {
  readonly abort: AbortController;
  readonly promise: Promise<void>;
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
  readonly #toolHost: RuntimeToolHost;
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
    this.#toolHost = options.toolHost;
  }

  get activeCount(): number {
    return this.#turns.size;
  }

  start(owner: LiveTurnOwner): void {
    if (this.#stopped || this.#turns.has(owner.turnId)) return;
    const abort = new AbortController();
    const promise = this.#run(owner, abort.signal)
      .catch(() => undefined)
      .finally(() => this.#turns.delete(owner.turnId));
    this.#turns.set(owner.turnId, { abort, promise });
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const turn of this.#turns.values()) turn.abort.abort("client_shutdown");
  }

  async settled(): Promise<void> {
    await Promise.all([...this.#turns.values()].map((turn) => turn.promise));
  }

  async #run(owner: LiveTurnOwner, shutdownSignal: AbortSignal): Promise<void> {
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
    let releaseTools: () => void = () => undefined;
    let releaseObserver: () => void = () => undefined;
    try {
      await this.#bindingStore.updateUnresolved(
        owner.request.agentId,
        owner.request.sessionId,
        owner.turnId,
        "starting",
      );
      const runtime = this.#runtimeManager.runtime(owner.request.sessionId);
      const cwd = this.#runtimeManager.cwd(owner.request.sessionId);
      const supplementalContext = await this.#resourceFetcher?.fetchForTurn(owner.request, cwd);
      releaseTools = this.#toolHost.activateRun(owner.turnId, owner.request, owner.request.runtime.allowedTools);
      releaseObserver = this.#runtimeManager.observe(owner.request.sessionId, async (event) => {
        trace.record(event);
        if (event.type === "run_started" && event.runId === owner.turnId) {
          await this.#bindingStore.updateUnresolved(
            owner.request.agentId,
            owner.request.sessionId,
            owner.turnId,
            "running",
          );
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
      completion = completionForResult(result, signal.reason);
    } catch (error) {
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
      releaseTools();
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

export function buildAgentInput(request: DirectImMessageDeliveryRequest, supplementalContext?: string): AgentInput {
  const sessionInstructions = request.runtime.instructions.session?.trim() || "No additional Session instructions.";
  const context = [
    "OpenTag managed runtime context (not user-authored).",
    `Agent: ${request.agentId}`,
    `Session: ${request.sessionId}`,
    `Agent revision: ${request.runtime.revision.agent.sequence}/${request.runtime.revision.agent.id}`,
    `Session revision: ${request.runtime.revision.session.sequence}/${request.runtime.revision.session.id}`,
    "Reload and obey the managed AGENTS.md before acting.",
    "For a new IM write, omit retryRequestId; OpenTag assigns the request identity.",
    "Never automatically repeat an unknown IM write. Only when explicitly retrying the exact same payload, reuse the returned requestId as retryRequestId.",
    "Session instructions:",
    sessionInstructions,
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
                .map((item) => `[${item.occurredAt}] ${item.imMessageId}: ${item.text}`)
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
  return Math.max(1, Math.min(...(limits.length > 0 ? limits : [30 * 60 * 1_000])));
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
  return {
    outcome: result.error?.code === "provider_protocol_error" ? "unknown" : "failed",
    executionEffects: "may_have_occurred",
    errorReason: result.error?.code === "provider_protocol_error" ? "provider_protocol_error" : "provider_failed",
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

export function completionForError(_error: unknown, abortReason: unknown): TurnCompletion {
  if (abortReason === "client_shutdown") {
    return { outcome: "cancelled", executionEffects: "may_have_occurred", errorReason: "client_shutdown" };
  }
  if (abortReason === "turn_timeout") {
    return { outcome: "failed", executionEffects: "may_have_occurred", errorReason: "turn_timeout" };
  }
  return { outcome: "unknown", executionEffects: "may_have_occurred", errorReason: "turn_state_unknown" };
}
