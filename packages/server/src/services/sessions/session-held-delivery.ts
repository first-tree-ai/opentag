import { createHash } from "node:crypto";
import { SESSION_DELIVERY_FAILURE_NOTICE_HEADER } from "@opentag/shared";

/**
 * A Session message the Server keeps because a Local Client could not take it yet. The row stays
 * `last_outcome = unknown` with this code until a redelivery gets a final answer. It is never written
 * as `accepted`, because execution authority reads that value as proof the target took custody.
 */
export const SESSION_MESSAGE_HELD_CODE = "delivery_held";

/** A held message older than this is given up and its sender is told. Mirrors the IM ambient TTL. */
export const SESSION_MESSAGE_HELD_TTL_MS = 24 * 60 * 60 * 1_000;

export const SESSION_MESSAGE_HELD_EXPIRED_CODE = "delivery_expired";

/** A later occurrence or an edit replaced a held scheduled message, so it is not delivered late. */
export const SESSION_MESSAGE_HELD_SUPERSEDED_CODE = "delivery_superseded";

export function heldMessageCutoff(nowMs: number): Date {
  return new Date(nowMs - SESSION_MESSAGE_HELD_TTL_MS);
}

/** The RFC 9562 URL namespace, as for the other Server-derived message IDs. */
const NOTICE_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** UUIDv5 over the failed message, so every path that gives it up converges on one notice row. */
export function deliveryFailureNoticeMessageId(messageId: string): string {
  const namespace = Buffer.from(NOTICE_NAMESPACE.replaceAll("-", ""), "hex");
  const name = `opentag:session-delivery-failure:${messageId}`;
  const digest = createHash("sha1").update(namespace).update(name, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isDeliveryFailureNotice(content: string): boolean {
  return content.startsWith(SESSION_DELIVERY_FAILURE_NOTICE_HEADER);
}

export function renderDeliveryFailureNotice(input: {
  messageId: string;
  targetSessionId: string;
  code: string;
}): string {
  return [
    SESSION_DELIVERY_FAILURE_NOTICE_HEADER,
    `Session: ${input.targetSessionId}`,
    `Message: ${input.messageId}`,
    `Reason: ${input.code}`,
    "",
    "A message you sent earlier was accepted by openTag but could not be delivered, so that Session never received it.",
    "This notice was written by openTag, not by that Session. openTag will not try again.",
    `To deliver it, send it again: opentag session send ${input.targetSessionId} --message "<message>"`,
  ].join("\n");
}
