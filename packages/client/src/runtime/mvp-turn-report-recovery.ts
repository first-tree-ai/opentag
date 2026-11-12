import {
  RUNTIME_MVP_RETAINED_REPORT_LIMIT,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type TurnReportRequest,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { LocalSessionBinding, SessionBindingStore } from "./session-binding-store.js";
import type { SessionReconciler } from "./session-reconciler.js";
import type { TurnCustodyOwner } from "./turn-custody-owner.js";
import type { TurnReportOwner } from "./turn-report-owner.js";

export interface MvpTurnReportRecoveryOptions {
  bindingStore: Pick<SessionBindingStore, "read" | "recordResult" | "updateUnresolved">;
  custody?: Pick<TurnCustodyOwner, "getTurn" | "recordResult">;
  logger?: ClientLogger;
  maxActiveReplays?: number;
  maxPreparedBatches?: number;
  reconciler: Pick<SessionReconciler, "claimRecovery" | "clearRecovery" | "withAgentLock">;
  reportOwner: Pick<TurnReportOwner, "create" | "rearmTerminal" | "submit">;
  /** Turns waiting for their automatic retry are not reported as interrupted. */
  retryGate?: { isPendingRetry(sessionId: string, turnId: string): boolean };
  /** Called once a replayed report is recorded, to drop the Turn's retry input. */
  onRecorded?(sessionId: string, turnId: string): Promise<void>;
}

type RetainedReportReference = NonNullable<SessionReconcileResult["retainedReports"]>[number];

interface RetainedReport {
  reference: RetainedReportReference;
  report: TurnReportRequest;
}

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
  readonly #custody: MvpTurnReportRecoveryOptions["custody"];
  readonly #logger: ClientLogger;
  readonly #maxActiveReplays: number;
  readonly #maxPreparedBatches: number;
  readonly #reconciler: MvpTurnReportRecoveryOptions["reconciler"];
  readonly #reportOwner: MvpTurnReportRecoveryOptions["reportOwner"];
  readonly #retryGate: MvpTurnReportRecoveryOptions["retryGate"];
  readonly #onRecorded: MvpTurnReportRecoveryOptions["onRecorded"];
  readonly #prepared = new Map<string, PreparedBatch>();
  readonly #queues = new Map<string, ReplayQueue>();
  #activeReplays = 0;

  constructor(options: MvpTurnReportRecoveryOptions) {
    this.#bindingStore = options.bindingStore;
    this.#custody = options.custody;
    this.#logger = options.logger ?? createLogger("report-recovery");
    this.#maxActiveReplays = options.maxActiveReplays ?? 10;
    this.#maxPreparedBatches = options.maxPreparedBatches ?? 256;
    this.#reconciler = options.reconciler;
    this.#reportOwner = options.reportOwner;
    this.#retryGate = options.retryGate;
    this.#onRecorded = options.onRecorded;
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
      let binding = await this.#bindingStore.read(request.agentId, request.sessionId);
      if (!matchesSession(binding, request)) return result;
      const unresolved = binding.unresolvedTurn;
      if (unresolved && !this.#claim(request, unresolved, binding.placementGeneration)) {
        return result;
      }
      if (unresolved && unresolved.phase !== "reporting") {
        const uncertain = unresolved.phase === "starting" || unresolved.phase === "running";
        const report = this.#reportOwner.create({
          deliveryId: unresolved.deliveryId,
          turnId: unresolved.turnId,
          sessionId: binding.sessionId,
          agentId: binding.agentId,
          placementGeneration: binding.placementGeneration,
          outcome: uncertain ? "unknown" : "failed",
          executionEffects: uncertain ? "may_have_occurred" : "not_started",
          errorReason: uncertain ? "turn_state_unknown" : "provider_start_failed",
          traceSummary: { lastSequence: 0, droppedEvents: 0 },
        });
        binding = await this.#bindingStore.updateUnresolved(
          request.agentId,
          request.sessionId,
          unresolved.turnId,
          "reporting",
          { report, resultHash: report.resultHash },
        );
      }
      const reports = retainedReports(binding);
      if (reports.length === 0) return result;
      if (reports.length > RUNTIME_MVP_RETAINED_REPORT_LIMIT) {
        throw new Error("The MVP retained Turn Report manifest exceeded its protocol limit");
      }
      if (!this.#prepared.has(request.requestId) && this.#prepared.size >= this.#maxPreparedBatches) {
        throw new Error("The MVP Turn Report prepared batch limit was reached");
      }
      const existing = this.#prepared.get(request.requestId);
      const references = reports.map((report) => report.reference);
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

  /**
   * A ready report can join its exact live reporting activity without taking over execution.
   * An interrupted Turn awaiting its automatic retry is not reported as failed.
   */
  #claim(
    request: SessionReconcileRequest,
    unresolved: { deliveryId: string; phase: string; turnId: string; report?: TurnReportRequest },
    generation: number,
  ): boolean {
    const reportReady =
      unresolved.phase === "reporting" && !!unresolved.report && generation === request.placementGeneration;
    if (
      !this.#reconciler.claimRecovery(
        request.sessionId,
        { deliveryId: unresolved.deliveryId, turnId: unresolved.turnId },
        { reportReady },
      )
    ) {
      return false;
    }
    return (
      unresolved.phase === "reporting" || this.#retryGate?.isPendingRetry(request.sessionId, unresolved.turnId) !== true
    );
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

  async #confirm(report: TurnReportRequest, disposition?: "superseded"): Promise<void> {
    const live = this.#custody?.getTurn(report.turnId);
    if (live) {
      if (
        live.request.agentId !== report.agentId ||
        live.request.sessionId !== report.sessionId ||
        live.request.deliveryId !== report.deliveryId ||
        live.request.placementGeneration !== report.placementGeneration
      ) {
        throw new Error("The retained Report does not match its live custody owner");
      }
      await this.#custody?.recordResult(report.turnId, report.resultHash, disposition);
    } else {
      await this.#reconciler.withAgentLock(report.agentId, async () => {
        await this.#bindingStore.recordResult(
          report.agentId,
          report.sessionId,
          report.turnId,
          report.resultHash,
          disposition,
        );
        this.#reconciler.clearRecovery(report.sessionId, report.turnId);
      });
    }
    await this.#recorded(report.sessionId, report.turnId);
  }

  async #recorded(sessionId: string, turnId: string): Promise<void> {
    if (!this.#onRecorded) return;
    await this.#onRecorded(sessionId, turnId).catch(() => undefined);
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
        const retained = retainedReports(binding).find((candidate) => reportMatchesReference(candidate, reference));
        if (!retained) {
          queue.references.shift();
          queue.keys.delete(reportKey(reference));
          continue;
        }
        const report = retained.report;
        this.#reportOwner.rearmTerminal(report);
        let reportTerminal: (() => void) | undefined;
        const terminal = new Promise<"terminal">((resolve) => {
          reportTerminal = () => resolve("terminal");
        });
        const submitted = this.#reportOwner
          .submit(report, (disposition) => this.#confirm(report, disposition), {
            resume: true,
            onTerminal: () => reportTerminal?.(),
          })
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

function matchesSession(
  binding: LocalSessionBinding | undefined,
  request: SessionReconcileRequest,
): binding is LocalSessionBinding {
  return binding?.agentId === request.agentId && binding.sessionId === request.sessionId;
}

function retainedReports(binding: Awaited<ReturnType<SessionBindingStore["read"]>>): RetainedReport[] {
  if (!binding) return [];
  const reports: RetainedReport[] = [];
  if (binding.unresolvedTurn?.phase === "reporting" && binding.unresolvedTurn.report) {
    reports.push({
      report: binding.unresolvedTurn.report,
      reference: reportReference(
        binding.unresolvedTurn.report,
        binding.unresolvedTurn.requestId,
        binding.unresolvedTurn.inputHash,
      ),
    });
  }
  for (const recorded of binding.recentRecordedInputs) {
    if (recorded.kind !== "turn") continue;
    if (
      recorded.report &&
      recorded.requestId &&
      !reports.some((candidate) => candidate.report.turnId === recorded.report?.turnId)
    ) {
      reports.push({
        report: recorded.report,
        reference: reportReference(recorded.report, recorded.requestId, recorded.inputHash),
      });
    }
  }
  return reports;
}

function reportKey(report: Pick<TurnReportRequest, "resultHash" | "turnId">): string {
  return `${report.turnId}:${report.resultHash}`;
}

function reportReference(
  report: TurnReportRequest,
  dispatchRequestId: string,
  inputHash: string,
): RetainedReportReference {
  return {
    dispatchRequestId,
    deliveryId: report.deliveryId,
    inputHash,
    turnId: report.turnId,
    placementGeneration: report.placementGeneration,
    resultHash: report.resultHash,
  };
}

function reportMatchesReference(report: RetainedReport, reference: RetainedReportReference): boolean {
  return (
    report.reference.dispatchRequestId === reference.dispatchRequestId &&
    report.reference.deliveryId === reference.deliveryId &&
    report.reference.inputHash === reference.inputHash &&
    report.reference.turnId === reference.turnId &&
    report.reference.placementGeneration === reference.placementGeneration &&
    report.reference.resultHash === reference.resultHash
  );
}
