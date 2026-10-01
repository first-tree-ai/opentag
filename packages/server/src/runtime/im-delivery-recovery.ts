import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../db/client.js";
import { agents, computers, imBindings, imMessageDeliveries, imMessages, sessions } from "../db/schema/index.js";
import { type SessionService, SessionServiceError } from "../services/sessions/session-service.js";

export const STEER_TARGET_ENDED_ERROR_CODE = "IM_DELIVERY_STEER_TARGET_ENDED";
export const STEER_TARGET_UNPLACEABLE_ERROR_CODE = "IM_DELIVERY_STEER_TARGET_UNPLACEABLE";

const STEER_TARGET_UNPLACEABLE_REASON = "steer_target_ended_unplaceable";

type SessionEnsurer = Pick<SessionService, "ensureChatSessionInTransaction">;

type Candidate = {
  id: string;
  messageId: string;
  sourceSessionId: string;
};

type RecoveryRoute = { kind: "pending"; sessionId: string; placementGeneration: number } | { kind: "terminal" };

const REPLACEABLE_SESSION_ERRORS = new Set([
  "AGENT_COMPUTER_NOT_BOUND",
  "AGENT_NOT_ACTIVE",
  "IM_BINDING_NOT_ACTIVE",
  "SESSION_SCOPE_INVALID",
]);

/**
 * Return steered children to the normal queue in message order.
 *
 * Recovery uses the same active-Session and placement code as normal IM ingress. A child left on
 * an ended target Session is not claimable because the worker deliberately filters ended Sessions.
 * The state predicate makes this operation idempotent when terminal reporting and the janitor race.
 */
export async function requeueSteeredDeliveries(
  transaction: DatabaseTransaction,
  targetDeliveryId: string,
  now: Date,
  sessionService: SessionEnsurer,
): Promise<string[]> {
  const candidates = await readSteeredCandidates(transaction, targetDeliveryId);
  if (candidates.length === 0) return [];
  const routes = await resolveRecoveryRoutes(transaction, candidates, now, sessionService);
  const recoveredIds: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const recoveredId = await transitionSteeredDelivery(
      transaction,
      candidate,
      targetDeliveryId,
      routes.get(candidate.sourceSessionId),
      now,
      index,
      candidates.length,
    );
    if (recoveredId) recoveredIds.push(recoveredId);
  }
  return recoveredIds;
}

async function readSteeredCandidates(transaction: DatabaseTransaction, targetDeliveryId: string): Promise<Candidate[]> {
  return (await transaction
    .select({
      id: imMessageDeliveries.id,
      messageId: imMessageDeliveries.messageId,
      sourceSessionId: imMessageDeliveries.sessionId,
    })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .where(
      and(eq(imMessageDeliveries.state, "steered"), eq(imMessageDeliveries.steerTargetDeliveryId, targetDeliveryId)),
    )
    .orderBy(
      asc(imMessages.occurredAt),
      asc(imMessages.providerRevisionKey),
      asc(imMessages.id),
      asc(imMessageDeliveries.id),
    )
    .for("update", { of: imMessageDeliveries, skipLocked: true })) as Candidate[];
}

async function resolveRecoveryRoutes(
  transaction: DatabaseTransaction,
  candidates: Candidate[],
  now: Date,
  sessionService: SessionEnsurer,
): Promise<Map<string, RecoveryRoute>> {
  const routes = new Map<string, RecoveryRoute>();
  for (const candidate of candidates) {
    if (!routes.has(candidate.sourceSessionId)) {
      routes.set(
        candidate.sourceSessionId,
        await resolveRecoveryRoute(transaction, candidate.sourceSessionId, now, sessionService),
      );
    }
  }
  return routes;
}

async function transitionSteeredDelivery(
  transaction: DatabaseTransaction,
  candidate: Candidate,
  targetDeliveryId: string,
  route: RecoveryRoute | undefined,
  now: Date,
  sequence: number,
  total: number,
): Promise<string | undefined> {
  if (!route || route.kind === "terminal") {
    return terminalizeSteeredDelivery(transaction, candidate.id, targetDeliveryId, STEER_TARGET_UNPLACEABLE_REASON);
  }

  const [duplicate] = await transaction
    .select({ id: imMessageDeliveries.id })
    .from(imMessageDeliveries)
    .where(
      and(
        eq(imMessageDeliveries.messageId, candidate.messageId),
        eq(imMessageDeliveries.sessionId, route.sessionId),
        ne(imMessageDeliveries.id, candidate.id),
      ),
    )
    .limit(1)
    .for("update");
  if (duplicate) {
    return terminalizeSteeredDelivery(transaction, candidate.id, targetDeliveryId, "steer_target_ended_duplicate");
  }

  const [updated] = await transaction
    .update(imMessageDeliveries)
    .set({
      state: "pending",
      sessionId: route.sessionId,
      placementGeneration: route.placementGeneration,
      attemptCount: sql`${imMessageDeliveries.attemptCount} + 1`,
      dispatchRequestId: null,
      dispatchInputHash: null,
      dispatchPayload: null,
      inputHash: null,
      turnId: null,
      steerTargetDeliveryId: null,
      steeredAt: null,
      reportOwnerInstanceId: null,
      resultHash: null,
      turnReport: null,
      reportedAt: null,
      acceptedAt: null,
      nextAttemptAt: new Date(now.getTime() - (total - sequence - 1)),
      reason: null,
      lastErrorCode: STEER_TARGET_ENDED_ERROR_CODE,
    })
    .where(
      and(
        eq(imMessageDeliveries.id, candidate.id),
        eq(imMessageDeliveries.state, "steered"),
        eq(imMessageDeliveries.steerTargetDeliveryId, targetDeliveryId),
      ),
    )
    .returning({ id: imMessageDeliveries.id });
  return updated?.id;
}

async function terminalizeSteeredDelivery(
  transaction: DatabaseTransaction,
  deliveryId: string,
  targetDeliveryId: string,
  reason: string,
): Promise<string | undefined> {
  const [updated] = await transaction
    .update(imMessageDeliveries)
    .set({
      state: "terminal_rejected",
      attemptCount: sql`${imMessageDeliveries.attemptCount} + 1`,
      dispatchRequestId: null,
      dispatchInputHash: null,
      dispatchPayload: null,
      inputHash: null,
      turnId: null,
      steerTargetDeliveryId: null,
      steeredAt: null,
      reportOwnerInstanceId: null,
      resultHash: null,
      turnReport: null,
      reportedAt: null,
      acceptedAt: null,
      reason,
      lastErrorCode: STEER_TARGET_UNPLACEABLE_ERROR_CODE,
    })
    .where(
      and(
        eq(imMessageDeliveries.id, deliveryId),
        eq(imMessageDeliveries.state, "steered"),
        eq(imMessageDeliveries.steerTargetDeliveryId, targetDeliveryId),
      ),
    )
    .returning({ id: imMessageDeliveries.id });
  return updated?.id;
}

async function resolveRecoveryRoute(
  transaction: DatabaseTransaction,
  sourceSessionId: string,
  now: Date,
  sessionService: SessionEnsurer,
): Promise<RecoveryRoute> {
  const [source] = await transaction
    .select({
      session: sessions,
      binding: imBindings,
      agent: agents,
      computer: computers,
    })
    .from(sessions)
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .leftJoin(computers, eq(computers.id, agents.computerId))
    .where(eq(sessions.id, sourceSessionId))
    .limit(1)
    .for("update", { of: sessions });

  if (
    !source ||
    source.binding.status !== "active" ||
    source.agent.status !== "active" ||
    source.agent.computerId === null ||
    source.computer === null ||
    source.computer.id !== source.agent.computerId ||
    source.computer.ownerAccountId !== source.agent.createdByUserId ||
    (source.session.kind !== "channel" && source.session.kind !== "thread")
  ) {
    return { kind: "terminal" };
  }

  try {
    const ensured = await sessionService.ensureChatSessionInTransaction(transaction, {
      imBindingId: source.session.imBindingId,
      channelId: source.session.channelId,
      conversationKind: source.session.conversationKind,
      kind: source.session.kind,
      ...(source.session.kind === "thread" && source.session.threadKey ? { threadKey: source.session.threadKey } : {}),
      computerId: source.agent.computerId,
      now,
    });
    return {
      kind: "pending",
      sessionId: ensured.session.id,
      placementGeneration: ensured.placement.generation,
    };
  } catch (error) {
    if (error instanceof SessionServiceError && REPLACEABLE_SESSION_ERRORS.has(error.code)) {
      return { kind: "terminal" };
    }
    throw error;
  }
}
