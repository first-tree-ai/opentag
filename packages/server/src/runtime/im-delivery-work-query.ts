import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { deliveryCandidatePredicate, deliveryWorkPredicate } from "../db/im-delivery-work.js";
import { agents, computers, imBindings, imMessageDeliveries, sessionPlacements, sessions } from "../db/schema/index.js";

export type DeliveryWorkQuery = Pick<DatabaseClient | DatabaseTransaction, "select" | "execute">;
export interface DeliveryCursor {
  time: string;
  id: string;
}

const candidateColumns = {
  id: imMessageDeliveries.id,
  messageId: imMessageDeliveries.messageId,
  sessionId: imMessageDeliveries.sessionId,
  state: imMessageDeliveries.state,
  reason: imMessageDeliveries.reason,
  dispatchRequestId: imMessageDeliveries.dispatchRequestId,
  steerTargetDeliveryId: imMessageDeliveries.steerTargetDeliveryId,
  lastErrorCode: imMessageDeliveries.lastErrorCode,
  reportedAt: imMessageDeliveries.reportedAt,
  nextAttemptAt: imMessageDeliveries.nextAttemptAt,
  // Preserve PostgreSQL microseconds in the keyset; JS Date only preserves milliseconds.
  cursorTime: sql<string>`${imMessageDeliveries.nextAttemptAt}::text`,
  ingressLive: sql<boolean>`${imMessageDeliveries.expiresAt} > now()`,
};

export function deliveryCandidatePage(
  database: DeliveryWorkQuery,
  now: Date,
  cursor?: DeliveryCursor,
  sessionId?: string,
  limit = 128,
) {
  return database
    .select(candidateColumns)
    .from(imMessageDeliveries)
    .where(
      and(
        deliveryWorkPredicate(imMessageDeliveries),
        deliveryCandidatePredicate(imMessageDeliveries),
        lte(imMessageDeliveries.nextAttemptAt, now),
        cursor
          ? sql`(${imMessageDeliveries.nextAttemptAt}, ${imMessageDeliveries.id}) > (${cursor.time}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
        sessionId ? eq(imMessageDeliveries.sessionId, sessionId) : undefined,
      ),
    )
    .orderBy(asc(imMessageDeliveries.nextAttemptAt), asc(imMessageDeliveries.id))
    .limit(limit);
}
export type DeliveryCandidate = Awaited<ReturnType<typeof deliveryCandidatePage>>[number];

export async function lockDeliveryCandidate(database: DatabaseTransaction, id: string, now: Date) {
  const [row] = await database
    .select({
      ...candidateColumns,
      deliveryGeneration: imMessageDeliveries.placementGeneration,
      dispatchInputHash: imMessageDeliveries.dispatchInputHash,
      dispatchPayload: imMessageDeliveries.dispatchPayload,
    })
    .from(imMessageDeliveries)
    .where(and(eq(imMessageDeliveries.id, id), lte(imMessageDeliveries.nextAttemptAt, now)))
    .for("update", { of: imMessageDeliveries, skipLocked: true });
  return row;
}

export interface DeliveryContext {
  sessionId: string;
  agentId: string;
  agentStatus: typeof agents.$inferSelect.status;
  bindingStatus: typeof imBindings.$inferSelect.status;
  endedAt: Date | null;
  computerId: string | undefined;
  computerKind: "local" | "cloud" | undefined;
  generation: number | undefined;
}

export async function loadDeliveryContexts(database: DeliveryWorkQuery, sessionIds: string[]) {
  const result = new Map<string, DeliveryContext>();
  const unique = [...new Set(sessionIds)];
  for (let offset = 0; offset < unique.length; offset += 512) {
    const ids = unique.slice(offset, offset + 512);
    const [sessionRows, placements] = await Promise.all([
      database
        .select({ id: sessions.id, bindingId: sessions.imBindingId, endedAt: sessions.endedAt })
        .from(sessions)
        .where(inArray(sessions.id, ids)),
      database
        .select({
          sessionId: sessionPlacements.sessionId,
          computerId: sessionPlacements.computerId,
          generation: sessionPlacements.generation,
        })
        .from(sessionPlacements)
        .where(inArray(sessionPlacements.sessionId, ids)),
    ]);
    const [bindings, computerRows] = await Promise.all([
      database
        .select({ id: imBindings.id, agentId: imBindings.agentId, status: imBindings.status })
        .from(imBindings)
        .where(inArray(imBindings.id, [...new Set(sessionRows.map((row) => row.bindingId))])),
      database
        .select({ id: computers.id, kind: computers.kind })
        .from(computers)
        .where(inArray(computers.id, [...new Set(placements.map((row) => row.computerId))])),
    ]);
    const agentRows = await database
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(inArray(agents.id, [...new Set(bindings.map((row) => row.agentId))]));
    const bindingMap = new Map(bindings.map((row) => [row.id, row]));
    const agentMap = new Map(agentRows.map((row) => [row.id, row]));
    const placementMap = new Map(placements.map((row) => [row.sessionId, row]));
    const computerMap = new Map(computerRows.map((row) => [row.id, row]));
    for (const session of sessionRows) {
      const binding = bindingMap.get(session.bindingId);
      const agent = binding && agentMap.get(binding.agentId);
      if (!binding || !agent) continue;
      const placement = placementMap.get(session.id);
      result.set(session.id, {
        sessionId: session.id,
        agentId: agent.id,
        agentStatus: agent.status,
        bindingStatus: binding.status,
        endedAt: session.endedAt,
        computerId: placement?.computerId,
        generation: placement?.generation,
        computerKind: placement ? computerMap.get(placement.computerId)?.kind : undefined,
      });
    }
  }
  return result;
}

export function activeDeliveryContext(context: DeliveryContext | undefined): context is DeliveryContext {
  return (
    !!context && context.endedAt === null && context.bindingStatus === "active" && context.agentStatus !== "deleted"
  );
}

export interface DeliveryCustodyRow {
  id: string;
  sessionId: string;
  state: typeof imMessageDeliveries.$inferSelect.state;
  reportedAt: string | null;
  turnId: string | null;
  reportOwnerInstanceId: string | null;
}

export function deliveryCustodyQuery() {
  // Materialize only the indexed active set. No payloads, messages, or reported history are read.
  return sql`
    with active_work as materialized (
      select id, session_id, state, reported_at, turn_id, report_owner_instance_id,
        dispatch_request_id, last_error_code
      from ${imMessageDeliveries} where ${deliveryWorkPredicate(imMessageDeliveries)}
    )
    select id, session_id as "sessionId", state, reported_at::text as "reportedAt",
      turn_id as "turnId", report_owner_instance_id as "reportOwnerInstanceId"
    from active_work
    where (state = 'accepted' and reported_at is null)
      or (state in ('pending', 'expired') and dispatch_request_id is not null)
      or (state = 'pending' and last_error_code like 'IM_DELIVERY_CLAIM_%')
  `;
}

export async function readDeliveryCustody(database: DeliveryWorkQuery) {
  return database.execute<DeliveryCustodyRow & Record<string, unknown>>(deliveryCustodyQuery());
}

type CustodyGroups = Map<string, Map<string, DeliveryCustodyRow>>;
export class DeliveryCustodySnapshot {
  readonly #agents: CustodyGroups = new Map();
  readonly #localAgents: CustodyGroups = new Map();
  readonly #sessions: CustodyGroups = new Map();
  readonly #accepted: CustodyGroups = new Map();

  constructor(rows: DeliveryCustodyRow[], contexts: Map<string, DeliveryContext>) {
    for (const row of rows) {
      const context = contexts.get(row.sessionId);
      if (!activeDeliveryContext(context)) continue;
      this.#put(this.#agents, context.agentId, row);
      this.#put(this.#sessions, row.sessionId, row);
      if (context.computerKind === "local") this.#put(this.#localAgents, context.agentId, row);
      if (row.state === "accepted" && row.reportedAt === null) this.#put(this.#accepted, row.sessionId, row);
    }
  }
  #put(groups: CustodyGroups, key: string, row: DeliveryCustodyRow) {
    let group = groups.get(key);
    if (!group) {
      group = new Map();
      groups.set(key, group);
    }
    group.set(row.id, row);
  }
  #other(group: Map<string, DeliveryCustodyRow> | undefined, id: string) {
    if (!group) return undefined;
    for (const row of group.values()) if (row.id !== id) return row;
    return undefined;
  }
  other(subject: { deliveryId: string; sessionId: string; agentId: string; computerKind: "local" | "cloud" }) {
    return (
      this.#other(this.#sessions.get(subject.sessionId), subject.deliveryId) ??
      this.#other(
        (subject.computerKind === "local" ? this.#agents : this.#localAgents).get(subject.agentId),
        subject.deliveryId,
      )
    );
  }
  acceptedInSession(sessionId: string, id: string) {
    return this.#other(this.#accepted.get(sessionId), id);
  }
}

export function cloudPendingHeadQuery(sessionId: string) {
  return sql`
    select d.id from im_message_deliveries d
    join lateral (select id, occurred_at, provider_revision_key from im_messages
      where id = d.message_id limit 1) m on true
    where d.session_id = ${sessionId}::uuid and d.state = 'pending' and d.reason is null
    order by m.occurred_at, m.provider_revision_key, m.id limit 1
  `;
}

export async function readCloudPendingHead(database: DeliveryWorkQuery, sessionId: string) {
  const [row] = await database.execute<{ id: string }>(cloudPendingHeadQuery(sessionId));
  return row?.id;
}
