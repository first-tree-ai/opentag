import { dirname } from "node:path";
import type { TurnOutgoingReplyContent, TurnOutgoingReplyMsgType } from "@opentag/shared";
import { createLogger } from "../../observability/logger.js";
import { contentFromBody } from "./outgoing-reply-content.js";
import { spawnCapturedProcess } from "./outgoing-reply-process.js";
import {
  beginOutgoingReplyInflight,
  markOutgoingReplyCaptureStatus,
  type ProviderCliOutgoingReplyReceipt,
  writeOutgoingReplyReceipt,
} from "./outgoing-reply-store.js";
import type { ProviderCliTurnPlan } from "./turn-plan.js";

export { postToPlainText } from "./outgoing-reply-post.js";
export { spawnCapturedProcess, truncateUtf8 } from "./outgoing-reply-process.js";

const logger = createLogger("runtime-provider-cli-outgoing-reply");

export const PROVIDER_CLI_OUTGOING_REPLY_STDOUT_CAPTURE_MAX_BYTES = 256 * 1024;
export const PROVIDER_CLI_OUTGOING_REPLY_QUERY_MAX_BYTES = 64 * 1024;
export const PROVIDER_CLI_OUTGOING_REPLY_QUERY_TIMEOUT_MS = 5_000;

const SEND_PATH = /^\/open-apis\/im\/v1\/messages$/;
const REPLY_PATH = /^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/;
const BOOLEAN_FLAGS = new Set([
  "--dry-run",
  "--json",
  "--yes",
  "--reply-in-thread",
  "--page-all",
  "--help",
  "--version",
  "-h",
]);

export type LarkOutgoingMutationKind = "send" | "reply";
export type OutgoingReplyCaptureOutcome = "ignored" | "recorded" | "incomplete";

export function classifyLarkOutgoingMutation(argv: readonly string[]): LarkOutgoingMutationKind | undefined {
  if (argv.some((argument) => argument === "--dry-run" || argument.startsWith("--dry-run="))) return undefined;
  const positional = positionalArgv(argv);
  if (positional[0] === "api") return classifyRawApiMutation(positional);
  return classifyImCommandMutation(positional[0] === "im" ? positional.slice(1) : positional);
}

function classifyRawApiMutation(positional: readonly string[]): LarkOutgoingMutationKind | undefined {
  const method = positional[1]?.toUpperCase();
  const path = positional[2] ? normalizeApiPath(positional[2]) : "";
  if (method !== "POST") return undefined;
  if (SEND_PATH.test(path)) return "send";
  if (REPLY_PATH.test(path)) return "reply";
  return undefined;
}

function classifyImCommandMutation(tokens: readonly string[]): LarkOutgoingMutationKind | undefined {
  if (tokens[0] === "+messages-send") return "send";
  if (tokens[0] === "+messages-reply") return "reply";
  if (tokens[0] === "messages" && tokens[1] === "create") return "send";
  if (tokens[0] === "messages" && tokens[1] === "reply") return "reply";
  return undefined;
}

export async function captureFeishuOutgoingReply(options: {
  readonly plan: ProviderCliTurnPlan;
  readonly planPath: string;
  readonly plansRoot: string;
  readonly userArgv: readonly string[];
  readonly spawnArgs: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly code: number;
  readonly stdout: Buffer;
  readonly stdoutTruncated?: boolean;
  readonly expectedSenderIds?: readonly string[];
}): Promise<OutgoingReplyCaptureOutcome> {
  if (options.plan.provider !== "feishu") return "ignored";
  const kind = classifyLarkOutgoingMutation(options.userArgv);
  if (!kind || options.code !== 0) return "ignored";
  if (options.stdoutTruncated) await markIncomplete(options);
  const parsed = inspectLarkCliEnvelope(options.stdout);
  if (parsed.kind === "rejected") return "ignored";
  if (parsed.kind === "malformed") {
    await markIncomplete(options);
    return "incomplete";
  }
  const receipt = extractSendReceipt(parsed.data);
  if (!receipt) {
    await markIncomplete(options);
    return "incomplete";
  }
  const acceptedAt = new Date();
  const base = {
    ...receipt,
    sequenceHint: acceptedAt.getTime(),
    recordedAt: acceptedAt.toISOString(),
    contentStatus: receipt.content ? receipt.contentStatus : ("unavailable" as const),
  };
  try {
    await persistOutgoingReplyReceipt(kind, applySenderPolicy(base, options.expectedSenderIds), options);
  } catch {
    logger.debug({ code: "outgoing_reply_receipt_write_failed" }, "Outgoing reply receipt write failed");
    await markIncomplete(options);
    return "incomplete";
  }
  if (receipt.content) return "recorded";
  const enriched = await enrichReceiptFromQuery(base, options);
  try {
    await persistOutgoingReplyReceipt(kind, applySenderPolicy(enriched, options.expectedSenderIds), options);
  } catch {
    logger.debug({ code: "outgoing_reply_receipt_enrich_failed" }, "Outgoing reply receipt enrich failed");
    await markIncomplete(options);
  }
  return "recorded";
}

async function enrichReceiptFromQuery(
  receipt: ExtractedMessage & { sequenceHint: number; recordedAt: string },
  options: {
    readonly plan: ProviderCliTurnPlan;
    readonly userArgv: readonly string[];
    readonly spawnArgs: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  },
): Promise<ExtractedMessage & { sequenceHint: number; recordedAt: string }> {
  const queried = await queryLarkMessageById({
    file: options.plan.targetPath,
    argsPrefix: managedArgPrefix(options.spawnArgs, options.userArgv),
    env: options.env,
    messageId: receipt.messageId,
  });
  if (queried.status !== "available" || !queried.item) {
    return {
      ...receipt,
      contentStatus: queried.status === "truncated" ? "truncated" : "unavailable",
    };
  }
  const extracted = extractMessageItem(queried.item);
  if (!extracted || extracted.messageId !== receipt.messageId || extracted.chatId !== receipt.chatId) {
    return { ...receipt, contentStatus: "unavailable" };
  }
  return {
    ...receipt,
    threadId: extracted.threadId ?? receipt.threadId,
    rootId: extracted.rootId ?? receipt.rootId,
    parentId: extracted.parentId ?? receipt.parentId,
    createTime: extracted.createTime ?? receipt.createTime,
    senderType: extracted.senderType ?? receipt.senderType,
    senderId: extracted.senderId ?? receipt.senderId,
    msgType: extracted.msgType ?? receipt.msgType,
    content: extracted.content,
    contentStatus: extracted.contentStatus,
  };
}

function applySenderPolicy(
  receipt: ExtractedMessage & { sequenceHint: number; recordedAt: string },
  expectedSenderIds: readonly string[] | undefined,
): ExtractedMessage & { sequenceHint: number; recordedAt: string } {
  if (receipt.senderType && receipt.senderType !== "app") {
    return { ...receipt, content: undefined, contentStatus: "unavailable" };
  }
  if (expectedSenderIds && expectedSenderIds.length > 0) {
    if (!receipt.senderId || !expectedSenderIds.includes(receipt.senderId)) {
      return { ...receipt, content: undefined, contentStatus: "unavailable" };
    }
  }
  return receipt;
}

async function persistOutgoingReplyReceipt(
  kind: LarkOutgoingMutationKind,
  receipt: ExtractedMessage & { sequenceHint: number; recordedAt: string },
  options: { readonly plan: ProviderCliTurnPlan; readonly planPath: string; readonly plansRoot: string },
): Promise<void> {
  await writeOutgoingReplyReceipt({
    plansRoot: options.plansRoot,
    sessionDir: dirname(options.planPath),
    runId: options.plan.runId,
    receipt: {
      kind,
      recordedAt: receipt.recordedAt,
      sequenceHint: receipt.sequenceHint,
      messageId: receipt.messageId,
      chatId: receipt.chatId,
      ...(receipt.threadId ? { threadId: receipt.threadId } : {}),
      ...(receipt.rootId ? { rootId: receipt.rootId } : {}),
      ...(receipt.parentId ? { parentId: receipt.parentId } : {}),
      ...(receipt.createTime ? { createTime: receipt.createTime } : {}),
      ...(receipt.senderType ? { senderType: receipt.senderType } : {}),
      ...(receipt.senderId ? { senderId: receipt.senderId } : {}),
      ...(receipt.msgType ? { msgType: receipt.msgType } : {}),
      contentStatus: receipt.contentStatus,
      content: receipt.content ?? { msgType: receipt.msgType ?? "unknown", unavailable: "content_read_failed" },
    },
  });
}

export async function withOutgoingReplyInflight<T>(options: {
  readonly plansRoot: string;
  readonly planPath: string;
  readonly runId: string;
  readonly enabled: boolean;
  readonly run: () => Promise<T>;
}): Promise<T> {
  if (!options.enabled) return options.run();
  let inflight: { release(): Promise<void> } | undefined;
  try {
    inflight = await beginOutgoingReplyInflight({
      plansRoot: options.plansRoot,
      sessionDir: dirname(options.planPath),
      runId: options.runId,
    });
  } catch {
    logger.debug({ code: "outgoing_reply_inflight_begin_failed" }, "Outgoing reply inflight begin failed");
    await markOutgoingReplyCaptureStatus({
      plansRoot: options.plansRoot,
      sessionDir: dirname(options.planPath),
      runId: options.runId,
      status: "unavailable",
    });
  }
  try {
    return await options.run();
  } finally {
    await inflight?.release();
  }
}

function inspectLarkCliEnvelope(
  stdout: Buffer | string,
): { kind: "success"; data: unknown } | { kind: "rejected" } | { kind: "malformed" } {
  const parsed = parseJsonValue(typeof stdout === "string" ? stdout : stdout.toString("utf8"));
  if (!isRecord(parsed)) return { kind: "malformed" };
  if (parsed.ok !== true) return { kind: "rejected" };
  if (parsed.dry_run === true) return { kind: "rejected" };
  if (parsed.identity !== undefined && parsed.identity !== "bot") return { kind: "rejected" };
  if (parsed.identity !== "bot") return { kind: "rejected" };
  return { kind: "success", data: parsed.data };
}

export function parseLarkCliSuccessEnvelope(
  stdout: Buffer | string,
): { ok: true; identity?: string; data: unknown } | undefined {
  const parsed = inspectLarkCliEnvelope(stdout);
  if (parsed.kind !== "success") return undefined;
  return { ok: true, identity: "bot", data: parsed.data };
}

function extractSendReceipt(data: unknown): ExtractedMessage | undefined {
  return extractMessageItem(unwrapMessageItem(data));
}

function unwrapMessageItem(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  if (Array.isArray(data.items) && isRecord(data.items[0])) return data.items[0];
  return data;
}

interface ExtractedMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  createTime?: string;
  senderType?: string;
  senderId?: string;
  msgType?: TurnOutgoingReplyMsgType;
  content?: TurnOutgoingReplyContent;
  contentStatus: ProviderCliOutgoingReplyReceipt["contentStatus"];
}

function extractMessageItem(item: Record<string, unknown> | undefined): ExtractedMessage | undefined {
  if (!item) return undefined;
  const messageId = asNonEmptyString(item.message_id);
  const chatId = asNonEmptyString(item.chat_id);
  if (!messageId || !chatId) return undefined;
  const bodyContent = messageBodyContent(item);
  return {
    messageId,
    chatId,
    ...optionalMessageIds(item),
    ...optionalSender(item),
    contentStatus: bodyContent.contentStatus,
    ...(bodyContent.msgType ? { msgType: bodyContent.msgType } : {}),
    ...(bodyContent.content ? { content: bodyContent.content } : {}),
  };
}

function optionalMessageIds(item: Record<string, unknown>): Partial<ExtractedMessage> {
  return {
    ...(asNonEmptyString(item.thread_id) ? { threadId: asNonEmptyString(item.thread_id) } : {}),
    ...(asNonEmptyString(item.root_id) ? { rootId: asNonEmptyString(item.root_id) } : {}),
    ...(asNonEmptyString(item.parent_id) ? { parentId: asNonEmptyString(item.parent_id) } : {}),
    ...(asNonEmptyString(item.create_time) ? { createTime: asNonEmptyString(item.create_time) } : {}),
  };
}

function optionalSender(item: Record<string, unknown>): Partial<ExtractedMessage> {
  const sender = isRecord(item.sender) ? item.sender : undefined;
  return {
    ...(asNonEmptyString(sender?.sender_type) ? { senderType: asNonEmptyString(sender?.sender_type) } : {}),
    ...(asNonEmptyString(sender?.id) ? { senderId: asNonEmptyString(sender?.id) } : {}),
  };
}

function messageBodyContent(
  item: Record<string, unknown>,
): Pick<ExtractedMessage, "contentStatus"> & Partial<ExtractedMessage> {
  const msgType = normalizeMsgType(item.msg_type);
  const body = isRecord(item.body) ? item.body : undefined;
  const hasBody = typeof body?.content === "string" || isRecord(body?.content);
  if (!hasBody || !body) return { ...(msgType ? { msgType } : {}), contentStatus: "unavailable" };
  const extracted = contentFromBody(msgType ?? "unknown", body);
  return {
    ...(msgType ? { msgType } : {}),
    content: extracted.content,
    contentStatus: extracted.truncated ? "truncated" : "available",
  };
}

async function queryLarkMessageById(options: {
  readonly file: string;
  readonly argsPrefix: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly messageId: string;
}): Promise<{ status: "available"; item: Record<string, unknown> } | { status: "failed" | "timeout" | "truncated" }> {
  const args = [
    ...options.argsPrefix,
    "api",
    "GET",
    `/open-apis/im/v1/messages/${encodeURIComponent(options.messageId)}`,
    "--as",
    "bot",
    "--json",
  ];
  try {
    const result = await spawnCapturedProcess({
      file: options.file,
      args,
      env: options.env,
      timeoutMs: PROVIDER_CLI_OUTGOING_REPLY_QUERY_TIMEOUT_MS,
      maxBytes: PROVIDER_CLI_OUTGOING_REPLY_QUERY_MAX_BYTES,
      forward: false,
    });
    if (result.timedOut) return { status: "timeout" };
    if (result.code !== 0) return { status: "failed" };
    const envelope = parseLarkCliSuccessEnvelope(result.stdout);
    if (!envelope) return { status: result.truncated ? "truncated" : "failed" };
    const item = unwrapMessageItem(envelope.data);
    if (!item) return { status: "failed" };
    return { status: "available", item };
  } catch {
    logger.debug({ code: "outgoing_reply_query_failed" }, "Outgoing reply content query failed");
    return { status: "failed" };
  }
}

async function markIncomplete(options: {
  readonly plansRoot: string;
  readonly planPath: string;
  readonly plan: ProviderCliTurnPlan;
}): Promise<void> {
  await markOutgoingReplyCaptureStatus({
    plansRoot: options.plansRoot,
    sessionDir: dirname(options.planPath),
    runId: options.plan.runId,
    status: "incomplete",
  });
}

function managedArgPrefix(spawnArgs: readonly string[], userArgv: readonly string[]): readonly string[] {
  if (userArgv.length === 0) return spawnArgs;
  if (spawnArgs.length >= userArgv.length) {
    const suffix = spawnArgs.slice(spawnArgs.length - userArgv.length);
    if (suffix.length === userArgv.length && suffix.every((value, index) => value === userArgv[index])) {
      return spawnArgs.slice(0, spawnArgs.length - userArgv.length);
    }
  }
  return [];
}

function positionalArgv(argv: readonly string[]): string[] {
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const skipped = skipArgvFlag(argument, index);
    if (skipped === "stop") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    positional.push(argument);
  }
  return positional;
}

function skipArgvFlag(argument: string, index: number): number | "stop" | undefined {
  if (argument === "--") return "stop";
  if (argument.startsWith("--")) {
    if (argument.includes("=") || BOOLEAN_FLAGS.has(argument)) return index;
    return index + 1;
  }
  if (argument.startsWith("-") && argument !== "-") {
    return argument === "-q" || argument === "-o" ? index + 1 : index;
  }
  return undefined;
}

function normalizeApiPath(path: string): string {
  let value = path.trim();
  const matched = /^https?:\/\/[^/]+(\/open-apis\/.+)$/.exec(value);
  if (matched?.[1]) value = matched[1];
  if (!value.startsWith("/open-apis/")) value = `/open-apis/${value.replace(/^\/+/, "")}`;
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function normalizeMsgType(value: unknown): TurnOutgoingReplyMsgType | undefined {
  if (typeof value !== "string") return undefined;
  const allowed: readonly TurnOutgoingReplyMsgType[] = [
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
  ];
  return allowed.includes(value as TurnOutgoingReplyMsgType) ? (value as TurnOutgoingReplyMsgType) : "unknown";
}

function parseJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === undefined) continue;
      try {
        return JSON.parse(line) as unknown;
      } catch {}
    }
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
