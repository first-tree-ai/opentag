import { randomUUID } from "node:crypto";
import {
  DirectImMessageDeliveryRequestSchema,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
  type SessionReconcileResult,
  type SessionRecoverRequest,
  type SessionRecoverResult,
} from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { agents, computers, imBindings, imMessageDeliveries, sessionPlacements, sessions } from "../db/schema/index.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../services/runtime-config/effective-runtime-snapshot-assembler.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeDispatchAdmission } from "./runtime-domain-owner.js";
import type { RuntimeBusinessContext } from "./runtime-session.js";

type RecoverDecision = Pick<SessionRecoverResult, "status" | "reason">;

export interface SessionRecoveryServiceOptions {
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  database: DatabaseClient;
  logger?: Pick<ServiceLogger, "warn">;
  registry: Pick<ConnectionRegistry, "canReceiveSnapshot">;
  /** Late-bound: the domain owner both routes the request here and sends the reconcile. */
  requestReconcile(
    computerId: string,
    instanceId: string,
    request: SessionReconcileRequest,
    admission: RuntimeDispatchAdmission<SessionReconcileResult>,
  ): Promise<SessionReconcileResult>;
}

interface RecoveryScope {
  sessionKind: "channel" | "thread" | "internal";
  creatorSessionId: string | null;
  installationId: string;
}

type Authorization = { refusal: string } | { scope: RecoveryScope; runtime?: EffectiveRuntimeSnapshot };

/**
 * Serves `runtime.sessionRecovery` v1. A Local Client that restarted while accepted work was in
 * flight owns the one automatic retry of that work, but only the Server can prepare the Session
 * for the new connection (a fresh Session CLI proof and the current runtime snapshot). This
 * service authorizes the request against the live Agent, binding, Session, placement and current
 * connection under row locks, moves the report ownership of a named accepted IM Turn to the
 * requesting connection in that same transaction, and then schedules an ordinary ready reconcile.
 * It never redelivers input and never writes a Turn Report.
 */
export class SessionRecoveryService {
  readonly #options: SessionRecoveryServiceOptions;
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(options: SessionRecoveryServiceOptions) {
    this.#options = options;
  }

  async recover(frame: SessionRecoverRequest, context: RuntimeBusinessContext): Promise<RecoverDecision> {
    if (!this.#options.registry.canReceiveSnapshot(context.computerId, context.instanceId)) {
      return { status: "retry", reason: "runtime_upgrade_required" };
    }
    const authorized = await this.#options.database.transaction((transaction) =>
      authorizeAndTakeOver(transaction, frame, context),
    );
    if ("refusal" in authorized) return rejected(authorized.refusal);
    let runtime: EffectiveRuntimeSnapshot;
    try {
      runtime = authorized.runtime ?? (await this.#options.assembler.assembleForSession(frame.sessionId));
    } catch {
      return { status: "retry", reason: "runtime_not_ready" };
    }
    const { scope } = authorized;
    this.#scheduleReconcile(frame, context, {
      type: "session:reconcile",
      requestId: randomUUID(),
      installationId: scope.installationId,
      sessionId: frame.sessionId,
      agentId: frame.agentId,
      placementGeneration: frame.placementGeneration,
      ...(scope.sessionKind === "internal" && scope.creatorSessionId
        ? { sessionKind: "internal" as const, creatorSessionId: scope.creatorSessionId }
        : {}),
      desired: "ready",
      runtime,
    });
    return { status: "scheduled" };
  }

  /**
   * The reconcile result arrives on the same connection; never wait for it inside this frame. A
   * reconcile that fails or is never answered is retried by the Client, which stays the owner of the
   * recovery until its Session is actually prepared.
   */
  #scheduleReconcile(
    frame: SessionRecoverRequest,
    context: RuntimeBusinessContext,
    request: SessionReconcileRequest,
  ): void {
    const reconcile = this.#options
      .requestReconcile(context.computerId, context.instanceId, request, (operation) =>
        this.#withDispatchAdmission(frame, context, operation),
      )
      .catch((error: unknown) => {
        this.#options.logger?.warn(
          {
            code: "SESSION_RECOVERY_RECONCILE_FAILED",
            sessionId: request.sessionId,
            computerId: context.computerId,
            error: error instanceof Error ? error.name : "unknown",
          },
          "Session recovery reconcile failed",
        );
      })
      .finally(() => this.#inFlight.delete(reconcile));
    this.#inFlight.add(reconcile);
  }

  /**
   * The final send boundary of the ready reconcile. Snapshot assembly and proof preparation ran after
   * the takeover committed, so the authority is locked and rechecked again while the frame is enqueued,
   * in the same order the Agent stop path takes (`withAgentSessionStopAuthority`: Agent, Session,
   * placement). A stop that committed first refuses this reconcile; a stop that comes later waits
   * and enqueues its `stopped` reconcile behind it.
   */
  #withDispatchAdmission(
    frame: SessionRecoverRequest,
    context: RuntimeBusinessContext,
    operation: (onDispatched: () => void) => Promise<SessionReconcileResult>,
  ): Promise<{ admitted: false } | { admitted: true; result: Promise<SessionReconcileResult> }> {
    return this.#options.database.transaction(async (transaction) => {
      const session = await lockLifecycle(transaction, frame, context);
      if ("refusal" in session) return { admitted: false } as const;
      const placement = await lockPlacement(transaction, frame, context);
      if ("refusal" in placement) return { admitted: false } as const;
      let markDispatched: () => void = () => undefined;
      const dispatched = new Promise<void>((resolve) => {
        markDispatched = resolve;
      });
      let result: Promise<SessionReconcileResult>;
      try {
        result = operation(markDispatched);
      } catch (error) {
        markDispatched();
        throw error;
      }
      void result.catch(() => markDispatched());
      await dispatched;
      return { admitted: true, result } as const;
    });
  }

  /** Waits for scheduled reconciles; used by tests and orderly shutdown. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }
}

/**
 * The authorization and the report-owner takeover share one transaction, so the facts they rely on
 * cannot change before the write. Lock order follows the Agent lifecycle and maintenance-report
 * paths: Agent and binding (`FOR SHARE`: lifecycle status writes wait), then the Session
 * (`FOR NO KEY UPDATE`, as Turn reports and retained claims take it), its placement (`FOR UPDATE`),
 * the Computer (`FOR SHARE`: a reconnect replacing `current_instance_id` waits), and only then the
 * delivery row.
 */
async function authorizeAndTakeOver(
  transaction: DatabaseTransaction,
  frame: SessionRecoverRequest,
  context: RuntimeBusinessContext,
): Promise<Authorization> {
  const session = await lockLifecycle(transaction, frame, context);
  if ("refusal" in session) return session;
  const computer = await lockPlacement(transaction, frame, context);
  if ("refusal" in computer) return computer;
  // An internal Session needs its creator, and only an IM Turn names a delivery.
  if (session.kind === "internal" && (!session.creatorSessionId || frame.deliveryId)) {
    return { refusal: "session_kind_mismatch" };
  }
  const scope: RecoveryScope = {
    sessionKind: session.kind,
    creatorSessionId: session.creatorSessionId,
    installationId: computer.installationId,
  };
  if (!frame.deliveryId || !frame.turnId) return { scope };
  // The restarted Client's old connection still owns the accepted Turn's report. Only this exact
  // accepted, unreported Turn at the current placement generation moves to the current connection;
  // the reconcile then uses its frozen dispatch snapshot, because the Client's Turn is fenced to it.
  const [owned] = await transaction
    .update(imMessageDeliveries)
    .set({ reportOwnerInstanceId: context.instanceId })
    .where(
      and(
        eq(imMessageDeliveries.id, frame.deliveryId),
        eq(imMessageDeliveries.sessionId, frame.sessionId),
        eq(imMessageDeliveries.state, "accepted"),
        eq(imMessageDeliveries.turnId, frame.turnId),
        eq(imMessageDeliveries.placementGeneration, frame.placementGeneration),
        isNull(imMessageDeliveries.reportedAt),
      ),
    )
    .returning({ payload: imMessageDeliveries.dispatchPayload });
  if (!owned) return { refusal: "turn_not_recoverable" };
  const frozen = DirectImMessageDeliveryRequestSchema.safeParse(owned.payload);
  return frozen.success ? { scope, runtime: frozen.data.runtime } : { scope };
}

/** Agent and binding `FOR SHARE`, then the live Session `FOR NO KEY UPDATE`. */
async function lockLifecycle(
  transaction: DatabaseTransaction,
  frame: SessionRecoverRequest,
  context: RuntimeBusinessContext,
): Promise<{ refusal: string } | { kind: RecoveryScope["sessionKind"]; creatorSessionId: string | null }> {
  const [agent] = await transaction
    .select({ status: agents.status, computerId: agents.computerId })
    .from(agents)
    .where(eq(agents.id, frame.agentId))
    .for("share");
  if (!agent || agent.computerId !== context.computerId) return { refusal: "agent_mismatch" };
  if (agent.status !== "active") return { refusal: "agent_not_active" };
  const [identity] = await transaction
    .select({ bindingId: sessions.imBindingId })
    .from(sessions)
    .where(eq(sessions.id, frame.sessionId))
    .limit(1);
  if (!identity) return { refusal: "session_not_found" };
  const [binding] = await transaction
    .select({ agentId: imBindings.agentId, status: imBindings.status })
    .from(imBindings)
    .where(eq(imBindings.id, identity.bindingId))
    .for("share");
  if (binding?.agentId !== frame.agentId) return { refusal: "agent_mismatch" };
  if (binding.status !== "active") return { refusal: "binding_not_active" };
  const [session] = await transaction
    .select({ kind: sessions.kind, endedAt: sessions.endedAt, creatorSessionId: sessions.createdBySessionId })
    .from(sessions)
    .where(eq(sessions.id, frame.sessionId))
    .for("no key update");
  if (!session || session.endedAt) return { refusal: "session_ended" };
  return { kind: session.kind, creatorSessionId: session.creatorSessionId };
}

/** The placement `FOR UPDATE`, then the Computer `FOR SHARE` with its exact current connection. */
async function lockPlacement(
  transaction: DatabaseTransaction,
  frame: SessionRecoverRequest,
  context: RuntimeBusinessContext,
): Promise<{ refusal: string } | { installationId: string }> {
  const [placement] = await transaction
    .select({ computerId: sessionPlacements.computerId, generation: sessionPlacements.generation })
    .from(sessionPlacements)
    .where(eq(sessionPlacements.sessionId, frame.sessionId))
    .for("update");
  if (placement?.computerId !== context.computerId || placement.generation !== frame.placementGeneration) {
    return { refusal: "placement_stale" };
  }
  const [computer] = await transaction
    .select({
      kind: computers.kind,
      installationId: computers.currentInstallationId,
      instanceId: computers.currentInstanceId,
    })
    .from(computers)
    .where(eq(computers.id, context.computerId))
    .for("share");
  if (!computer || computer.instanceId !== context.instanceId) return { refusal: "stale_connection" };
  if (computer.kind !== "local") return { refusal: "cloud_unsupported" };
  return { installationId: computer.installationId };
}

function rejected(reason: string): RecoverDecision {
  return { status: "rejected", reason };
}
