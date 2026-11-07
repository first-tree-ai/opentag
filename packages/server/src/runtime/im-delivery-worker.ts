import { randomUUID } from "node:crypto";
import {
  computeRuntimeImSteerInputHash,
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  type RuntimeImDeliveryContent,
  type RuntimeImSteerRequest,
  RuntimeImSteerRequestSchema,
} from "@opentag/shared";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
} from "../db/schema/index.js";
import type { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import {
  imAttrs,
  outcomeAttrs,
  runtimeAttrs,
  setActiveSpanAttributes,
  traceDeliveryClaim,
  updateCurrentPerformanceContext,
} from "../observability/index.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import {
  type EffectiveRuntimeSnapshotAssembler,
  EffectiveRuntimeSnapshotAssemblerError,
} from "../services/runtime-config/index.js";
import type { CloudDeliveryOwner } from "../services/sandboxes/index.js";
import type { ReadyRunnerAllocation } from "../services/sandboxes/sandbox-runner-service.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { appendPendingImBatch } from "./im-delivery-batch.js";
import { claimAttempt, claimPhase, dispatchClaimToken, maintainDeliveryClaimLease } from "./im-delivery-claim.js";
import {
  type CloudDeliveryClaimRow,
  CloudDeliveryCoordinator,
  readPersistedDeliveryRequest,
} from "./im-delivery-cloud.js";
import {
  deliveryMessageContent,
  ImDeliveryInputError,
  validateFreshImRequest,
  validateUndispatchedContent,
} from "./im-delivery-content.js";
import {
  type ClaimLease,
  deliveryLaneKey,
  fitDeliveryFrame,
  hasOtherCustody,
  loadDirectHistory,
} from "./im-delivery-custody.js";
import { isOperationCancellation, withOperationDeadline } from "./im-delivery-deadline.js";
import {
  type DeliveryFailureDeps,
  type DeliveryFailureOptions,
  deferRecoveryRetry,
  diagnosticContext,
  handleDeliveryFailure,
  recordDeliveryFailure,
  rejectDelivery,
  rejectInvalidDeliveryInput,
  releaseDeliveryDispatch,
  settleExhaustedTimeoutRun,
  settleLostReportOrDefer,
  settleUnreportableTurn,
} from "./im-delivery-failure.js";
import {
  createImDeliveryMaintenanceSchedulers,
  type ImDeliveryJanitorConfig,
  resolveImDeliveryJanitorConfig,
  runImDeliveryExpiry,
  runImDeliveryJanitor,
  runImDeliveryRetention,
} from "./im-delivery-janitor.js";
import { validateRecoveryPayload } from "./im-delivery-pinned-hash.js";
import { ImDeliveryReadyWakeup } from "./im-delivery-ready-wakeup.js";
import { acceptedReportClosed } from "./im-delivery-retry.js";
import { ImDeliverySelector, lockEligibleDelivery } from "./im-delivery-selector.js";
import { advanceParkedRetries } from "./im-delivery-work-query.js";
import type {
  CloudSessionAllocationPort,
  DeliveryAttempt,
  ImDeliveryDiagnosticReporter,
  ImDeliveryWorkerInput,
  RuntimeDeliveryWorkerMetric,
  WorkerClaim,
} from "./im-delivery-worker.types.js";
import { KeyedTaskScheduler } from "./keyed-task-scheduler.js";
import { PostgresRuntimeCustodyStore } from "./runtime-custody-store.js";
import type { RuntimeDomainOwner, RuntimeReconcileResult } from "./runtime-domain-owner.js";

const DEFAULT_INTERVAL_MS = 500;
const RETRY_DELAY_MS = 2_000;
const CLAIM_LEASE_MS = 15_000;
const CLAIM_RENEW_MS = 5_000;

function positiveWorkerLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
/** A claim deferred by another occupant: Local rows are declined steers, Cloud rows are custody races. */
function custodyDeferralCode(computerKind: "local" | "cloud"): string {
  return computerKind === "cloud" ? "IM_DELIVERY_CUSTODY_DEFERRED" : "IM_DELIVERY_STEER_DEFERRED";
}
/** The failure policy's ports, bound to one worker instance. */
function failureDepsFor(
  input: ImDeliveryWorkerInput,
  ports: {
    clock: () => Date;
    now: () => number;
    onDiagnostic: ImDeliveryDiagnosticReporter;
    onMetric: (metric: RuntimeDeliveryWorkerMetric) => void;
    readyRetryClaims: ReadonlySet<string>;
    recheckReady: (deliveryId: string) => void;
  },
): DeliveryFailureDeps {
  const settled = input.onDeliverySettled;
  return {
    database: input.database,
    now: ports.now,
    onDiagnostic: ports.onDiagnostic,
    onMetric: ports.onMetric,
    ...(input.logger ? { logger: input.logger } : {}),
    ...(settled ? { onDeliverySettled: settled } : {}),
    custody: new PostgresRuntimeCustodyStore(input.database, {
      now: ports.clock,
      ...(settled ? { onDeliverySettled: settled } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
    }),
    readyRetryClaims: ports.readyRetryClaims,
    recheckReady: ports.recheckReady,
  };
}
/** How long the placement Computer has been silent; a Computer that never registered is fully offline. */
function absentRuntimeMs(lastSeenAt: Date | null, now: number): number {
  return lastSeenAt ? now - lastSeenAt.getTime() : Number.POSITIVE_INFINITY;
}
function setDeliveryRowPerformanceContext(
  row: Pick<CloudDeliveryClaimRow, "agent" | "computer" | "session" | "delivery">,
  turnIdOverride?: string,
): void {
  const turnId = turnIdOverride ?? row.delivery.turnId ?? undefined;
  updateCurrentPerformanceContext({
    accountId: row.agent.createdByUserId,
    agentId: row.agent.id,
    computerId: row.computer.id,
    sessionId: row.session.id,
    deliveryId: row.delivery.id,
    ...(turnId ? { turnId } : {}),
  });
}
export class ImDeliveryWorker {
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #abort = new AbortController();
  readonly #work = new Set<Promise<unknown>>();
  readonly #selector: ImDeliverySelector;
  #claimOperation: Promise<WorkerClaim | undefined> | undefined;
  readonly #recoveries = new Map<string, { lease: ClaimLease; abort: AbortController }>();
  readonly #readyWakeup: ImDeliveryReadyWakeup;
  readonly #readyRetryClaims = new Set<string>();
  readonly #database: DatabaseClient;
  readonly #domain: RuntimeDomainOwner;
  readonly #assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  readonly #registry: ConnectionRegistry;
  readonly #cloudDelivery?: CloudDeliveryOwner;
  readonly #cloudAllocation?: CloudSessionAllocationPort;
  readonly #cloudCoordinator: CloudDeliveryCoordinator;
  readonly #intervalMs: number;
  readonly #janitorConfig: ImDeliveryJanitorConfig;
  readonly #claimLeaseMs: number;
  readonly #claimRenewMs: number;
  readonly #afterClaimRowLocked?: () => Promise<void>;
  readonly #beforeDeliveryAdmission?: (signal: AbortSignal) => Promise<void>;
  readonly #onDiagnostic: ImDeliveryDiagnosticReporter;
  /** Every give-up transition (backoff, release, terminal, unknown settlement) in one policy. */
  readonly #failures: DeliveryFailureDeps;
  readonly #onDeliverySettled?: (deliveryId: string) => void;
  readonly #supervisor?: BackgroundFailureSupervisor;
  readonly #clock: () => Date;
  readonly #now: () => number;
  readonly #operationTimeoutMs: number;
  readonly #maxQueueAgeMs?: number;
  readonly #scheduler: KeyedTaskScheduler;
  readonly #onMetric: (metric: RuntimeDeliveryWorkerMetric) => void;
  readonly #logger?: ServiceLogger;
  #timer?: ReturnType<typeof setInterval>;
  #janitorTimer?: ReturnType<typeof setInterval>;
  #retentionTimer?: ReturnType<typeof setInterval>;
  readonly #scheduleJanitor: () => void;
  readonly #scheduleRetention: () => void;

  constructor(input: ImDeliveryWorkerInput) {
    this.#database = input.database;
    this.#selector = new ImDeliverySelector(input.database);
    this.#domain = input.domain;
    this.#assembler = input.assembler;
    this.#registry = input.registry;
    this.#cloudDelivery = input.cloudDelivery;
    this.#cloudAllocation = input.cloudAllocation;
    this.#intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#janitorConfig = resolveImDeliveryJanitorConfig(input);
    this.#claimLeaseMs = input.claimLeaseMs ?? CLAIM_LEASE_MS;
    this.#claimRenewMs = input.claimRenewMs ?? CLAIM_RENEW_MS;
    this.#afterClaimRowLocked = input.afterClaimRowLocked;
    this.#beforeDeliveryAdmission = input.beforeDeliveryAdmission;
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
    this.#onDeliverySettled = input.onDeliverySettled;
    this.#supervisor = input.supervisor;
    this.#clock = input.now ?? (() => new Date());
    this.#now = () => this.#clock().getTime();
    this.#operationTimeoutMs = positiveWorkerLimit(input.operationTimeoutMs ?? 30_000, "operationTimeoutMs");
    this.#failures = failureDepsFor(input, {
      clock: this.#clock,
      now: this.#now,
      onDiagnostic: this.#onDiagnostic,
      onMetric: (metric) => this.#onMetric(metric),
      readyRetryClaims: this.#readyRetryClaims,
      recheckReady: (deliveryId) => this.#readyWakeup.recheck(deliveryId),
    });
    this.#maxQueueAgeMs =
      input.maxQueueAgeMs === undefined ? undefined : positiveWorkerLimit(input.maxQueueAgeMs, "maxQueueAgeMs");
    this.#scheduler = new KeyedTaskScheduler({
      maxConcurrent: positiveWorkerLimit(input.maxConcurrent ?? 8, "maxConcurrent"),
      maxQueuedPerKey: positiveWorkerLimit(input.maxQueuedPerAgent ?? 8, "maxQueuedPerAgent"),
      maxQueuedTotal: positiveWorkerLimit(input.maxQueuedTotal ?? 256, "maxQueuedTotal"),
      now: this.#now,
      supervisor: this.#supervisor,
    });
    this.#onMetric = input.onMetric ?? (() => undefined);
    this.#logger = input.logger;
    this.#cloudCoordinator = new CloudDeliveryCoordinator({
      ...(this.#logger ? { logger: this.#logger } : {}),
      database: this.#database,
      ...(this.#cloudDelivery ? { cloudDelivery: this.#cloudDelivery } : {}),
      ...(this.#cloudAllocation ? { cloudAllocation: this.#cloudAllocation } : {}),
      now: this.#now,
      onDiagnostic: this.#onDiagnostic,
      ...(this.#beforeDeliveryAdmission ? { beforeDeliveryAdmission: this.#beforeDeliveryAdmission } : {}),
      assembleRuntime: (attempt, sessionId, mode) => this.#assembleRuntime(attempt, sessionId, mode),
      replyRole: (messageId, sessionKind, threadKey) => this.#replyRole(messageId, sessionKind, threadKey),
      buildDeliveryContent: (contentInput) => this.#buildDeliveryContent(contentInput),
      hasOtherCustody: (subject) => hasOtherCustody(this.#database, subject),
      recordFailure: (attempt, code, options) => this.#recordFailure(attempt, code, options),
      releaseDispatch: (attempt, requestId, code) => this.#releaseDispatch(attempt, requestId, code),
      rejectInput: async (deliveryId, reason, claimToken) => {
        await this.#reject(deliveryId, reason, claimToken);
      },
      withActiveAgentAdmission: (expected, operation, signal) =>
        this.#withActiveAgentAdmission(expected, operation, signal),
    });
    this.#readyWakeup = new ImDeliveryReadyWakeup({
      database: this.#database,
      allocation: this.#cloudAllocation,
      now: this.#clock,
      runSession: (sessionId) => {
        this.#selector.invalidate(sessionId);
        return this.#runTracked(sessionId);
      },
      supervisor: this.#supervisor,
      onDiagnostic: this.#onDiagnostic,
    });
    const schedulers = createImDeliveryMaintenanceSchedulers({
      expiryRun: () => this.runExpiryOnce(),
      retentionRun: () => this.runRetentionOnce(),
      supervisor: this.#supervisor,
      onDiagnostic: this.#onDiagnostic,
    });
    this.#scheduleJanitor = schedulers.expiry;
    this.#scheduleRetention = schedulers.retention;
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.#schedule();
    this.#timer = setInterval(() => this.#schedule(), this.#intervalMs);
    this.#timer.unref();
    this.#janitorTimer = setInterval(() => this.#scheduleJanitor(), this.#janitorConfig.janitorIntervalMs);
    this.#janitorTimer.unref();
    this.#retentionTimer = setInterval(() => this.#scheduleRetention(), this.#janitorConfig.retentionIntervalMs);
    this.#retentionTimer.unref();
  }

  stop(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#abort.abort();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#janitorTimer) clearInterval(this.#janitorTimer);
    this.#janitorTimer = undefined;
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#retentionTimer = undefined;
    const scheduler = this.#scheduler.close();
    this.#selector.invalidate();
    const wakeups = this.#readyWakeup.stop();
    this.#closing = (async () => {
      await Promise.allSettled([scheduler, wakeups]);
      while (this.#work.size) await Promise.allSettled([...this.#work]);
    })();
    return this.#closing;
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#work.add(operation);
    void operation.then(
      () => this.#work.delete(operation),
      () => this.#work.delete(operation),
    );
    return operation;
  }

  runJanitorOnce(): Promise<void> {
    return this.#track(this.#runJanitor());
  }

  async #runJanitor(): Promise<void> {
    if (this.#closed) return;
    const options = { ...this.#janitorConfig, clock: this.#clock, ...(this.#logger ? { logger: this.#logger } : {}) };
    await runImDeliveryJanitor(this.#database, options, this.#onDeliverySettled, this.#onDiagnostic);
    if (!this.#closed) await this.#cloudCoordinator.reconcileStoppedWork();
  }

  runExpiryOnce(): Promise<void> {
    return this.#track(
      (async () => {
        if (this.#closed) return;
        const options = {
          ...this.#janitorConfig,
          clock: this.#clock,
          ...(this.#logger ? { logger: this.#logger } : {}),
        };
        await runImDeliveryExpiry(this.#database, options, this.#onDeliverySettled, this.#onDiagnostic);
        if (!this.#closed) await this.#cloudCoordinator.reconcileStoppedWork();
      })(),
    );
  }

  runRetentionOnce(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#track(runImDeliveryRetention(this.#database, { ...this.#janitorConfig, clock: this.#clock }));
  }

  async runOnce(): Promise<void> {
    await this.#runTracked();
  }

  #runTracked(sessionId?: string): Promise<void> {
    return this.#track(this.#runOnce(sessionId));
  }

  async #runOnce(sessionId?: string): Promise<void> {
    if (this.#closed) return;
    const claimed = await this.#claim(sessionId);
    if (!claimed) return;
    if (this.#closed) {
      await this.#releaseRecovery(claimed.id);
      return;
    }
    this.#logger?.info(
      {
        module: "im-delivery",
        operation: "im.delivery.claim",
        outcome: "claimed",
        deliveryId: claimed.id,
        agentId: claimed.agentId,
        kind: claimed.kind,
        laneKey: claimed.laneKey,
      },
      "IM delivery claimed",
    );
    const queueAge = Math.max(0, this.#now() - claimed.queuedAt);
    this.#onMetric({ name: "queue_age_ms", value: queueAge, agentId: claimed.agentId });
    if (this.#maxQueueAgeMs !== undefined && queueAge > this.#maxQueueAgeMs) {
      this.#onMetric({ name: "saturation", value: 1, agentId: claimed.agentId });
      try {
        await this.#recordFailure(claimAttempt(claimed, "claim"), "IM_DELIVERY_QUEUE_AGE_EXCEEDED");
      } finally {
        await this.#releaseRecovery(claimed.id);
      }
      return;
    }
    const attempt = claimAttempt(claimed, claimPhase(claimed));
    const recovery = this.#recoveries.get(claimed.id);
    let started = false;
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const complete = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const run = async () => {
      started = true;
      if (sessionId && "claimToken" in claimed) this.#readyRetryClaims.add(claimed.claimToken);
      this.#onMetric({ name: "active_lanes", value: this.#scheduler.stats().active, agentId: claimed.agentId });
      let failed = false;
      try {
        await withOperationDeadline(
          this.#operationTimeoutMs,
          async (deadlineSignal) => {
            const signal = AbortSignal.any([
              deadlineSignal,
              this.#abort.signal,
              ...(recovery ? [recovery.abort.signal] : []),
            ]);
            await this.#track(
              traceDeliveryClaim(claimed, async (claim) => {
                if (claim.kind === "pending") await this.#deliver(claim, signal);
                else if (claim.kind === "steer") await this.#deliverSteer(claim, signal);
                else if (recovery) await this.#runRecovery(claim, recovery.lease, signal, deadlineSignal);
              }),
            );
          },
          async () => {
            this.#onMetric({ name: "timeout", value: 1, agentId: claimed.agentId });
            // A timeout cannot discard accepted custody or overwrite a later report/attempt.
            if (!recovery) await this.#recordFailure(attempt, "IM_DELIVERY_OPERATION_TIMEOUT");
          },
          async () => {
            this.#onDiagnostic("IM_DELIVERY_OPERATION_LATE_SETTLE", diagnosticContext(attempt));
            this.#onMetric({ name: "late_settle", value: 1, agentId: claimed.agentId });
            // The outcome is known now, so the terminal decision can no longer contradict it.
            await settleExhaustedTimeoutRun(this.#failures, attempt);
          },
          () => this.#onDiagnostic("IM_DELIVERY_OPERATION_ABANDONED", diagnosticContext(attempt)),
        );
      } catch (error) {
        if (
          recovery &&
          [this.#abort.signal, recovery.abort.signal].some((signal) => isOperationCancellation(error, signal))
        )
          return;
        failed = true;
        reject(error);
        throw error;
      } finally {
        if ("claimToken" in claimed) this.#readyRetryClaims.delete(claimed.claimToken);
        this.#onMetric({ name: "active_lanes", value: this.#scheduler.stats().active, agentId: claimed.agentId });
        if (!failed) resolve();
      }
    };
    try {
      const enqueued = this.#scheduler.enqueue(claimed.laneKey, run, () => {
        if (recovery) {
          void this.#releaseRecovery(claimed.id).then(resolve, reject);
          return;
        }
        this.#onMetric({ name: "saturation", value: 1, agentId: claimed.agentId });
        void this.#recordFailure(claimAttempt(claimed, "claim"), "IM_DELIVERY_WORKER_SATURATED")
          .catch(() => undefined)
          .finally(resolve);
      });
      if (!enqueued) {
        if (recovery && this.#closed) {
          await this.#releaseRecovery(claimed.id);
          resolve();
        } else {
          this.#onMetric({ name: "saturation", value: 1, agentId: claimed.agentId });
          await this.#recordFailure(claimAttempt(claimed, "claim"), "IM_DELIVERY_WORKER_SATURATED");
          resolve();
        }
      }
      this.#onMetric({ name: "queued_tasks", value: this.#scheduler.stats().queued, agentId: claimed.agentId });
      await complete;
    } finally {
      if (!started) await this.#releaseRecovery(claimed.id);
    }
  }

  async #releaseRecovery(deliveryId: string): Promise<void> {
    const recovery = this.#recoveries.get(deliveryId);
    if (!recovery) return;
    await recovery.lease.stop();
    this.#recoveries.delete(deliveryId);
  }

  notifyCloudRunnerReady(allocation: ReadyRunnerAllocation): Promise<void> {
    return this.#readyWakeup.notify(allocation);
  }

  /** A Computer's runtime became usable again, so its offline-parked retries are due again. */
  notifyComputerReady(computerId: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#track(advanceParkedRetries(this.#database, computerId, this.#now()));
  }

  #schedule(): void {
    // Coalesce polling while a claim is pending; runtime execution remains concurrent.
    if (this.#claimOperation) return;
    const operation = this.runOnce().catch((error: unknown) => {
      this.#onDiagnostic("IM_DELIVERY_WORKER_SCHEDULING_FAILED", { phase: "worker" });
      throw error;
    });
    if (this.#supervisor) {
      this.#supervisor.track(operation, {
        code: "IM_DELIVERY_WORKER_SCHEDULING_FAILED",
        category: "internal",
        retryability: "backoff",
        phase: "worker",
        operation: "im-delivery-worker.schedule",
      });
      return;
    }
    void operation.catch(() => undefined);
  }

  async #claim(sessionId?: string): Promise<WorkerClaim | undefined> {
    // Explicit/ready calls queue rather than losing the notification during a concurrent scan.
    while (this.#claimOperation) {
      try {
        await this.#claimOperation;
      } catch {
        /* The original caller reports its failure. */
      }
    }
    if (this.#closed) return undefined;
    const operation = this.#claimNext(sessionId);
    this.#claimOperation = operation;
    let claim: WorkerClaim | undefined;
    try {
      claim = await operation;
      if (claim?.kind === "recovery") {
        const abort = new AbortController();
        const lease = this.#maintainClaimLease(claimAttempt(claim, "recover"), () =>
          abort.abort(new Error("IM_DELIVERY_CLAIM_LOST")),
        );
        this.#recoveries.set(claim.id, { lease, abort });
      }
    } finally {
      this.#claimOperation = undefined;
    }
    // Diagnostics hooks and runtime work do not hold the claim single-flight gate.
    try {
      if (claim) await this.#afterClaimRowLocked?.();
      return claim;
    } catch (error) {
      if (claim) await this.#releaseRecovery(claim.id);
      throw error;
    }
  }

  async #claimNext(sessionId?: string): Promise<WorkerClaim | undefined> {
    let attempts = 0;
    for await (const candidate of this.#selector.candidates(this.#clock(), sessionId)) {
      if (this.#closed) return undefined;
      if (this.#recoveries.has(candidate.row.id)) continue;
      const claimed = await this.#claimCandidate(candidate.row.id, candidate.context.agentId, sessionId);
      this.#selector.invalidate(candidate.row.sessionId);
      if (claimed) return claimed;
      if (++attempts >= 8) return undefined;
    }
    return undefined;
  }

  // The durable marker bridges the transaction-to-runtime gap. The Agent advisory lock
  // serializes claim decisions; the marker and custody fence preserve ownership after commit.
  async #claimCandidate(
    deliveryId: string,
    expectedAgentId: string,
    sessionId?: string,
  ): Promise<WorkerClaim | undefined> {
    let uncertainDeliveryId: string | undefined;
    let uncertainAgentId: string | undefined;
    const claim = await this.#database.transaction(async (transaction) => {
      const now = this.#clock();
      const locked = await lockEligibleDelivery(transaction, deliveryId, expectedAgentId, now, sessionId);
      if (!locked) return undefined;
      const { row, custody } = locked;
      const subject = {
        deliveryId: row.id,
        agentId: row.agentId,
        sessionId: row.sessionId,
        computerKind: row.computerKind,
      };
      const otherCustody = row.state === "accepted" ? undefined : custody.other(subject);
      const laneKey = deliveryLaneKey(subject);
      let steerTarget: { id: string; turnId: string } | undefined;
      if (otherCustody) {
        const instanceId =
          row.computerKind === "cloud"
            ? this.#cloudDelivery?.inputInstance(row.sessionId)
            : this.#registry.currentInstanceId(row.computerId);
        if (
          !["pending", "expired"].includes(row.state) ||
          (row.dispatchRequestId !== null && row.steerTargetDeliveryId !== otherCustody.id) ||
          otherCustody.state !== "accepted" ||
          otherCustody.sessionId !== row.sessionId ||
          otherCustody.reportedAt !== null ||
          !otherCustody.turnId ||
          !instanceId ||
          otherCustody.reportOwnerInstanceId !== instanceId ||
          !(row.computerKind === "cloud"
            ? this.#cloudDelivery?.canSteer(row.sessionId, instanceId)
            : this.#registry.supportsCapability(row.computerId, instanceId, RUNTIME_CAPABILITY.imSteer))
        ) {
          // A declined steer must be deferred, not skipped: returning without advancing the row
          // makes the same earliest row win every tick and block all other tenants' deliveries.
          await transaction
            .update(imMessageDeliveries)
            .set({
              nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS),
              lastErrorCode: custodyDeferralCode(row.computerKind),
            })
            .where(eq(imMessageDeliveries.id, row.id));
          return undefined;
        }
        steerTarget = { id: otherCustody.id, turnId: otherCustody.turnId };
      }
      if (row.state === "accepted") {
        await transaction
          .update(imMessageDeliveries)
          .set({
            attemptCount: sql`${imMessageDeliveries.attemptCount} + 1`,
            nextAttemptAt: new Date(now.getTime() + this.#claimLeaseMs),
            lastErrorCode: null,
          })
          .where(and(eq(imMessageDeliveries.id, row.id), eq(imMessageDeliveries.state, "accepted")));
        return {
          id: row.id,
          agentId: row.agentId,
          computerId: row.computerId,
          attemptCount: row.attemptCount + 1,
          previousErrorCode: row.lastErrorCode,
          laneKey,
          queuedAt: row.nextAttemptAt.getTime(),
          kind: "recovery" as const,
        };
      }
      const staleCorrelation = staleDispatchGeneration(row);
      if (staleCorrelation) {
        await transaction
          .update(imMessageDeliveries)
          .set({
            nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS),
            lastErrorCode: "IM_DELIVERY_PLACEMENT_STALE",
          })
          .where(eq(imMessageDeliveries.id, row.id));
        return undefined;
      }
      const retiredSteerCorrelation = frozenSteerMatches(row);
      if (retiredSteerCorrelation && !steerTarget) {
        if (await recoverableSteerTarget(transaction, row)) {
          await transaction
            .update(imMessageDeliveries)
            .set({ nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS) })
            .where(eq(imMessageDeliveries.id, row.id));
          return undefined;
        }
        await transaction
          .update(imMessageDeliveries)
          .set({
            state: "terminal_rejected",
            reason: "steer_state_unknown",
            lastErrorCode: "IM_DELIVERY_STEER_UNKNOWN",
          })
          .where(
            or(
              eq(imMessageDeliveries.id, row.id),
              and(
                eq(imMessageDeliveries.steerTargetDeliveryId, row.id),
                eq(imMessageDeliveries.reason, "batch_pending"),
              ),
            ),
          );
        uncertainDeliveryId = row.id;
        uncertainAgentId = row.agentId;
        return undefined;
      }
      if (retiredSteerCorrelation && row.lastErrorCode === "IM_DELIVERY_STEER_UNKNOWN") {
        await transaction
          .update(imMessageDeliveries)
          .set({ nextAttemptAt: new Date(now.getTime() + 30_000) })
          .where(eq(imMessageDeliveries.id, row.id));
        return undefined;
      }
      const claimToken = dispatchClaimToken();
      await transaction
        .update(imMessageDeliveries)
        .set({
          attemptCount: sql`${imMessageDeliveries.attemptCount} + 1`,
          ...(row.state === "pending" ? { placementGeneration: row.generation } : {}),
          executionOrigin: sql`case when ${imMessageDeliveries.dispatchRequestId} is null then null else ${imMessageDeliveries.executionOrigin} end`,
          nextAttemptAt: new Date(now.getTime() + this.#claimLeaseMs),
          lastErrorCode: claimToken,
        })
        .where(eq(imMessageDeliveries.id, row.id));
      return steerTarget
        ? {
            id: row.id,
            agentId: row.agentId,
            computerId: row.computerId,
            attemptCount: row.attemptCount + 1,
            previousErrorCode: row.lastErrorCode,
            laneKey,
            queuedAt: row.nextAttemptAt.getTime(),
            kind: "steer" as const,
            claimToken,
            rootDeliveryId: steerTarget.id,
            expectedTurnId: steerTarget.turnId,
          }
        : {
            id: row.id,
            agentId: row.agentId,
            computerId: row.computerId,
            attemptCount: row.attemptCount + 1,
            previousErrorCode: row.lastErrorCode,
            laneKey,
            queuedAt: row.nextAttemptAt.getTime(),
            kind: "pending" as const,
            claimToken,
          };
    });
    if (uncertainDeliveryId) {
      this.#logger?.warn(
        {
          module: "im-delivery",
          operation: "im.custody.release",
          outcome: "uncertain",
          code: "IM_DELIVERY_STEER_UNKNOWN",
          errorCode: "IM_DELIVERY_STEER_UNKNOWN",
          deliveryId: uncertainDeliveryId,
          ...(uncertainAgentId ? { agentId: uncertainAgentId } : {}),
        },
        "IM delivery custody released as uncertain",
      );
      this.#onDeliverySettled?.(uncertainDeliveryId);
    }
    return claim;
  }

  async #deliver(claim: WorkerClaim & { kind: "pending" }, signal: AbortSignal): Promise<void> {
    const attempt = { ...claimAttempt(claim, "deliver"), claimToken: claim.claimToken };
    const lease = this.#maintainClaimLease(attempt);
    try {
      await this.#deliverClaimed(attempt, lease, signal);
    } catch (error) {
      if (!(error instanceof ImDeliveryInputError)) throw error;
      await this.#rejectInvalidInput(attempt, error);
    } finally {
      await lease.stop();
    }
  }

  #supportsBatchInput(
    row: CloudDeliveryClaimRow,
    instanceId: string,
    capability: typeof RUNTIME_CAPABILITY.imSteer | typeof RUNTIME_CAPABILITY.imDelivery,
    version: number,
  ): boolean {
    return row.computer.kind === "cloud"
      ? this.#cloudDelivery?.canBatch(row.session.id) === true
      : (this.#registry.capabilityVersion(row.computer.id, instanceId, capability) ?? 0) >= version;
  }

  #steerInstance(row: CloudDeliveryClaimRow): string | undefined {
    if (row.computer.kind === "cloud") return this.#cloudDelivery?.inputInstance(row.session.id);
    const instanceId = this.#registry.currentInstanceId(row.computer.id);
    return instanceId &&
      row.computer.currentInstanceId === instanceId &&
      this.#registry.supportsCapability(row.computer.id, instanceId, RUNTIME_CAPABILITY.imSteer)
      ? instanceId
      : undefined;
  }

  async #buildSteerRequest(
    row: CloudDeliveryClaimRow,
    claim: { rootDeliveryId: string; expectedTurnId: string },
    replyRole: "observer" | undefined,
    instanceId: string,
  ): Promise<RuntimeImSteerRequest> {
    const pinned = RuntimeImSteerRequestSchema.safeParse(row.delivery.dispatchPayload);
    let request: RuntimeImSteerRequest;
    if (pinned.success) {
      request = pinned.data;
      if (
        request.requestId !== row.delivery.dispatchRequestId ||
        computeRuntimeImSteerInputHash(request) !== row.delivery.dispatchInputHash ||
        request.rootDeliveryId !== claim.rootDeliveryId
      )
        throw new Error("IM_DELIVERY_STEER_INPUT_CONFLICT");
    } else {
      const content = await this.#buildDeliveryContent({
        delivery: row.delivery,
        message: row.message,
        session: row.session,
        imBinding: row.imBinding,
        receiveMode: row.agent.receiveMode,
      });
      request = {
        type: "im:steer",
        requestId: randomUUID(),
        deliveryId: row.delivery.id,
        imMessageId: row.message.id,
        sessionId: row.session.id,
        agentId: row.agent.id,
        placementGeneration: row.placement.generation,
        rootDeliveryId: claim.rootDeliveryId,
        expectedTurnId: claim.expectedTurnId,
        attention: row.delivery.attention,
        ...(replyRole ? { replyRole } : {}),
        content,
        deadlineAt: row.delivery.expiresAt.toISOString(),
      };
      fitDeliveryFrame(request);
      if (this.#supportsBatchInput(row, instanceId, RUNTIME_CAPABILITY.imSteer, 3)) {
        await appendPendingImBatch(this.#database, request, row.imBinding, row.session, this.#clock());
      }
      validateFreshImRequest(request);
    }
    return request;
  }

  async #deliverSteer(claim: WorkerClaim & { kind: "steer" }, signal: AbortSignal): Promise<void> {
    const attempt = claimAttempt(claim, "steer");
    const claimToken = claim.claimToken;
    const lease = this.#maintainClaimLease(attempt);
    try {
      const [row] = await this.#database
        .select({
          delivery: imMessageDeliveries,
          message: imMessages,
          session: sessions,
          placement: sessionPlacements,
          imBinding: imBindings,
          agent: agents,
          computer: computers,
          computerOwnerAccountId: computers.ownerAccountId,
        })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
        .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
        .where(
          and(
            eq(imMessageDeliveries.id, claim.id),
            inArray(imMessageDeliveries.state, ["pending", "expired"]),
            isNull(imMessageDeliveries.reason),
            isNull(sessions.endedAt),
            eq(imBindings.status, "active"),
            eq(agents.status, "active"),
          ),
        )
        .limit(1);
      if (!row || row.delivery.placementGeneration !== row.placement.generation) {
        await this.#recordFailure(attempt, "IM_DELIVERY_STEER_AUTHORITY_UNAVAILABLE");
        return;
      }
      setDeliveryRowPerformanceContext(row, claim.expectedTurnId);
      if (row.computerOwnerAccountId !== row.agent.createdByUserId) {
        if (row.delivery.dispatchRequestId === null) {
          await this.#reject(claim.id, "computer_owner_mismatch", claimToken);
        } else {
          await this.#recordFailure(attempt, "IM_DELIVERY_COMPUTER_OWNER_MISMATCH");
        }
        return;
      }
      const instanceId = this.#steerInstance(row);
      if (!instanceId) {
        await this.#recordFailure(attempt, "IM_DELIVERY_STEER_UNAVAILABLE");
        return;
      }
      const replyRole = await this.#replyRole(row.message.id, row.session.kind, row.message.threadKey);
      if (replyRole === "observer" && !this.#supportsBatchInput(row, instanceId, RUNTIME_CAPABILITY.imSteer, 2)) {
        await this.#recordFailure(attempt, "IM_DELIVERY_OBSERVER_STEER_UNSUPPORTED");
        return;
      }
      const [target] = await this.#database
        .select({
          id: imMessageDeliveries.id,
          sessionId: imMessageDeliveries.sessionId,
          state: imMessageDeliveries.state,
          turnId: imMessageDeliveries.turnId,
          reportedAt: imMessageDeliveries.reportedAt,
          reportOwnerInstanceId: imMessageDeliveries.reportOwnerInstanceId,
          turnReport: imMessageDeliveries.turnReport,
        })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, claim.rootDeliveryId))
        .limit(1);
      if (
        target?.state !== "accepted" ||
        target.sessionId !== row.session.id ||
        target.turnId !== claim.expectedTurnId ||
        target.reportedAt !== null ||
        target.reportOwnerInstanceId !== instanceId
      ) {
        await this.#recordFailure(attempt, "IM_DELIVERY_STEER_TARGET_ENDED", {
          expectedDeferral:
            row.delivery.dispatchRequestId === null &&
            target?.state === "accepted" &&
            target.sessionId === row.session.id &&
            target.turnId === claim.expectedTurnId &&
            target.reportOwnerInstanceId === instanceId &&
            target.reportedAt !== null &&
            target.turnReport?.outcome === "completed",
        });
        return;
      }
      const request = await this.#buildSteerRequest(row, claim, replyRole, instanceId);
      if (!(await lease.assertOwned())) return;
      await this.#database
        .update(imMessageDeliveries)
        .set({ executionOrigin: row.computer.kind })
        .where(and(eq(imMessageDeliveries.id, claim.id), eq(imMessageDeliveries.lastErrorCode, claimToken)));
      const admitted = await this.#withActiveAgentAdmission(
        {
          agentId: row.agent.id,
          computerId: row.computer.id,
          placementGeneration: row.placement.generation,
          sessionId: row.session.id,
        },
        (onDispatched) =>
          row.computer.kind === "cloud" && this.#cloudDelivery
            ? this.#cloudDelivery.requestSteer(request, onDispatched, signal)
            : this.#domain.requestSteer(row.computer.id, instanceId, request, onDispatched, signal),
        signal,
      );
      if (!admitted.admitted) {
        await this.#recordFailure(attempt, "IM_DELIVERY_AGENT_NOT_ACTIVE");
        return;
      }
      const result = await admitted.result;
      setActiveSpanAttributes(outcomeAttrs(result.status, "reason" in result ? result.reason : undefined));
      if (result.status === "rejected" && result.reason === "invalid_input") {
        await this.#reject(claim.id, result.reason, claimToken);
      } else if (result.status !== "steered") {
        await this.#recordFailure(
          attempt,
          result.status === "retry" ? "IM_DELIVERY_STEER_STARTING" : "IM_DELIVERY_STEER_DEFERRED",
        );
      }
    } catch (error) {
      await this.#recordOperationFailure(attempt, "IM_DELIVERY_STEER_FAILED", error, signal);
    } finally {
      await lease.stop();
    }
  }

  async #deliverClaimed(
    attempt: DeliveryAttempt & { claimToken: string },
    lease: ClaimLease,
    signal: AbortSignal,
  ): Promise<void> {
    const deliveryId = attempt.deliveryId;
    const claimToken = attempt.claimToken;
    const [row] = await this.#database
      .select({
        delivery: imMessageDeliveries,
        message: imMessages,
        session: sessions,
        placement: sessionPlacements,
        imBinding: imBindings,
        agent: agents,
        computer: computers,
        computerOwnerAccountId: computers.ownerAccountId,
      })
      .from(imMessageDeliveries)
      .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          or(
            and(eq(imMessageDeliveries.state, "pending"), isNull(imMessageDeliveries.reason)),
            and(eq(imMessageDeliveries.state, "expired"), isNotNull(imMessageDeliveries.dispatchRequestId)),
          ),
          isNull(sessions.endedAt),
          eq(imBindings.status, "active"),
          eq(agents.status, "active"),
        ),
      )
      .limit(1);
    if (!row) {
      setActiveSpanAttributes(outcomeAttrs("failed", "IM_DELIVERY_RUNTIME_AUTHORITY_UNAVAILABLE"));
      await this.#recordFailure(attempt, "IM_DELIVERY_RUNTIME_AUTHORITY_UNAVAILABLE");
      return;
    }
    setDeliveryRowPerformanceContext(row);
    if (row.computerOwnerAccountId !== row.agent.createdByUserId && row.delivery.dispatchRequestId === null) {
      setActiveSpanAttributes(outcomeAttrs("failed", "IM_DELIVERY_COMPUTER_OWNER_MISMATCH"));
      await this.#reject(deliveryId, "computer_owner_mismatch", claimToken);
      return;
    }
    setActiveSpanAttributes({
      ...imAttrs({
        provider: row.imBinding.provider,
        bindingId: row.imBinding.id,
        deliveryId: row.delivery.id,
        messageId: row.message.id,
      }),
      ...runtimeAttrs({
        deliveryId: row.delivery.id,
        messageId: row.message.id,
        sessionId: row.session.id,
        agentId: row.agent.id,
        installationId: row.computer.currentInstallationId,
        computerId: row.computer.id,
        placementGeneration: row.placement.generation,
        attempt: row.delivery.attemptCount,
      }),
    });
    if (row.delivery.placementGeneration !== row.placement.generation) {
      await this.#recordFailure(attempt, "IM_DELIVERY_PLACEMENT_STALE");
      return;
    }
    validateUndispatchedContent(row);
    /*
     * Cloud dispatch uses the per-Sandbox owner and short claim/operation deadlines, not the
     * Local runtime registry or queue-age TTL. Unready Runners retry in short attempts; ingress
     * expiresAt bounds undispatched input, the runtime budget bounds frozen dispatches, and
     * accepted-unreported custody never expires.
     */
    await this.#database
      .update(imMessageDeliveries)
      .set({ executionOrigin: row.computer.kind })
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          eq(imMessageDeliveries.lastErrorCode, claimToken),
          isNull(imMessageDeliveries.executionOrigin),
        ),
      );
    if (row.computer.kind === "cloud") {
      await this.#deliverCloud(row, attempt, lease, signal);
      return;
    }
    const instanceId = this.#registry.currentInstanceId(row.computer.id);
    if (!instanceId || row.computer.currentInstanceId !== instanceId) {
      await this.#recordFailure(
        { ...attempt, offlineMs: absentRuntimeMs(row.computer.lastSeenAt, this.#now()) },
        "IM_DELIVERY_RUNTIME_UNAVAILABLE",
      );
      return;
    }
    const persisted = readPersistedDeliveryRequest({
      delivery: row.delivery,
      message: row.message,
      session: row.session,
      agent: row.agent,
      placementGeneration: row.placement.generation,
    });
    if (persisted.status === "invalid") {
      await this.#recordFailure(attempt, "IM_DELIVERY_DISPATCH_PAYLOAD_INVALID");
      return;
    }
    const persistedRequest = persisted.status === "valid" ? persisted.request : undefined;
    const replyRole = persistedRequest
      ? persistedRequest.replyRole
      : await this.#replyRole(row.message.id, row.session.kind, row.message.threadKey);
    if (replyRole === "observer" && !this.#supportsBatchInput(row, instanceId, RUNTIME_CAPABILITY.imDelivery, 2)) {
      await this.#recordFailure(attempt, "IM_DELIVERY_OBSERVER_UNSUPPORTED");
      return;
    }
    if (!this.#registry.canReceiveSnapshot(row.computer.id, instanceId)) {
      await this.#recordFailure(attempt, "IM_DELIVERY_RUNTIME_UPGRADE_REQUIRED");
      return;
    }
    const runtime = persistedRequest?.runtime ?? (await this.#assembleRuntime(attempt, row.session.id, "delivery"));
    if (!runtime) return;
    signal.throwIfAborted();
    // A late acceptance may commit after this delivery was claimed. Recheck at
    // the last boundary before any reconcile or delivery frame reaches runtime.
    if (
      await hasOtherCustody(this.#database, {
        deliveryId,
        agentId: row.agent.id,
        sessionId: row.session.id,
        computerKind: row.computer.kind,
      })
    ) {
      await this.#recordFailure(attempt, "IM_DELIVERY_AGENT_CUSTODY_FENCED");
      return;
    }
    if (!(await lease.assertOwned())) return;
    let failureCode = "IM_DELIVERY_RUNTIME_FAILED";
    try {
      const admission = {
        agentId: row.agent.id,
        computerId: row.computer.id,
        placementGeneration: row.placement.generation,
        sessionId: row.session.id,
      };
      const reconcile = await this.#domain.requestReconcile(
        row.computer.id,
        instanceId,
        {
          type: "session:reconcile",
          requestId: randomUUID(),
          installationId: row.computer.currentInstallationId,
          sessionId: row.session.id,
          agentId: row.agent.id,
          placementGeneration: row.placement.generation,
          desired: "ready",
          runtime,
        },
        undefined,
        async (operation) => {
          const admitted = await this.#withActiveAgentAdmission(admission, operation, signal);
          if (!admitted.admitted) failureCode = "IM_DELIVERY_AGENT_NOT_ACTIVE";
          return admitted;
        },
        signal,
      );
      const [currentDelivery] = await this.#database
        .select({ state: imMessageDeliveries.state })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId))
        .limit(1);
      if (!currentDelivery || currentDelivery.state === "accepted" || currentDelivery.state === "terminal_rejected") {
        return;
      }
      if (!(await lease.assertOwned())) return;
      if (reconcile.status === "rejected") {
        // A rejection is answered immediately and may persist (e.g. a durable binding conflict),
        // so back off instead of re-reconciling on the fixed cadence until the message expires.
        await this.#recordFailure(attempt, "IM_DELIVERY_RECONCILE_REJECTED");
        return;
      }
      if (reconcile.status !== "ready") {
        await this.#recordFailure(attempt, "IM_DELIVERY_RECONCILE_NOT_READY");
        return;
      }
      if (reconcile.retainedReports?.some((claim) => claim.deliveryId === deliveryId)) {
        await this.#recordFailure(attempt, "IM_DELIVERY_RETAINED_CUSTODY_CONFLICT");
        return;
      }
      if (currentDelivery.state === "expired") {
        if (persistedRequest) {
          await this.#releaseDispatch(attempt, persistedRequest.requestId, "IM_DELIVERY_EXPIRED");
        }
        return;
      }
      if (persistedRequest) {
        await this.#releaseDispatch(attempt, persistedRequest.requestId, "IM_DELIVERY_RECONCILED_NO_CUSTODY");
        return;
      }
      const content = await this.#buildDeliveryContent({
        delivery: row.delivery,
        message: row.message,
        session: row.session,
        imBinding: row.imBinding,
        receiveMode: row.agent.receiveMode,
      });
      const request: DirectImMessageDeliveryRequest = {
        type: "im:deliver",
        requestId: randomUUID(),
        deliveryId: row.delivery.id,
        imMessageId: row.message.id,
        sessionId: row.session.id,
        agentId: row.agent.id,
        placementGeneration: row.placement.generation,
        attention: row.delivery.attention,
        ...(replyRole ? { replyRole } : {}),
        content,
        runtime,
        deadlineAt: row.delivery.expiresAt.toISOString(),
      };
      fitDeliveryFrame(request);
      if (this.#supportsBatchInput(row, instanceId, RUNTIME_CAPABILITY.imDelivery, 3)) {
        await appendPendingImBatch(this.#database, request, row.imBinding, row.session, this.#clock());
      }
      validateFreshImRequest(request);
      if (!(await lease.assertOwned())) return;
      await this.#beforeDeliveryAdmission?.(signal);
      const admittedDelivery = await this.#withActiveAgentAdmission(
        admission,
        (onDispatched) => this.#domain.requestDelivery(row.computer.id, instanceId, request, onDispatched, signal),
        signal,
      );
      if (!admittedDelivery.admitted) {
        await this.#recordFailure(attempt, "IM_DELIVERY_AGENT_NOT_ACTIVE");
        return;
      }
      const result = await admittedDelivery.result;
      setActiveSpanAttributes(outcomeAttrs(result.status, "reason" in result ? result.reason : undefined));
      if (result.status !== "rejected") return;
      if (["configuration_unsupported", "invalid_input"].includes(result.reason ?? "")) {
        await this.#reject(deliveryId, result.reason ?? "terminal_rejected", claimToken);
      } else {
        await this.#releaseDispatch(attempt, request.requestId, "IM_DELIVERY_RUNTIME_REJECTED");
      }
    } catch (error) {
      await this.#recordOperationFailure(attempt, failureCode, error, signal);
    }
  }

  /** One claimed Cloud delivery: delegated to the cohesive Cloud coordinator. */
  async #deliverCloud(
    row: {
      delivery: typeof imMessageDeliveries.$inferSelect;
      message: typeof imMessages.$inferSelect;
      session: typeof sessions.$inferSelect;
      placement: typeof sessionPlacements.$inferSelect;
      imBinding: typeof imBindings.$inferSelect;
      agent: typeof agents.$inferSelect;
      computer: typeof computers.$inferSelect;
    },
    attempt: DeliveryAttempt,
    lease: ClaimLease,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#cloudCoordinator.deliver(row, attempt, lease, signal);
  }

  async #runRecovery(
    claim: WorkerClaim & { kind: "recovery" },
    lease: ClaimLease,
    signal: AbortSignal,
    deadlineSignal: AbortSignal,
  ): Promise<void> {
    try {
      signal.throwIfAborted();
      if (await lease.assertOwned()) await this.#recover(claim, signal, lease);
    } finally {
      // Keep the lease and local owner through actual settlement, even after the scheduler grace.
      await lease.stop();
      try {
        if (deadlineSignal.aborted)
          await this.#recordFailure(claimAttempt(claim, "recover"), "IM_DELIVERY_OPERATION_TIMEOUT");
      } finally {
        this.#recoveries.delete(claim.id);
      }
    }
  }

  async #recover(claim: WorkerClaim & { kind: "recovery" }, signal: AbortSignal, lease: ClaimLease): Promise<void> {
    const attempt = claimAttempt(claim, "recover");
    const deliveryId = claim.id;
    const [row] = await this.#database
      .select({
        delivery: imMessageDeliveries,
        session: sessions,
        placement: sessionPlacements,
        imBinding: imBindings,
        agent: agents,
        computer: computers,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          eq(imMessageDeliveries.state, "accepted"),
          eq(imMessageDeliveries.attemptCount, claim.attemptCount),
          eq(agents.id, claim.agentId),
          eq(computers.id, claim.computerId),
          isNull(imMessageDeliveries.reportedAt),
          isNull(sessions.endedAt),
          eq(imBindings.status, "active"),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) return;
    setDeliveryRowPerformanceContext(row);
    setActiveSpanAttributes({
      ...imAttrs({
        provider: row.imBinding.provider,
        bindingId: row.imBinding.id,
        deliveryId: row.delivery.id,
        messageId: row.delivery.messageId,
      }),
      ...runtimeAttrs({
        deliveryId: row.delivery.id,
        messageId: row.delivery.messageId,
        sessionId: row.session.id,
        agentId: row.agent.id,
        installationId: row.computer.currentInstallationId,
        computerId: row.computer.id,
        placementGeneration: row.placement.generation,
        attempt: row.delivery.attemptCount,
      }),
    });
    /*
     * E4 Cloud recovery: an accepted Cloud delivery owes a Turn Report from its Sandbox Runner.
     * While the allocation still owns the report, recovery waits for the Runner's journal-driven
     * re-report (transient retry); once the allocation is superseded or released, the owner
     * settles the delivery exactly once as unknown/turn_state_unknown — never a blind replay.
     */
    if (row.computer.kind === "cloud") {
      await this.#cloudCoordinator.recover(attempt);
      return;
    }
    /*
     * A live owner of the delivery's own placement gets its reconcile attempt first, whatever the
     * clock says: it can still describe the Turn, and settling it would discard a genuine result.
     * The report-acceptance cutoff below covers only custody that cannot report through this path —
     * no reconcilable placement, or no live runtime on the Computer.
     */
    const instanceId = this.#registry.currentInstanceId(row.computer.id);
    const liveOwner = instanceId !== undefined && row.computer.currentInstanceId === instanceId;
    const placementCurrent = row.delivery.placementGeneration === row.placement.generation;
    if (!placementCurrent || !liveOwner) {
      if (placementCurrent && acceptedReportClosed(row.delivery.acceptedAt, this.#now())) {
        if (await settleUnreportableTurn(this.#failures, row)) return;
      }
      if (!placementCurrent) {
        await this.#recordFailure(attempt, "IM_DELIVERY_PLACEMENT_STALE");
        return;
      }
      await this.#recordFailure(
        { ...attempt, offlineMs: absentRuntimeMs(row.computer.lastSeenAt, this.#now()) },
        "IM_DELIVERY_RUNTIME_UNAVAILABLE",
      );
      return;
    }
    if (!(await validateRecoveryPayload(row, attempt, (attempt, code) => this.#recordFailure(attempt, code)))) return;
    signal.throwIfAborted();
    if (!(await lease.assertOwned())) return;
    signal.throwIfAborted();
    let result: RuntimeReconcileResult;
    try {
      result = await this.#domain.requestReconcile(
        row.computer.id,
        instanceId,
        {
          type: "session:reconcile",
          requestId: randomUUID(),
          installationId: row.computer.currentInstallationId,
          sessionId: row.session.id,
          agentId: row.agent.id,
          placementGeneration: row.placement.generation,
          // Accepted work must settle before applying any snapshot, including after an upgrade.
          desired: "stopped",
        },
        undefined,
        undefined,
        signal,
        { joinSettlement: true },
      );
    } catch {
      signal.throwIfAborted();
      await lease.stop();
      signal.throwIfAborted();
      await this.#deferRecovery(attempt, claim.attemptCount, "IM_DELIVERY_RECOVERY_FAILED");
      return;
    }
    await lease.stop();
    if (!signal.aborted)
      await settleLostReportOrDefer(this.#failures, row, attempt, claim.attemptCount, result, instanceId, this.#now());
  }

  /** A reconcile response is not a report; preserve custody until the actual report settles it. */
  #deferRecovery(attempt: DeliveryAttempt, attemptCount: number, code: string): Promise<void> {
    return deferRecoveryRetry(this.#failures, attempt, attemptCount, code);
  }

  async #assembleRuntime(
    attempt: DeliveryAttempt,
    sessionId: string,
    mode: "delivery" | "recovery",
  ): Promise<EffectiveRuntimeSnapshot | undefined> {
    try {
      return await this.#assembler.assembleForSession(sessionId);
    } catch (error) {
      const code = error instanceof EffectiveRuntimeSnapshotAssemblerError ? error.code : "DATABASE_FAILURE";
      if (
        mode === "delivery" &&
        ["UNSUPPORTED_PROVIDER", "RUNTIME_CONFIG_MISSING", "INVALID_STORED_CONFIG", "SNAPSHOT_INVALID"].includes(code)
      ) {
        await this.#reject(
          attempt.deliveryId,
          code === "UNSUPPORTED_PROVIDER" ? "configuration_unsupported" : "invalid_input",
          attempt.claimToken,
        );
        return undefined;
      }
      await this.#recordFailure(
        attempt,
        code === "DATABASE_FAILURE"
          ? "IM_DELIVERY_RUNTIME_AUTHORITY_FAILED"
          : "IM_DELIVERY_RUNTIME_AUTHORITY_UNAVAILABLE",
      );
      return undefined;
    }
  }

  async #withActiveAgentAdmission<T>(
    expected: {
      agentId: string;
      computerId: string;
      placementGeneration: number;
      sessionId: string;
    },
    operation: (onDispatched: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<{ admitted: false } | { admitted: true; result: Promise<T> }> {
    if (signal?.aborted) return { admitted: false };
    const admitted = await this.#database.transaction(async (transaction) => {
      const [agent] = await transaction
        .select({ computerId: agents.computerId, createdByUserId: agents.createdByUserId, status: agents.status })
        .from(agents)
        .where(eq(agents.id, expected.agentId))
        .limit(1);
      if (agent?.status !== "active") return false;
      const [placement] = await transaction
        .select({
          computerId: sessionPlacements.computerId,
          generation: sessionPlacements.generation,
          ownerAccountId: computers.ownerAccountId,
        })
        .from(sessionPlacements)
        .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
        .where(eq(sessionPlacements.sessionId, expected.sessionId))
        .limit(1);
      if (
        !placement ||
        agent.computerId !== expected.computerId ||
        placement.computerId !== expected.computerId ||
        placement.generation !== expected.placementGeneration ||
        placement.ownerAccountId !== agent.createdByUserId
      ) {
        return false;
      }
      return true;
    });
    if (!admitted) return { admitted: false };
    if (signal?.aborted) return { admitted: false };
    let markDispatched: () => void = () => undefined;
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve;
    });
    const result = operation(markDispatched);
    void result.catch(() => markDispatched());
    await dispatched;
    return { admitted: true, result };
  }

  #recordFailure(attempt: DeliveryAttempt, code: string, options?: DeliveryFailureOptions): Promise<void> {
    if (attempt.phase === "recover" && code === "IM_DELIVERY_OPERATION_TIMEOUT")
      return this.#track(this.#deferRecovery(attempt, attempt.attemptCount, code));
    return this.#track(recordDeliveryFailure(this.#failures, attempt, code, options));
  }

  #releaseDispatch(attempt: DeliveryAttempt, requestId: string, code: string): Promise<void> {
    return releaseDeliveryDispatch(this.#failures, attempt, requestId, code);
  }

  #handleDeliveryFailure(attempt: DeliveryAttempt, code: string, error: unknown): Promise<void> {
    return handleDeliveryFailure(this.#failures, attempt, code, error);
  }

  /**
   * Record the failure of an operation that the deadline may have aborted. The deadline already
   * recorded that attempt, and a second write would reset the consecutive-timeout count it produced.
   */
  #recordOperationFailure(attempt: DeliveryAttempt, code: string, error: unknown, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return this.#handleDeliveryFailure(attempt, code, error);
  }

  #rejectInvalidInput(attempt: DeliveryAttempt, error: ImDeliveryInputError): Promise<void> {
    return rejectInvalidDeliveryInput(this.#failures, attempt, error);
  }

  #reject(deliveryId: string, reason: string, claimToken?: string): Promise<boolean> {
    return rejectDelivery(this.#failures, deliveryId, reason, claimToken);
  }

  #maintainClaimLease(attempt: DeliveryAttempt, onLost?: () => void): ClaimLease {
    return maintainDeliveryClaimLease(this.#database, attempt, {
      now: this.#now,
      leaseMs: this.#claimLeaseMs,
      renewMs: this.#claimRenewMs,
      ...(onLost ? { onLost } : {}),
    });
  }

  async #buildDeliveryContent(input: {
    delivery: Pick<typeof imMessageDeliveries.$inferSelect, "attention">;
    message: typeof imMessages.$inferSelect;
    session: typeof sessions.$inferSelect;
    imBinding: typeof imBindings.$inferSelect;
    receiveMode: (typeof agents.$inferSelect)["receiveMode"];
  }): Promise<RuntimeImDeliveryContent> {
    const content = deliveryMessageContent(input.message, input.imBinding);
    const history =
      input.session.kind === "thread" || (input.delivery.attention === "direct" && input.receiveMode === "mention_only")
        ? await loadDirectHistory(this.#database, {
            session: input.session,
            providerContext: input.message.providerContext,
            externalMessageId: input.message.externalMessageId,
            occurredAt: input.message.occurredAt,
            providerRevisionKey: input.message.providerRevisionKey,
            messageId: input.message.id,
          })
        : { items: [], truncated: false };
    return {
      ...content,
      ...(history.items.length > 0 ? { history: history.items, historyTruncated: history.truncated } : {}),
    };
  }

  async #replyRole(
    messageId: string,
    sessionKind: (typeof sessions.$inferSelect)["kind"],
    threadKey: string | null,
  ): Promise<"observer" | undefined> {
    if (sessionKind !== "channel" || threadKey === null) return undefined;
    const [threadDelivery] = await this.#database
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .where(
        and(
          eq(imMessageDeliveries.messageId, messageId),
          eq(sessions.kind, "thread"),
          eq(sessions.threadKey, threadKey),
        ),
      )
      .limit(1);
    return threadDelivery ? "observer" : undefined;
  }
}

type LockedDeliveryRow = NonNullable<Awaited<ReturnType<typeof lockEligibleDelivery>>>["row"];

function staleDispatchGeneration(row: LockedDeliveryRow): boolean {
  const parsed = DirectImMessageDeliveryRequestSchema.safeParse(row.dispatchPayload);
  const steer = RuntimeImSteerRequestSchema.safeParse(row.dispatchPayload);
  const generation = parsed.success
    ? parsed.data.placementGeneration
    : steer.success
      ? steer.data.placementGeneration
      : undefined;
  return (
    row.dispatchRequestId !== null &&
    (row.deliveryGeneration !== row.generation || (generation !== undefined && generation !== row.generation))
  );
}

function frozenSteerMatches(row: LockedDeliveryRow): boolean {
  const parsed = RuntimeImSteerRequestSchema.safeParse(row.dispatchPayload);
  if (!parsed.success) return false;
  const request = parsed.data;
  return (
    row.dispatchRequestId === request.requestId &&
    row.dispatchInputHash === computeRuntimeImSteerInputHash(request) &&
    row.steerTargetDeliveryId === request.rootDeliveryId &&
    row.id === request.deliveryId &&
    row.sessionId === request.sessionId &&
    row.agentId === request.agentId
  );
}

async function recoverableSteerTarget(transaction: DatabaseTransaction, row: LockedDeliveryRow): Promise<boolean> {
  if (!row.steerTargetDeliveryId) return false;
  const [target] = await transaction
    .select({ id: imMessageDeliveries.id })
    .from(imMessageDeliveries)
    .where(
      and(
        eq(imMessageDeliveries.id, row.steerTargetDeliveryId),
        ne(imMessageDeliveries.id, row.id),
        eq(imMessageDeliveries.sessionId, row.sessionId),
        or(
          ne(imMessageDeliveries.state, "accepted"),
          and(
            isNotNull(imMessageDeliveries.reportedAt),
            sql`coalesce(${imMessageDeliveries.turnReport} ->> 'outcome', 'unknown') <> 'completed'`,
          ),
        ),
      ),
    )
    .limit(1);
  return target !== undefined;
}
