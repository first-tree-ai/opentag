import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { imMessageDeliveries, imMessages } from "../../db/schema/index.js";

export const IM_QUEUE_WARNING_COUNT = 10;
export const IM_QUEUE_CAPACITY = 99;
export const IM_DUPLICATE_PENDING_REASON = "duplicate_pending";

export async function repeatsPendingInput(
  transaction: DatabaseTransaction,
  message: typeof imMessages.$inferSelect,
  sessionId: string,
  attention: "direct" | "ambient",
  now: Date,
): Promise<boolean> {
  if (message.operation !== "created") return false;
  const [previous] = await transaction
    .select({
      delivery: {
        state: imMessageDeliveries.state,
        reason: imMessageDeliveries.reason,
        attention: imMessageDeliveries.attention,
        dispatchRequestId: imMessageDeliveries.dispatchRequestId,
        steerTargetDeliveryId: imMessageDeliveries.steerTargetDeliveryId,
        lastErrorCode: imMessageDeliveries.lastErrorCode,
        expiresAt: imMessageDeliveries.expiresAt,
      },
      message: {
        operation: imMessages.operation,
        authorKind: imMessages.authorKind,
        authorExternalId: imMessages.authorExternalId,
        threadKey: imMessages.threadKey,
        replyToExternalId: imMessages.replyToExternalId,
        occurredAt: imMessages.occurredAt,
        content: imMessages.content,
      },
    })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .where(
      and(
        eq(imMessageDeliveries.sessionId, sessionId),
        ne(imMessages.id, message.id),
        or(isNull(imMessageDeliveries.reason), ne(imMessageDeliveries.reason, IM_DUPLICATE_PENDING_REASON)),
      ),
    )
    .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
    .limit(1);
  if (!previous) return false;
  const input = previous.delivery;
  const source = previous.message;
  return (
    input.state === "pending" &&
    input.reason === null &&
    input.expiresAt > now &&
    input.dispatchRequestId === null &&
    input.steerTargetDeliveryId === null &&
    !input.lastErrorCode?.startsWith("IM_DELIVERY_CLAIM_") &&
    input.attention === attention &&
    source.operation === "created" &&
    source.authorKind === message.authorKind &&
    source.authorExternalId === message.authorExternalId &&
    source.threadKey === message.threadKey &&
    source.replyToExternalId === message.replyToExternalId &&
    source.occurredAt.getTime() <= message.occurredAt.getTime() &&
    isDeepStrictEqual(source.content, message.content)
  );
}
