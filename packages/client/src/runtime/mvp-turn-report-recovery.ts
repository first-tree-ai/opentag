import {
  RUNTIME_MVP_RETAINED_REPORT_LIMIT,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
} from "@opentag/shared";
import type { SessionBindingStore } from "./session-binding-store.js";
import type { SessionReconciler } from "./session-reconciler.js";
import type { TurnReportOwner } from "./turn-report-owner.js";

export interface MvpTurnReportRecoveryOptions {
  bindingStore: Pick<SessionBindingStore, "read" | "recordResult">;
  log?: (message: string) => void;
  maxPreparedBatches?: number;
  reconciler: Pick<SessionReconciler, "clearRecovery" | "withAgentLock">;
  reportOwner: Pick<TurnReportOwner, "submit">;
}

interface PreparedBatch {
  agentId: string;
  reports: TurnReportRequest[];
  sessionId: string;
}

interface ReplayQueue {
  keys: Set<string>;
  reports: TurnReportRequest[];
  running: boolean;
}

// MVP bridge: the Client remains the durable result owner until Server-side durable
// Turn storage replaces this reconcile manifest and replay queue after MVP.
export class MvpTurnReportRecovery {
  readonly #bindingStore: MvpTurnReportRecoveryOptions["bindingStore"];
  readonly #log?: (message: string) => void;
  readonly #maxPreparedBatches: number;
  readonly #reconciler: MvpTurnReportRecoveryOptions["reconciler"];
  readonly #reportOwner: MvpTurnReportRecoveryOptions["reportOwner"];
  readonly #prepared = new Map<string, PreparedBatch>();
  readonly #queues = new Map<string, ReplayQueue>();

  constructor(options: MvpTurnReportRecoveryOptions) {
    this.#bindingStore = options.bindingStore;
    this.#log = options.log;
    this.#maxPreparedBatches = options.maxPreparedBatches ?? 256;
    this.#reconciler = options.reconciler;
    this.#reportOwner = options.reportOwner;
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
      this.#prepared.set(request.requestId, {
        agentId: request.agentId,
        reports,
        sessionId: request.sessionId,
      });
      this.#trimPrepared();
      return {
        ...result,
        retainedReports: reports.map((report) => ({
          deliveryId: report.deliveryId,
          turnId: report.turnId,
          placementGeneration: report.placementGeneration,
          resultHash: report.resultHash,
        })),
      };
    });
  }

  afterReconciled(request: SessionReconcileRequest): void {
    const batch = this.#prepared.get(request.requestId);
    if (!batch) return;
    this.#prepared.delete(request.requestId);
    const queue = this.#queues.get(batch.sessionId) ?? { keys: new Set<string>(), reports: [], running: false };
    if (!this.#queues.has(batch.sessionId)) this.#queues.set(batch.sessionId, queue);
    for (const report of batch.reports) {
      const key = reportKey(report);
      if (queue.keys.has(key)) continue;
      queue.keys.add(key);
      queue.reports.push(report);
    }
    if (!queue.running) void this.#runQueue(batch.agentId, batch.sessionId, queue);
  }

  async #runQueue(agentId: string, sessionId: string, queue: ReplayQueue): Promise<void> {
    queue.running = true;
    try {
      while (queue.reports.length > 0) {
        const report = queue.reports[0];
        if (!report) break;
        await this.#reportOwner.submit(report, () =>
          this.#reconciler.withAgentLock(agentId, async () => {
            await this.#bindingStore.recordResult(agentId, sessionId, report.turnId, report.resultHash);
            this.#reconciler.clearRecovery(sessionId, report.turnId);
          }),
        );
        queue.reports.shift();
        queue.keys.delete(reportKey(report));
      }
    } catch {
      this.#log?.(`MVP Turn Report replay for Session ${sessionId} remains pending`);
    } finally {
      queue.running = false;
      if (queue.reports.length === 0) this.#queues.delete(sessionId);
    }
  }

  #trimPrepared(): void {
    while (this.#prepared.size > this.#maxPreparedBatches) {
      const oldest = this.#prepared.keys().next().value;
      if (oldest === undefined) break;
      this.#prepared.delete(oldest);
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

function reportKey(report: TurnReportRequest): string {
  return `${report.turnId}:${report.resultHash}`;
}
