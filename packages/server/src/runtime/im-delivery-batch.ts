import {
  computeRuntimeImMessageSemanticHash,
  type DirectImMessageDeliveryRequest,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  RUNTIME_IM_BATCH_MAX_COUNT,
  RUNTIME_IM_RESOURCE_MAX_COUNT,
  RUNTIME_MAX_FRAME_BYTES,
  type RuntimeImDeliveryContent,
  type RuntimeImSteerRequest,
} from "@opentag/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../db/client.js";
import {
  type imBindings,
  imMessageDeliveries,
  imMessages,
  type sessions,
  sessions as sessionsTable,
} from "../db/schema/index.js";
import { deliveryMessageContent } from "./im-delivery-content.js";

export const IM_BATCH_PENDING_REASON = "batch_pending";
export const IM_BATCH_INITIAL_REASON = "batch_initial";
type ImRequest = DirectImMessageDeliveryRequest | RuntimeImSteerRequest;

export async function appendPendingImBatch(
  database: DatabaseClient,
  request: ImRequest,
  binding: typeof imBindings.$inferSelect,
  session: typeof sessions.$inferSelect,
  now: Date,
): Promise<void> {
  const rows = await database
    .select({ delivery: imMessageDeliveries, message: imMessages })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .where(
      and(
        eq(imMessageDeliveries.sessionId, request.sessionId),
        eq(imMessageDeliveries.state, "pending"),
        isNull(imMessageDeliveries.reason),
      ),
    )
    .orderBy(asc(imMessages.occurredAt), asc(imMessages.providerRevisionKey), asc(imMessages.id))
    .limit(RUNTIME_IM_BATCH_MAX_COUNT);
  if (rows[0]?.delivery.id !== request.deliveryId) return;
  const threadOwners =
    session.kind === "channel"
      ? await database
          .select({ messageId: imMessageDeliveries.messageId })
          .from(imMessageDeliveries)
          .innerJoin(sessionsTable, eq(sessionsTable.id, imMessageDeliveries.sessionId))
          .where(
            and(
              inArray(
                imMessageDeliveries.messageId,
                rows.map((row) => row.message.id),
              ),
              eq(sessionsTable.kind, "thread"),
            ),
          )
      : [];
  const observers = new Set(threadOwners.map((row) => row.messageId));
  for (const { delivery, message } of rows.slice(1)) {
    if (!compatibleBatchMember(delivery, message, request, rows[0]?.message.threadKey, observers, now)) break;
    if (!appendBatchMember(request, rows[0].message, delivery, message, binding)) break;
  }
}

export async function reserveImBatch(
  transaction: DatabaseTransaction,
  request: ImRequest,
  now: Date,
): Promise<boolean> {
  if (!request.batch) return true;
  const ids = request.batch.map((member) => member.deliveryId);
  const rows = await transaction
    .select()
    .from(imMessageDeliveries)
    .where(inArray(imMessageDeliveries.id, ids))
    .orderBy(asc(imMessageDeliveries.id))
    .for("update");
  if (
    rows.length !== ids.length ||
    request.batch.some(
      (member) =>
        !rows.some(
          (row) =>
            row.id === member.deliveryId &&
            row.messageId === member.imMessageId &&
            row.sessionId === request.sessionId &&
            row.placementGeneration === request.placementGeneration &&
            row.attention === request.attention &&
            row.state === "pending" &&
            row.reason === null &&
            row.dispatchRequestId === null &&
            row.steerTargetDeliveryId === null &&
            !row.lastErrorCode?.startsWith("IM_DELIVERY_CLAIM_") &&
            row.expiresAt > now &&
            row.nextAttemptAt <= now,
        ),
    )
  )
    return false;
  await transaction
    .update(imMessageDeliveries)
    .set({ reason: IM_BATCH_PENDING_REASON, steerTargetDeliveryId: request.deliveryId })
    .where(inArray(imMessageDeliveries.id, ids));
  return true;
}

export async function settleImBatch(
  transaction: DatabaseTransaction,
  request: ImRequest,
  targetId: string,
  now: Date,
  initial = false,
): Promise<void> {
  if (!request.batch) return;
  const members = sql.join(
    request.batch.map(
      (member) => sql`(${member.deliveryId}::uuid, ${member.imMessageId}::uuid, ${member.inputHash}::text)`,
    ),
    sql`, `,
  );
  const rows = (await transaction.execute(sql`
    update im_message_deliveries as d set state = 'steered', input_hash = member.input_hash,
      steer_target_delivery_id = ${targetId}::uuid, steered_at = ${now.toISOString()}::timestamptz,
      reason = ${initial ? IM_BATCH_INITIAL_REASON : null}, last_error_code = null
    from (values ${members}) as member(id, message_id, input_hash)
    where d.id = member.id and d.message_id = member.message_id and d.session_id = ${request.sessionId}::uuid
      and (d.state in ('pending', 'expired') or (d.state = 'terminal_rejected' and d.reason = 'steer_state_unknown')) and d.steer_target_delivery_id = ${request.deliveryId}::uuid
    returning d.id
  `)) as Array<{ id: string }>;
  if (rows.length !== request.batch.length) throw new Error("IM_BATCH_MEMBER_CONFLICT");
}

export async function releaseImBatch(transaction: DatabaseTransaction, rootId: string): Promise<void> {
  await transaction
    .update(imMessageDeliveries)
    .set({
      steerTargetDeliveryId: null,
      reason: sql`case when ${imMessageDeliveries.reason} = ${IM_BATCH_PENDING_REASON} then null else ${imMessageDeliveries.reason} end`,
    })
    .where(
      and(
        eq(imMessageDeliveries.steerTargetDeliveryId, rootId),
        inArray(imMessageDeliveries.state, ["pending", "expired"]),
        isNull(imMessageDeliveries.inputHash),
      ),
    );
}

function compatibleBatchMember(
  delivery: typeof imMessageDeliveries.$inferSelect,
  message: typeof imMessages.$inferSelect,
  request: ImRequest,
  threadKey: string | null | undefined,
  observers: Set<string>,
  now: Date,
): boolean {
  return (
    delivery.attention === request.attention &&
    delivery.placementGeneration === request.placementGeneration &&
    delivery.dispatchRequestId === null &&
    delivery.steerTargetDeliveryId === null &&
    !delivery.lastErrorCode?.startsWith("IM_DELIVERY_CLAIM_") &&
    delivery.nextAttemptAt <= now &&
    delivery.expiresAt > now &&
    message.threadKey === threadKey &&
    (observers.has(message.id) ? "observer" : undefined) === request.replyRole
  );
}

function appendBatchMember(
  request: ImRequest,
  root: typeof imMessages.$inferSelect,
  delivery: typeof imMessageDeliveries.$inferSelect,
  message: typeof imMessages.$inferSelect,
  binding: typeof imBindings.$inferSelect,
): boolean {
  let content: RuntimeImDeliveryContent;
  try {
    content = deliveryMessageContent(message, binding);
  } catch {
    return false;
  }
  const resources = [...(request.content.resources ?? []), ...(content.resources ?? [])];
  if (resources.length > RUNTIME_IM_RESOURCE_MAX_COUNT) return false;
  const suffix = `\n\n[Message ${message.id}; author ${JSON.stringify({ id: message.authorExternalId, name: message.authorDisplayName })}; ${message.occurredAt.toISOString()}]\nProvider reference: ${JSON.stringify(content.providerRef)}\n${content.text}`;
  const firstHeader = request.batch
    ? ""
    : `[Message ${root.id}; author ${JSON.stringify({ id: root.authorExternalId, name: root.authorDisplayName })}; ${root.occurredAt.toISOString()}]\n`;
  const text = firstHeader + request.content.text + suffix;
  if (Buffer.byteLength(text, "utf8") > RUNTIME_DIRECT_TEXT_MAX_BYTES) return false;
  const member = {
    deliveryId: delivery.id,
    imMessageId: message.id,
    inputHash: computeRuntimeImMessageSemanticHash({
      ...request,
      batch: undefined,
      deliveryId: delivery.id,
      imMessageId: message.id,
      content,
      deadlineAt: delivery.expiresAt.toISOString(),
    }),
  };
  const candidate: ImRequest = {
    ...request,
    content: { ...request.content, text, ...(resources.length ? { resources } : {}) },
    batch: [...(request.batch ?? []), member],
  };
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > RUNTIME_MAX_FRAME_BYTES) return false;
  Object.assign(request, candidate);
  return true;
}
