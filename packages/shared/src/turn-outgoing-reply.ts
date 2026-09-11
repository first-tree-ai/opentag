import { z } from "zod";
import { runtimeByteString as byteString, runtimeUtf8Length as utf8Length } from "./runtime-config.js";

export const RUNTIME_OUTGOING_REPLY_MAX_COUNT = 16;
export const RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES = 8 * 1024;
export const RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES = 8 * 1024;
export const RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES = 32 * 1024;

const outgoingId = byteString(512, "Provider reference exceeds the 512-byte limit", 1);

export const TurnOutgoingReplyUnavailableReasonSchema = z.enum([
  "content_read_failed",
  "content_truncated",
  "out_of_scope",
  "omitted",
]);

export const TurnOutgoingReplyMsgTypeSchema = z.enum([
  "text",
  "post",
  "image",
  "file",
  "audio",
  "video",
  "media",
  "interactive",
  "sticker",
  "share_chat",
  "share_user",
  "unknown",
]);

export const TurnOutgoingReplyContentSchema = z
  .object({
    msgType: TurnOutgoingReplyMsgTypeSchema,
    text: byteString(RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES, "Outgoing reply text exceeds the 8 KiB limit").optional(),
    post: z.unknown().optional(),
    filename: byteString(512, "Outgoing reply filename exceeds the 512-byte limit", 1).optional(),
    fileKey: byteString(512, "Outgoing reply file key exceeds the 512-byte limit", 1).optional(),
    imageKey: byteString(512, "Outgoing reply image key exceeds the 512-byte limit", 1).optional(),
    raw: byteString(
      RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES,
      "Outgoing reply raw payload exceeds the 8 KiB limit",
    ).optional(),
    unavailable: TurnOutgoingReplyUnavailableReasonSchema.optional(),
  })
  .strict();

export const TurnOutgoingReplySchema = z
  .object({
    provider: z.literal("feishu"),
    teamBrand: z.enum(["feishu", "lark"]),
    messageId: outgoingId,
    chatId: outgoingId,
    threadId: outgoingId.optional(),
    rootId: outgoingId.optional(),
    parentId: outgoingId.optional(),
    createTime: byteString(64, "Outgoing reply create time exceeds the 64-byte limit", 1).optional(),
    content: TurnOutgoingReplyContentSchema,
  })
  .strict();

export const TurnOutgoingReplySnapshotSchema = z
  .object({
    status: z.enum(["complete", "incomplete", "unavailable"]),
    replies: z.array(TurnOutgoingReplySchema).max(RUNTIME_OUTGOING_REPLY_MAX_COUNT),
    omittedCount: z.number().int().safe().nonnegative().optional(),
    runtimeSummaryTruncated: z.boolean().optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (utf8Length(JSON.stringify(snapshot)) > RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "Outgoing reply snapshot exceeds the 32 KiB limit" });
    }
  });

export type TurnOutgoingReplyUnavailableReason = z.infer<typeof TurnOutgoingReplyUnavailableReasonSchema>;
export type TurnOutgoingReplyMsgType = z.infer<typeof TurnOutgoingReplyMsgTypeSchema>;
export type TurnOutgoingReplyContent = z.infer<typeof TurnOutgoingReplyContentSchema>;
export type TurnOutgoingReply = z.infer<typeof TurnOutgoingReplySchema>;
export type TurnOutgoingReplySnapshot = z.infer<typeof TurnOutgoingReplySnapshotSchema>;
