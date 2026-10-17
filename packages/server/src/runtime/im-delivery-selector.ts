import { sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import { DISPATCH_CLAIM_PREFIX } from "./im-delivery-claim.js";
import { isCloudReadinessRetry } from "./im-delivery-ready-wakeup.js";
import {
  activeDeliveryContext,
  type DeliveryCandidate,
  type DeliveryContext,
  type DeliveryCursor,
  DeliveryCustodySnapshot,
  deliveryCandidatePage,
  loadDeliveryContexts,
  lockDeliveryCandidate,
  readCloudPendingHead,
  readDeliveryCustody,
} from "./im-delivery-work-query.js";

function readyCandidate(row: DeliveryCandidate, context: DeliveryContext) {
  return (
    context.computerKind === "cloud" &&
    row.state === "pending" &&
    row.dispatchRequestId === null &&
    (row.lastErrorCode === null || isCloudReadinessRetry(row.lastErrorCode))
  );
}

export function eligibleDeliveryCandidate(
  row: DeliveryCandidate,
  context: DeliveryContext | undefined,
  custody: DeliveryCustodySnapshot,
  targeted = false,
): context is DeliveryContext & { computerId: string; computerKind: "local" | "cloud"; generation: number } {
  if (
    !activeDeliveryContext(context) ||
    !context.computerId ||
    !context.computerKind ||
    context.generation === undefined
  )
    return false;
  if (targeted && !readyCandidate(row, context)) return false;
  if (row.state === "accepted") return row.reportedAt === null;
  if (context.agentStatus !== "active") return false;
  const dueInput =
    (row.state === "pending" &&
      row.reason === null &&
      (row.ingressLive || (context.computerKind === "cloud" && row.dispatchRequestId !== null))) ||
    (row.state === "expired" && row.dispatchRequestId !== null);
  if (!dueInput) return false;
  const other = custody.other({
    deliveryId: row.id,
    sessionId: row.sessionId,
    agentId: context.agentId,
    computerKind: context.computerKind,
  });
  const steer =
    context.computerKind === "local" &&
    row.state === "pending" &&
    row.dispatchRequestId === null &&
    row.steerTargetDeliveryId === null &&
    custody.acceptedInSession(row.sessionId, row.id);
  return !other || !!steer;
}

export function needsCloudOrder(row: DeliveryCandidate, context: DeliveryContext) {
  return (
    context.computerKind === "cloud" &&
    row.state === "pending" &&
    row.dispatchRequestId === null &&
    !row.lastErrorCode?.startsWith(DISPATCH_CLAIM_PREFIX)
  );
}

/** One bounded scan owns its cursor; occupancy is fresh each scan, metadata is only a hint. */
export class ImDeliverySelector {
  readonly #cache = new Map<string, { context: DeliveryContext; expires: number }>();
  #cursor: DeliveryCursor | undefined;
  #dueBefore: Date | undefined;

  constructor(readonly database: DatabaseClient) {}

  invalidate(sessionId?: string) {
    if (sessionId) this.#cache.delete(sessionId);
    else this.#cache.clear();
  }

  async #contexts(ids: string[], now: Date) {
    const result = new Map<string, DeliveryContext>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      const cached = this.#cache.get(id);
      if (cached && cached.expires > now.getTime()) result.set(id, cached.context);
      else {
        this.#cache.delete(id);
        missing.push(id);
      }
    }
    for (const [id, context] of await loadDeliveryContexts(this.database, missing)) {
      result.set(id, context);
      if (this.#cache.size >= 2048) {
        const oldest = this.#cache.keys().next().value;
        if (oldest !== undefined) this.#cache.delete(oldest);
      }
      this.#cache.set(id, { context, expires: now.getTime() + 5_000 });
    }
    return result;
  }

  async #ordered(row: DeliveryCandidate, context: DeliveryContext, heads: Map<string, string | undefined>) {
    if (!needsCloudOrder(row, context)) return true;
    if (!heads.has(row.sessionId)) heads.set(row.sessionId, await readCloudPendingHead(this.database, row.sessionId));
    return heads.get(row.sessionId) === row.id;
  }

  async *#pageCandidates(
    rows: DeliveryCandidate[],
    now: Date,
    custody: DeliveryCustodySnapshot,
    heads: Map<string, string | undefined>,
    sessionId?: string,
  ) {
    const contexts = await this.#contexts(
      rows.map((row) => row.sessionId),
      now,
    );
    for (const row of rows) {
      if (!sessionId) this.#cursor = { time: row.cursorTime, id: row.id };
      const context = contexts.get(row.sessionId);
      if (!eligibleDeliveryCandidate(row, context, custody, !!sessionId)) continue;
      if (await this.#ordered(row, context, heads)) yield { row, context };
    }
  }

  async *candidates(now: Date, sessionId?: string) {
    const rows = await readDeliveryCustody(this.database);
    const contexts = await this.#contexts(
      rows.map((row) => row.sessionId),
      now,
    );
    const custody = new DeliveryCustodySnapshot(rows, contexts);
    const cloudHeads = new Map<string, string | undefined>();
    let cursor = sessionId ? undefined : this.#cursor;
    let dueBefore = sessionId ? now : (this.#dueBefore ?? now);
    let wrapped = false;
    if (!sessionId) this.#dueBefore = dueBefore;
    for (let page = 0; page < 8; page++) {
      const candidates = await deliveryCandidatePage(this.database, dueBefore, cursor, sessionId);
      yield* this.#pageCandidates(candidates, now, custody, cloudHeads, sessionId);
      const last = candidates.at(-1);
      if (last) cursor = { time: last.cursorTime, id: last.id };
      if (candidates.length === 128) continue;
      if (!sessionId) {
        this.#cursor = undefined;
        this.#dueBefore = undefined;
      }
      if (!cursor || wrapped || sessionId) return;
      // A newly due input behind the cursor must not require an extra timer tick after a sweep.
      cursor = undefined;
      dueBefore = now;
      this.#dueBefore = now;
      wrapped = true;
    }
  }
}

/** Fresh authority after the Agent fence; cached context is only the expected lock identity. */
export async function lockEligibleDelivery(
  database: DatabaseTransaction,
  deliveryId: string,
  expectedAgentId: string,
  now: Date,
  sessionId?: string,
) {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`im-agent-custody:${expectedAgentId}`}, 0))`,
  );
  const delivery = await lockDeliveryCandidate(database, deliveryId, now);
  if (!delivery || (sessionId && delivery.sessionId !== sessionId)) return undefined;
  const rows = await readDeliveryCustody(database);
  const contexts = await loadDeliveryContexts(database, [delivery.sessionId, ...rows.map((row) => row.sessionId)]);
  const context = contexts.get(delivery.sessionId);
  const custody = new DeliveryCustodySnapshot(rows, contexts);
  if (!eligibleDeliveryCandidate(delivery, context, custody, !!sessionId) || context.agentId !== expectedAgentId)
    return undefined;
  if (needsCloudOrder(delivery, context) && (await readCloudPendingHead(database, delivery.sessionId)) !== delivery.id)
    return undefined;
  return { row: { ...delivery, ...context }, custody };
}
