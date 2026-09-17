import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeRuntimeImSteerInputHash,
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  type RuntimeImDeliveryContent,
  type RuntimeImSteerRequest,
  RuntimeImSteerRequestSchema,
} from "@opentag/shared";
import { and, asc, eq, exists, inArray, isNotNull, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseClient } from "../db/client.js";
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
} from "../observability/index.js";
import {
  type EffectiveRuntimeSnapshotAssembler,
  EffectiveRuntimeSnapshotAssemblerError,
} from "../services/runtime-config/index.js";
import type { CloudDeliveryOwner } from "../services/sandboxes/index.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import { dispatchClaimToken } from "./im-delivery-claim.js";
import { CloudDeliveryCoordinator, readPersistedDeliveryRequest } from "./im-delivery-cloud.js";
import {
  type ClaimLease,
  findOtherAgentCustody,
  fitDeliveryFrame,
  hasOtherAgentCustody,
  loadDirectHistory,
  truncateUtf8,
  uncertainAgentCustody,
} from "./im-delivery-custody.js";
import { withOperationDeadline } from "./im-delivery-deadline.js";
import {
  createImDeliveryMaintenanceSchedulers,
  type ImDeliveryJanitorConfig,
  resolveImDeliveryJanitorConfig,
  runImDeliveryExpiry,
  runImDeliveryJanitor,
  runImDeliveryRetention,
} from "./im-delivery-janitor.js";
import type {
  CloudSessionAllocationPort,
  ImDeliveryWorkerInput,
  RuntimeDeliveryWorkerMetric,
  WorkerClaim,
} from "./im-delivery-worker.types.js";
import { KeyedTaskScheduler } from "./keyed-task-scheduler.js";
import type { RuntimeDomainOwner } from "./runtime-domain-owner.js";
import { runtimeProviderMessageRef } from "./runtime-provider-message-ref.js";

const DEFAULT_INTERVAL_MS = 500;
const RETRY_DELAY_MS = 2_000;
const CLAIM_LEASE_MS = 15_000;
const CLAIM_RENEW_MS = 5_000;
// Replica model: persisted recoverable ownership. The durable marker bridges the
// transaction-to-runtime gap. Advisory locks serialize competing claims; the
// marker keeps later transactions fenced after commit.
const acceptedDeliveries = alias(imMessageDeliveries, "agent_accepted_deliveries");
const acceptedSessions = alias(sessions, "agent_accepted_sessions");
const acceptedImBindings = alias(imBindings, "agent_accepted_im_bindings");
const acceptedAgents = alias(agents, "agent_accepted_agents");

function positiveWorkerLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export class ImDeliveryWorker {
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
  readonly #onDiagnostic: (code: string) => void;
  readonly #supervisor?: BackgroundFailureSupervisor;
  readonly #clock: () => Date;
  readonly #now: () => number;
  readonly #operationTimeoutMs: number;
  readonly #maxQueueAgeMs?: number;
  readonly #scheduler: KeyedTaskScheduler;
  readonly #onMetric: (metric: RuntimeDeliveryWorkerMetric) => void;
  #timer?: ReturnType<typeof setInterval>;
  #janitorTimer?: ReturnType<typeof setInterval>;
  #retentionTimer?: ReturnType<typeof setInterval>;
  readonly #scheduleJanitor: () => void;
  readonly #scheduleRetention: () => void;

  constructor(input: ImDeliveryWorkerInput) {
    this.#database = input.database;
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
    this.#supervisor = input.supervisor;
    this.#clock = input.now ?? (() => new Date());
    this.#now = () => this.#clock().getTime();
    this.#operationTimeoutMs = positiveWorkerLimit(input.operationTimeoutMs ?? 30_000, "operationTimeoutMs");
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
    this.#cloudCoordinator = new CloudDeliveryCoordinator({
      database: this.#database,
      ...(this.#cloudDelivery ? { cloudDelivery: this.#cloudDelivery } : {}),
      ...(this.#cloudAllocation ? { cloudAllocation: this.#cloudAllocation } : {}),
      now: this.#now,
      onDiagnostic: this.#onDiagnostic,
      ...(this.#beforeDeliveryAdmission ? { beforeDeliveryAdmission: this.#beforeDeliveryAdmission } : {}),
      assembleRuntime: (deliveryId, sessionId, mode, claimToken) =>
        this.#assembleRuntime(deliveryId, sessionId, mode, claimToken),
      replyRole: (messageId, sessionKind, threadKey) => this.#replyRole(messageId, sessionKind, threadKey),
      buildDeliveryContent: (contentInput) => this.#buildDeliveryContent(contentInput),
      hasOtherAgentCustody: (agentId, deliveryId) => hasOtherAgentCustody(this.#database, agentId, deliveryId),
      recordFailure: (deliveryId, code, claimToken, retryDelayMs) =>
        this.#recordFailure(deliveryId, code, claimToken, retryDelayMs),
      releaseDispatch: (deliveryId, requestId, code, claimToken) =>
        this.#releaseDispatch(deliveryId, requestId, code, claimToken),
      rejectInput: (deliveryId, reason, claimToken) => this.#reject(deliveryId, reason, claimToken),
      withActiveAgentAdmission: (expected, operation, signal) =>
        this.#withActiveAgentAdmission(expected, operation, signal),
    });
    const schedulers = createImDeliveryMaintenanceSchedulers({
      expiryRun: async () => {
        await runImDeliveryExpiry(this.#database, { ...this.#janitorConfig, clock: this.#clock });
        await this.#cloudCoordinator.reconcileStoppedWork();
      },
      retentionRun: () => runImDeliveryRetention(this.#database, { ...this.#janitorConfig, clock: this.#clock }),
      supervisor: this.#supervisor,
      onDiagnostic: this.#onDiagnostic,
    });
    this.#scheduleJanitor = schedulers.expiry;
    this.#scheduleRetention = schedulers.retention;
  }

  start(): void {
    if (this.#timer) return;
    this.#schedule();
    this.#timer = setInterval(() => this.#schedule(), this.#intervalMs);
    this.#timer.unref();
    this.#janitorTimer = setInterval(() => this.#scheduleJanitor(), this.#janitorConfig.janitorIntervalMs);
    this.#janitorTimer.unref();
    this.#retentionTimer = setInterval(() => this.#scheduleRetention(), this.#janitorConfig.retentionIntervalMs);
    this.#retentionTimer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#janitorTimer) clearInterval(this.#janitorTimer);
    this.#janitorTimer = undefined;
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#retentionTimer = undefined;
    this.#scheduler.close();
  }

  async runJanitorOnce(): Promise<void> {
    await runImDeliveryJanitor(this.#database, { ...this.#janitorConfig, clock: this.#clock });
    await this.#cloudCoordinator.reconcileStoppedWork();
  }

  async runOnce(): Promise<void> {
    const claimed = await this.#claim();
    if (!claimed) return;
    const queueAge = Math.max(0, this.#now() - claimed.queuedAt);
    this.#onMetric({ name: "queue_age_ms", value: queueAge, agentId: claimed.agentId });
    if (this.#maxQueueAgeMs !== undefined && queueAge > this.#maxQueueAgeMs) {
      this.#onMetric({ name: "saturation", value: 1, agentId: claimed.agentId });
      await this.#recordFailure(
        claimed.id,
        "IM_DELIVERY_QUEUE_AGE_EXCEEDED",
        "claimToken" in claimed ? claimed.claimToken : undefined,
      );
      return;
    }
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const complete = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const run = async () => {
      this.#onMetric({ name: "active_lanes", value: this.#scheduler.stats().active, agentId: claimed.agentId });
      let failed = false;
      try {
        await withOperationDeadline(
          this.#operationTimeoutMs,
          async (signal) => {
            await traceDeliveryClaim(claimed, async (claim) => {
              if (claim.kind === "pending") await this.#deliver(claim.id, claim.claimToken, signal);
              else if (claim.kind === "steer") await this.#deliverSteer(claim, signal);
              else await this.#recover(claim.id);
            });
          },
          async () => {
            this.#onMetric({ name: "timeout", value: 1, agentId: claimed.agentId });
            await this.#recordFailure(
              claimed.id,
              "IM_DELIVERY_OPERATION_TIMEOUT",
              "claimToken" in claimed ? claimed.claimToken : undefined,
            );
          },
          () => {
            this.#onDiagnostic("IM_DELIVERY_OPERATION_LATE_SETTLE");
            this.#onMetric({ name: "late_settle", value: 1, agentId: claimed.agentId });
          },
          () => this.#onDiagnostic("IM_DELIVERY_OPERATION_ABANDONED"),
        );
      } catch (error) {
        failed = true;
        reject(error);
        throw error;
      } finally {
        this.#onMetric({ name: "active_lanes", value: this.#scheduler.stats().active, agentId: claimed.agentId });
        if (!failed) resolve();
      }
    };
    const enqueued = this.#scheduler.enqueue(`agent:${claimed.agentId}`, run, () => {
      this.#onMetric({ name: "saturation", value: 1, agentId: claimed.agentId });
      void this.#recordFailure(
        claimed.id,
        "IM_DELIVERY_WORKER_SATURATED",
        "claimToken" in claimed ? claimed.claimToken : undefined,
      )
        .catch(() => undefined)
        .finally(resolve);
    });
    if (!enqueued) {
      this.#onMetric({ name: "saturation", value: 1, agentId: claimed.agentId });
      await this.#recordFailure(
        claimed.id,
        "IM_DELIVERY_WORKER_SATURATED",
        "claimToken" in claimed ? claimed.claimToken : undefined,
      );
      resolve();
    }
    this.#onMetric({ name: "queued_tasks", value: this.#scheduler.stats().queued, agentId: claimed.agentId });
    await complete;
  }

  #schedule(): void {
    const operation = this.runOnce().catch((error: unknown) => {
      this.#onDiagnostic("IM_DELIVERY_WORKER_SCHEDULING_FAILED");
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

  async #claim(): Promise<WorkerClaim | undefined> {
    const claim = await this.#database.transaction(async (transaction) => {
      const now = this.#clock();
      const [row] = await transaction
        .select({
          id: imMessageDeliveries.id,
          state: imMessageDeliveries.state,
          deliveryGeneration: imMessageDeliveries.placementGeneration,
          dispatchRequestId: imMessageDeliveries.dispatchRequestId,
          dispatchInputHash: imMessageDeliveries.dispatchInputHash,
          dispatchPayload: imMessageDeliveries.dispatchPayload,
          nextAttemptAt: imMessageDeliveries.nextAttemptAt,
          generation: sessionPlacements.generation,
          agentId: imBindings.agentId,
          sessionId: imMessageDeliveries.sessionId,
          computerId: sessionPlacements.computerId,
          steerTargetDeliveryId: imMessageDeliveries.steerTargetDeliveryId,
        })
        .from(imMessageDeliveries)
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, imMessageDeliveries.sessionId))
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
        .where(
          and(
            isNull(sessions.endedAt),
            eq(imBindings.status, "active"),
            ne(agents.status, "deleted"),
            or(
              and(
                eq(agents.status, "active"),
                or(
                  and(
                    eq(imMessageDeliveries.state, "pending"),
                    isNull(imMessageDeliveries.reason),
                    lte(imMessageDeliveries.nextAttemptAt, now),
                    // The ingress deadline bounds pending input. An UNDISPATCHED Cloud row is not
                    // claimed past it (the janitor expires it as ttl). A DISPATCHED Cloud row is
                    // owned by its frozen execution window instead: the worker still claims it to
                    // release stale dispatches, and the janitor expires it afterwards.
                    or(
                      sql`${imMessageDeliveries.expiresAt} > now()`,
                      and(eq(computers.kind, "cloud"), isNotNull(imMessageDeliveries.dispatchRequestId)),
                    ),
                  ),
                  and(
                    eq(imMessageDeliveries.state, "expired"),
                    isNotNull(imMessageDeliveries.dispatchRequestId),
                    lte(imMessageDeliveries.nextAttemptAt, now),
                  ),
                ),
                or(
                  notExists(
                    transaction
                      .select({ id: acceptedDeliveries.id })
                      .from(acceptedDeliveries)
                      .innerJoin(acceptedSessions, eq(acceptedSessions.id, acceptedDeliveries.sessionId))
                      .innerJoin(acceptedImBindings, eq(acceptedImBindings.id, acceptedSessions.imBindingId))
                      .innerJoin(acceptedAgents, eq(acceptedAgents.id, acceptedImBindings.agentId))
                      .where(
                        and(
                          eq(acceptedImBindings.agentId, imBindings.agentId),
                          ne(acceptedDeliveries.id, imMessageDeliveries.id),
                          isNull(acceptedSessions.endedAt),
                          eq(acceptedImBindings.status, "active"),
                          ne(acceptedAgents.status, "deleted"),
                          uncertainAgentCustody(acceptedDeliveries),
                        ),
                      ),
                  ),
                  and(
                    // Cloud follow-ups never enter the Local steer path: the E4 protocol has no
                    // steer frame, and selecting them here only to decline would re-select the
                    // same row every tick and starve every other tenant.
                    eq(computers.kind, "local"),
                    eq(imMessageDeliveries.state, "pending"),
                    isNull(imMessageDeliveries.dispatchRequestId),
                    isNull(imMessageDeliveries.steerTargetDeliveryId),
                    exists(
                      transaction
                        .select({ id: acceptedDeliveries.id })
                        .from(acceptedDeliveries)
                        .innerJoin(acceptedSessions, eq(acceptedSessions.id, acceptedDeliveries.sessionId))
                        .innerJoin(acceptedImBindings, eq(acceptedImBindings.id, acceptedSessions.imBindingId))
                        .where(
                          and(
                            eq(acceptedImBindings.agentId, imBindings.agentId),
                            ne(acceptedDeliveries.id, imMessageDeliveries.id),
                            eq(acceptedDeliveries.sessionId, imMessageDeliveries.sessionId),
                            eq(acceptedDeliveries.state, "accepted"),
                            isNull(acceptedDeliveries.reportedAt),
                          ),
                        ),
                    ),
                  ),
                ),
              ),
              and(
                eq(imMessageDeliveries.state, "accepted"),
                isNull(imMessageDeliveries.reportedAt),
                lte(imMessageDeliveries.nextAttemptAt, now),
              ),
            ),
          ),
        )
        .orderBy(asc(imMessageDeliveries.nextAttemptAt), asc(imMessageDeliveries.id))
        .limit(1)
        .for("update", { of: imMessageDeliveries, skipLocked: true });
      if (!row) return undefined;
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`im-agent-custody:${row.agentId}`}, 0))`,
      );
      const otherCustody =
        row.state === "accepted" ? undefined : await findOtherAgentCustody(transaction, row.agentId, row.id);
      let steerTarget: { id: string; turnId: string } | undefined;
      if (otherCustody) {
        const instanceId = this.#registry.currentInstanceId(row.computerId);
        if (
          row.state !== "pending" ||
          row.dispatchRequestId !== null ||
          row.steerTargetDeliveryId !== null ||
          otherCustody.state !== "accepted" ||
          otherCustody.sessionId !== row.sessionId ||
          otherCustody.reportedAt !== null ||
          !otherCustody.turnId ||
          !instanceId ||
          otherCustody.reportOwnerInstanceId !== instanceId ||
          !this.#registry.supportsCapability(row.computerId, instanceId, RUNTIME_CAPABILITY.imSteer)
        ) {
          // A declined steer must be deferred, not skipped: returning without advancing the row
          // makes the same earliest row win every tick and block all other tenants' deliveries.
          await transaction
            .update(imMessageDeliveries)
            .set({
              nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS),
              lastErrorCode: "IM_DELIVERY_STEER_DEFERRED",
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
            nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS),
            lastErrorCode: null,
          })
          .where(and(eq(imMessageDeliveries.id, row.id), eq(imMessageDeliveries.state, "accepted")));
        return { id: row.id, agentId: row.agentId, queuedAt: row.nextAttemptAt.getTime(), kind: "recovery" as const };
      }
      const persistedRequest = row.dispatchPayload
        ? DirectImMessageDeliveryRequestSchema.safeParse(row.dispatchPayload)
        : undefined;
      const persistedSteer = row.dispatchPayload
        ? RuntimeImSteerRequestSchema.safeParse(row.dispatchPayload)
        : undefined;
      const persistedPlacementGeneration = persistedRequest?.success
        ? persistedRequest.data.placementGeneration
        : persistedSteer?.success
          ? persistedSteer.data.placementGeneration
          : undefined;
      const staleCorrelation =
        row.dispatchRequestId !== null &&
        (row.deliveryGeneration !== row.generation ||
          (persistedPlacementGeneration !== undefined && persistedPlacementGeneration !== row.generation));
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
      const retiredSteerCorrelation =
        persistedSteer?.success === true &&
        row.dispatchRequestId === persistedSteer.data.requestId &&
        row.dispatchInputHash === computeRuntimeImSteerInputHash(persistedSteer.data) &&
        row.steerTargetDeliveryId === persistedSteer.data.rootDeliveryId &&
        row.id === persistedSteer.data.deliveryId &&
        row.sessionId === persistedSteer.data.sessionId &&
        row.agentId === persistedSteer.data.agentId;
      if (retiredSteerCorrelation && row.state === "expired") {
        await transaction
          .update(imMessageDeliveries)
          .set({
            dispatchRequestId: null,
            dispatchInputHash: null,
            dispatchPayload: null,
            steerTargetDeliveryId: null,
            lastErrorCode: null,
          })
          .where(eq(imMessageDeliveries.id, row.id));
        return undefined;
      }
      const claimToken = dispatchClaimToken();
      await transaction
        .update(imMessageDeliveries)
        .set({
          attemptCount: sql`${imMessageDeliveries.attemptCount} + 1`,
          ...(row.state === "pending" ? { placementGeneration: row.generation } : {}),
          ...(retiredSteerCorrelation
            ? {
                dispatchRequestId: null,
                dispatchInputHash: null,
                dispatchPayload: null,
                steerTargetDeliveryId: null,
              }
            : {}),
          nextAttemptAt: new Date(now.getTime() + this.#claimLeaseMs),
          lastErrorCode: claimToken,
        })
        .where(eq(imMessageDeliveries.id, row.id));
      return steerTarget
        ? {
            id: row.id,
            agentId: row.agentId,
            queuedAt: row.nextAttemptAt.getTime(),
            kind: "steer" as const,
            claimToken,
            rootDeliveryId: steerTarget.id,
            expectedTurnId: steerTarget.turnId,
          }
        : {
            id: row.id,
            agentId: row.agentId,
            queuedAt: row.nextAttemptAt.getTime(),
            kind: "pending" as const,
            claimToken,
          };
    });
    // The hook is intentionally outside the claim transaction. It is a test and
    // diagnostics seam, not part of the database critical section.
    if (claim) await this.#afterClaimRowLocked?.();
    return claim;
  }

  async #deliver(deliveryId: string, claimToken: string, signal: AbortSignal): Promise<void> {
    const lease = this.#maintainClaimLease(deliveryId, claimToken);
    try {
      await this.#deliverClaimed(deliveryId, claimToken, lease, signal);
    } finally {
      await lease.stop();
    }
  }

  async #deliverSteer(
    claim: {
      id: string;
      claimToken: string;
      rootDeliveryId: string;
      expectedTurnId: string;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const lease = this.#maintainClaimLease(claim.id, claim.claimToken);
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
            eq(imMessageDeliveries.state, "pending"),
            isNull(imMessageDeliveries.reason),
            isNull(sessions.endedAt),
            eq(imBindings.status, "active"),
            eq(agents.status, "active"),
          ),
        )
        .limit(1);
      if (!row || row.delivery.placementGeneration !== row.placement.generation) {
        await this.#recordFailure(claim.id, "IM_DELIVERY_STEER_AUTHORITY_UNAVAILABLE", claim.claimToken);
        return;
      }
      if (row.computerOwnerAccountId !== row.agent.createdByUserId) {
        if (row.delivery.dispatchRequestId === null) {
          await this.#reject(claim.id, "computer_owner_mismatch", claim.claimToken);
        } else {
          await this.#recordFailure(claim.id, "IM_DELIVERY_COMPUTER_OWNER_MISMATCH", claim.claimToken);
        }
        return;
      }
      const instanceId = this.#registry.currentInstanceId(row.computer.id);
      if (
        !instanceId ||
        row.computer.currentInstanceId !== instanceId ||
        !this.#registry.supportsCapability(row.computer.id, instanceId, RUNTIME_CAPABILITY.imSteer)
      ) {
        await this.#recordFailure(claim.id, "IM_DELIVERY_STEER_UNAVAILABLE", claim.claimToken);
        return;
      }
      const replyRole = await this.#replyRole(row.message.id, row.session.kind, row.message.threadKey);
      if (
        replyRole === "observer" &&
        this.#registry.capabilityVersion(row.computer.id, instanceId, RUNTIME_CAPABILITY.imSteer) !== 2
      ) {
        await this.#recordFailure(claim.id, "IM_DELIVERY_OBSERVER_STEER_UNSUPPORTED", claim.claimToken);
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
        await this.#recordFailure(claim.id, "IM_DELIVERY_STEER_TARGET_ENDED", claim.claimToken);
        return;
      }
      const content = await this.#buildDeliveryContent({
        delivery: row.delivery,
        message: row.message,
        session: row.session,
        imBinding: row.imBinding,
        receiveMode: row.agent.receiveMode,
      });
      const request: RuntimeImSteerRequest = {
        type: "im:steer",
        requestId: randomUUID(),
        deliveryId: row.delivery.id,
        imMessageId: row.message.id,
        sessionId: row.session.id,
        agentId: row.agent.id,
        placementGeneration: row.placement.generation,
        rootDeliveryId: target.id,
        expectedTurnId: claim.expectedTurnId,
        attention: row.delivery.attention,
        ...(replyRole ? { replyRole } : {}),
        content,
        deadlineAt: row.delivery.expiresAt.toISOString(),
      };
      fitDeliveryFrame(request);
      if (!(await lease.assertOwned())) return;
      const admitted = await this.#withActiveAgentAdmission(
        {
          agentId: row.agent.id,
          computerId: row.computer.id,
          placementGeneration: row.placement.generation,
          sessionId: row.session.id,
        },
        (onDispatched) => this.#domain.requestSteer(row.computer.id, instanceId, request, onDispatched),
        signal,
      );
      if (!admitted.admitted) {
        await this.#recordFailure(claim.id, "IM_DELIVERY_AGENT_NOT_ACTIVE", claim.claimToken);
        return;
      }
      const result = await admitted.result;
      setActiveSpanAttributes(outcomeAttrs(result.status, "reason" in result ? result.reason : undefined));
      if (result.status === "rejected" && (result.reason === "invalid_input" || result.reason === "input_conflict")) {
        await this.#reject(claim.id, result.reason, claim.claimToken);
      } else if (result.status !== "steered") {
        await this.#recordFailure(
          claim.id,
          result.status === "retry" ? "IM_DELIVERY_STEER_STARTING" : "IM_DELIVERY_STEER_DEFERRED",
          claim.claimToken,
        );
      }
    } catch {
      await this.#recordFailure(claim.id, "IM_DELIVERY_STEER_FAILED", claim.claimToken);
    } finally {
      await lease.stop();
    }
  }

  async #deliverClaimed(deliveryId: string, claimToken: string, lease: ClaimLease, signal: AbortSignal): Promise<void> {
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
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_AUTHORITY_UNAVAILABLE", claimToken);
      return;
    }
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
      await this.#recordFailure(deliveryId, "IM_DELIVERY_PLACEMENT_STALE", claimToken);
      return;
    }
    /*
     * E4 Cloud branch: a Cloud Computer is a logical identity with one Sandbox Runner per Agent
     * Session, so deliveries route through the per-Sandbox Cloud dispatch owner, never the Local
     * runtime registry (`computer.currentInstanceId`/`registry.currentInstanceId` are Local-only
     * facts). Cloud pending-deadline discipline, deliberately reusing Local bounds:
     * - the claim lease (claimLeaseMs) and operation deadline (operationTimeoutMs) are unchanged:
     *   Cloud dispatch is a short custody write + control-frame send, never a wait for cold start;
     * - an unready environment/Runner is a TRANSIENT failure retried on RETRY_DELAY_MS, so long
     *   allocations are absorbed by repeated short attempts instead of one long in-operation wait;
     * - no Local admission/queue-age TTL applies (maxQueueAgeMs is unset in production wiring);
     *   the delivery's own expiresAt — set at ingress and protected by the Cloud-aware
     *   inbox/janitor retention — is the bounded deadline for the UNDISPATCHED pending input;
     *   once a dispatch window is frozen, its runtime-budget deadline (separate from the short
     *   operationTimeoutMs and ingress TTL) bounds it; accepted-unreported custody is never expired.
     */
    if (row.computer.kind === "cloud") {
      await this.#deliverCloud(row, claimToken, lease, signal);
      return;
    }
    const instanceId = this.#registry.currentInstanceId(row.computer.id);
    if (!instanceId || row.computer.currentInstanceId !== instanceId) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_UNAVAILABLE", claimToken);
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
      await this.#recordFailure(deliveryId, "IM_DELIVERY_DISPATCH_PAYLOAD_INVALID", claimToken);
      return;
    }
    const persistedRequest = persisted.status === "valid" ? persisted.request : undefined;
    const replyRole = persistedRequest
      ? persistedRequest.replyRole
      : await this.#replyRole(row.message.id, row.session.kind, row.message.threadKey);
    if (
      replyRole === "observer" &&
      this.#registry.capabilityVersion(row.computer.id, instanceId, RUNTIME_CAPABILITY.imDelivery) !== 2
    ) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_OBSERVER_UNSUPPORTED", claimToken);
      return;
    }
    const runtime =
      persistedRequest?.runtime ?? (await this.#assembleRuntime(deliveryId, row.session.id, "delivery", claimToken));
    if (!runtime) return;
    // A late acceptance may commit after this delivery was claimed. Recheck at
    // the last boundary before any reconcile or delivery frame reaches runtime.
    if (await hasOtherAgentCustody(this.#database, row.agent.id, deliveryId)) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_AGENT_CUSTODY_FENCED", claimToken);
      return;
    }
    if (!(await lease.assertOwned())) return;
    try {
      const admission = {
        agentId: row.agent.id,
        computerId: row.computer.id,
        placementGeneration: row.placement.generation,
        sessionId: row.session.id,
      };
      const admittedReconcile = await this.#withActiveAgentAdmission(
        admission,
        (onDispatched) =>
          this.#domain.requestReconcile(
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
            onDispatched,
          ),
        signal,
      );
      if (!admittedReconcile.admitted) {
        await this.#recordFailure(deliveryId, "IM_DELIVERY_AGENT_NOT_ACTIVE", claimToken);
        return;
      }
      const reconcile = await admittedReconcile.result;
      const [currentDelivery] = await this.#database
        .select({ state: imMessageDeliveries.state })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, deliveryId))
        .limit(1);
      if (!currentDelivery || currentDelivery.state === "accepted" || currentDelivery.state === "terminal_rejected") {
        return;
      }
      if (!(await lease.assertOwned())) return;
      if (reconcile.status !== "ready") {
        await this.#recordFailure(
          deliveryId,
          reconcile.status === "rejected" ? "IM_DELIVERY_RECONCILE_REJECTED" : "IM_DELIVERY_RECONCILE_NOT_READY",
          claimToken,
        );
        return;
      }
      if (reconcile.retainedReports?.some((claim) => claim.deliveryId === deliveryId)) {
        await this.#recordFailure(deliveryId, "IM_DELIVERY_RETAINED_CUSTODY_CONFLICT", claimToken);
        return;
      }
      if (currentDelivery.state === "expired") {
        if (persistedRequest) {
          await this.#releaseDispatch(deliveryId, persistedRequest.requestId, "IM_DELIVERY_EXPIRED", claimToken);
        }
        return;
      }
      if (persistedRequest) {
        await this.#releaseDispatch(
          deliveryId,
          persistedRequest.requestId,
          "IM_DELIVERY_RECONCILED_NO_CUSTODY",
          claimToken,
        );
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
      if (!(await lease.assertOwned())) return;
      await this.#beforeDeliveryAdmission?.(signal);
      const admittedDelivery = await this.#withActiveAgentAdmission(
        admission,
        (onDispatched) => this.#domain.requestDelivery(row.computer.id, instanceId, request, onDispatched),
        signal,
      );
      if (!admittedDelivery.admitted) {
        await this.#recordFailure(deliveryId, "IM_DELIVERY_AGENT_NOT_ACTIVE", claimToken);
        return;
      }
      const result = await admittedDelivery.result;
      setActiveSpanAttributes(outcomeAttrs(result.status, "reason" in result ? result.reason : undefined));
      if (
        result.status === "rejected" &&
        ["configuration_unsupported", "invalid_input"].includes(result.reason ?? "")
      ) {
        await this.#reject(deliveryId, result.reason ?? "terminal_rejected", claimToken);
      } else if (result.status === "rejected") {
        await this.#releaseDispatch(deliveryId, request.requestId, "IM_DELIVERY_RUNTIME_REJECTED", claimToken);
      }
    } catch {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_FAILED", claimToken);
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
    claimToken: string,
    lease: ClaimLease,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#cloudCoordinator.deliver(row, claimToken, lease, signal);
  }

  async #recover(deliveryId: string): Promise<void> {
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
          isNull(imMessageDeliveries.reportedAt),
          isNull(sessions.endedAt),
          eq(imBindings.status, "active"),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1);
    if (!row) return;
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
    if (row.delivery.placementGeneration !== row.placement.generation) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_PLACEMENT_STALE");
      return;
    }
    /*
     * E4 Cloud recovery: an accepted Cloud delivery owes a Turn Report from its Sandbox Runner.
     * While the allocation still owns the report, recovery waits for the Runner's journal-driven
     * re-report (transient retry); once the allocation is superseded or released, the owner
     * settles the delivery exactly once as unknown/turn_state_unknown — never a blind replay.
     */
    if (row.computer.kind === "cloud") {
      await this.#cloudCoordinator.recover(deliveryId);
      return;
    }
    const instanceId = this.#registry.currentInstanceId(row.computer.id);
    if (!instanceId || row.computer.currentInstanceId !== instanceId) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_UNAVAILABLE");
      return;
    }
    const recovery = await this.#resolveRecoveryRuntime(row, deliveryId);
    if ("invalid" in recovery) return;
    const runtime = recovery.runtime;
    if (row.agent.status === "active" && !runtime) return;
    try {
      await this.#domain.requestReconcile(row.computer.id, instanceId, {
        type: "session:reconcile",
        requestId: randomUUID(),
        installationId: row.computer.currentInstallationId,
        sessionId: row.session.id,
        agentId: row.agent.id,
        placementGeneration: row.placement.generation,
        desired: row.agent.status === "active" ? "ready" : "stopped",
        ...(runtime ? { runtime } : {}),
      });
      setActiveSpanAttributes(outcomeAttrs("recovered"));
    } catch {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RECOVERY_FAILED");
    }
  }

  /**
   * The Local recovery runtime: a pinned dispatch payload is validated exactly, a legacy row may
   * fall back to the assembled snapshot only while the Agent is still active.
   */
  async #resolveRecoveryRuntime(
    row: {
      delivery: typeof imMessageDeliveries.$inferSelect;
      session: typeof sessions.$inferSelect;
      agent: typeof agents.$inferSelect;
      placement: typeof sessionPlacements.$inferSelect;
    },
    deliveryId: string,
  ): Promise<{ invalid: true } | { runtime: EffectiveRuntimeSnapshot | undefined }> {
    if (row.delivery.dispatchPayload === null) {
      if (row.agent.status !== "active") return { runtime: undefined };
      this.#onDiagnostic("IM_DELIVERY_RECOVERY_LEGACY_SNAPSHOT_FALLBACK");
      return { runtime: await this.#assembleRuntime(deliveryId, row.session.id, "recovery") };
    }
    const pinned = DirectImMessageDeliveryRequestSchema.safeParse(row.delivery.dispatchPayload);
    const pinnedInputHash = pinned.success ? computeDirectInputHash(pinned.data) : undefined;
    if (
      !pinned.success ||
      pinned.data.deliveryId !== row.delivery.id ||
      pinned.data.imMessageId !== row.delivery.messageId ||
      pinned.data.sessionId !== row.session.id ||
      pinned.data.agentId !== row.agent.id ||
      pinned.data.placementGeneration !== row.placement.generation ||
      pinned.data.requestId !== row.delivery.dispatchRequestId ||
      pinnedInputHash !== row.delivery.dispatchInputHash ||
      pinnedInputHash !== row.delivery.inputHash
    ) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RECOVERY_PAYLOAD_INVALID");
      return { invalid: true };
    }
    return { runtime: row.agent.status === "active" ? pinned.data.runtime : undefined };
  }

  async #assembleRuntime(
    deliveryId: string,
    sessionId: string,
    mode: "delivery" | "recovery",
    claimToken?: string,
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
          deliveryId,
          code === "UNSUPPORTED_PROVIDER" ? "configuration_unsupported" : "invalid_input",
          claimToken,
        );
        return undefined;
      }
      await this.#recordFailure(
        deliveryId,
        code === "DATABASE_FAILURE"
          ? "IM_DELIVERY_RUNTIME_AUTHORITY_FAILED"
          : "IM_DELIVERY_RUNTIME_AUTHORITY_UNAVAILABLE",
        claimToken,
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

  async #recordFailure(
    deliveryId: string,
    code: string,
    claimToken?: string,
    retryDelayMs: number = RETRY_DELAY_MS,
  ): Promise<void> {
    const bounded = /^IM_DELIVERY_[A-Z0-9_]{1,100}$/.test(code) ? code : "IM_DELIVERY_FAILED";
    setActiveSpanAttributes(outcomeAttrs("failed", bounded));
    const [updated] = await this.#database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: bounded, nextAttemptAt: new Date(this.#now() + retryDelayMs) })
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          sql`${imMessageDeliveries.state} in ('pending', 'accepted', 'expired')`,
          ...(claimToken ? [eq(imMessageDeliveries.lastErrorCode, claimToken)] : []),
        ),
      )
      .returning({ id: imMessageDeliveries.id });
    if (updated) {
      this.#onDiagnostic(bounded);
      this.#onMetric({ name: "retry", value: 1 });
    }
  }

  async #releaseDispatch(deliveryId: string, requestId: string, code: string, claimToken: string): Promise<void> {
    const bounded = /^IM_DELIVERY_[A-Z0-9_]{1,100}$/.test(code) ? code : "IM_DELIVERY_FAILED";
    setActiveSpanAttributes(outcomeAttrs("released", bounded));
    const [released] = await this.#database
      .update(imMessageDeliveries)
      .set({
        dispatchRequestId: null,
        dispatchInputHash: null,
        dispatchPayload: null,
        lastErrorCode: bounded,
        nextAttemptAt: new Date(this.#now() + RETRY_DELAY_MS),
      })
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          inArray(imMessageDeliveries.state, ["pending", "expired"]),
          eq(imMessageDeliveries.dispatchRequestId, requestId),
          eq(imMessageDeliveries.lastErrorCode, claimToken),
        ),
      )
      .returning({ id: imMessageDeliveries.id });
    if (released) {
      this.#onDiagnostic(bounded);
      this.#onMetric({ name: "retry", value: 1 });
    }
  }

  async #reject(deliveryId: string, reason: string, claimToken?: string): Promise<void> {
    setActiveSpanAttributes(outcomeAttrs("terminal_rejected", reason));
    await this.#database
      .update(imMessageDeliveries)
      .set({
        state: "terminal_rejected",
        dispatchRequestId: null,
        dispatchInputHash: null,
        dispatchPayload: null,
        reason: reason.slice(0, 120),
        lastErrorCode: "IM_DELIVERY_TERMINAL",
      })
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          eq(imMessageDeliveries.state, "pending"),
          ...(claimToken ? [eq(imMessageDeliveries.lastErrorCode, claimToken)] : []),
        ),
      );
  }

  #maintainClaimLease(deliveryId: string, claimToken: string): ClaimLease {
    let active = true;
    let lost = false;
    let renewal = Promise.resolve();
    const renew = () => {
      renewal = renewal
        .then(async () => {
          if (!active || lost) return;
          lost = !(await this.#renewClaim(deliveryId, claimToken));
        })
        .catch(() => {
          lost = true;
        });
    };
    const timer = setInterval(renew, this.#claimRenewMs);
    timer.unref();
    return {
      assertOwned: async () => {
        await renewal;
        if (lost) return false;
        const [owned] = await this.#database
          .select({ id: imMessageDeliveries.id })
          .from(imMessageDeliveries)
          .where(
            and(
              eq(imMessageDeliveries.id, deliveryId),
              inArray(imMessageDeliveries.state, ["pending", "expired"]),
              eq(imMessageDeliveries.lastErrorCode, claimToken),
            ),
          )
          .limit(1);
        if (!owned) lost = true;
        return !lost;
      },
      stop: async () => {
        active = false;
        clearInterval(timer);
        await renewal;
      },
    };
  }

  async #renewClaim(deliveryId: string, claimToken: string): Promise<boolean> {
    const [renewed] = await this.#database
      .update(imMessageDeliveries)
      .set({ nextAttemptAt: new Date(this.#now() + this.#claimLeaseMs) })
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          inArray(imMessageDeliveries.state, ["pending", "expired"]),
          eq(imMessageDeliveries.lastErrorCode, claimToken),
        ),
      )
      .returning({ id: imMessageDeliveries.id });
    return renewed !== undefined;
  }

  async #buildDeliveryContent(input: {
    delivery: Pick<typeof imMessageDeliveries.$inferSelect, "attention">;
    message: typeof imMessages.$inferSelect;
    session: typeof sessions.$inferSelect;
    imBinding: typeof imBindings.$inferSelect;
    receiveMode: (typeof agents.$inferSelect)["receiveMode"];
  }): Promise<RuntimeImDeliveryContent> {
    const resources = input.message.content.resources ?? [];
    const history =
      input.delivery.attention === "direct" && (input.receiveMode === "mention_only" || input.session.kind === "thread")
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
      kind: "text",
      text: truncateUtf8(
        input.message.operation === "deleted" ? "[deleted]" : input.message.content.fallbackText,
        RUNTIME_DIRECT_TEXT_MAX_BYTES,
      ),
      providerRef: runtimeProviderMessageRef(input.message, input.imBinding),
      ...(history.items.length > 0 ? { history: history.items, historyTruncated: history.truncated } : {}),
      ...(resources.length > 0
        ? {
            resources: resources.map((resource, index) => ({
              imMessageId: input.message.id,
              ordinal: resource.ordinal ?? index,
              kind: resource.kind,
              ...(resource.filename ? { filename: resource.filename } : {}),
              ...(resource.mediaType ? { mediaType: resource.mediaType } : {}),
              ...(resource.sizeBytes !== null ? { sizeBytes: resource.sizeBytes } : {}),
              availability: resource.availability ?? "available",
            })),
          }
        : {}),
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
