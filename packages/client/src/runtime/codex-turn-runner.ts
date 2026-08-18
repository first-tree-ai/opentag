import { resolve } from "node:path";
import type { TurnFailureReason, TurnReportHashInput, TurnReportRequest } from "@opentag/shared";
import { type CodexAdapter, CodexTurnError, type CodexTurnOutcome } from "../providers/codex/adapter.js";
import { CodexAppServerError } from "../providers/codex/app-server-wire.js";
import type { AgentWorkspaceManager } from "./agent-workspace.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import type { SessionBindingStore } from "./session-binding-store.js";
import { TurnTraceBuffer } from "./trace-buffer.js";
import type { LiveTurnOwner, TurnCustodyOwner } from "./turn-custody-owner.js";
import type { TurnReportOwner } from "./turn-report-owner.js";

export interface CodexTurnRunnerOptions {
  adapter: CodexAdapter;
  bindingStore: SessionBindingStore;
  connection: Pick<RuntimeConnection, "send">;
  custody: Pick<TurnCustodyOwner, "markReporting" | "recordResult">;
  log?: (message: string) => void;
  now?: () => number;
  reportOwner: TurnReportOwner;
  workspace: AgentWorkspaceManager;
}

interface RunningTurn {
  abort: AbortController;
  promise: Promise<void>;
}

interface TurnCompletion {
  errorReason?: TurnFailureReason;
  executionEffects: "completed" | "may_have_occurred" | "not_started";
  finalText?: string;
  outcome: CodexTurnOutcome;
  usage?: TurnReportHashInput["usage"];
}

export class CodexTurnRunner {
  readonly #adapter: CodexAdapter;
  readonly #bindingStore: SessionBindingStore;
  readonly #connection: Pick<RuntimeConnection, "send">;
  readonly #custody: Pick<TurnCustodyOwner, "markReporting" | "recordResult">;
  readonly #log?: (message: string) => void;
  readonly #now: () => number;
  readonly #reportOwner: TurnReportOwner;
  readonly #workspace: AgentWorkspaceManager;
  readonly #turns = new Map<string, RunningTurn>();
  #stopped = false;

  constructor(options: CodexTurnRunnerOptions) {
    this.#adapter = options.adapter;
    this.#bindingStore = options.bindingStore;
    this.#connection = options.connection;
    this.#custody = options.custody;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#reportOwner = options.reportOwner;
    this.#workspace = options.workspace;
  }

  get activeCount(): number {
    return this.#turns.size;
  }

  start(owner: LiveTurnOwner): void {
    if (this.#stopped || this.#turns.has(owner.turnId)) return;
    const abort = new AbortController();
    const promise = this.#run(owner, abort.signal)
      .catch(() => undefined)
      .finally(() => {
        this.#turns.delete(owner.turnId);
      });
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
    const timeout = new AbortController();
    const timeoutMs = turnTimeoutMs(owner, this.#now());
    const timer = setTimeout(() => timeout.abort("turn_timeout"), timeoutMs);
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
    try {
      await this.#bindingStore.updateUnresolved(
        owner.request.agentId,
        owner.request.sessionId,
        owner.turnId,
        "starting",
      );
      const binding = await this.#bindingStore.read(owner.request.agentId, owner.request.sessionId);
      if (!binding) throw new Error("The Session binding disappeared before provider start");
      const cwd = await this.#workspace.cwd(owner.request.agentId);
      const result = await this.#adapter.runTurn({
        request: owner.request,
        cwd,
        agentsFile: resolve(cwd, "..", "AGENTS.md"),
        providerThreadId: binding.providerThreadId,
        signal,
        trace,
        onThreadReady: async (providerThreadId) => {
          await this.#bindingStore.updateUnresolved(
            owner.request.agentId,
            owner.request.sessionId,
            owner.turnId,
            "starting",
            { providerThreadId },
          );
        },
        onTurnStarted: async (providerTurnId) => {
          await this.#bindingStore.updateUnresolved(
            owner.request.agentId,
            owner.request.sessionId,
            owner.turnId,
            "running",
            { providerTurnId },
          );
        },
      });
      completion =
        result.outcome === "completed"
          ? {
              outcome: "completed",
              executionEffects: "completed",
              ...(result.finalText ? { finalText: result.finalText } : {}),
              ...(result.usage ? { usage: result.usage } : {}),
            }
          : {
              outcome: result.outcome,
              executionEffects: "may_have_occurred",
              errorReason: "provider_failed",
              ...(result.usage ? { usage: result.usage } : {}),
            };
    } catch (error) {
      if (error instanceof CodexTurnError && error.cause instanceof CodexAppServerError) {
        this.#log?.(`Turn ${owner.turnId} failed at the Codex boundary (${error.cause.code})`);
      }
      completion = completionForError(error, signal.reason);
      trace.turnCompleted(completion.outcome);
    } finally {
      clearTimeout(timer);
    }

    const traceSummary = await trace.finish();
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
      await this.#custody.markReporting(owner.turnId, report.resultHash);
    } catch {
      this.#log?.(`Turn ${owner.turnId} could not enter the reporting phase`);
      return;
    }
    void this.#reportOwner
      .submit(report, () => this.#custody.recordResult(owner.turnId, report.resultHash))
      .catch(() => undefined);
  }
}

function turnTimeoutMs(owner: LiveTurnOwner, now: number): number {
  const limits: number[] = [];
  if (owner.request.runtime.budget?.maxDurationMs) limits.push(owner.request.runtime.budget.maxDurationMs);
  if (owner.request.deadlineAt) limits.push(Math.max(1, Date.parse(owner.request.deadlineAt) - now));
  return Math.max(1, Math.min(...(limits.length > 0 ? limits : [30 * 60 * 1_000])));
}

function completionForError(error: unknown, abortReason: unknown): TurnCompletion {
  if (abortReason === "client_shutdown") {
    return { outcome: "cancelled", executionEffects: "may_have_occurred", errorReason: "client_shutdown" };
  }
  if (abortReason === "turn_timeout") {
    return { outcome: "failed", executionEffects: "may_have_occurred", errorReason: "turn_timeout" };
  }
  if (error instanceof CodexTurnError) {
    return {
      outcome:
        error.reason === "turn_state_unknown" || error.reason === "provider_teardown_failed" ? "unknown" : "failed",
      executionEffects: error.executionEffects,
      errorReason: error.reason,
    };
  }
  return { outcome: "failed", executionEffects: "not_started", errorReason: "configuration_conflict" };
}
