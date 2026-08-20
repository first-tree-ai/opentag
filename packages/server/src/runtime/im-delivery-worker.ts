import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  type EffectiveRuntimeSnapshot,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  RUNTIME_IM_HISTORY_MAX_BYTES,
  RUNTIME_MAX_FRAME_BYTES,
  runtimeFrameByteLength,
} from "@opentag/shared";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeDomainOwner } from "./runtime-domain-owner.js";

const DEFAULT_INTERVAL_MS = 500;
const RETRY_DELAY_MS = 2_000;
const CLAIM_LEASE_MS = 15_000;
const CLAIM_RENEW_MS = 5_000;
// This durable marker bridges the transaction-to-runtime gap. The advisory lock
// serializes competing claims; the marker keeps later transactions fenced after commit.
const DISPATCH_CLAIM_PREFIX = "IM_DELIVERY_CLAIM_";
const acceptedDeliveries = alias(imMessageDeliveries, "agent_accepted_deliveries");
const acceptedSessions = alias(sessions, "agent_accepted_sessions");
const acceptedImBindings = alias(imBindings, "agent_accepted_im_bindings");
const acceptedAgents = alias(agents, "agent_accepted_agents");

export class ImDeliveryWorker {
  readonly #database: DatabaseClient;
  readonly #domain: RuntimeDomainOwner;
  readonly #assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  readonly #registry: ConnectionRegistry;
  readonly #intervalMs: number;
  readonly #claimLeaseMs: number;
  readonly #claimRenewMs: number;
  readonly #afterClaimRowLocked?: () => Promise<void>;
  readonly #beforeDeliveryAdmission?: () => Promise<void>;
  readonly #onDiagnostic: (code: string) => void;
  #timer?: ReturnType<typeof setInterval>;
  #running = false;

  constructor(input: {
    database: DatabaseClient;
    domain: RuntimeDomainOwner;
    assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
    registry: ConnectionRegistry;
    intervalMs?: number;
    claimLeaseMs?: number;
    claimRenewMs?: number;
    afterClaimRowLocked?: () => Promise<void>;
    beforeDeliveryAdmission?: () => Promise<void>;
    onDiagnostic?: (code: string) => void;
  }) {
    this.#database = input.database;
    this.#domain = input.domain;
    this.#assembler = input.assembler;
    this.#registry = input.registry;
    this.#intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#claimLeaseMs = input.claimLeaseMs ?? CLAIM_LEASE_MS;
    this.#claimRenewMs = input.claimRenewMs ?? CLAIM_RENEW_MS;
    this.#afterClaimRowLocked = input.afterClaimRowLocked;
    this.#beforeDeliveryAdmission = input.beforeDeliveryAdmission;
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    this.#schedule();
    this.#timer = setInterval(() => this.#schedule(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const claimed = await this.#claim();
      await traceDeliveryClaim(claimed, async (claim) => {
        if (claim.kind === "pending") await this.#deliver(claim.id, claim.claimToken);
        else await this.#recover(claim.id);
      });
    } finally {
      this.#running = false;
    }
  }

  #schedule(): void {
    void this.runOnce().catch(() => this.#onDiagnostic("IM_DELIVERY_WORKER_SCHEDULING_FAILED"));
  }

  async #claim(): Promise<
    { id: string; kind: "pending"; claimToken: string } | { id: string; kind: "recovery" } | undefined
  > {
    return this.#database.transaction(async (transaction) => {
      const now = new Date();
      await transaction
        .update(imMessageDeliveries)
        .set({ state: "expired", reason: "ttl" })
        .where(
          and(
            eq(imMessageDeliveries.state, "pending"),
            isNull(imMessageDeliveries.reason),
            lte(imMessageDeliveries.expiresAt, now),
          ),
        );
      const [row] = await transaction
        .select({
          id: imMessageDeliveries.id,
          state: imMessageDeliveries.state,
          deliveryGeneration: imMessageDeliveries.placementGeneration,
          dispatchRequestId: imMessageDeliveries.dispatchRequestId,
          dispatchInputHash: imMessageDeliveries.dispatchInputHash,
          dispatchPayload: imMessageDeliveries.dispatchPayload,
          generation: sessionPlacements.generation,
          agentId: imBindings.agentId,
        })
        .from(imMessageDeliveries)
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, imMessageDeliveries.sessionId))
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
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
                    sql`${imMessageDeliveries.expiresAt} > now()`,
                  ),
                  and(
                    eq(imMessageDeliveries.state, "expired"),
                    isNotNull(imMessageDeliveries.dispatchRequestId),
                    lte(imMessageDeliveries.nextAttemptAt, now),
                  ),
                ),
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
      await this.#afterClaimRowLocked?.();
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`im-agent-custody:${row.agentId}`}, 0))`,
      );
      if (row.state !== "accepted" && (await hasOtherAgentCustody(transaction, row.agentId, row.id))) {
        return undefined;
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
        return { id: row.id, kind: "recovery" as const };
      }
      const persistedRequest = row.dispatchPayload
        ? DirectImMessageDeliveryRequestSchema.safeParse(row.dispatchPayload)
        : undefined;
      const staleCorrelation =
        row.dispatchRequestId !== null &&
        (row.deliveryGeneration !== row.generation ||
          (persistedRequest?.success && persistedRequest.data.placementGeneration !== row.generation));
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
      const claimToken = dispatchClaimToken();
      await transaction
        .update(imMessageDeliveries)
        .set({
          attemptCount: sql`${imMessageDeliveries.attemptCount} + 1`,
          ...(row.state === "pending" ? { placementGeneration: row.generation } : {}),
          nextAttemptAt: new Date(now.getTime() + this.#claimLeaseMs),
          lastErrorCode: claimToken,
        })
        .where(eq(imMessageDeliveries.id, row.id));
      return { id: row.id, kind: "pending" as const, claimToken };
    });
  }

  async #deliver(deliveryId: string, claimToken: string): Promise<void> {
    const lease = this.#maintainClaimLease(deliveryId, claimToken);
    try {
      await this.#deliverClaimed(deliveryId, claimToken, lease);
    } finally {
      await lease.stop();
    }
  }

  async #deliverClaimed(deliveryId: string, claimToken: string, lease: ClaimLease): Promise<void> {
    const [row] = await this.#database
      .select({
        delivery: imMessageDeliveries,
        message: imMessages,
        session: sessions,
        placement: sessionPlacements,
        imBinding: imBindings,
        agent: agents,
        computer: computers,
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
        computerId: row.placement.computerId,
        placementGeneration: row.placement.generation,
        attempt: row.delivery.attemptCount,
      }),
    });
    if (row.delivery.placementGeneration !== row.placement.generation) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_PLACEMENT_STALE", claimToken);
      return;
    }
    const instanceId = this.#registry.currentInstanceId(row.placement.computerId);
    if (!instanceId || row.computer.currentInstanceId !== instanceId) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_UNAVAILABLE", claimToken);
      return;
    }
    const parsedPersistedRequest = row.delivery.dispatchPayload
      ? DirectImMessageDeliveryRequestSchema.safeParse(row.delivery.dispatchPayload)
      : undefined;
    if (
      parsedPersistedRequest &&
      (!parsedPersistedRequest.success ||
        parsedPersistedRequest.data.deliveryId !== row.delivery.id ||
        parsedPersistedRequest.data.imMessageId !== row.message.id ||
        parsedPersistedRequest.data.sessionId !== row.session.id ||
        parsedPersistedRequest.data.agentId !== row.agent.id ||
        parsedPersistedRequest.data.placementGeneration !== row.placement.generation ||
        parsedPersistedRequest.data.requestId !== row.delivery.dispatchRequestId ||
        computeDirectInputHash(parsedPersistedRequest.data) !== row.delivery.dispatchInputHash)
    ) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_DISPATCH_PAYLOAD_INVALID", claimToken);
      return;
    }
    const persistedRequest = parsedPersistedRequest?.data;
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
      const admittedReconcile = await this.#withActiveAgentAdmission(row.agent.id, (onDispatched) =>
        this.#domain.requestReconcile(
          row.placement.computerId,
          instanceId,
          {
            type: "session:reconcile",
            requestId: randomUUID(),
            computerId: row.placement.computerId,
            sessionId: row.session.id,
            agentId: row.agent.id,
            placementGeneration: row.placement.generation,
            desired: "ready",
            runtime,
          },
          onDispatched,
        ),
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
      const resources = row.message.content.resources ?? [];
      const history =
        row.agent.receiveMode === "mention_only" && row.delivery.attention === "direct"
          ? await this.#history(row.session, row.message.occurredAt, row.message.providerRevisionKey, row.message.id)
          : { items: [], truncated: false };
      const request: DirectImMessageDeliveryRequest = {
        type: "im:deliver",
        requestId: randomUUID(),
        deliveryId: row.delivery.id,
        imMessageId: row.message.id,
        sessionId: row.session.id,
        agentId: row.agent.id,
        placementGeneration: row.placement.generation,
        attention: row.delivery.attention,
        content: {
          kind: "text",
          text: truncateUtf8(
            row.message.operation === "deleted" ? "[deleted]" : row.message.content.fallbackText,
            RUNTIME_DIRECT_TEXT_MAX_BYTES,
          ),
          ...(history.items.length > 0 ? { history: history.items, historyTruncated: history.truncated } : {}),
          ...(resources.length > 0
            ? {
                resources: resources.map((resource, index) => ({
                  imMessageId: row.message.id,
                  ordinal: resource.ordinal ?? index,
                  kind: resource.kind,
                  ...(resource.filename ? { filename: resource.filename } : {}),
                  ...(resource.mediaType ? { mediaType: resource.mediaType } : {}),
                  ...(resource.sizeBytes !== null ? { sizeBytes: resource.sizeBytes } : {}),
                  availability: resource.availability ?? "available",
                })),
              }
            : {}),
        },
        runtime,
        deadlineAt: row.delivery.expiresAt.toISOString(),
      };
      fitDeliveryFrame(request);
      if (!(await lease.assertOwned())) return;
      await this.#beforeDeliveryAdmission?.();
      const admittedDelivery = await this.#withActiveAgentAdmission(row.agent.id, (onDispatched) =>
        this.#domain.requestDelivery(row.placement.computerId, instanceId, request, onDispatched),
      );
      if (!admittedDelivery.admitted) {
        await this.#recordFailure(deliveryId, "IM_DELIVERY_AGENT_NOT_ACTIVE", claimToken);
        return;
      }
      const result = await admittedDelivery.result;
      setActiveSpanAttributes(outcomeAttrs(result.status, result.reason));
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
        computerId: row.placement.computerId,
        placementGeneration: row.placement.generation,
        attempt: row.delivery.attemptCount,
      }),
    });
    if (row.delivery.placementGeneration !== row.placement.generation) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_PLACEMENT_STALE");
      return;
    }
    const instanceId = this.#registry.currentInstanceId(row.placement.computerId);
    if (!instanceId || row.computer.currentInstanceId !== instanceId) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_UNAVAILABLE");
      return;
    }
    let runtime: EffectiveRuntimeSnapshot | undefined;
    if (row.delivery.dispatchPayload !== null) {
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
        return;
      }
      runtime = row.agent.status === "active" ? pinned.data.runtime : undefined;
    } else if (row.agent.status === "active") {
      this.#onDiagnostic("IM_DELIVERY_RECOVERY_LEGACY_SNAPSHOT_FALLBACK");
      runtime = await this.#assembleRuntime(deliveryId, row.session.id, "recovery");
    }
    if (row.agent.status === "active" && !runtime) return;
    try {
      await this.#domain.requestReconcile(row.placement.computerId, instanceId, {
        type: "session:reconcile",
        requestId: randomUUID(),
        computerId: row.placement.computerId,
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
    agentId: string,
    operation: (onDispatched: () => void) => Promise<T>,
  ): Promise<{ admitted: false } | { admitted: true; result: Promise<T> }> {
    return this.#database.transaction(async (transaction) => {
      const [agent] = await transaction
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
        .for("update");
      if (agent?.status !== "active") return { admitted: false } as const;
      let markDispatched: () => void = () => undefined;
      const dispatched = new Promise<void>((resolve) => {
        markDispatched = resolve;
      });
      const result = operation(markDispatched);
      void result.catch(() => markDispatched());
      await dispatched;
      return { admitted: true, result } as const;
    });
  }

  async #recordFailure(deliveryId: string, code: string, claimToken?: string): Promise<void> {
    const bounded = /^IM_DELIVERY_[A-Z0-9_]{1,100}$/.test(code) ? code : "IM_DELIVERY_FAILED";
    setActiveSpanAttributes(outcomeAttrs("failed", bounded));
    const [updated] = await this.#database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: bounded, ...(claimToken ? { nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) } : {}) })
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          sql`${imMessageDeliveries.state} in ('pending', 'accepted', 'expired')`,
          ...(claimToken ? [eq(imMessageDeliveries.lastErrorCode, claimToken)] : []),
        ),
      )
      .returning({ id: imMessageDeliveries.id });
    if (updated) this.#onDiagnostic(bounded);
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
        nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
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
    if (released) this.#onDiagnostic(bounded);
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
      .set({ nextAttemptAt: new Date(Date.now() + this.#claimLeaseMs) })
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

  async #history(
    session: typeof sessions.$inferSelect,
    occurredAt: Date,
    providerRevisionKey: string,
    messageId: string,
  ): Promise<{
    items: Array<{ imMessageId: string; occurredAt: string; text: string }>;
    truncated: boolean;
  }> {
    const [lastAccepted] = await this.#database
      .select({
        id: imMessages.id,
        occurredAt: imMessages.occurredAt,
        providerRevisionKey: imMessages.providerRevisionKey,
      })
      .from(imMessageDeliveries)
      .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
      .where(
        and(
          eq(imMessageDeliveries.sessionId, session.id),
          eq(imMessageDeliveries.state, "accepted"),
          messageBefore(occurredAt, providerRevisionKey, messageId),
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
      .limit(1);
    const rows = await this.#database
      .select({ id: imMessages.id, occurredAt: imMessages.occurredAt, content: imMessages.content })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, session.imBindingId),
          eq(imMessages.channelId, session.channelId),
          eq(imMessages.direction, "inbound"),
          ...(session.kind === "thread" && session.threadKey ? [eq(imMessages.threadKey, session.threadKey)] : []),
          messageBefore(occurredAt, providerRevisionKey, messageId),
          ...(lastAccepted
            ? [messageAfter(lastAccepted.occurredAt, lastAccepted.providerRevisionKey, lastAccepted.id)]
            : []),
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
      .limit(101);
    const selected = rows.slice(0, 100);
    const items: Array<{ imMessageId: string; occurredAt: string; text: string }> = [];
    let bytes = 2;
    let truncated = rows.length > selected.length;
    for (const row of selected) {
      const item = {
        imMessageId: row.id,
        occurredAt: row.occurredAt.toISOString(),
        text: truncateUtf8(row.content.fallbackText, RUNTIME_DIRECT_TEXT_MAX_BYTES),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 ? 1 : 0);
      if (bytes + itemBytes > RUNTIME_IM_HISTORY_MAX_BYTES) {
        truncated = true;
        break;
      }
      items.push(item);
      bytes += itemBytes;
    }
    return { items: items.reverse(), truncated };
  }
}

type CustodyQuery = Pick<DatabaseClient | DatabaseTransaction, "select">;

interface ClaimLease {
  assertOwned(): Promise<boolean>;
  stop(): Promise<void>;
}

async function hasOtherAgentCustody(database: CustodyQuery, agentId: string, deliveryId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: imMessageDeliveries.id })
    .from(imMessageDeliveries)
    .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .where(
      and(
        eq(imBindings.agentId, agentId),
        ne(imMessageDeliveries.id, deliveryId),
        isNull(sessions.endedAt),
        eq(imBindings.status, "active"),
        ne(agents.status, "deleted"),
        uncertainAgentCustody(imMessageDeliveries),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function uncertainAgentCustody(delivery: typeof imMessageDeliveries | typeof acceptedDeliveries) {
  return or(
    and(eq(delivery.state, "accepted"), isNull(delivery.reportedAt)),
    and(inArray(delivery.state, ["pending", "expired"]), isNotNull(delivery.dispatchRequestId)),
    and(eq(delivery.state, "pending"), like(delivery.lastErrorCode, `${DISPATCH_CLAIM_PREFIX}%`)),
  );
}

function dispatchClaimToken(): string {
  return `${DISPATCH_CLAIM_PREFIX}${randomUUID().replaceAll("-", "").toUpperCase()}`;
}

function messageBefore(occurredAt: Date, providerRevisionKey: string, messageId: string) {
  return or(
    lt(imMessages.occurredAt, occurredAt),
    and(
      eq(imMessages.occurredAt, occurredAt),
      or(
        lt(imMessages.providerRevisionKey, providerRevisionKey),
        and(eq(imMessages.providerRevisionKey, providerRevisionKey), lt(imMessages.id, messageId)),
      ),
    ),
  );
}

function messageAfter(occurredAt: Date, providerRevisionKey: string, messageId: string) {
  return or(
    gt(imMessages.occurredAt, occurredAt),
    and(
      eq(imMessages.occurredAt, occurredAt),
      or(
        gt(imMessages.providerRevisionKey, providerRevisionKey),
        and(eq(imMessages.providerRevisionKey, providerRevisionKey), gt(imMessages.id, messageId)),
      ),
    ),
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  return encoded.byteLength <= maxBytes ? value : encoded.subarray(0, maxBytes).toString("utf8");
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
