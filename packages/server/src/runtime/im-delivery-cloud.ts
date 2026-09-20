import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  type EffectiveRuntimeSnapshot,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_MAX_DURATION_MS,
  RUNTIME_MAX_FRAME_BYTES,
  type RuntimeImDeliveryContent,
  runtimeFrameByteLength,
} from "@opentag/shared";
import { and, asc, eq, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  type imMessages,
  sessionPlacements,
  sessions,
  users,
} from "../db/schema/index.js";
import { outcomeAttrs, setActiveSpanAttributes } from "../observability/index.js";
import type { CloudDeliveryOwner } from "../services/sandboxes/cloud-delivery-owner.js";
import { CloudDeliveryDispatchError } from "../services/sandboxes/cloud-delivery-owner.js";
import { CloudCapacityExceededError } from "../services/sandboxes/errors.js";
import { loadSandboxRecordBySessionId } from "../services/sandboxes/owned-sandbox.js";
import type { DeliveryOccupancySubject } from "./im-delivery-custody.js";
import type { CloudSessionAllocationPort } from "./im-delivery-worker.types.js";

/**
 * Cohesive E4 Cloud admission/allocation/recovery for the IM delivery worker. Kept out of the
 * already-large worker module: the worker delegates one claimed Cloud row, the bounded
 * stopped-Session reconciliation pass, and accepted-turn recovery here, passing its shared
 * custody helpers in so both paths keep the same durable semantics.
 */

export const STOPPED_CLOUD_RECONCILE_BATCH = 25;
export const STOPPED_CLOUD_RECONCILE_INTERVAL_MS = 30_000;

export type CloudDeliveryClaimRow = {
  delivery: typeof imMessageDeliveries.$inferSelect;
  message: typeof imMessages.$inferSelect;
  session: typeof sessions.$inferSelect;
  placement: typeof sessionPlacements.$inferSelect;
  imBinding: typeof imBindings.$inferSelect;
  agent: typeof agents.$inferSelect;
  computer: typeof computers.$inferSelect;
};

export interface CloudClaimLease {
  assertOwned(): Promise<boolean>;
  stop(): Promise<void>;
}

export type ActiveAgentAdmission = <T>(
  expected: { agentId: string; computerId: string; placementGeneration: number; sessionId: string },
  operation: (onDispatched: () => void) => Promise<T>,
  signal?: AbortSignal,
) => Promise<{ admitted: false } | { admitted: true; result: Promise<T> }>;

export interface CloudDeliveryCoordinatorOptions {
  database: DatabaseClient;
  cloudDelivery?: CloudDeliveryOwner;
  cloudAllocation?: CloudSessionAllocationPort;
  now: () => number;
  onDiagnostic: (code: string) => void;
  beforeDeliveryAdmission?: (signal: AbortSignal) => Promise<void>;
  assembleRuntime: (
    deliveryId: string,
    sessionId: string,
    mode: "delivery" | "recovery",
    claimToken?: string,
  ) => Promise<EffectiveRuntimeSnapshot | undefined>;
  replyRole: (
    messageId: string,
    sessionKind: (typeof sessions.$inferSelect)["kind"],
    threadKey: string | null,
  ) => Promise<"observer" | undefined>;
  buildDeliveryContent: (input: {
    delivery: Pick<typeof imMessageDeliveries.$inferSelect, "attention">;
    message: typeof imMessages.$inferSelect;
    session: typeof sessions.$inferSelect;
    imBinding: typeof imBindings.$inferSelect;
    receiveMode: (typeof agents.$inferSelect)["receiveMode"];
  }) => Promise<RuntimeImDeliveryContent>;
  /** Occupancy recheck at the last boundary: a competing owner of the delivery's scope. */
  hasOtherCustody: (subject: DeliveryOccupancySubject) => Promise<boolean>;
  recordFailure: (deliveryId: string, code: string, claimToken?: string, retryDelayMs?: number) => Promise<void>;
  releaseDispatch: (deliveryId: string, requestId: string, code: string, claimToken: string) => Promise<void>;
  rejectInput: (deliveryId: string, reason: string, claimToken?: string) => Promise<void>;
  withActiveAgentAdmission: ActiveAgentAdmission;
}

export class CloudDeliveryCoordinator {
  readonly #options: CloudDeliveryCoordinatorOptions;

  constructor(options: CloudDeliveryCoordinatorOptions) {
    this.#options = options;
  }

  /** One claimed Cloud delivery: validate/refresh the dispatch and send it through the owner. */
  async deliver(row: CloudDeliveryClaimRow, claimToken: string, lease: CloudClaimLease, signal: AbortSignal) {
    const deliveryId = row.delivery.id;
    // Release a stale/expired dispatch FIRST: a dispatched row is outside the janitor's TTL bound,
    // so this is the only path back to the bounded deadline, and it must not depend on the model
    // path being configured.
    if (!(await lease.assertOwned())) return;
    if (await this.#releaseUnusableDispatch(row, deliveryId, claimToken)) return;
    const prepared = await this.#prepareDispatch(row, claimToken);
    if (prepared.kind !== "continue") return;
    if (
      await this.#options.hasOtherCustody({
        deliveryId,
        agentId: row.agent.id,
        sessionId: row.session.id,
        computerKind: row.computer.kind,
      })
    ) {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_AGENT_CUSTODY_FENCED", claimToken);
      return;
    }
    if (!(await lease.assertOwned())) return;
    try {
      const built =
        prepared.persistedRequest ?? (await this.#buildFreshDispatch(row, prepared.replyRole, prepared.runtime));
      if (!(await lease.assertOwned())) return;
      if (!(await this.#ensureEnvironment(deliveryId, row, claimToken))) return;
      if (!(await lease.assertOwned())) return;
      const cloudDelivery = this.#options.cloudDelivery;
      if (!cloudDelivery) return;
      await this.#dispatchToRunner(row, cloudDelivery, built, claimToken, signal);
    } catch (error) {
      await this.#recordDispatchError(deliveryId, row.delivery.attemptCount, error, claimToken);
    }
  }

  /**
   * Validate the model path and the persisted dispatch, then resolve the model BEFORE any fresh
   * payload/input hash exists. A persisted request is already frozen and is never mutated.
   */
  async #prepareDispatch(
    row: CloudDeliveryClaimRow,
    claimToken: string,
  ): Promise<
    | { kind: "stop" }
    | {
        kind: "continue";
        persistedRequest: DirectImMessageDeliveryRequest | undefined;
        replyRole: "observer" | undefined;
        runtime: EffectiveRuntimeSnapshot;
      }
  > {
    const deliveryId = row.delivery.id;
    const cloudDelivery = this.#options.cloudDelivery;
    if (!cloudDelivery) {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_UNAVAILABLE", claimToken);
      return { kind: "stop" };
    }
    if (!cloudDelivery.isModelPathConfigured()) {
      // Model-disabled configuration: report the transient inability instead of provisioning a
      // Cloud environment that could never execute the delivery. This is a transient dispatch
      // failure too, so it backs off with the existing attempt counter instead of a 2 s hot retry.
      await this.#options.recordFailure(
        deliveryId,
        "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE",
        claimToken,
        cloudDispatchRetryDelayMs(row.delivery.attemptCount),
      );
      return { kind: "stop" };
    }
    const persisted = readPersistedDeliveryRequest({
      delivery: row.delivery,
      message: row.message,
      session: row.session,
      agent: row.agent,
      placementGeneration: row.placement.generation,
    });
    if (persisted.status === "invalid") {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_DISPATCH_PAYLOAD_INVALID", claimToken);
      return { kind: "stop" };
    }
    const persistedRequest = persisted.status === "valid" ? persisted.request : undefined;
    const replyRole = persistedRequest
      ? persistedRequest.replyRole
      : await this.#options.replyRole(row.message.id, row.session.kind, row.message.threadKey);
    const assembledRuntime =
      persistedRequest?.runtime ??
      (await this.#options.assembleRuntime(deliveryId, row.session.id, "delivery", claimToken));
    if (!assembledRuntime) return { kind: "stop" };
    const runtime = persistedRequest ? assembledRuntime : cloudDelivery.resolveRuntimeModel(assembledRuntime);
    if (!runtime) {
      await this.#options.recordFailure(
        deliveryId,
        "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE",
        claimToken,
        cloudDispatchRetryDelayMs(row.delivery.attemptCount),
      );
      return { kind: "stop" };
    }
    return { kind: "continue", persistedRequest, replyRole, runtime };
  }

  /**
   * Release dispatches that must not execute: an expired row, or a frozen window that already
   * passed. A pending row never held execution permission, so a stale window is released for a
   * fresh attempt rather than faked forward.
   */
  async #releaseUnusableDispatch(row: CloudDeliveryClaimRow, deliveryId: string, claimToken: string): Promise<boolean> {
    const persisted = readPersistedDeliveryRequest({
      delivery: row.delivery,
      message: row.message,
      session: row.session,
      agent: row.agent,
      placementGeneration: row.placement.generation,
    });
    const persistedRequest = persisted.status === "valid" ? persisted.request : undefined;
    if (row.delivery.state === "expired") {
      // Same rule as Local: an expired dispatch is released, never executed.
      if (persistedRequest) {
        await this.#options.releaseDispatch(deliveryId, persistedRequest.requestId, "IM_DELIVERY_EXPIRED", claimToken);
      }
      return true;
    }
    if (persistedRequest && cloudDispatchWindowExpired(persistedRequest, this.#options.now())) {
      await this.#options.releaseDispatch(
        deliveryId,
        persistedRequest.requestId,
        "IM_DELIVERY_CLOUD_DISPATCH_EXPIRED",
        claimToken,
      );
      return true;
    }
    return false;
  }

  async #buildFreshDispatch(
    row: CloudDeliveryClaimRow,
    replyRole: "observer" | undefined,
    runtime: EffectiveRuntimeSnapshot,
  ): Promise<DirectImMessageDeliveryRequest> {
    const content = await this.#options.buildDeliveryContent({
      delivery: row.delivery,
      message: row.message,
      session: row.session,
      imBinding: row.imBinding,
      receiveMode: row.agent.receiveMode,
    });
    const fresh: DirectImMessageDeliveryRequest = {
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
      // The execution window is the runtime budget for THIS attempt, never the ingress TTL.
      deadlineAt: cloudDispatchDeadline(this.#options.now(), runtime),
    };
    fitDeliveryFrame(fresh);
    return fresh;
  }

  async #dispatchToRunner(
    row: CloudDeliveryClaimRow,
    cloudDelivery: CloudDeliveryOwner,
    built: DirectImMessageDeliveryRequest,
    claimToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#options.beforeDeliveryAdmission?.(signal);
    const admitted = await this.#options.withActiveAgentAdmission(
      {
        agentId: row.agent.id,
        computerId: row.computer.id,
        placementGeneration: row.placement.generation,
        sessionId: row.session.id,
      },
      async (onDispatched) => {
        try {
          await cloudDelivery.dispatchDelivery({
            computerId: row.computer.id,
            inputHash: computeDirectInputHash(built),
            installationId: row.computer.currentInstallationId,
            request: built,
          });
        } finally {
          onDispatched();
        }
      },
      signal,
    );
    if (!admitted.admitted) {
      await this.#options.recordFailure(row.delivery.id, "IM_DELIVERY_AGENT_NOT_ACTIVE", claimToken);
      return;
    }
    await admitted.result;
  }

  async #recordDispatchError(
    deliveryId: string,
    attemptCount: number,
    error: unknown,
    claimToken: string,
  ): Promise<void> {
    if (error instanceof CloudDeliveryDispatchError) {
      const code = cloudDispatchFailureCode(error);
      setActiveSpanAttributes(outcomeAttrs("failed", error.code));
      // A Runner that is not ready yet (cold start, brief reconnect) or a model grant that is
      // temporarily unavailable must not pin the worker to a 2 s hot retry until the frozen
      // window runs out: back off with the existing attempt counter, capped well below the
      // dispatch deadline. Every other failure keeps the immediate bounded retry.
      const retryDelayMs = TRANSIENT_CLOUD_DISPATCH_CODES.has(code)
        ? cloudDispatchRetryDelayMs(attemptCount)
        : undefined;
      await this.#options.recordFailure(deliveryId, code, claimToken, retryDelayMs);
      return;
    }
    await this.#options.recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_FAILED", claimToken);
  }

  /**
   * Idempotent normal-ingress environment ensure: creates the Session Sandbox row through the
   * existing SandboxService when it is missing, then converges the current allocation through the
   * existing E3 service. Runs OUTSIDE agent admission and inside the bounded delivery operation,
   * so a cold create never holds another delivery's lock or an agent lane indefinitely.
   */
  async #ensureEnvironment(
    deliveryId: string,
    row: Pick<CloudDeliveryClaimRow, "delivery" | "session" | "agent">,
    claimToken: string,
  ): Promise<boolean> {
    const sandboxId = await this.#ensureSandboxRow(deliveryId, row, claimToken);
    if (!sandboxId) return false;
    if (!this.#options.cloudAllocation) return true;
    return this.#convergeAllocation(
      deliveryId,
      row.agent.createdByUserId,
      sandboxId,
      claimToken,
      row.delivery.attemptCount,
    );
  }

  /** Create the Session Sandbox through the existing SandboxService when it is missing. */
  async #ensureSandboxRow(
    deliveryId: string,
    row: Pick<CloudDeliveryClaimRow, "session" | "agent">,
    claimToken: string,
  ): Promise<string | undefined> {
    const existing = await loadSandboxRecordBySessionId(this.#options.database, row.session.id);
    if (existing) return existing.id;
    const port = this.#options.cloudAllocation;
    if (!port) {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_ALLOCATION_UNAVAILABLE", claimToken);
      return undefined;
    }
    if (row.session.kind !== "channel" && row.session.kind !== "thread") {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_SESSION_KIND_UNSUPPORTED", claimToken);
      return undefined;
    }
    if (row.session.kind === "thread" && !row.session.threadKey) {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_ALLOCATION_FAILED", claimToken);
      return undefined;
    }
    const ensureInput = {
      accountId: row.agent.createdByUserId,
      imBindingId: row.session.imBindingId,
      channelId: row.session.channelId,
      conversationKind: row.session.conversationKind,
    };
    try {
      await port.ensureSandbox(
        row.session.kind === "thread"
          ? { ...ensureInput, kind: "thread", threadKey: row.session.threadKey as string }
          : { ...ensureInput, kind: "channel" },
      );
    } catch {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_ALLOCATION_FAILED", claimToken);
      return undefined;
    }
    const created = await loadSandboxRecordBySessionId(this.#options.database, row.session.id);
    if (!created) {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_ALLOCATION_FAILED", claimToken);
      return undefined;
    }
    return created.id;
  }

  async #convergeAllocation(
    deliveryId: string,
    accountId: string,
    sandboxId: string,
    claimToken: string,
    attemptCount: number,
  ): Promise<boolean> {
    try {
      const outcome = await this.#options.cloudAllocation?.ensureEnvironmentAllocated({ accountId, sandboxId });
      if (outcome === "restore_required") {
        // E5 guard: never allocate a blank replacement for previously used storage. This is a
        // permanent condition for the input, so it terminates explicitly instead of retrying.
        await this.#options.rejectInput(deliveryId, "restore_required", claimToken);
        return false;
      }
      if (outcome === "stopped") {
        // The environment is being released; this input can never run on it. Terminal, not a
        // 2 s retry loop.
        await this.#options.rejectInput(deliveryId, "environment_stopped", claimToken);
        return false;
      }
      return true;
    } catch (error) {
      if (error instanceof CloudCapacityExceededError) {
        // Capacity is transient for IM: the input stays in the existing bounded queue ("waiting
        // for cloud resources") with the same capped backoff and ingress TTL.
        await this.#options.recordFailure(
          deliveryId,
          "IM_DELIVERY_CLOUD_CAPACITY_WAITING",
          claimToken,
          cloudDispatchRetryDelayMs(attemptCount),
        );
        return false;
      }
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_ALLOCATION_FAILED", claimToken);
      return false;
    }
  }

  /**
   * Bounded reconciliation for Cloud work whose authority chain is no longer active: the Session
   * ended, the Agent or binding was deactivated/suspended, or the Account was suspended. Those
   * rows are outside the normal claim filters, so this pass keeps them from being stranded.
   * Pending inputs whose stop is PERMANENT are terminally rejected with an explicit reason; a bare
   * `reauthorization_required` binding is a TRANSIENT pause, so its queued input stays pending
   * within the existing TTL/capacity and is delivered after the user restores authorization.
   * Accepted-unreported turns are re-driven through the owner's persisted-allocation recovery
   * (never a blind replay) on a bounded cadence — a paused authority keeps its evidence pending, a
   * permanent stop cancels it truthfully, and a genuine outcome is preserved until the Runner
   * reports or the allocation is proven retired/superseded.
   */
  async reconcileStoppedWork(): Promise<void> {
    const owner = this.#options.cloudDelivery;
    if (!owner) return;
    const pending = await this.#stoppedRows("pending");
    for (const row of pending) {
      try {
        await this.#options.rejectInput(row.id, row.reason);
      } catch {
        this.#options.onDiagnostic("IM_DELIVERY_CLOUD_STOPPED_REJECT_FAILED");
      }
    }
    const accepted = await this.#stoppedRows("accepted");
    for (const row of accepted) {
      try {
        await owner.recoverAccepted(row.id);
      } catch {
        this.#options.onDiagnostic("IM_DELIVERY_CLOUD_STOPPED_RECONCILE_FAILED");
      }
      await this.#throttleStoppedRow(row.id);
    }
  }

  /** Accepted Cloud work for one delivery: owner recovery with the pending retry signal. */
  async recover(deliveryId: string): Promise<void> {
    const owner = this.#options.cloudDelivery;
    if (!owner) {
      await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_UNAVAILABLE");
      return;
    }
    const outcome = await owner.recoverAccepted(deliveryId);
    if (outcome === "pending") await this.#options.recordFailure(deliveryId, "IM_DELIVERY_CLOUD_REPORT_PENDING");
  }

  async #stoppedRows(state: "pending" | "accepted"): Promise<{ id: string; reason: string }[]> {
    const rows = await this.#options.database
      .select({
        id: imMessageDeliveries.id,
        ended: isNotNull(sessions.endedAt),
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(users, eq(users.id, agents.createdByUserId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(
        and(
          eq(imMessageDeliveries.state, state),
          state === "pending" ? isNull(imMessageDeliveries.reason) : isNull(imMessageDeliveries.reportedAt),
          eq(computers.kind, "cloud"),
          lte(imMessageDeliveries.nextAttemptAt, new Date(this.#options.now())),
          // Every authority filter the normal claim path applies, plus the ones it only checks
          // later: an inactive chain must still reach bounded reconciliation. Pending rows are
          // only rejected for DEFINITIVE stops — `reauthorization_required` alone is a transient
          // pause that keeps queued input within its TTL/capacity for delivery after reauth.
          state === "pending"
            ? or(
                isNotNull(sessions.endedAt),
                ne(agents.status, "active"),
                isNotNull(users.suspendedAt),
                and(ne(imBindings.status, "active"), ne(imBindings.status, "reauthorization_required")),
              )
            : or(
                isNotNull(sessions.endedAt),
                ne(agents.status, "active"),
                ne(imBindings.status, "active"),
                isNotNull(users.suspendedAt),
              ),
        ),
      )
      .orderBy(asc(imMessageDeliveries.id))
      .limit(STOPPED_CLOUD_RECONCILE_BATCH);
    return rows.map((row) => ({ id: row.id, reason: row.ended ? "session_ended" : "authority_stopped" }));
  }

  async #throttleStoppedRow(deliveryId: string): Promise<void> {
    try {
      await this.#options.database
        .update(imMessageDeliveries)
        .set({ nextAttemptAt: new Date(this.#options.now() + STOPPED_CLOUD_RECONCILE_INTERVAL_MS) })
        .where(
          and(
            eq(imMessageDeliveries.id, deliveryId),
            eq(imMessageDeliveries.state, "accepted"),
            isNull(imMessageDeliveries.reportedAt),
          ),
        );
    } catch {
      this.#options.onDiagnostic("IM_DELIVERY_CLOUD_STOPPED_RECONCILE_THROTTLE_FAILED");
    }
  }
}

/** A pending row (or a frozen dispatch) that must be released: the row expired, or its window passed. */
export function cloudDispatchWindowExpired(request: DirectImMessageDeliveryRequest, nowMs: number): boolean {
  if (request.deadlineAt === undefined) return false;
  const deadlineMs = Date.parse(request.deadlineAt);
  return Number.isFinite(deadlineMs) && deadlineMs <= nowMs;
}

/**
 * The Cloud execution window frozen into one dispatch attempt: the runtime budget of THIS attempt
 * (Agent budget or the platform default), bounded by the supported maximum. Deliberately separate
 * from the ingress `expiresAt`, which bounds Local and undispatched Cloud pending input.
 */
export function cloudDispatchDeadline(nowMs: number, runtime: EffectiveRuntimeSnapshot): string {
  const requested = runtime.budget?.maxDurationMs;
  const duration =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? requested
      : RUNTIME_DEFAULT_MAX_DURATION_MS;
  const bounded = Math.min(Math.trunc(duration), RUNTIME_MAX_DURATION_MS);
  return new Date(nowMs + bounded).toISOString();
}

export function cloudDispatchFailureCode(error: CloudDeliveryDispatchError): string {
  return error.code === "stale_generation"
    ? "IM_DELIVERY_PLACEMENT_STALE"
    : error.code === "model_unavailable"
      ? "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE"
      : error.code === "dispatch_conflict"
        ? "IM_DELIVERY_CLOUD_DISPATCH_CONFLICT"
        : "IM_DELIVERY_CLOUD_ENVIRONMENT_NOT_READY";
}

/**
 * Transient dispatch failures (Runner not ready yet, model grant temporarily unavailable) retry
 * with a capped exponential backoff derived from the existing `attemptCount`. Local deliveries
 * keep their unchanged fixed retry: only these Cloud codes pass a delay to `recordFailure`.
 */
const CLOUD_RETRY_BASE_DELAY_MS = 2_000;
const CLOUD_RETRY_MAX_DELAY_MS = 30_000;

/** The Cloud failures that back off instead of retrying on the fixed cadence. */
const TRANSIENT_CLOUD_DISPATCH_CODES = new Set([
  "IM_DELIVERY_CLOUD_ENVIRONMENT_NOT_READY",
  "IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE",
]);

/** `attemptCount` is the post-claim attempt number: 1 -> 2 s, 2 -> 4 s, … capped at 30 s. */
export function cloudDispatchRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(0, Math.trunc(attemptCount) - 1), 20);
  return Math.min(CLOUD_RETRY_BASE_DELAY_MS * 2 ** exponent, CLOUD_RETRY_MAX_DELAY_MS);
}

export type PersistedDeliveryRequest =
  | { status: "absent" }
  | { status: "valid"; request: DirectImMessageDeliveryRequest }
  | { status: "invalid" };

/** Parse and cross-check the persisted dispatch payload against the claimed row identity. */
export function readPersistedDeliveryRequest(input: {
  delivery: Pick<
    typeof imMessageDeliveries.$inferSelect,
    "id" | "sessionId" | "dispatchPayload" | "dispatchRequestId" | "dispatchInputHash"
  >;
  message: Pick<typeof imMessages.$inferSelect, "id">;
  session: Pick<typeof sessions.$inferSelect, "id">;
  agent: Pick<typeof agents.$inferSelect, "id">;
  placementGeneration: number;
}): PersistedDeliveryRequest {
  if (!input.delivery.dispatchPayload) return { status: "absent" };
  const parsed = DirectImMessageDeliveryRequestSchema.safeParse(input.delivery.dispatchPayload);
  const request = parsed.success ? parsed.data : undefined;
  const matches =
    request !== undefined &&
    request.deliveryId === input.delivery.id &&
    request.imMessageId === input.message.id &&
    request.sessionId === input.session.id &&
    request.agentId === input.agent.id &&
    request.placementGeneration === input.placementGeneration &&
    request.requestId === input.delivery.dispatchRequestId &&
    computeDirectInputHash(request) === input.delivery.dispatchInputHash;
  return matches && request ? { status: "valid", request } : { status: "invalid" };
}

function fitDeliveryFrame(request: DirectImMessageDeliveryRequest): void {
  const fits = () => runtimeFrameByteLength(JSON.stringify(request)) <= RUNTIME_MAX_FRAME_BYTES;
  while (!fits() && request.content.history && request.content.history.length > 0) {
    request.content.history.shift();
    request.content.historyTruncated = true;
  }
  while (!fits() && request.content.resources && request.content.resources.length > 0) {
    request.content.resources.pop();
  }
  if (!fits()) throw new Error("IM_DELIVERY_FRAME_TOO_LARGE");
}
