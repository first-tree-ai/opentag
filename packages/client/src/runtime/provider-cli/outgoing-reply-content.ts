import {
  RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES,
  RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES,
  type TurnOutgoingReplyContent,
  type TurnOutgoingReplyMsgType,
} from "@opentag/shared";
import { postToPlainText } from "./outgoing-reply-post.js";
import { truncateUtf8 } from "./outgoing-reply-process.js";

export function contentFromBody(
  msgType: TurnOutgoingReplyMsgType,
  body: Record<string, unknown>,
): { content: TurnOutgoingReplyContent; truncated: boolean } {
  const payload = parseBodyPayload(body.content);
  if (payload.parseFailed) {
    return {
      content: {
        msgType,
        raw: truncateUtf8(String(body.content), RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES).text,
        unavailable: "content_read_failed",
      },
      truncated: false,
    };
  }
  if (msgType === "text") return contentFromText(payload.value);
  if (msgType === "post") return contentFromPost(payload.value);
  if (msgType === "image" || msgType === "sticker") return contentFromImage(msgType, payload.value);
  if (msgType === "file" || msgType === "audio" || msgType === "video" || msgType === "media") {
    return contentFromFile(msgType, payload.value);
  }
  return contentFromRaw(msgType, payload.value ?? body);
}

function parseBodyPayload(content: unknown): { value: unknown; parseFailed: boolean } {
  if (typeof content !== "string") return { value: content, parseFailed: false };
  try {
    return { value: JSON.parse(content) as unknown, parseFailed: false };
  } catch {
    return { value: content, parseFailed: true };
  }
}

function contentFromText(payload: unknown): { content: TurnOutgoingReplyContent; truncated: boolean } {
  const text = isRecord(payload) && typeof payload.text === "string" ? payload.text : undefined;
  if (text === undefined) return { content: { msgType: "text", unavailable: "content_read_failed" }, truncated: false };
  const truncated = truncateUtf8(text, RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES);
  return {
    content: {
      msgType: "text",
      text: truncated.text,
      ...(truncated.truncated ? { unavailable: "content_truncated" as const } : {}),
    },
    truncated: truncated.truncated,
  };
}

function contentFromPost(payload: unknown): { content: TurnOutgoingReplyContent; truncated: boolean } {
  const text = postToPlainText(payload);
  const truncatedText = truncateUtf8(text, RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES);
  const raw = truncateUtf8(JSON.stringify(payload), RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES);
  return {
    content: {
      msgType: "post",
      ...(truncatedText.text ? { text: truncatedText.text } : {}),
      post: raw.truncated ? undefined : payload,
      ...(raw.truncated ? { raw: raw.text } : {}),
      ...(truncatedText.truncated || raw.truncated ? { unavailable: "content_truncated" as const } : {}),
    },
    truncated: truncatedText.truncated || raw.truncated,
  };
}

function contentFromImage(
  msgType: "image" | "sticker",
  payload: unknown,
): { content: TurnOutgoingReplyContent; truncated: boolean } {
  const imageKey = isRecord(payload)
    ? (asNonEmptyString(payload.image_key) ?? asNonEmptyString(payload.file_key))
    : undefined;
  return {
    content: { msgType, ...(imageKey ? { imageKey } : { unavailable: "content_read_failed" as const }) },
    truncated: false,
  };
}

function contentFromFile(
  msgType: "file" | "audio" | "video" | "media",
  payload: unknown,
): { content: TurnOutgoingReplyContent; truncated: boolean } {
  const record = isRecord(payload) ? payload : undefined;
  const fileKey = record ? asNonEmptyString(record.file_key) : undefined;
  const filename = record ? asNonEmptyString(record.file_name) : undefined;
  const imageKey = record ? asNonEmptyString(record.image_key) : undefined;
  return {
    content: {
      msgType,
      ...(fileKey ? { fileKey } : {}),
      ...(filename ? { filename } : {}),
      ...(imageKey ? { imageKey } : {}),
      ...(fileKey || imageKey ? {} : { unavailable: "content_read_failed" as const }),
    },
    truncated: false,
  };
}

function contentFromRaw(
  msgType: TurnOutgoingReplyMsgType,
  payload: unknown,
): { content: TurnOutgoingReplyContent; truncated: boolean } {
  const raw = truncateUtf8(JSON.stringify(payload), RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES);
  return {
    content: { msgType, raw: raw.text, ...(raw.truncated ? { unavailable: "content_truncated" as const } : {}) },
    truncated: raw.truncated,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
