import type {
  ImContentV1,
  ListTasksResponse,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  TaskTurn,
  TurnReportRequest,
} from "@opentag/shared";
import { asc, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../../db/client.js";
import { sessionMessages } from "../../db/schema/index.js";
import { workspaceNotFound } from "../workspace-admin-access/workspace-admin-access.js";
import { deriveTaskTitle } from "./task-title.js";

const CursorSchema = z.object({ at: z.string().datetime(), id: z.string().uuid() }).strict();

interface TaskSummaryRow extends Record<string, unknown> {
  id: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  runtimeProvider: "codex" | "claude-code";
  provider: "feishu" | "slack";
  conversationKind: "channel" | "dm" | "group_dm";
  sessionKind: "channel" | "thread";
  channelId: string;
  threadKey: string | null;
  createdAt: Date | string;
  endedAt: Date | string | null;
  lastActivityAt: Date | string;
  fallbackText: string | null;
  titleContent: ImContentV1 | null;
  addressedExternalId: string | null;
  deliveryState: "pending" | "accepted" | "steered" | "terminal_rejected" | "expired" | null;
  reportedAt: Date | string | null;
  turnReport: TurnReportRequest | null;
}

interface TaskTurnRow extends Record<string, unknown> {
  deliveryId: string;
  attention: "direct" | "ambient";
  deliveryState: "pending" | "accepted" | "steered" | "terminal_rejected" | "expired";
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
  content: { fallbackText?: unknown; truncated?: unknown };
  occurredAt: Date | string;
}

interface InternalSessionRow extends Record<string, unknown> {
  id: string;
  createdBySessionId: string;
  runtimeModel: string | null;
  runtimeReasoningEffort: string | null;
  endedAt: Date | string | null;
  createdAt: Date | string;
}

export interface ListTaskOptions {
  agentId?: string;
  cursor?: string;
  kind?: "channel" | "thread";
  limit: number;
}

export interface GetTaskOptions {
  cursor?: string;
  limit: number;
}

/**
 * The timestamp travels into the query as an ISO string with an explicit cast. Binding the `Date`
 * itself is what the driver refuses, and the refusal only surfaces on the second page.
 */
function parseCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { at: new Date(decoded.at), id: decoded.id };
  } catch {
    throw new TaskQueryError("VALIDATION_ERROR", "The pagination cursor is invalid", 400);
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function encodeCursor(at: Date | string, id: string): string {
  return Buffer.from(JSON.stringify({ at: toIso(at), id }), "utf8").toString("base64url");
}

function taskStatus(row: TaskSummaryRow): TaskStatus {
  if (row.endedAt) return "ended";
  if (!row.deliveryState) return "idle";
  if (row.deliveryState === "pending") return "queued";
  if (row.deliveryState === "expired") return "expired";
  if (row.deliveryState === "terminal_rejected") return "failed";
  if (!row.reportedAt || !row.turnReport) return "running";
  return row.turnReport.outcome === "completed" ? "completed" : "failed";
}

function toSummary(row: TaskSummaryRow): TaskSummary {
  const fallbackTitle = row.sessionKind === "thread" ? "Thread task" : "Channel task";
  return {
    id: row.id,
    agent: {
      id: row.agentId,
      name: row.agentName,
      displayName: row.agentDisplayName,
      runtimeProvider: row.runtimeProvider,
    },
    source: {
      provider: row.provider,
      conversationKind: row.conversationKind,
      channelId: row.channelId,
      threadKey: row.threadKey,
    },
    sessionKind: row.sessionKind,
    title: deriveTaskTitle({
      fallbackText: row.fallbackText,
      fallbackTitle,
      provider: row.provider,
      addressedExternalId: row.addressedExternalId,
      blocks: row.titleContent?.blocks ?? null,
    }),
    status: taskStatus(row),
    createdAt: toIso(row.createdAt),
    endedAt: row.endedAt ? toIso(row.endedAt) : null,
    lastActivityAt: toIso(row.lastActivityAt),
  };
}

function toTurn(row: TaskTurnRow): TaskTurn {
  const report = row.turnReport;
  return {
    deliveryId: row.deliveryId,
    attention: row.attention,
    delivery: {
      state: row.deliveryState,
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
      fallbackText: typeof row.content.fallbackText === "string" ? row.content.fallbackText : "",
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
            reportedAt: toIso(row.reportedAt),
          }
        : null,
  };
}

export class TaskQueryError extends Error {
  readonly code: string;
  readonly category = "validation" as const;

  constructor(
    code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "TaskQueryError";
    this.code = code;
  }
}

export class TaskService {
  constructor(readonly database: DatabaseClient) {}

  async list(accountId: string, options: ListTaskOptions): Promise<ListTasksResponse> {
    const cursor = parseCursor(options.cursor);
    const rows = await this.#summaryRows(accountId, {
      ...options,
      cursor,
      limit: options.limit + 1,
    });
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      tasks: page.map(toSummary),
      nextCursor: rows.length > options.limit && last ? encodeCursor(last.lastActivityAt, last.id) : null,
    };
  }

  async get(accountId: string, sessionId: string, options: GetTaskOptions): Promise<TaskDetail> {
    const [row] = await this.#summaryRows(accountId, { sessionId, limit: 1 });
    if (!row) throw workspaceNotFound();
    const cursor = parseCursor(options.cursor);
    const turns = await this.database.execute<TaskTurnRow>(sql`
      select
        d.id as "deliveryId",
        d.attention,
        d.state as "deliveryState",
        d.attempt_count::int as "attemptCount",
        d.accepted_at as "acceptedAt",
        d.steered_at as "steeredAt",
        d.expires_at as "expiresAt",
        d.reason,
        d.last_error_code as "lastErrorCode",
        d.turn_id as "turnId",
        d.turn_report as "turnReport",
        d.reported_at as "reportedAt",
        root.id as "absorbedByDeliveryId",
        root.turn_id as "absorbedByTurnId",
        m.id as "messageId",
        m.external_message_id as "externalMessageId",
        m.operation,
        m.author_kind as "authorKind",
        m.author_display_name as "authorDisplayName",
        m.content,
        m.occurred_at as "occurredAt"
      from im_message_deliveries d
      inner join im_messages m on m.id = d.message_id
      left join im_message_deliveries root on root.id = d.steer_target_delivery_id
      where d.session_id = ${sessionId}::uuid
        ${cursor ? sql`and (m.occurred_at, d.id) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)` : sql``}
      order by m.occurred_at desc, d.id desc
      limit ${options.limit + 1}
    `);
    const page = [...turns].slice(0, options.limit);
    const last = page.at(-1);

    const internalSessions = await this.database.execute<InternalSessionRow>(sql`
      with recursive related as (
        select id, created_by_session_id, runtime_model, runtime_reasoning_effort, ended_at, created_at
        from sessions
        where created_by_session_id = ${sessionId}::uuid
        union all
        select child.id, child.created_by_session_id, child.runtime_model, child.runtime_reasoning_effort,
               child.ended_at, child.created_at
        from sessions child
        inner join related parent on child.created_by_session_id = parent.id
      )
      select
        id,
        created_by_session_id as "createdBySessionId",
        runtime_model as "runtimeModel",
        runtime_reasoning_effort as "runtimeReasoningEffort",
        ended_at as "endedAt",
        created_at as "createdAt"
      from related
      order by created_at asc, id asc
    `);
    const relatedSessionIds = [sessionId, ...[...internalSessions].map(({ id }) => id)];
    const collaborationRows =
      relatedSessionIds.length === 0
        ? []
        : await this.database
            .select()
            .from(sessionMessages)
            .where(
              or(
                inArray(sessionMessages.sourceSessionId, relatedSessionIds),
                inArray(sessionMessages.targetSessionId, relatedSessionIds),
              ),
            )
            .orderBy(asc(sessionMessages.createdAt), asc(sessionMessages.id));

    return {
      task: toSummary(row),
      turns: page.map(toTurn),
      internalSessions: [...internalSessions].map((session) => ({
        id: session.id,
        createdBySessionId: session.createdBySessionId,
        createdAt: toIso(session.createdAt),
        endedAt: session.endedAt ? toIso(session.endedAt) : null,
        runtimeModel: session.runtimeModel,
        runtimeReasoningEffort: session.runtimeReasoningEffort,
      })),
      collaborationMessages: collaborationRows.map((message) => ({
        id: message.id,
        sourceSessionId: message.sourceSessionId,
        targetSessionId: message.targetSessionId,
        content: message.content,
        outcome: message.lastOutcome,
        attemptCount: message.attemptCount,
        lastErrorCode: message.lastErrorCode,
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
      })),
      nextCursor: turns.length > options.limit && last ? encodeCursor(last.occurredAt, last.deliveryId) : null,
    };
  }

  async #summaryRows(
    accountId: string,
    options: {
      agentId?: string;
      cursor?: { at: Date; id: string };
      kind?: "channel" | "thread";
      limit: number;
      sessionId?: string;
    },
  ): Promise<TaskSummaryRow[]> {
    const rows = await this.database.execute<TaskSummaryRow>(sql`
      with latest_delivery as (
        select distinct on (d.session_id)
          d.session_id,
          d.state as delivery_state,
          case when d.state = 'steered' then root.reported_at else d.reported_at end as reported_at,
          case when d.state = 'steered' then root.turn_report else d.turn_report end as turn_report,
          m.content ->> 'fallbackText' as fallback_text,
          m.content as title_content,
          greatest(
            m.occurred_at,
            coalesce(d.accepted_at, m.occurred_at),
            coalesce(d.steered_at, m.occurred_at),
            coalesce(case when d.state = 'steered' then root.reported_at else d.reported_at end, m.occurred_at)
          ) as activity_at
        from im_message_deliveries d
        inner join im_messages m on m.id = d.message_id
        left join im_message_deliveries root on root.id = d.steer_target_delivery_id
        order by d.session_id, activity_at desc, d.id desc
      )
      select
        s.id,
        a.id as "agentId",
        a.name as "agentName",
        a.display_name as "agentDisplayName",
        a.runtime_provider as "runtimeProvider",
        b.provider,
        s.conversation_kind as "conversationKind",
        s.kind as "sessionKind",
        s.channel_id as "channelId",
        s.thread_key as "threadKey",
        s.created_at as "createdAt",
        s.ended_at as "endedAt",
        greatest(s.created_at, coalesce(ld.activity_at, s.created_at)) as "lastActivityAt",
        ld.fallback_text as "fallbackText",
        ld.title_content as "titleContent",
        b.external_bot_id as "addressedExternalId",
        ld.delivery_state as "deliveryState",
        ld.reported_at as "reportedAt",
        ld.turn_report as "turnReport"
      from sessions s
      inner join im_bindings b on b.id = s.im_binding_id
      inner join agents a on a.id = b.agent_id
      left join latest_delivery ld on ld.session_id = s.id
      where a.created_by_user_id = ${accountId}::uuid
        and a.status <> 'deleted'
        and s.kind in ('channel', 'thread')
        ${options.sessionId ? sql`and s.id = ${options.sessionId}::uuid` : sql``}
        ${options.agentId ? sql`and a.id = ${options.agentId}::uuid` : sql``}
        ${options.kind ? sql`and s.kind = ${options.kind}` : sql``}
        ${
          options.cursor
            ? sql`and (greatest(s.created_at, coalesce(ld.activity_at, s.created_at)), s.id) < (${options.cursor.at.toISOString()}::timestamptz, ${options.cursor.id}::uuid)`
            : sql``
        }
      order by "lastActivityAt" desc, s.id desc
      limit ${options.limit}
    `);
    return [...rows];
  }
}
