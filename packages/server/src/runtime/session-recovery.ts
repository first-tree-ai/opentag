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
import type { DatabaseClient } from "../db/client.js";
import { agents, computers, imBindings, imMessageDeliveries, sessionPlacements, sessions } from "../db/schema/index.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../services/runtime-config/effective-runtime-snapshot-assembler.js";
import type { ConnectionRegistry } from "./connection-registry.js";
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
  ): Promise<SessionReconcileResult>;
}

/**
 * Serves `runtime.sessionRecovery` v1. A Local Client that restarted while accepted work was in
 * flight owns the one automatic retry of that work, but only the Server can prepare the Session
 * for the new connection (a fresh Session CLI proof and the current runtime snapshot). This
 * service authorizes the request against the Session's current placement, moves the report
 * ownership of a named accepted IM Turn to the requesting connection, and schedules an ordinary
 * ready reconcile. It never redelivers input and never writes a Turn Report.
 */
export class SessionRecoveryService {
  readonly #options: SessionRecoveryServiceOptions;
  readonly #inFlight = new Set<Promise<unknown>>();

  constructor(options: SessionRecoveryServiceOptions) {
    this.#options = options;
  }

  async recover(frame: SessionRecoverRequest, context: RuntimeBusinessContext): Promise<RecoverDecision> {
    const row = await this.#loadScope(frame.sessionId);
    const refusal = scopeRefusal(row, frame, context);
    if (refusal || !row) return rejected(refusal ?? "session_not_found");
    if (!this.#options.registry.canReceiveSnapshot(context.computerId, context.instanceId)) {
      return { status: "retry", reason: "runtime_upgrade_required" };
    }
    const owned = await this.#takeOverTurn(frame, context);
    if (owned === "missing") return rejected("turn_not_recoverable");
    let runtime: EffectiveRuntimeSnapshot;
    try {
      runtime = owned?.runtime ?? (await this.#options.assembler.assembleForSession(frame.sessionId));
    } catch {
      return { status: "retry", reason: "runtime_not_ready" };
    }
    this.#scheduleReconcile(context, {
      type: "session:reconcile",
      requestId: randomUUID(),
      installationId: row.installationId,
      sessionId: frame.sessionId,
      agentId: frame.agentId,
      placementGeneration: frame.placementGeneration,
      ...(row.sessionKind === "internal" && row.creatorSessionId
        ? { sessionKind: "internal" as const, creatorSessionId: row.creatorSessionId }
        : {}),
      desired: "ready",
      runtime,
    });
    return { status: "scheduled" };
  }

  #loadScope(sessionId: string): Promise<RecoveryScope | undefined> {
    return this.#options.database
      .select({
        sessionKind: sessions.kind,
        endedAt: sessions.endedAt,
        creatorSessionId: sessions.createdBySessionId,
        placementComputerId: sessionPlacements.computerId,
        placementGeneration: sessionPlacements.generation,
        computerKind: computers.kind,
        installationId: computers.currentInstallationId,
        agentId: agents.id,
        agentStatus: agents.status,
        agentComputerId: agents.computerId,
      })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .then(([row]) => row);
  }

  /**
   * The Client restarted, so the accepted Turn's report owner is a connection that no longer exists.
   * Only the same Computer's current connection may take it over, and only for the exact accepted,
   * unreported Turn at the current placement generation. The reconcile then uses the frozen dispatch
   * snapshot, because the Client's unresolved Turn is fenced to it.
   */
  async #takeOverTurn(
    frame: SessionRecoverRequest,
    context: RuntimeBusinessContext,
  ): Promise<{ runtime?: EffectiveRuntimeSnapshot } | "missing" | undefined> {
    if (!frame.deliveryId || !frame.turnId) return undefined;
    const [owned] = await this.#options.database
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
    if (!owned) return "missing";
    const frozen = DirectImMessageDeliveryRequestSchema.safeParse(owned.payload);
    return frozen.success ? { runtime: frozen.data.runtime } : {};
  }

  /** The reconcile result arrives on the same connection; never wait for it inside this frame. */
  #scheduleReconcile(context: RuntimeBusinessContext, request: SessionReconcileRequest): void {
    const reconcile = this.#options
      .requestReconcile(context.computerId, context.instanceId, request)
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

  /** Waits for scheduled reconciles; used by tests and orderly shutdown. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }
}

interface RecoveryScope {
  sessionKind: "channel" | "thread" | "internal";
  endedAt: Date | null;
  creatorSessionId: string | null;
  placementComputerId: string;
  placementGeneration: number;
  computerKind: string;
  installationId: string;
  agentId: string;
  agentStatus: string;
  agentComputerId: string | null;
}

/** Why the Session cannot be recovered on this connection, or undefined when it can. */
function scopeRefusal(
  row: RecoveryScope | undefined,
  frame: SessionRecoverRequest,
  context: RuntimeBusinessContext,
): string | undefined {
  if (!row) return "session_not_found";
  if (row.endedAt) return "session_ended";
  if (row.agentId !== frame.agentId || row.agentComputerId !== context.computerId) return "agent_mismatch";
  if (row.agentStatus !== "active") return "agent_not_active";
  if (row.computerKind !== "local") return "cloud_unsupported";
  if (row.placementComputerId !== context.computerId || row.placementGeneration !== frame.placementGeneration) {
    return "placement_stale";
  }
  // An internal Session needs its creator, and only an IM Turn names a delivery.
  if (row.sessionKind === "internal" && (!row.creatorSessionId || frame.deliveryId)) return "session_kind_mismatch";
  return undefined;
}

function rejected(reason: string): RecoverDecision {
  return { status: "rejected", reason };
}
