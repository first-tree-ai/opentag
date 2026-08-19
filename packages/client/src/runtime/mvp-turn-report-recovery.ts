import {
  RUNTIME_MVP_RETAINED_REPORT_LIMIT,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { SessionBindingStore } from "./session-binding-store.js";
import type { SessionReconciler } from "./session-reconciler.js";
import type { TurnReportOwner } from "./turn-report-owner.js";

export interface MvpTurnReportRecoveryOptions {
  bindingStore: Pick<SessionBindingStore, "read" | "recordResult">;
  logger?: ClientLogger;
  maxActiveReplays?: number;
  maxPreparedBatches?: number;
  reconciler: Pick<SessionReconciler, "clearRecovery" | "withAgentLock">;
  reportOwner: Pick<TurnReportOwner, "rearmTerminal" | "submit">;
}

type RetainedReportReference = NonNullable<SessionReconcileResult["retainedReports"]>[number];

interface PreparedBatch {
  agentId: string;
  pendingSends: number;
  sessionId: string;
}

interface ReplayQueue {
  agentId: string;
  blocked: boolean;
  keys: Set<string>;
  references: RetainedReportReference[];
  restartRequested: boolean;
  running: boolean;
}

// MVP bridge: the Client remains the durable result owner until Server-side durable
// Turn storage replaces this reconcile manifest and replay queue after MVP.
export class MvpTurnReportRecovery {
  readonly #bindingStore: MvpTurnReportRecoveryOptions["bindingStore"];
  readonly #logger: ClientLogger;
  readonly #maxActiveReplays: number;
  readonly #maxPreparedBatches: number;
  readonly #reconciler: MvpTurnReportRecoveryOptions["reconciler"];
  readonly #reportOwner: MvpTurnReportRecoveryOptions["reportOwner"];
  readonly #prepared = new Map<string, PreparedBatch>();
  readonly #queues = new Map<string, ReplayQueue>();
  #activeReplays = 0;

  constructor(options: MvpTurnReportRecoveryOptions) {
    this.#bindingStore = options.bindingStore;
    this.#logger = options.logger ?? createLogger("report-recovery");
    this.#maxActiveReplays = options.maxActiveReplays ?? 10;
    this.#maxPreparedBatches = options.maxPreparedBatches ?? 256;
    this.#reconciler = options.reconciler;
    this.#reportOwner = options.reportOwner;
    if (!Number.isSafeInteger(this.#maxActiveReplays) || this.#maxActiveReplays < 1) {
      throw new Error("MVP Turn Report active replay limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxPreparedBatches) || this.#maxPreparedBatches < 1) {
      throw new Error("MVP Turn Report prepared batch limit must be a positive safe integer");
    }
  }

  prepare(request: SessionReconcileRequest, result: SessionReconcileResult): Promise<SessionReconcileResult> {
    if (result.status === "rejected") return Promise.resolve(result);
    return this.#reconciler.withAgentLock(request.agentId, async () => {
      const binding = await this.#bindingStore.read(request.agentId, request.sessionId);
      if (!binding) return result;
      const reports = retainedReports(binding);
      if (reports.length === 0) return result;
      if (reports.length > RUNTIME_MVP_RETAINED_REPORT_LIMIT) {
        throw new Error("The MVP retained Turn Report manifest exceeded its protocol limit");
      }
      if (!this.#prepared.has(request.requestId) && this.#prepared.size >= this.#maxPreparedBatches) {
        throw new Error("The MVP Turn Report prepared batch limit was reached");
      }
      const existing = this.#prepared.get(request.requestId);
      const references = reports.map(reportReference);
      this.#prepared.set(request.requestId, {
        agentId: request.agentId,
        pendingSends: (existing?.pendingSends ?? 0) + 1,
        sessionId: request.sessionId,
      });
      return {
        ...result,
        retainedReports: references,
      };
    });
  }

  afterReconciled(request: SessionReconcileRequest, result: SessionReconcileResult): void {
    const references = result.retainedReports;
    if (!references || references.length === 0) return;
    const batch = this.#prepared.get(request.requestId);
    if (!batch) return;
    this.#prepared.delete(request.requestId);
    const queue = this.#queues.get(batch.sessionId) ?? {
      agentId: batch.agentId,
      blocked: false,
      keys: new Set<string>(),
      references: [],
      restartRequested: false,
      running: false,
    };
    if (queue.agentId !== batch.agentId) {
      this.#logger.warn(
        { agentId: batch.agentId, sessionId: batch.sessionId },
        "Turn Report replay has a conflicting Agent owner",
      );
      return;
    }
    if (!this.#queues.has(batch.sessionId)) this.#queues.set(batch.sessionId, queue);
    queue.blocked = false;
    if (queue.running) queue.restartRequested = true;
    for (const reference of references) {
      const key = reportKey(reference);
      if (queue.keys.has(key)) continue;
      queue.keys.add(key);
      queue.references.push(reference);
    }
    this.#startQueues();
  }

  cancel(
    request: Pick<SessionReconcileRequest, "requestId">,
    result: Pick<SessionReconcileResult, "retainedReports">,
  ): void {
    if (!result.retainedReports || result.retainedReports.length === 0) return;
    const batch = this.#prepared.get(request.requestId);
    if (!batch) return;
    if (batch.pendingSends === 1) this.#prepared.delete(request.requestId);
    else batch.pendingSends -= 1;
  }

  #startQueues(): void {
    for (const [sessionId, queue] of this.#queues) {
      if (this.#activeReplays >= this.#maxActiveReplays) return;
      if (queue.running || queue.blocked || queue.references.length === 0) continue;
      queue.running = true;
      this.#activeReplays += 1;
      void this.#runQueue(sessionId, queue).then((completed) => {
        const restartRequested = queue.restartRequested;
        queue.restartRequested = false;
        queue.running = false;
        queue.blocked = !completed && !restartRequested;
        this.#activeReplays -= 1;
        if (queue.references.length === 0 && this.#queues.get(sessionId) === queue) {
          this.#queues.delete(sessionId);
        }
        this.#startQueues();
      });
    }
  }

  async #runQueue(sessionId: string, queue: ReplayQueue): Promise<boolean> {
    this.#logger.info({ agentId: queue.agentId, sessionId }, "Turn Report replay started");
    try {
      while (queue.references.length > 0) {
        const reference = queue.references[0];
        if (!reference) break;
        const binding = await this.#bindingStore.read(queue.agentId, sessionId);
        const report = retainedReports(binding).find((candidate) => reportMatchesReference(candidate, reference));
        if (!report) {
          queue.references.shift();
          queue.keys.delete(reportKey(reference));
          continue;
        }
        this.#reportOwner.rearmTerminal(report);
        let reportTerminal: (() => void) | undefined;
        const terminal = new Promise<"terminal">((resolve) => {
          reportTerminal = () => resolve("terminal");
        });
        const submitted = this.#reportOwner
          .submit(
            report,
            () =>
              this.#reconciler.withAgentLock(queue.agentId, async () => {
                await this.#bindingStore.recordResult(queue.agentId, sessionId, report.turnId, report.resultHash);
                this.#reconciler.clearRecovery(sessionId, report.turnId);
              }),
            { onTerminal: () => reportTerminal?.() },
          )
          .then(() => "recorded" as const);
        if ((await Promise.race([submitted, terminal])) === "terminal") {
          this.#logger.warn(
            { agentId: queue.agentId, sessionId, turnId: report.turnId },
            "Turn Report replay reached a terminal Server status",
          );
          return false;
        }
        queue.references.shift();
        queue.keys.delete(reportKey(reference));
      }
      this.#logger.info({ agentId: queue.agentId, sessionId }, "Turn Report replay completed");
      return true;
    } catch {
      this.#logger.warn({ agentId: queue.agentId, sessionId }, "Turn Report replay remains pending");
      return false;
    }
  }
}

function retainedReports(binding: Awaited<ReturnType<SessionBindingStore["read"]>>): TurnReportRequest[] {
  if (!binding) return [];
  const reports: TurnReportRequest[] = [];
  if (binding.unresolvedTurn?.phase === "reporting" && binding.unresolvedTurn.report) {
    reports.push(binding.unresolvedTurn.report);
  }
  for (const recorded of binding.recentRecordedInputs) {
    if (recorded.report && !reports.some((report) => report.turnId === recorded.report?.turnId)) {
      reports.push(recorded.report);
    }
  }
  return reports;
}

function reportKey(report: Pick<TurnReportRequest, "resultHash" | "turnId">): string {
  return `${report.turnId}:${report.resultHash}`;
}

function reportReference(report: TurnReportRequest): RetainedReportReference {
  return {
    deliveryId: report.deliveryId,
    turnId: report.turnId,
    placementGeneration: report.placementGeneration,
    resultHash: report.resultHash,
  };
}

function reportMatchesReference(report: TurnReportRequest, reference: RetainedReportReference): boolean {
  return (
    report.deliveryId === reference.deliveryId &&
    report.turnId === reference.turnId &&
    report.placementGeneration === reference.placementGeneration &&
    report.resultHash === reference.resultHash
  );
}
