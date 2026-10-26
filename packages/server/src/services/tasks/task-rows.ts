import type {
  AgentRuntimeProvider,
  ImContentV1,
  TaskReply,
  TaskStatus,
  TaskSummary,
  TaskTurn,
  TurnReportRequest,
} from "@opentag/shared";
import { agentAvatarPath, TASK_CANCELLED_DELIVERY_REASON } from "@opentag/shared";
import { deriveTaskTitle, messageTextFromBlocks } from "./task-title.js";

/**
 * The stored shape of one Task list or detail row: the topic identity, its rollup facts and the
 * latest execution of the topic. Every column here is read from one SQL statement, so a row never
 * mixes executions of different reads.
 */
export interface TaskSummaryRow extends Record<string, unknown> {
  id: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  agentAvatarSourceUrl: string | null;
  runtimeProvider: AgentRuntimeProvider;
  provider: "feishu" | "slack";
  conversationKind: "channel" | "dm" | "group_dm";
  sessionKind: "channel" | "thread";
  channelId: string;
  threadKey: string | null;
  createdAt: Date | string;
  endedAt: Date | string | null;
  manualTitle: string | null;
  generatedTitle: string | null;
  lastActivityAt: Date | string;
  fallbackText: string | null;
  titleContent: ImContentV1 | null;
  addressedExternalId: string | null;
  hasRunning: boolean;
  hasPending: boolean;
  deliveryState: "pending" | "accepted" | "steered" | "terminal_rejected" | "expired" | null;
  deliveryReason: string | null;
  latestRunning: boolean | null;
  reportedAt: Date | string | null;
  turnReport: TurnReportRequest | null;
  /**
   * The exact `(last_activity_at)` key of this row as UTC text with microseconds. The keyset cursor
   * is built from it, never from the millisecond `Date` next to it.
   */
  cursorAt: string;
}

export interface TaskTurnRow extends Record<string, unknown> {
  deliveryId: string;
  attention: "direct" | "ambient";
  deliveryState: "pending" | "accepted" | "steered" | "terminal_rejected" | "expired";
  isRunning: boolean;
  attemptCount: number;
  acceptedAt: Date | string | null;
  steeredAt: Date | string | null;
  expiresAt: Date | string;
  reason: string | null;
  lastErrorCode: string | null;
  turnId: string | null;
  turnReport: TurnReportRequest | null;
  reportedAt: Date | string | null;
  absorbedByDeliveryId: string | null;
  absorbedByTurnId: string | null;
  messageId: string;
  externalMessageId: string;
  operation: "created" | "edited" | "deleted";
  authorKind: "human" | "bot" | "system";
  authorDisplayName: string | null;
  content: {
    fallbackText?: unknown;
    truncated?: unknown;
    blocks?: ImContentV1["blocks"];
    resources?: ImContentV1["resources"];
  };
  occurredAt: Date | string;
  /** The exact `occurred_at` key of this row, at the precision the page was ordered by. */
  cursorAt: string;
}

export interface InternalSessionRow extends Record<string, unknown> {
  id: string;
  createdBySessionId: string;
  runtimeModel: string | null;
  runtimeReasoningEffort: string | null;
  endedAt: Date | string | null;
  createdAt: Date | string;
  /** The exact `created_at` key of this row, at the precision the page was ordered by. */
  cursorAt: string;
}

export interface TaskReplyRow extends Record<string, unknown> {
  id: string;
  provider: "feishu" | "slack";
  channelId: string;
  externalMessageId: string;
  authorKind: "human" | "bot" | "system";
  authorDisplayName: string | null;
  content: {
    fallbackText?: unknown;
    truncated?: unknown;
    blocks?: ImContentV1["blocks"];
    resources?: ImContentV1["resources"];
    outbound?: {
      messageType?: unknown;
      contentAvailable?: unknown;
      timeSource?: unknown;
    };
  };
  occurredAt: Date | string;
  /** The exact `occurred_at` key of this row, at the precision the page was ordered by. */
  cursorAt: string;
}

export interface CollaborationMessageRow extends Record<string, unknown> {
  id: string;
  sourceSessionId: string | null;
  scheduledOrigin: { scheduleId: string; scheduledFor: string; timezone: string; name: string } | null;
  targetSessionId: string;
  content: string;
  outcome: "unknown" | "accepted" | "unreachable" | "rejected";
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  /** The exact `created_at` key of this row, at the precision the page was ordered by. */
  cursorAt: string;
}

export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The status is the topic's latest execution situation, read by precedence rather than by the
 * most recent delivery: a disconnected channel first, then any Turn still running, then anything
 * still queued, and only then the outcome of the last execution. An accepted delivery counts as
 * running only while its deadline has not passed, its Session is alive, and no later Turn ran in
 * that Session; a Session runs one Turn at a time, so a later acceptance proves the earlier one
 * ended without a report. A delivery the Account withdrew from the queue is stored as expired with
 * the cancelled reason, and reads as `cancelled` rather than as a deadline that passed. The
 * withdrawal is an execution event of its own: the row's `expires_at` holds the cancel instant and
 * counts as its activity, so a Turn that finished after the withdrawn message arrived, but before
 * the cancel, does not outrank it.
 */
export function taskStatus(row: TaskSummaryRow): TaskStatus {
  if (row.endedAt) return "ended";
  if (row.hasRunning) return "running";
  if (row.hasPending) return "queued";
  // Every listed topic has a direct delivery, so a missing latest execution cannot happen.
  if (!row.deliveryState) return "idle";
  if (row.deliveryState === "expired")
    return row.deliveryReason === TASK_CANCELLED_DELIVERY_REASON ? "cancelled" : "expired";
  if (row.deliveryState === "terminal_rejected") return "failed";
  if (!row.reportedAt || !row.turnReport) return row.latestRunning ? "running" : "expired";
  return row.turnReport.outcome === "completed" ? "completed" : "failed";
}

export function toSummary(row: TaskSummaryRow): TaskSummary {
  const fallbackTitle = row.sessionKind === "thread" ? "Thread task" : "Channel task";
  const title =
    row.manualTitle ??
    row.generatedTitle ??
    deriveTaskTitle({
      fallbackText: row.fallbackText,
      fallbackTitle,
      provider: row.provider,
      addressedExternalId: row.addressedExternalId,
      blocks: row.titleContent?.blocks ?? null,
    });
  return {
    id: row.id,
    agent: {
      id: row.agentId,
      name: row.agentName,
      displayName: row.agentDisplayName,
      ...(row.agentAvatarSourceUrl ? { avatarPath: agentAvatarPath(row.agentId) } : {}),
      runtimeProvider: row.runtimeProvider,
    },
    source: {
      provider: row.provider,
      conversationKind: row.conversationKind,
      channelId: row.channelId,
      threadKey: row.threadKey,
    },
    sessionKind: row.sessionKind,
    title,
    status: taskStatus(row),
    createdAt: toIso(row.createdAt),
    endedAt: row.endedAt ? toIso(row.endedAt) : null,
    lastActivityAt: toIso(row.lastActivityAt),
  };
}

/**
 * The text a Turn shows for its message: the blocks' rendering when the message carries mentions,
 * so a reader sees `@Atlas` rather than Feishu's `@_user_1`, and the lossless fallback otherwise.
 */
function turnText(content: TaskTurnRow["content"]): string {
  const fallback = typeof content.fallbackText === "string" ? content.fallbackText : "";
  return messageTextFromBlocks(Array.isArray(content.blocks) ? content.blocks : undefined) ?? fallback;
}

function attachments(content: { resources?: ImContentV1["resources"] }): TaskTurn["message"]["attachments"] {
  return (content.resources ?? []).map((resource, index) => ({
    ordinal: resource.ordinal ?? index,
    kind: resource.kind,
    filename: resource.filename,
    mediaType: resource.mediaType,
    sizeBytes: resource.sizeBytes,
    availability: resource.availability ?? "available",
  }));
}

/**
 * One platform-confirmed outbound message in a Task's scope. The stored record is projected the
 * same way a Turn message is; `contentAvailable`/`timeSource` come from the optional outbound
 * metadata and default honestly for rows captured before it existed.
 */
export function toReply(row: TaskReplyRow): TaskReply {
  const outbound = row.content.outbound;
  return {
    id: row.id,
    provider: row.provider,
    channelId: row.channelId,
    externalMessageId: row.externalMessageId,
    authorKind: row.authorKind,
    authorDisplayName: row.authorDisplayName,
    messageType: typeof outbound?.messageType === "string" ? outbound.messageType : null,
    contentAvailable: typeof outbound?.contentAvailable === "boolean" ? outbound.contentAvailable : true,
    fallbackText: turnText(row.content),
    attachments: attachments(row.content),
    truncated: row.content.truncated === true,
    occurredAt: toIso(row.occurredAt),
    timeSource: outbound?.timeSource === "observed" ? "observed" : "provider",
  };
}

export function toTurn(row: TaskTurnRow): TaskTurn {
  const report = row.turnReport;
  return {
    deliveryId: row.deliveryId,
    attention: row.attention,
    delivery: {
      state: row.deliveryState,
      isRunning: row.isRunning,
      attemptCount: row.attemptCount,
      acceptedAt: row.acceptedAt ? toIso(row.acceptedAt) : null,
      steeredAt: row.steeredAt ? toIso(row.steeredAt) : null,
      expiresAt: toIso(row.expiresAt),
      reason: row.reason,
      lastErrorCode: row.lastErrorCode,
    },
    message: {
      id: row.messageId,
      externalMessageId: row.externalMessageId,
      operation: row.operation,
      authorKind: row.authorKind,
      authorDisplayName: row.authorDisplayName,
      fallbackText: turnText(row.content),
      attachments: attachments(row.content),
      truncated: row.content.truncated === true,
      occurredAt: toIso(row.occurredAt),
    },
    absorbedBy:
      row.deliveryState === "steered" && row.absorbedByDeliveryId && row.absorbedByTurnId
        ? { deliveryId: row.absorbedByDeliveryId, turnId: row.absorbedByTurnId }
        : null,
    report:
      report && row.turnId && row.reportedAt
        ? {
            turnId: row.turnId,
            outcome: report.outcome,
            executionEffects: report.executionEffects,
            finalText: report.finalText ?? null,
            errorReason: report.errorReason ?? null,
            usage: report.usage
              ? {
                  inputTokens: report.usage.inputTokens ?? null,
                  cachedInputTokens: report.usage.cachedInputTokens ?? null,
                  outputTokens: report.usage.outputTokens ?? null,
                }
              : null,
            traceSummary: report.traceSummary,
            outgoingReplies: report.outgoingReplies ?? null,
            reportedAt: toIso(row.reportedAt),
          }
        : null,
  };
}

export function toInternalSession(session: InternalSessionRow) {
  return {
    id: session.id,
    createdBySessionId: session.createdBySessionId,
    createdAt: toIso(session.createdAt),
    endedAt: session.endedAt ? toIso(session.endedAt) : null,
    runtimeModel: session.runtimeModel,
    runtimeReasoningEffort: session.runtimeReasoningEffort,
  };
}

export function toCollaborationMessage(message: CollaborationMessageRow) {
  return {
    id: message.id,
    sourceSessionId: message.sourceSessionId,
    scheduledOrigin: message.scheduledOrigin,
    targetSessionId: message.targetSessionId,
    content: message.content,
    outcome: message.outcome,
    attemptCount: message.attemptCount,
    lastErrorCode: message.lastErrorCode,
    createdAt: toIso(message.createdAt),
    updatedAt: toIso(message.updatedAt),
  };
}
