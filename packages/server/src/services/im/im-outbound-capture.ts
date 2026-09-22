import {
  type ImContentV1,
  type ProviderInboundContext,
  RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES,
  type RuntimeCredentialProvider,
} from "@opentag/shared";
import { and, desc, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imBindings, imMessages } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";

/**
 * Capture of platform-confirmed outbound IM messages. Local and Cloud traffic share the one
 * Server provider proxy; when a registered send/reply operation succeeds there, the native JSON
 * response is handed here BEFORE any temporary-URL rewriting, and the confirmed message identity
 * plus a bounded, display-oriented copy of the body is stored in `im_messages` as
 * `direction=outbound`, `operation=created`, `provider_revision_key=outbound:created:v1` with
 * `provider_event_id=null` (a send receipt is not an inbound event).
 *
 * Boundaries, by design:
 * - No provider history calls, no replay, no inference from request text or runtime summaries.
 *   Only the verified platform response is a confirmed body; the request supplies at most the
 *   verified target (Feishu `receive_id` with `receive_id_type=chat_id`, Slack `channel`).
 * - No inbox, delivery, Session, or Agent side effects: one `INSERT ... ON CONFLICT DO NOTHING`
 *   on the existing semantic unique key, plus bounded lookups for binding identity and the local
 *   same-binding parent a Feishu reply needs when the response omits thread/root.
 * - Capture failures are isolated: they are logged with codes and identifiers (never headers,
 *   tokens, or message bodies) and must never turn a confirmed send into a failure or a resend.
 * - Every statement runs through the cancellable postgres-js client under one capture deadline,
 *   so a saturated pool or blocked write cannot hold the confirmed provider response hostage.
 */

/** The existing semantic unique key component for captured outbound creates. */
export const OUTBOUND_CREATED_REVISION_KEY = "outbound:created:v1";
/** One captured record's content JSON is capped well under the shared schema's own envelope. */
export const OUTBOUND_CAPTURED_CONTENT_MAX_BYTES = 32 * 1024;
/**
 * The whole capture — binding lookup, thread lookup, and insert — must settle within this budget.
 * Statements that outlive it are cancelled instead of being left pending behind a `Promise.race`.
 */
export const OUTBOUND_CAPTURE_DEADLINE_MS = 1_500;
const OUTBOUND_CAPTURED_TEXT_MAX_BYTES = RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES;
const OUTBOUND_CAPTURED_RESOURCES_MAX = 16;
const ID_MAX_BYTES = 512;
const MESSAGE_TYPE_MAX_BYTES = 160;
const PROVIDER_TIME_MAX_BYTES = 64;
const SLACK_PROJECTION_MAX_ITEMS = 8;

/** One verified send/reply observation handed over by the proxy after platform success. */
export interface OutboundCaptureEvent {
  provider: RuntimeCredentialProvider;
  operationId: string;
  /** Server-authorized binding identity; never taken from the request body. */
  bindingId: string;
  pathParams: Record<string, string>;
  /** Raw query string of the proxied request (Feishu carries `receive_id_type` there). */
  query: string;
  /** Parsed request body (JSON or decoded Slack form); used only for the verified target/thread. */
  requestBody: unknown;
  /** Native JSON response exactly as the platform returned it, before any handle rewriting. */
  responsePayload: unknown;
  /** When the Server observed the confirmed response; the fallback time, honestly labeled. */
  observedAt: Date;
}

export interface CapturedOutboundMessage {
  channelId: string;
  externalMessageId: string;
  threadKey: string | null;
  replyToExternalId: string | null;
  /** Bot identity the platform response confirms; used only when the binding has none stored. */
  responseAuthorExternalId: string | null;
  content: ImContentV1;
  providerContext: ProviderInboundContext;
  occurredAt: Date;
  timeSource: "provider" | "observed";
  /** Verified Feishu reply target, needed for local parent thread resolution. */
  replyTargetExternalId: string | null;
}

export type OutboundCaptureSkipReason =
  | "operation_not_observed"
  | "platform_not_successful"
  | "message_identity_missing"
  | "message_identity_conflict"
  | "channel_missing"
  | "channel_mismatch"
  | "reply_target_conflict";

export type OutboundCaptureParse =
  | { status: "captured"; message: CapturedOutboundMessage }
  | { status: "skipped"; reason: OutboundCaptureSkipReason };

type Skipped = { status: "skipped"; reason: OutboundCaptureSkipReason };

function skipped(reason: OutboundCaptureSkipReason): Skipped {
  return { status: "skipped", reason };
}

const textEncoder = new TextEncoder();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * JSONB rejects NUL and lone surrogates, and a PostgreSQL text column rejects NUL too. Replacing
 * them here keeps a confirmed message identity from disappearing over a hostile display string.
 */
function safeDisplayText(value: string): string {
  let text = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    text += codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff) ? "\uFFFD" : char;
  }
  return text;
}

/** Bounded string acceptance for identifiers and labels: over-long values are refused, not cut. */
function bounded(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const text = safeDisplayText(value);
  return textEncoder.encode(text).byteLength <= maxBytes ? text : undefined;
}

/** Display text is truncated at the byte cap without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (textEncoder.encode(value).byteLength <= maxBytes) return { text: value, truncated: false };
  let text = "";
  let size = 0;
  for (const char of value) {
    const charBytes = textEncoder.encode(char).byteLength;
    if (size + charBytes > maxBytes) break;
    text += char;
    size += charBytes;
  }
  return { text, truncated: true };
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function slackEpochToDate(ts: string): Date | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(ts)) return undefined;
  const milliseconds = Number(ts) * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  const at = new Date(milliseconds);
  return Number.isFinite(at.getTime()) ? at : undefined;
}

/** Feishu `create_time` is epoch milliseconds as a decimal string. */
function feishuEpochToDate(value: string | undefined): Date | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return undefined;
  const at = new Date(milliseconds);
  return Number.isFinite(at.getTime()) ? at : undefined;
}

type ContentBlock = ImContentV1["blocks"][number];
type ResourceDescriptor = NonNullable<ImContentV1["resources"]>[number];
type TimeSource = "provider" | "observed";

interface ContentInput {
  text?: string;
  blocks?: ContentBlock[];
  resources?: ResourceDescriptor[];
  unsupportedType?: string;
  messageType?: string;
  timeSource: TimeSource;
}

function defaultBlocks(boundText: string, unsupportedType: string | undefined): ContentBlock[] {
  if (boundText.length > 0) return [{ type: "text", text: boundText }];
  return unsupportedType ? [{ type: "unsupported", providerType: unsupportedType }] : [];
}

function jsonBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

/** The longest code-point prefix of `text` that keeps the whole content JSON within the cap. */
function fitFallbackText(content: ImContentV1, text: string): { text: string; truncated: boolean } | undefined {
  if (jsonBytes({ ...content, fallbackText: "" }) > OUTBOUND_CAPTURED_CONTENT_MAX_BYTES) return undefined;
  const points = Array.from(text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...content, fallbackText: points.slice(0, middle).join("") };
    if (jsonBytes(candidate) <= OUTBOUND_CAPTURED_CONTENT_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  return { text: points.slice(0, low).join(""), truncated: low < points.length };
}

/**
 * JSON escaping can inflate control-heavy text far beyond its UTF-8 size, so the 32 KiB cap is
 * enforced on the actual serialized bytes: blocks are dropped first, then the text is truncated
 * until the whole envelope fits. The confirmed identity and its outbound metadata always survive.
 */
function capContent(content: ImContentV1): ImContentV1 {
  if (jsonBytes(content) <= OUTBOUND_CAPTURED_CONTENT_MAX_BYTES) return content;
  const stripped: ImContentV1 = {
    version: 1,
    fallbackText: content.fallbackText,
    blocks: [],
    truncated: true,
    ...(content.resources && content.resources.length > 0 ? { resources: content.resources } : {}),
    ...(content.outbound ? { outbound: content.outbound } : {}),
  };
  const fitted = fitFallbackText(stripped, content.fallbackText);
  if (fitted) return { ...stripped, fallbackText: fitted.text, truncated: true };
  // Even an empty body with resources cannot fit; drop them and keep the confirmed identity.
  return {
    version: 1,
    fallbackText: "",
    blocks: [],
    truncated: true,
    ...(content.outbound ? { outbound: { ...content.outbound, contentAvailable: false } } : {}),
  };
}

/**
 * The bounded normalized content of one confirmed send. Only fields extracted above ever reach
 * this object — never a raw response copy — so no signed URL, temporary handle, or credential can
 * leak into storage. The confirmed identity survives an unavailable or truncated body.
 */
function buildContent(input: ContentInput): ImContentV1 {
  const normalized = input.text === undefined ? undefined : safeDisplayText(input.text);
  const normalizedChanged = normalized !== undefined && normalized !== input.text;
  const bound =
    normalized === undefined
      ? { text: "", truncated: false }
      : truncateUtf8(normalized, OUTBOUND_CAPTURED_TEXT_MAX_BYTES);
  const resources = (input.resources ?? []).slice(0, OUTBOUND_CAPTURED_RESOURCES_MAX);
  const blocks = input.blocks ?? defaultBlocks(bound.text, input.unsupportedType);
  const outbound = {
    ...(input.messageType ? { messageType: input.messageType } : {}),
    contentAvailable: bound.text.length > 0 || resources.length > 0,
    timeSource: input.timeSource,
  };
  return capContent({
    version: 1,
    fallbackText: bound.text,
    blocks,
    ...(resources.length > 0 ? { resources } : {}),
    truncated: bound.truncated || normalizedChanged,
    outbound,
  });
}

/** One Feishu post paragraph is a sequence of tagged segments; only their text runs display. */
function feishuPostLine(paragraph: unknown): string {
  if (!Array.isArray(paragraph)) return "";
  let line = "";
  for (const segment of paragraph) {
    const record = asRecord(segment);
    if (!record) continue;
    if ((record.tag === "text" || record.tag === "a") && typeof record.text === "string") line += record.text;
    if (record.tag === "at" && typeof record.user_name === "string") line += `@${record.user_name}`;
  }
  return line;
}

/** A post field at the top level, or under the locale key older response shapes wrap it in. */
function feishuPostField(body: Record<string, unknown>, key: "title" | "content" | "content_v2"): unknown {
  if (body[key] !== undefined) return body[key];
  for (const value of Object.values(body)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Tagged post paragraphs joined by lines; only their display runs are read. */
function feishuPostParagraphs(paragraphs: unknown): string {
  if (!Array.isArray(paragraphs)) return "";
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const line = feishuPostLine(paragraph);
    if (line.length > 0) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Post display text, at the top level or under the locale key older shapes wrap it in. The tagged
 * form wins; the same content sent as markdown (content_v2) is read only when it has no text.
 */
function feishuPostText(body: Record<string, unknown>): string | undefined {
  const title = feishuPostField(body, "title");
  const tagged = feishuPostParagraphs(feishuPostField(body, "content"));
  const markdown = feishuPostField(body, "content_v2");
  const bodyText = tagged.length > 0 ? tagged : typeof markdown === "string" ? markdown.trim() : "";
  const parts = [typeof title === "string" ? title.trim() : "", bodyText].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Each Feishu media type has its own documented body key; another key is not a substitute. */
const FEISHU_RESOURCE_KINDS: ReadonlyMap<string, { kind: ResourceDescriptor["kind"]; key: "image_key" | "file_key" }> =
  new Map([
    ["image", { kind: "image", key: "image_key" }],
    ["file", { kind: "file", key: "file_key" }],
    ["audio", { kind: "audio", key: "file_key" }],
    ["media", { kind: "video", key: "file_key" }],
    ["sticker", { kind: "image", key: "file_key" }],
  ]);

/** Native resource keys are opaque ids: URL, handle, and path shapes must never reach storage. */
const OPAQUE_RESOURCE_KEY = /^[A-Za-z0-9_-]{1,512}$/;

function feishuResource(
  msgType: string,
  body: Record<string, unknown> | undefined,
): { resource: ResourceDescriptor; block: ContentBlock } | undefined {
  const mapping = FEISHU_RESOURCE_KINDS.get(msgType);
  if (!mapping || !body) return undefined;
  const providerResourceKey = bounded(body[mapping.key], 2048);
  if (!providerResourceKey || !OPAQUE_RESOURCE_KEY.test(providerResourceKey)) return undefined;
  const filename = bounded(body.file_name, 512) ?? null;
  return {
    resource: {
      providerResourceKey,
      kind: mapping.kind,
      filename,
      mediaType: null,
      sizeBytes: null,
      ordinal: 0,
    },
    block: { type: mapping.kind === "image" ? "image" : "file", resourceOrdinal: 0, label: filename ?? msgType },
  };
}

function feishuBodyContent(
  msgType: string | undefined,
  body: Record<string, unknown> | undefined,
  timeSource: TimeSource,
) {
  const resource = msgType ? feishuResource(msgType, body) : undefined;
  return buildContent({
    ...(msgType === "text" ? { text: typeof body?.text === "string" ? body.text : undefined } : {}),
    ...(msgType === "post" ? { text: body ? feishuPostText(body) : undefined } : {}),
    ...(resource ? { blocks: [resource.block], resources: [resource.resource] } : {}),
    ...(msgType && !resource && msgType !== "text" && msgType !== "post" ? { unsupportedType: msgType } : {}),
    ...(msgType ? { messageType: msgType } : {}),
    timeSource,
  });
}

/** Slack conversation-like ids are C…/D…/G…; `#name`, `@user`, and user ids are not channels. */
const SLACK_CONVERSATION_ID = /^[CDG][A-Z0-9]{5,31}$/;

/**
 * The confirmed Slack target: the platform's actual channel wins, and a canonical C/D/G request
 * conversation may only disagree with it as an outright conflict. Without a response channel, a
 * canonical request conversation id can stand in — a user id or alias never becomes a channel.
 */
function slackChannel(request: Record<string, unknown>, response: Record<string, unknown>) {
  const responseChannel = bounded(response.channel, ID_MAX_BYTES);
  const requestChannel = bounded(request.channel, ID_MAX_BYTES);
  if (responseChannel) {
    if (requestChannel && SLACK_CONVERSATION_ID.test(requestChannel) && requestChannel !== responseChannel) {
      return skipped("channel_mismatch");
    }
    return { status: "ok" as const, channelId: responseChannel };
  }
  if (requestChannel && SLACK_CONVERSATION_ID.test(requestChannel)) {
    return { status: "ok" as const, channelId: requestChannel };
  }
  return skipped("channel_missing");
}

/** Bounded display descriptions from Slack legacy attachments. */
function slackAttachmentText(message: Record<string, unknown>): string[] {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const parts: string[] = [];
  for (const attachment of attachments.slice(0, SLACK_PROJECTION_MAX_ITEMS)) {
    const record = asRecord(attachment);
    if (!record) continue;
    for (const key of ["pretext", "title", "text", "fallback"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) parts.push(value.trim());
    }
  }
  return parts;
}

/** Bounded Block Kit text, read only when the response carries no plain text of its own. */
function slackBlockText(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message.blocks)) return [];
  const parts: string[] = [];
  for (const block of message.blocks.slice(0, SLACK_PROJECTION_MAX_ITEMS)) {
    const record = asRecord(block);
    if (!record) continue;
    const text = asRecord(record.text);
    if (typeof text?.text === "string" && text.text.trim().length > 0) parts.push(text.text.trim());
    collectSlackRichText(record.elements, parts, 2);
  }
  return parts;
}

function collectSlackRichText(elements: unknown, parts: string[], depth: number): void {
  if (depth <= 0 || !Array.isArray(elements) || parts.length >= SLACK_PROJECTION_MAX_ITEMS) return;
  for (const element of elements) {
    if (parts.length >= SLACK_PROJECTION_MAX_ITEMS) return;
    const record = asRecord(element);
    if (!record) continue;
    if (typeof record.text === "string" && record.text.trim().length > 0) parts.push(record.text.trim());
    collectSlackRichText(record.elements, parts, depth - 1);
  }
}

/** The display body Slack confirms: message text plus bounded attachment/rich-text descriptions. */
function slackMessageText(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) return undefined;
  const primary = typeof message.text === "string" ? message.text : "";
  const parts = primary.trim().length > 0 ? [primary] : [];
  parts.push(...slackAttachmentText(message));
  if (primary.trim().length === 0) parts.push(...slackBlockText(message));
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.length > 0 ? unique.join("\n") : undefined;
}

function parseSlackPostMessage(event: OutboundCaptureEvent): OutboundCaptureParse {
  const request = asRecord(event.requestBody) ?? {};
  const response = asRecord(event.responsePayload);
  if (response?.ok !== true) return skipped("platform_not_successful");
  const externalMessageId = bounded(response.ts, ID_MAX_BYTES);
  if (!externalMessageId) return skipped("message_identity_missing");
  const message = asRecord(response.message);
  const messageTs = bounded(message?.ts, ID_MAX_BYTES);
  if (messageTs && messageTs !== externalMessageId) return skipped("message_identity_conflict");
  const channel = slackChannel(request, response);
  if (channel.status !== "ok") return channel;
  const threadTs = bounded(message?.thread_ts, ID_MAX_BYTES) ?? bounded(request.thread_ts, ID_MAX_BYTES) ?? null;
  const messageType =
    bounded(message?.subtype, MESSAGE_TYPE_MAX_BYTES) ?? bounded(message?.type, MESSAGE_TYPE_MAX_BYTES);
  const text = slackMessageText(message);
  const providerAt = slackEpochToDate(externalMessageId);
  const timeSource: TimeSource = providerAt ? "provider" : "observed";
  return {
    status: "captured",
    message: {
      channelId: channel.channelId,
      externalMessageId,
      threadKey: threadTs,
      replyToExternalId: null,
      responseAuthorExternalId: bounded(message?.bot_id, 255) ?? bounded(message?.user, 255) ?? null,
      content: buildContent({
        ...(text !== undefined ? { text } : {}),
        ...(messageType ? { messageType } : {}),
        timeSource,
      }),
      providerContext: { provider: "slack", ...(threadTs ? { threadTs } : {}) },
      occurredAt: providerAt ?? event.observedAt,
      timeSource,
      replyTargetExternalId: null,
    },
  };
}

/**
 * The confirmed Feishu target. A reply's chat comes from the response; a create addressed by
 * `receive_id_type=chat_id` may fall back to that verified request target, and any disagreement
 * between it and the response is refused. A non-chat receive id never names the conversation.
 */
function feishuChannel(event: OutboundCaptureEvent, data: Record<string, unknown>, reply: boolean) {
  const responseChatId = bounded(data.chat_id, ID_MAX_BYTES);
  if (reply) return responseChatId ? { status: "ok" as const, channelId: responseChatId } : skipped("channel_missing");
  const receiveIdType = new URLSearchParams(event.query).get("receive_id_type") ?? "open_id";
  const receiveId = bounded(asRecord(event.requestBody)?.receive_id, ID_MAX_BYTES);
  if (receiveIdType !== "chat_id") {
    return responseChatId ? { status: "ok" as const, channelId: responseChatId } : skipped("channel_missing");
  }
  if (responseChatId && receiveId && responseChatId !== receiveId) return skipped("channel_mismatch");
  const channelId = responseChatId ?? receiveId;
  return channelId ? { status: "ok" as const, channelId } : skipped("channel_missing");
}

/** The threading, authorship, and timing facts a Feishu send response confirms. */
interface FeishuResponseMeta {
  rootId: string | null;
  threadId: string | null;
  parentId: string | null;
  replyTargetExternalId: string | null;
  replyToExternalId: string | null;
  responseAuthorExternalId: string | null;
  providerAt: Date | undefined;
}

function feishuResponseMeta(
  data: Record<string, unknown>,
  event: OutboundCaptureEvent,
  reply: boolean,
): FeishuResponseMeta {
  const rootId = bounded(data.root_id, ID_MAX_BYTES) ?? null;
  const threadId = bounded(data.thread_id, ID_MAX_BYTES) ?? null;
  const parentId = bounded(data.parent_id, ID_MAX_BYTES) ?? null;
  const replyTargetExternalId = reply ? (bounded(event.pathParams.message_id, ID_MAX_BYTES) ?? null) : null;
  const sender = asRecord(data.sender);
  const providerAt = feishuEpochToDate(bounded(data.create_time, PROVIDER_TIME_MAX_BYTES));
  return {
    rootId,
    threadId,
    parentId,
    replyTargetExternalId,
    replyToExternalId: parentId ?? replyTargetExternalId,
    responseAuthorExternalId: sender?.sender_type === "app" ? (bounded(sender.id, 255) ?? null) : null,
    providerAt,
  };
}

/**
 * A reply must not be placed in a topic the platform did not confirm. An ordinary reply repeats
 * the requested target as `parent_id`; a thread reply is the documented exception, where
 * `parent_id` identifies the thread root and may legitimately differ from the specific target.
 */
function feishuReplyConflict(meta: FeishuResponseMeta): boolean {
  if (meta.parentId === null) return false;
  if (meta.threadId !== null || meta.rootId !== null) return false;
  return meta.replyTargetExternalId !== null && meta.parentId !== meta.replyTargetExternalId;
}

function parseFeishuSend(event: OutboundCaptureEvent, reply: boolean): OutboundCaptureParse {
  const response = asRecord(event.responsePayload);
  if (response?.code !== 0) return skipped("platform_not_successful");
  const data = asRecord(response.data);
  const externalMessageId = bounded(data?.message_id, ID_MAX_BYTES);
  if (!externalMessageId) return skipped("message_identity_missing");
  const channel = feishuChannel(event, data ?? {}, reply);
  if (channel.status !== "ok") return channel;
  const meta = feishuResponseMeta(data ?? {}, event, reply);
  if (reply && feishuReplyConflict(meta)) return skipped("reply_target_conflict");
  const msgType = bounded(data?.msg_type, MESSAGE_TYPE_MAX_BYTES);
  const bodyEnvelope = asRecord(data?.body);
  const body = parseJsonObject(typeof bodyEnvelope?.content === "string" ? bodyEnvelope.content : undefined);
  const timeSource: TimeSource = meta.providerAt ? "provider" : "observed";
  return {
    status: "captured",
    message: {
      channelId: channel.channelId,
      externalMessageId,
      threadKey: meta.threadId ?? meta.rootId,
      replyToExternalId: meta.replyToExternalId,
      responseAuthorExternalId: meta.responseAuthorExternalId,
      content: feishuBodyContent(msgType, body, timeSource),
      providerContext: {
        provider: "feishu",
        ...(meta.threadId ? { threadId: meta.threadId } : {}),
        ...(meta.rootId ? { rootId: meta.rootId } : {}),
        ...(meta.replyToExternalId ? { parentId: meta.replyToExternalId } : {}),
      },
      occurredAt: meta.providerAt ?? event.observedAt,
      timeSource,
      replyTargetExternalId: meta.replyTargetExternalId,
    },
  };
}

/**
 * Parse one verified send/reply observation into the bounded record to persist, or say why it is
 * not capturable. Anything that is not one of the three observed operations is ignored here; a
 * successful response that lacks confirmed identity or a confirmed target is skipped rather than
 * recorded under a guess.
 */
export function parseCapturedOutbound(event: OutboundCaptureEvent): OutboundCaptureParse {
  if (event.provider === "slack" && event.operationId === "chat.postMessage") {
    return parseSlackPostMessage(event);
  }
  if (event.provider === "feishu" && event.operationId === "feishu.im.messages.create") {
    return parseFeishuSend(event, false);
  }
  if (event.provider === "feishu" && event.operationId === "feishu.im.messages.reply") {
    return parseFeishuSend(event, true);
  }
  return skipped("operation_not_observed");
}

export interface ImOutboundCaptureOptions {
  now?: () => Date;
  logger?: Pick<ServiceLogger, "error" | "warn">;
  /** Test/deployment override for the bounded capture budget; defaults to the production budget. */
  deadlineMs?: number;
}

interface StoredMessageContext {
  externalMessageId: string;
  threadKey: string | null;
  providerContext: ProviderInboundContext;
}

/** Compiled Drizzle statements are executed through the cancellable postgres-js client. */
interface CompiledStatement {
  toSQL(): { sql: string; params: unknown[] };
}

/** The postgres-js pending-query surface the deadline path needs. */
interface CancellablePending {
  cancel(): unknown;
  then(onFulfilled: () => unknown, onRejected: (reason: unknown) => unknown): unknown;
}

/** How long a cancelled statement may take to settle before capture gives up on it. */
const OUTBOUND_CAPTURE_CANCEL_GRACE_MS = 250;

/**
 * Cancel a queued or running postgres-js statement and wait, within a short grace period, for it to
 * settle. A cancelled statement rejects only after the server has aborted it, so a settled
 * statement can no longer write; if the server never acknowledges, capture moves on rather than
 * blocking the confirmed provider response.
 */
async function cancelPendingStatement(pending: CancellablePending, graceMs: number): Promise<void> {
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  try {
    pending.cancel();
  } catch {
    // The statement may already have settled; the grace below still bounds the wait.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  try {
    await Promise.race([settled, grace]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Raw postgres-js rows keep the selected column names, so the mapping stays explicit. */
interface BindingRow {
  external_bot_id: string | null;
}

interface StoredMessageRow {
  external_message_id: string;
  thread_key: string | null;
  provider_context: ProviderInboundContext;
}

class OutboundCaptureDeadlineError extends Error {
  constructor() {
    super("IM outbound capture deadline exceeded");
    this.name = "OutboundCaptureDeadlineError";
  }
}

export class ImOutboundCapture {
  readonly #database: DatabaseClient;
  readonly #logger: Pick<ServiceLogger, "error" | "warn"> | undefined;
  readonly #now: () => Date;
  readonly #deadlineMs: number;

  constructor(database: DatabaseClient, options: ImOutboundCaptureOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
    this.#deadlineMs = options.deadlineMs ?? OUTBOUND_CAPTURE_DEADLINE_MS;
  }

  /**
   * Persist one verified observation. This is the isolation boundary the proxy relies on: it
   * resolves never with an error, so a capture failure can never rewrite the confirmed send's
   * outcome or cause a resend. Failures land in the structured log with codes only.
   */
  async capture(event: OutboundCaptureEvent): Promise<void> {
    const deadlineAt = Date.now() + this.#deadlineMs;
    try {
      await this.#persist(event, deadlineAt);
    } catch (error) {
      if (error instanceof OutboundCaptureDeadlineError) {
        this.#logger?.warn(
          { code: "IM_OUTBOUND_CAPTURE_TIMEOUT", provider: event.provider, operationId: event.operationId },
          "IM outbound capture exceeded its deadline",
        );
        return;
      }
      // Controlled identifiers only: database failures can embed SQL parameters and message bodies.
      this.#logger?.error(
        { code: "IM_OUTBOUND_CAPTURE_FAILED", provider: event.provider, operationId: event.operationId },
        "IM outbound capture failed",
      );
    }
  }

  async #persist(event: OutboundCaptureEvent, deadlineAt: number): Promise<void> {
    const parsed = parseCapturedOutbound(event);
    if (parsed.status === "skipped") {
      this.#logSkipped(event, parsed.reason);
      return;
    }
    const authorExternalId = await this.#authorExternalId(event, parsed.message, deadlineAt);
    if (!authorExternalId) return;
    const thread = await this.#resolveThread(event.bindingId, parsed.message, deadlineAt);
    const statement = this.#database
      .insert(imMessages)
      .values({
        imBindingId: event.bindingId,
        providerEventId: null,
        channelId: parsed.message.channelId,
        externalMessageId: parsed.message.externalMessageId,
        providerRevisionKey: OUTBOUND_CREATED_REVISION_KEY,
        operation: "created",
        direction: "outbound",
        threadKey: thread.threadKey,
        replyToExternalId: parsed.message.replyToExternalId,
        authorKind: "bot",
        authorExternalId,
        authorDisplayName: null,
        content: parsed.message.content,
        providerContext: thread.providerContext,
        occurredAt: parsed.message.occurredAt,
        receivedAt: this.#now(),
      })
      .onConflictDoNothing();
    await this.#statement(statement, deadlineAt);
  }

  /**
   * Execute one compiled statement inside the shared capture deadline. A statement that outlives
   * the deadline — whether it is still waiting for a pooled connection or already running — is
   * cancelled through postgres-js, so it cannot insert after the caller has moved on.
   */
  async #statement<T>(statement: CompiledStatement, deadlineAt: number): Promise<T[]> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new OutboundCaptureDeadlineError();
    const compiled = statement.toSQL();
    const pending = this.#database.$client.unsafe<T[]>(compiled.sql, compiled.params as never[]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remainingMs);
    });
    try {
      const result = await Promise.race([pending, timedOut]);
      if (result === "timeout") {
        await cancelPendingStatement(pending, OUTBOUND_CAPTURE_CANCEL_GRACE_MS);
        throw new OutboundCaptureDeadlineError();
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Skips on data problems of an observed operation are noteworthy; unobserved traffic is not. */
  #logSkipped(event: OutboundCaptureEvent, reason: OutboundCaptureSkipReason): void {
    if (reason === "operation_not_observed" || reason === "platform_not_successful") return;
    this.#logger?.warn(
      { code: "IM_OUTBOUND_CAPTURE_SKIPPED", provider: event.provider, operationId: event.operationId, reason },
      "IM outbound capture skipped",
    );
  }

  /**
   * The bot identity the record is attributed to: the Server-authorized binding first, the
   * platform-confirmed response identity only when the binding has none stored. Without either,
   * the confirmed send is skipped rather than misattributed.
   */
  async #authorExternalId(
    event: OutboundCaptureEvent,
    message: CapturedOutboundMessage,
    deadlineAt: number,
  ): Promise<string | undefined> {
    const query = this.#database
      .select({ externalBotId: imBindings.externalBotId })
      .from(imBindings)
      .where(eq(imBindings.id, event.bindingId))
      .limit(1);
    const [binding] = await this.#statement<BindingRow>(query, deadlineAt);
    const authorExternalId = binding?.external_bot_id ?? message.responseAuthorExternalId ?? undefined;
    if (binding && authorExternalId) return authorExternalId;
    this.#logger?.warn(
      {
        code: "IM_OUTBOUND_CAPTURE_SKIPPED",
        provider: event.provider,
        operationId: event.operationId,
        reason: binding ? "author_unknown" : "binding_stale",
      },
      "IM outbound capture skipped",
    );
    return undefined;
  }

  /**
   * The reply's thread, resolved from the platform response first and from the locally stored
   * same-binding, same-channel parent when the response omits thread/root — never guessed from
   * timings, and never borrowed from another conversation.
   */
  async #resolveThread(
    bindingId: string,
    message: CapturedOutboundMessage,
    deadlineAt: number,
  ): Promise<{ threadKey: string | null; providerContext: ProviderInboundContext }> {
    if (message.threadKey !== null || !message.replyTargetExternalId) {
      return { threadKey: message.threadKey, providerContext: message.providerContext };
    }
    const parent = await this.#storedMessageContext(
      bindingId,
      message.channelId,
      message.replyTargetExternalId,
      deadlineAt,
    );
    if (!parent) return { threadKey: null, providerContext: message.providerContext };
    const parentRootId = parent.providerContext.provider === "feishu" ? (parent.providerContext.rootId ?? null) : null;
    const rootId = parentRootId ?? (parent.threadKey ? null : parent.externalMessageId);
    const providerContext =
      message.providerContext.provider === "feishu" && rootId && !message.providerContext.rootId
        ? { ...message.providerContext, rootId }
        : message.providerContext;
    return { threadKey: parent.threadKey ?? parentRootId ?? parent.externalMessageId, providerContext };
  }

  /** The locally stored same-binding, same-channel message a reply targets, newest revision first. */
  async #storedMessageContext(
    bindingId: string,
    channelId: string,
    externalMessageId: string,
    deadlineAt: number,
  ): Promise<StoredMessageContext | undefined> {
    const query = this.#database
      .select({
        externalMessageId: imMessages.externalMessageId,
        threadKey: imMessages.threadKey,
        providerContext: imMessages.providerContext,
      })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, bindingId),
          eq(imMessages.channelId, channelId),
          eq(imMessages.externalMessageId, externalMessageId),
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.id))
      .limit(1);
    const [row] = await this.#statement<StoredMessageRow>(query, deadlineAt);
    if (!row) return undefined;
    return {
      externalMessageId: row.external_message_id,
      threadKey: row.thread_key,
      providerContext: row.provider_context,
    };
  }
}
