import {
  computeTurnResultHash,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_OUTGOING_REPLY_MAX_COUNT,
  RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES,
  type RuntimeProviderMessageRef,
  runtimeFrameByteLength,
  type TurnOutgoingReply,
  TurnOutgoingReplySchema,
  type TurnOutgoingReplySnapshot,
  TurnOutgoingReplySnapshotSchema,
  type TurnReportHashInput,
} from "@opentag/shared";
import { truncateUtf8 } from "./outgoing-reply-capture.js";
import type { ProviderCliOutgoingReplyCollectResult, ProviderCliOutgoingReplyReceipt } from "./outgoing-reply-store.js";

export interface FeishuOutgoingReplyScope {
  readonly appId?: string;
  readonly botOpenId?: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly threadId?: string;
  readonly rootId?: string;
  readonly parentId?: string;
  readonly chatType?: string;
  readonly teamBrand: "feishu" | "lark";
}

export function feishuOutgoingReplyScope(providerRef: RuntimeProviderMessageRef): FeishuOutgoingReplyScope | undefined {
  if (providerRef.provider !== "feishu") return undefined;
  return {
    appId: providerRef.appId,
    botOpenId: providerRef.botOpenId,
    chatId: providerRef.chatId,
    messageId: providerRef.messageId,
    ...(providerRef.threadId ? { threadId: providerRef.threadId } : {}),
    ...(providerRef.rootId ? { rootId: providerRef.rootId } : {}),
    ...(providerRef.parentId ? { parentId: providerRef.parentId } : {}),
    ...(providerRef.chatType ? { chatType: providerRef.chatType } : {}),
    teamBrand: providerRef.teamBrand,
  };
}

export function isOutgoingReplyInScope(
  scope: FeishuOutgoingReplyScope,
  receipt: ProviderCliOutgoingReplyReceipt,
): boolean {
  if (receipt.chatId !== scope.chatId) return false;
  if (receipt.senderType && receipt.senderType !== "app") return false;
  if (
    receipt.senderId &&
    scope.appId &&
    scope.botOpenId &&
    receipt.senderId !== scope.appId &&
    receipt.senderId !== scope.botOpenId
  )
    return false;
  if (scope.chatType === "p2p") return true;
  if (scope.threadId && receipt.threadId) return receipt.threadId === scope.threadId;
  const rootId = scope.rootId ?? scope.messageId;
  if (receipt.rootId && receipt.rootId !== rootId) return false;
  if (receipt.rootId === rootId || receipt.parentId === scope.messageId) return true;
  // Older DM references may omit chatType; never widen an explicit group or topic.
  return !scope.chatType && !scope.threadId && !scope.rootId;
}

export function snapshotOutgoingReplies(
  collected: ProviderCliOutgoingReplyCollectResult,
  scope: FeishuOutgoingReplyScope,
): TurnOutgoingReplySnapshot {
  if (collected.status === "unavailable" && collected.receipts.length === 0) {
    return TurnOutgoingReplySnapshotSchema.parse({ status: "unavailable", replies: [] });
  }
  const replies: TurnOutgoingReply[] = [];
  let omittedCount = 0;
  let incomplete = collected.status !== "complete";
  for (const receipt of uniqueReceipts(collected.receipts)) {
    if (!isOutgoingReplyInScope(scope, receipt)) {
      omittedCount += 1;
      incomplete = true;
      continue;
    }
    if (replies.length >= RUNTIME_OUTGOING_REPLY_MAX_COUNT) {
      omittedCount += 1;
      incomplete = true;
      continue;
    }
    const parsed = TurnOutgoingReplySchema.safeParse(toOutgoingReply(receipt, scope.teamBrand));
    if (!parsed.success) {
      omittedCount += 1;
      incomplete = true;
      continue;
    }
    replies.push(parsed.data);
    if (parsed.data.content.unavailable) incomplete = true;
  }
  const snapshot = {
    status: incomplete ? ("incomplete" as const) : ("complete" as const),
    replies,
    ...(omittedCount > 0 ? { omittedCount } : {}),
  };
  return fitSnapshot(snapshot);
}

function uniqueReceipts(receipts: readonly ProviderCliOutgoingReplyReceipt[]): ProviderCliOutgoingReplyReceipt[] {
  const unique = new Map<string, ProviderCliOutgoingReplyReceipt>();
  for (const receipt of receipts) {
    const previous = unique.get(receipt.messageId);
    if (!previous || (previous.contentStatus !== "available" && receipt.contentStatus === "available")) {
      unique.set(receipt.messageId, receipt);
    }
  }
  return [...unique.values()];
}

export function budgetTurnReportHashInput(input: TurnReportHashInput): TurnReportHashInput {
  const initial = input.outgoingReplies;
  if (initial === undefined) return input;
  let snapshot = fitSnapshot(initial);
  let current: TurnReportHashInput = { ...input, outgoingReplies: snapshot };
  if (
    frameBytes(current) <= RUNTIME_MAX_FRAME_BYTES &&
    snapshotBytes(snapshot) <= RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES
  ) {
    return current;
  }
  if (current.finalText) {
    current = truncateFinalTextToFit(current);
    snapshot = current.outgoingReplies ?? snapshot;
  }
  if (
    frameBytes(current) <= RUNTIME_MAX_FRAME_BYTES &&
    snapshotBytes(snapshot) <= RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES
  ) {
    return current;
  }
  snapshot = fitSnapshot(stripReplyBodies(snapshot, snapshot.omittedCount ?? 0));
  current = { ...current, outgoingReplies: snapshot };
  if (frameBytes(current) <= RUNTIME_MAX_FRAME_BYTES) return current;
  let replies = [...snapshot.replies];
  let omittedCount = snapshot.omittedCount ?? 0;
  while (replies.length > 0 && frameBytes(withReplies(current, replies, omittedCount)) > RUNTIME_MAX_FRAME_BYTES) {
    replies = replies.slice(0, -1);
    omittedCount += 1;
  }
  return withReplies(current, replies, omittedCount);
}

function toOutgoingReply(receipt: ProviderCliOutgoingReplyReceipt, teamBrand: "feishu" | "lark"): TurnOutgoingReply {
  return {
    provider: "feishu",
    teamBrand,
    messageId: receipt.messageId,
    chatId: receipt.chatId,
    ...optionalReplyIds(receipt),
    content: outgoingReplyContent(receipt),
  };
}

function optionalReplyIds(
  receipt: ProviderCliOutgoingReplyReceipt,
): Pick<TurnOutgoingReply, "threadId" | "rootId" | "parentId" | "createTime"> {
  return {
    ...(receipt.threadId ? { threadId: receipt.threadId } : {}),
    ...(receipt.rootId ? { rootId: receipt.rootId } : {}),
    ...(receipt.parentId ? { parentId: receipt.parentId } : {}),
    ...(receipt.createTime ? { createTime: receipt.createTime } : {}),
  };
}

function outgoingReplyContent(receipt: ProviderCliOutgoingReplyReceipt): TurnOutgoingReply["content"] {
  const unavailable =
    receipt.contentStatus === "available"
      ? receipt.content?.unavailable
      : (receipt.content?.unavailable ??
        (receipt.contentStatus === "truncated" ? "content_truncated" : "content_read_failed"));
  return {
    msgType: receipt.content?.msgType ?? receipt.msgType ?? "unknown",
    ...(receipt.content?.text !== undefined ? { text: receipt.content.text } : {}),
    ...(receipt.content?.post !== undefined ? { post: receipt.content.post } : {}),
    ...(receipt.content?.filename ? { filename: receipt.content.filename } : {}),
    ...(receipt.content?.fileKey ? { fileKey: receipt.content.fileKey } : {}),
    ...(receipt.content?.imageKey ? { imageKey: receipt.content.imageKey } : {}),
    ...(receipt.content?.raw ? { raw: receipt.content.raw } : {}),
    ...(unavailable ? { unavailable } : {}),
  };
}

function truncateFinalTextToFit(input: TurnReportHashInput): TurnReportHashInput {
  const current = input.outgoingReplies;
  if (!current) return input;
  const snapshot: TurnOutgoingReplySnapshot = {
    ...current,
    runtimeSummaryTruncated: true,
  };
  if (!input.finalText) {
    return { ...input, outgoingReplies: snapshot };
  }
  let high = Buffer.byteLength(input.finalText, "utf8");
  let low = 0;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const text = truncateUtf8(input.finalText, mid).text;
    const candidate: TurnReportHashInput = {
      ...omitFinalText(input),
      ...(text ? { finalText: text } : {}),
      outgoingReplies: snapshot,
    };
    if (frameBytes(candidate) <= RUNTIME_MAX_FRAME_BYTES) {
      best = text;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (!best) {
    const { finalText: _removed, ...rest } = input;
    return { ...rest, outgoingReplies: snapshot };
  }
  return { ...input, finalText: best, outgoingReplies: snapshot };
}

function omitFinalText(input: TurnReportHashInput): Omit<TurnReportHashInput, "finalText"> {
  const { finalText: _finalText, ...rest } = input;
  return rest;
}

function stripReplyBodies(snapshot: TurnOutgoingReplySnapshot, omittedCount: number): TurnOutgoingReplySnapshot {
  return {
    status: snapshot.status === "complete" ? "incomplete" : snapshot.status,
    replies: snapshot.replies.map((reply) => ({
      ...reply,
      content: {
        msgType: reply.content.msgType,
        ...(reply.content.filename ? { filename: reply.content.filename } : {}),
        ...(reply.content.fileKey ? { fileKey: reply.content.fileKey } : {}),
        ...(reply.content.imageKey ? { imageKey: reply.content.imageKey } : {}),
        unavailable: "content_truncated",
      },
    })),
    omittedCount,
    ...(snapshot.runtimeSummaryTruncated ? { runtimeSummaryTruncated: true } : {}),
  };
}

function withReplies(
  input: TurnReportHashInput,
  replies: readonly TurnOutgoingReply[],
  omittedCount: number,
): TurnReportHashInput {
  const snapshot = fitSnapshot({
    status: omittedCount > 0 || input.outgoingReplies?.status !== "complete" ? "incomplete" : "complete",
    replies: [...replies],
    ...(omittedCount > 0 ? { omittedCount } : {}),
    ...(input.outgoingReplies?.runtimeSummaryTruncated ? { runtimeSummaryTruncated: true } : {}),
  });
  return { ...input, outgoingReplies: snapshot };
}

function fitSnapshot(snapshot: TurnOutgoingReplySnapshot): TurnOutgoingReplySnapshot {
  const parsed = TurnOutgoingReplySnapshotSchema.safeParse(snapshot);
  if (parsed.success) return parsed.data;
  const replies = [...snapshot.replies];
  let omittedCount = snapshot.omittedCount ?? 0;
  // Keep earlier bodies and later message identities while bounded by the wire
  // contract. Only omit identities once their metadata itself exceeds the limit.
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const reply = replies[index];
    if (!reply) continue;
    replies[index] = stripReplyBodies({ status: "incomplete", replies: [reply] }, 0).replies[0] ?? reply;
    const candidate = { ...snapshot, status: "incomplete" as const, replies };
    const next = TurnOutgoingReplySnapshotSchema.safeParse(candidate);
    if (next.success) return next.data;
  }
  while (replies.length > 0) {
    replies.pop();
    omittedCount += 1;
    const candidate = {
      status: "incomplete" as const,
      replies,
      omittedCount,
      ...(snapshot.runtimeSummaryTruncated ? { runtimeSummaryTruncated: true } : {}),
    };
    const next = TurnOutgoingReplySnapshotSchema.safeParse(candidate);
    if (next.success) return next.data;
  }
  return TurnOutgoingReplySnapshotSchema.parse({
    status: "incomplete",
    replies: [],
    omittedCount: Math.max(omittedCount, 1),
    ...(snapshot.runtimeSummaryTruncated ? { runtimeSummaryTruncated: true } : {}),
  });
}

function frameBytes(input: TurnReportHashInput): number {
  const report = {
    type: "turn:report",
    requestId: "00000000-0000-4000-8000-000000000000",
    connectionId: "00000000-0000-4000-8000-000000000000",
    ...input,
    resultHash: computeTurnResultHash(input),
  };
  return runtimeFrameByteLength(JSON.stringify(report));
}

function snapshotBytes(snapshot: TurnOutgoingReplySnapshot): number {
  return runtimeFrameByteLength(JSON.stringify(snapshot));
}

export function emptyCompleteOutgoingReplies(): TurnOutgoingReplySnapshot {
  return TurnOutgoingReplySnapshotSchema.parse({ status: "complete", replies: [] });
}

export function unavailableOutgoingReplies(): TurnOutgoingReplySnapshot {
  return TurnOutgoingReplySnapshotSchema.parse({ status: "unavailable", replies: [] });
}
