import type {
  DirectImMessageDeliveryRequest,
  RuntimeImSteerRequest,
  SessionReconcileRequest,
  SessionReconcileResult,
  TurnReportRequest,
  TurnReportResult,
} from "@opentag/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import {
  agents,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
  workspaceComputers,
} from "../db/schema/index.js";
import type { RuntimeBusinessContext } from "./runtime-session.js";

export interface AcceptedDeliveryRecord {
  agentId: string;
  workspaceComputerId: string;
  deliveryId: string;
  inputHash: string;
  instanceId: string;
  placementGeneration: number;
  sessionId: string;
  turnId: string;
}

export interface RecordedTurnRecord {
  workspaceComputerId: string;
  instanceId: string;
  report: TurnReportRequest;
  resultHash: string;
}

export type DeliveryCustodyStatus = "accepted" | "already_accepted" | "conflict" | "stale_generation";
export type DeliveryDispatchStatus = "dispatched" | "already_dispatched" | "conflict" | "stale_generation";
export type SteerCustodyStatus = "steered" | "already_steered" | "conflict" | "stale_generation";
export type SteerReleaseStatus = "released" | "already_released" | "conflict";

export interface DeliveryDispatchContext {
  workspaceComputerId: string;
  instanceId: string;
}

export interface RuntimeCustodyStore {
  beginDeliveryDispatch(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    context: DeliveryDispatchContext,
  ): Promise<DeliveryDispatchStatus>;
  acceptDelivery(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    turnId: string,
    context: RuntimeBusinessContext,
  ): Promise<DeliveryCustodyStatus>;
  beginSteerDispatch(
    request: RuntimeImSteerRequest,
    inputHash: string,
    context: DeliveryDispatchContext,
  ): Promise<DeliveryDispatchStatus>;
  recordSteered(
    request: RuntimeImSteerRequest,
    inputHash: string,
    semanticHash: string,
    context: RuntimeBusinessContext,
  ): Promise<SteerCustodyStatus>;
  recordAbsorbed(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    semanticHash: string,
    rootDeliveryId: string,
    turnId: string,
    context: RuntimeBusinessContext,
  ): Promise<SteerCustodyStatus>;
  releaseSteerDispatch(
    request: RuntimeImSteerRequest,
    inputHash: string,
    disposition: "retry" | "deferred",
  ): Promise<SteerReleaseStatus>;
  claimRetainedReports(
    request: SessionReconcileRequest,
    claims: NonNullable<SessionReconcileResult["retainedReports"]>,
    context: RuntimeBusinessContext,
  ): Promise<void>;
  getDelivery(deliveryId: string): Promise<AcceptedDeliveryRecord | undefined>;
  getDeliveryByTurn(turnId: string): Promise<AcceptedDeliveryRecord | undefined>;
  getTurn(turnId: string): Promise<RecordedTurnRecord | undefined>;
  recordTurn(
    report: TurnReportRequest,
    context: RuntimeBusinessContext,
  ): Promise<TurnReportResult["status"] | undefined>;
}

interface DeliveryScope {
  delivery: typeof imMessageDeliveries.$inferSelect;
  message: typeof imMessages.$inferSelect;
  placement: typeof sessionPlacements.$inferSelect;
  session: typeof sessions.$inferSelect;
  workspaceComputer: typeof workspaceComputers.$inferSelect;
  agentId: string;
}

export class PostgresRuntimeCustodyStore implements RuntimeCustodyStore {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async beginDeliveryDispatch(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    context: DeliveryDispatchContext,
  ): Promise<DeliveryDispatchStatus> {
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#deliveryScope(transaction, request.deliveryId);
      if (!scope || !deliveryRequestMatches(scope, request)) return "conflict";
      if (!placementMatches(scope, context.workspaceComputerId, request.placementGeneration)) return "stale_generation";
      if (scope.delivery.state !== "pending") return "conflict";
      if (scope.delivery.dispatchRequestId !== null) {
        return scope.delivery.dispatchRequestId === request.requestId && scope.delivery.dispatchInputHash === inputHash
          ? "already_dispatched"
          : "conflict";
      }
      const [dispatched] = await transaction
        .update(imMessageDeliveries)
        .set({
          dispatchRequestId: request.requestId,
          dispatchInputHash: inputHash,
          dispatchPayload: request,
          steerTargetDeliveryId: null,
        })
        .where(
          and(
            eq(imMessageDeliveries.id, request.deliveryId),
            eq(imMessageDeliveries.state, "pending"),
            isNull(imMessageDeliveries.dispatchRequestId),
          ),
        )
        .returning({ id: imMessageDeliveries.id });
      return dispatched ? "dispatched" : "conflict";
    });
  }

  async beginSteerDispatch(
    request: RuntimeImSteerRequest,
    inputHash: string,
    context: DeliveryDispatchContext,
  ): Promise<DeliveryDispatchStatus> {
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#deliveryScope(transaction, request.deliveryId);
      if (!scope || !steerRequestMatches(scope, request)) return "conflict";
      if (!placementMatches(scope, context.workspaceComputerId, request.placementGeneration)) return "stale_generation";
      if (scope.delivery.state !== "pending") return "conflict";
      if (scope.delivery.dispatchRequestId !== null) {
        return scope.delivery.dispatchRequestId === request.requestId && scope.delivery.dispatchInputHash === inputHash
          ? "already_dispatched"
          : "conflict";
      }
      if (scope.delivery.steerTargetDeliveryId !== null) return "conflict";
      const target = await this.#deliveryScope(transaction, request.rootDeliveryId);
      if (!target || !steerTargetMatches(scope, target, request, context)) return "conflict";
      const [dispatched] = await transaction
        .update(imMessageDeliveries)
        .set({
          dispatchRequestId: request.requestId,
          dispatchInputHash: inputHash,
          dispatchPayload: request,
          steerTargetDeliveryId: request.rootDeliveryId,
        })
        .where(
          and(
            eq(imMessageDeliveries.id, request.deliveryId),
            eq(imMessageDeliveries.state, "pending"),
            isNull(imMessageDeliveries.dispatchRequestId),
            isNull(imMessageDeliveries.steerTargetDeliveryId),
          ),
        )
        .returning({ id: imMessageDeliveries.id });
      return dispatched ? "dispatched" : "conflict";
    });
  }

  async recordSteered(
    request: RuntimeImSteerRequest,
    inputHash: string,
    semanticHash: string,
    context: RuntimeBusinessContext,
  ): Promise<SteerCustodyStatus> {
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#deliveryScope(transaction, request.deliveryId);
      if (!scope || !steerRequestMatches(scope, request)) return "conflict";
      if (!placementMatches(scope, context.workspaceComputerId, request.placementGeneration)) return "stale_generation";
      if (scope.delivery.state === "steered") {
        return scope.delivery.inputHash === semanticHash &&
          scope.delivery.steerTargetDeliveryId === request.rootDeliveryId
          ? "already_steered"
          : "conflict";
      }
      if (
        !["pending", "expired"].includes(scope.delivery.state) ||
        scope.delivery.dispatchRequestId !== request.requestId ||
        scope.delivery.dispatchInputHash !== inputHash ||
        scope.delivery.steerTargetDeliveryId !== request.rootDeliveryId
      ) {
        return "conflict";
      }
      const target = await this.#deliveryScope(transaction, request.rootDeliveryId);
      if (!target || !steerTargetMatches(scope, target, request, context, true)) return "conflict";
      return (await this.#writeSteered(transaction, request.deliveryId, semanticHash, request.rootDeliveryId))
        ? "steered"
        : "conflict";
    });
  }

  async recordAbsorbed(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    semanticHash: string,
    rootDeliveryId: string,
    turnId: string,
    context: RuntimeBusinessContext,
  ): Promise<SteerCustodyStatus> {
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#deliveryScope(transaction, request.deliveryId);
      if (!scope || !deliveryRequestMatches(scope, request)) return "conflict";
      if (!placementMatches(scope, context.workspaceComputerId, request.placementGeneration)) return "stale_generation";
      if (scope.delivery.state === "steered") {
        return scope.delivery.inputHash === semanticHash && scope.delivery.steerTargetDeliveryId === rootDeliveryId
          ? "already_steered"
          : "conflict";
      }
      if (
        !["pending", "expired"].includes(scope.delivery.state) ||
        scope.delivery.dispatchRequestId !== request.requestId ||
        scope.delivery.dispatchInputHash !== inputHash
      ) {
        return "conflict";
      }
      const target = await this.#deliveryScope(transaction, rootDeliveryId);
      if (!target || !absorbedTargetMatches(scope, target, turnId, context)) return "conflict";
      return (await this.#writeSteered(transaction, request.deliveryId, semanticHash, rootDeliveryId))
        ? "steered"
        : "conflict";
    });
  }

  async releaseSteerDispatch(
    request: RuntimeImSteerRequest,
    inputHash: string,
    disposition: "retry" | "deferred",
  ): Promise<SteerReleaseStatus> {
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#deliveryScope(transaction, request.deliveryId);
      if (!scope || !steerRequestMatches(scope, request) || scope.delivery.state !== "pending") return "conflict";
      if (scope.delivery.dispatchRequestId === null) {
        const targetMatches =
          disposition === "retry"
            ? scope.delivery.steerTargetDeliveryId === null
            : scope.delivery.steerTargetDeliveryId === request.rootDeliveryId;
        return targetMatches ? "already_released" : "conflict";
      }
      if (
        scope.delivery.dispatchRequestId !== request.requestId ||
        scope.delivery.dispatchInputHash !== inputHash ||
        scope.delivery.steerTargetDeliveryId !== request.rootDeliveryId
      ) {
        return "conflict";
      }
      const [released] = await transaction
        .update(imMessageDeliveries)
        .set({
          dispatchRequestId: null,
          dispatchInputHash: null,
          dispatchPayload: null,
          ...(disposition === "retry" ? { steerTargetDeliveryId: null } : {}),
        })
        .where(
          and(
            eq(imMessageDeliveries.id, request.deliveryId),
            eq(imMessageDeliveries.state, "pending"),
            eq(imMessageDeliveries.dispatchRequestId, request.requestId),
            eq(imMessageDeliveries.dispatchInputHash, inputHash),
            eq(imMessageDeliveries.steerTargetDeliveryId, request.rootDeliveryId),
          ),
        )
        .returning({ id: imMessageDeliveries.id });
      return released ? "released" : "conflict";
    });
  }

  async acceptDelivery(
    request: DirectImMessageDeliveryRequest,
    inputHash: string,
    turnId: string,
    context: RuntimeBusinessContext,
  ): Promise<DeliveryCustodyStatus> {
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#deliveryScope(transaction, request.deliveryId);
      if (!scope || !deliveryRequestMatches(scope, request)) return "conflict";
      if (!placementMatches(scope, context.workspaceComputerId, request.placementGeneration)) return "stale_generation";
      if (scope.delivery.dispatchRequestId !== request.requestId || scope.delivery.dispatchInputHash !== inputHash) {
        return "conflict";
      }
      if (scope.delivery.state === "accepted") {
        return scope.delivery.inputHash === inputHash && scope.delivery.turnId === turnId
          ? "already_accepted"
          : "conflict";
      }
      if (scope.delivery.state !== "pending" && scope.delivery.state !== "expired") return "conflict";
      const [accepted] = await transaction
        .update(imMessageDeliveries)
        .set({
          state: "accepted",
          placementGeneration: request.placementGeneration,
          inputHash,
          turnId,
          reportOwnerInstanceId: context.instanceId,
          acceptedAt: this.#now(),
          steerTargetDeliveryId: null,
          reason: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(imMessageDeliveries.id, request.deliveryId),
            inArray(imMessageDeliveries.state, ["pending", "expired"]),
            eq(imMessageDeliveries.dispatchRequestId, request.requestId),
            eq(imMessageDeliveries.dispatchInputHash, inputHash),
          ),
        )
        .returning({ id: imMessageDeliveries.id });
      return accepted ? "accepted" : "conflict";
    });
  }

  async claimRetainedReports(
    request: SessionReconcileRequest,
    claims: NonNullable<SessionReconcileResult["retainedReports"]>,
    context: RuntimeBusinessContext,
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [placement] = await transaction
        .select()
        .from(sessionPlacements)
        .innerJoin(sessions, eq(sessions.id, sessionPlacements.sessionId))
        .where(
          and(
            eq(sessionPlacements.sessionId, request.sessionId),
            eq(sessionPlacements.workspaceComputerId, context.workspaceComputerId),
            eq(sessionPlacements.generation, request.placementGeneration),
            isNull(sessions.endedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!placement) return;
      for (const claim of claims) {
        const scope = await this.#deliveryScope(transaction, claim.deliveryId);
        if (
          !scope ||
          scope.delivery.sessionId !== request.sessionId ||
          scope.agentId !== request.agentId ||
          scope.delivery.placementGeneration !== claim.placementGeneration ||
          !placementMatches(scope, context.workspaceComputerId, request.placementGeneration) ||
          scope.delivery.dispatchRequestId !== claim.dispatchRequestId ||
          scope.delivery.dispatchInputHash !== claim.inputHash ||
          (scope.delivery.resultHash !== null && scope.delivery.resultHash !== claim.resultHash)
        ) {
          continue;
        }
        if (scope.delivery.state === "pending" || scope.delivery.state === "expired") {
          await transaction
            .update(imMessageDeliveries)
            .set({
              state: "accepted",
              inputHash: claim.inputHash,
              turnId: claim.turnId,
              reportOwnerInstanceId: context.instanceId,
              resultHash: claim.resultHash,
              acceptedAt: this.#now(),
              steerTargetDeliveryId: null,
              reason: null,
              lastErrorCode: null,
            })
            .where(
              and(
                eq(imMessageDeliveries.id, claim.deliveryId),
                inArray(imMessageDeliveries.state, ["pending", "expired"]),
                eq(imMessageDeliveries.dispatchRequestId, claim.dispatchRequestId),
                eq(imMessageDeliveries.dispatchInputHash, claim.inputHash),
              ),
            );
          continue;
        }
        if (scope.delivery.state !== "accepted" || scope.delivery.turnId !== claim.turnId) continue;
        await transaction
          .update(imMessageDeliveries)
          .set({ reportOwnerInstanceId: context.instanceId, resultHash: claim.resultHash })
          .where(eq(imMessageDeliveries.id, claim.deliveryId));
      }
    });
  }

  async getDelivery(deliveryId: string): Promise<AcceptedDeliveryRecord | undefined> {
    const [row] = await this.#database
      .select({
        delivery: imMessageDeliveries,
        placement: sessionPlacements,
        workspaceComputer: workspaceComputers,
        agentId: agents.id,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(
        workspaceComputers,
        and(
          eq(workspaceComputers.workspaceId, agents.workspaceId),
          eq(workspaceComputers.id, sessionPlacements.workspaceComputerId),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .where(eq(imMessageDeliveries.id, deliveryId))
      .limit(1);
    return row ? acceptedRecord(row.delivery, row.workspaceComputer.id, row.agentId) : undefined;
  }

  async getDeliveryByTurn(turnId: string): Promise<AcceptedDeliveryRecord | undefined> {
    const [row] = await this.#database
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.turnId, turnId))
      .limit(1);
    return row ? this.getDelivery(row.id) : undefined;
  }

  async getTurn(turnId: string): Promise<RecordedTurnRecord | undefined> {
    const [row] = await this.#database
      .select({
        report: imMessageDeliveries.turnReport,
        resultHash: imMessageDeliveries.resultHash,
        instanceId: imMessageDeliveries.reportOwnerInstanceId,
        workspaceComputerId: workspaceComputers.id,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, imMessageDeliveries.sessionId))
      .innerJoin(sessions, eq(sessions.id, sessionPlacements.sessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(
        workspaceComputers,
        and(
          eq(workspaceComputers.workspaceId, agents.workspaceId),
          eq(workspaceComputers.id, sessionPlacements.workspaceComputerId),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .where(eq(imMessageDeliveries.turnId, turnId))
      .limit(1);
    return row?.report && row.resultHash && row.instanceId
      ? {
          workspaceComputerId: row.workspaceComputerId,
          instanceId: row.instanceId,
          report: row.report,
          resultHash: row.resultHash,
        }
      : undefined;
  }

  async recordTurn(
    report: TurnReportRequest,
    context: RuntimeBusinessContext,
  ): Promise<TurnReportResult["status"] | undefined> {
    return this.#database.transaction(async (transaction) => {
      const scope = await this.#deliveryScope(transaction, report.deliveryId);
      if (!scope) return undefined;
      if (
        scope.delivery.turnId !== report.turnId ||
        scope.delivery.sessionId !== report.sessionId ||
        scope.agentId !== report.agentId
      ) {
        return "conflict";
      }
      if (!placementMatches(scope, context.workspaceComputerId, report.placementGeneration)) return "stale_generation";
      if (scope.delivery.turnReport) {
        return scope.delivery.resultHash === report.resultHash && sameReport(scope.delivery.turnReport, report)
          ? "already_recorded"
          : "conflict";
      }
      if (
        scope.delivery.state !== "accepted" ||
        scope.delivery.reportOwnerInstanceId !== context.instanceId ||
        (scope.delivery.resultHash !== null && scope.delivery.resultHash !== report.resultHash)
      ) {
        return undefined;
      }
      await transaction
        .update(imMessageDeliveries)
        .set({
          dispatchPayload: null,
          resultHash: report.resultHash,
          turnReport: report,
          reportedAt: this.#now(),
          lastErrorCode: null,
        })
        .where(eq(imMessageDeliveries.id, report.deliveryId));
      return "recorded";
    });
  }

  async #deliveryScope(transaction: DatabaseTransaction, deliveryId: string): Promise<DeliveryScope | undefined> {
    const [identity] = await transaction
      .select({ sessionId: imMessageDeliveries.sessionId })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId))
      .limit(1);
    if (!identity) return undefined;
    const [placement] = await transaction
      .select({ sessionId: sessionPlacements.sessionId })
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, identity.sessionId))
      .limit(1)
      .for("update");
    if (!placement) return undefined;
    const [scope] = await transaction
      .select({
        delivery: imMessageDeliveries,
        message: imMessages,
        placement: sessionPlacements,
        session: sessions,
        workspaceComputer: workspaceComputers,
        agentId: agents.id,
      })
      .from(imMessageDeliveries)
      .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(
        workspaceComputers,
        and(
          eq(workspaceComputers.workspaceId, agents.workspaceId),
          eq(workspaceComputers.id, sessionPlacements.workspaceComputerId),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .where(eq(imMessageDeliveries.id, deliveryId))
      .limit(1)
      .for("update", { of: imMessageDeliveries });
    return scope;
  }

  async #writeSteered(
    transaction: DatabaseTransaction,
    deliveryId: string,
    semanticHash: string,
    rootDeliveryId: string,
  ): Promise<boolean> {
    const [steered] = await transaction
      .update(imMessageDeliveries)
      .set({
        state: "steered",
        inputHash: semanticHash,
        steerTargetDeliveryId: rootDeliveryId,
        steeredAt: this.#now(),
        reason: null,
        lastErrorCode: null,
      })
      .where(and(eq(imMessageDeliveries.id, deliveryId), inArray(imMessageDeliveries.state, ["pending", "expired"])))
      .returning({ id: imMessageDeliveries.id });
    return steered !== undefined;
  }
}

function acceptedRecord(
  delivery: typeof imMessageDeliveries.$inferSelect,
  workspaceComputerId: string,
  agentId: string,
): AcceptedDeliveryRecord | undefined {
  return delivery.state === "accepted" && delivery.inputHash && delivery.turnId && delivery.reportOwnerInstanceId
    ? {
        agentId,
        workspaceComputerId,
        deliveryId: delivery.id,
        inputHash: delivery.inputHash,
        instanceId: delivery.reportOwnerInstanceId,
        placementGeneration: delivery.placementGeneration,
        sessionId: delivery.sessionId,
        turnId: delivery.turnId,
      }
    : undefined;
}

function deliveryRequestMatches(scope: DeliveryScope, request: DirectImMessageDeliveryRequest): boolean {
  return (
    scope.delivery.id === request.deliveryId &&
    scope.delivery.sessionId === request.sessionId &&
    scope.message.id === request.imMessageId &&
    scope.agentId === request.agentId
  );
}

function steerRequestMatches(scope: DeliveryScope, request: RuntimeImSteerRequest): boolean {
  return (
    scope.delivery.id === request.deliveryId &&
    scope.delivery.sessionId === request.sessionId &&
    scope.message.id === request.imMessageId &&
    scope.agentId === request.agentId
  );
}

function steerTargetMatches(
  delivery: DeliveryScope,
  target: DeliveryScope,
  request: RuntimeImSteerRequest,
  context: DeliveryDispatchContext,
  allowReported = false,
): boolean {
  return (
    target.delivery.id === request.rootDeliveryId &&
    target.delivery.state === "accepted" &&
    (allowReported || target.delivery.reportedAt === null) &&
    target.delivery.turnId === request.expectedTurnId &&
    target.delivery.sessionId === delivery.delivery.sessionId &&
    target.agentId === delivery.agentId &&
    target.delivery.placementGeneration === request.placementGeneration &&
    target.workspaceComputer.id === context.workspaceComputerId &&
    target.delivery.reportOwnerInstanceId === context.instanceId
  );
}

function absorbedTargetMatches(
  delivery: DeliveryScope,
  target: DeliveryScope,
  turnId: string,
  context: RuntimeBusinessContext,
): boolean {
  return (
    target.delivery.state === "accepted" &&
    target.delivery.turnId === turnId &&
    target.delivery.sessionId === delivery.delivery.sessionId &&
    target.agentId === delivery.agentId &&
    target.delivery.placementGeneration === delivery.delivery.placementGeneration &&
    target.workspaceComputer.id === context.workspaceComputerId &&
    target.delivery.reportOwnerInstanceId === context.instanceId
  );
}

function placementMatches(scope: DeliveryScope, workspaceComputerId: string, placementGeneration: number): boolean {
  return (
    scope.delivery.placementGeneration === placementGeneration &&
    scope.workspaceComputer.id === workspaceComputerId &&
    scope.placement.generation === placementGeneration
  );
}

function sameReport(left: TurnReportRequest, right: TurnReportRequest): boolean {
  return (
    left.turnId === right.turnId &&
    left.deliveryId === right.deliveryId &&
    left.sessionId === right.sessionId &&
    left.agentId === right.agentId &&
    left.placementGeneration === right.placementGeneration &&
    left.resultHash === right.resultHash
  );
}
