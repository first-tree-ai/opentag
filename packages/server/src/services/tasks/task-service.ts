import type {
  ImContentV1,
  ListTasksResponse,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  TaskTurn,
  TurnReportRequest,
} from "@opentag/shared";
import { TASK_CANCELLED_DELIVERY_REASON, TaskTitleSchema } from "@opentag/shared";
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../../db/client.js";
import { imMessageDeliveries, sessionMessages, sessions } from "../../db/schema/index.js";
import { DISPATCH_CLAIM_PREFIX } from "../../runtime/im-delivery-claim.js";
import { AuthServiceError } from "../auth/index.js";
import { deriveTaskTitle, messageTextFromBlocks } from "./task-title.js";

const CursorSchema = z.object({ at: z.string().datetime(), id: z.string().uuid() }).strict();

/**
 * A Task is a read-only projection over stored IM messages and their deliveries. Inside a group,
 * channel, or multi-person direct message it is one topic: the root message plus the reply chain
 * around it. A private chat is one Task. A topic is listed only once somebody addressed the Agent
 * directly; overheard-only chatter is not a Task. Nothing here changes delivery, Session
 * materialization, or the runtime.
 *
 * The topic key is `coalesce(thread root, thread_key, external_message_id)`, where "thread root"
 * maps a provider thread id back to the root message it hangs off (Feishu topic groups carry a
 * `thread_id` that differs from the root's message id; Slack's `thread_ts` is the root's own id).
 */
interface TopicScope {
  bindingId: string;
  channelId: string;
  /** Null for a private chat, whose whole conversation is one Task. */
  topicKey: string | null;
}

/** A channel-wide scope, used to classify one message or Session before its topic is known. */
type ChannelScope = Pick<TopicScope, "bindingId" | "channelId">;

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
}

interface TaskTurnRow extends Record<string, unknown> {
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
  content: { fallbackText?: unknown; truncated?: unknown; blocks?: ImContentV1["blocks"] };
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

interface ScopeRow extends Record<string, unknown> {
  bindingId: string;
  channelId: string;
  topicKey: string | null;
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

export interface TaskServiceOptions {
  now?: () => Date;
}

function parseCursor(cursor: string | undefined): { at: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { at: new Date(decoded.at), id: decoded.id };
  } catch {
    throw new TaskQueryError("VALIDATION_ERROR", "The pagination cursor is invalid", 400);
  }
}

/**
 * Keep cursor timestamps explicit when they cross the SQL boundary. The postgres driver rejects
 * binding the decoded Date directly in a tuple comparison, which only affects requests after the
 * first page. An ISO value with a timestamptz cast preserves the cursor's instant and its ordering.
 */
function cursorTimestamp(cursor: { at: Date; id: string }): string {
  return cursor.at.toISOString();
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function encodeCursor(at: Date | string, id: string): string {
  return Buffer.from(JSON.stringify({ at: toIso(at), id }), "utf8").toString("base64url");
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
function taskStatus(row: TaskSummaryRow): TaskStatus {
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

function toSummary(row: TaskSummaryRow): TaskSummary {
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

function toTurn(row: TaskTurnRow): TaskTurn {
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

/** A topic's identity, compared with NULL-safe equality because a private chat's key is NULL. */
function sameTopic(left: string, right: string): SQL {
  return sql`${sql.raw(left)}.im_binding_id = ${sql.raw(right)}.im_binding_id
    and ${sql.raw(left)}.channel_id = ${sql.raw(right)}.channel_id
    and ${sql.raw(left)}.topic_key is not distinct from ${sql.raw(right)}.topic_key`;
}

/**
 * The CTE chain every Task read shares. It scopes bindings to the Account, classifies each stored
 * inbound message and each chat Session into its topic, and keeps only the deliveries that count as
 * executions of that topic: the channel Session's ambient observer copy of a message the thread
 * Session owns is left out, as is a delivery expired because a newer revision superseded it.
 */
function topicCtes(input: { accountId: string; agentId?: string; scope?: TopicScope | ChannelScope; now: Date }): SQL {
  const channelFilter = (alias: string) =>
    input.scope ? sql`and ${sql.raw(alias)}.channel_id = ${input.scope.channelId}` : sql``;
  const topicFilter = (alias: string) =>
    input.scope && "topicKey" in input.scope
      ? sql`and ${sql.raw(alias)}.topic_key is not distinct from ${input.scope.topicKey}`
      : sql``;
  return sql`
    scoped_bindings as (
      select
        b.id as binding_id,
        b.provider,
        b.external_bot_id,
        a.id as agent_id,
        a.name as agent_name,
        a.display_name as agent_display_name,
        a.runtime_provider
      from im_bindings b
      inner join agents a on a.id = b.agent_id
      where a.created_by_user_id = ${input.accountId}::uuid
        and a.status <> 'deleted'
        ${input.agentId ? sql`and a.id = ${input.agentId}::uuid` : sql``}
        ${input.scope ? sql`and b.id = ${input.scope.bindingId}::uuid` : sql``}
    ),
    channels as (
      select distinct on (s.im_binding_id, s.channel_id)
        s.im_binding_id,
        s.channel_id,
        s.conversation_kind
      from sessions s
      inner join scoped_bindings sb on sb.binding_id = s.im_binding_id
      where s.kind in ('channel', 'thread')
        ${channelFilter("s")}
      order by s.im_binding_id, s.channel_id, (s.ended_at is null) desc, (s.kind = 'channel') desc, s.created_at desc, s.id desc
    ),
    thread_roots as (
      select distinct on (m.im_binding_id, m.channel_id, m.thread_key)
        m.im_binding_id,
        m.channel_id,
        m.thread_key,
        m.provider_context ->> 'rootId' as root_external_id
      from im_messages m
      inner join scoped_bindings sb on sb.binding_id = m.im_binding_id
      where m.direction = 'inbound'
        and m.thread_key is not null
        and m.provider_context ->> 'rootId' is not null
        and m.provider_context ->> 'rootId' <> m.thread_key
        ${channelFilter("m")}
      order by m.im_binding_id, m.channel_id, m.thread_key, m.occurred_at asc, m.provider_revision_key asc, m.id asc
    ),
    classified_messages as (
      select
        m.id,
        m.im_binding_id,
        m.channel_id,
        m.external_message_id,
        m.provider_revision_key,
        m.occurred_at,
        m.thread_key,
        case
          when ch.conversation_kind = 'dm' then null
          else coalesce(tr.root_external_id, m.thread_key, m.external_message_id)
        end as topic_key
      from im_messages m
      inner join scoped_bindings sb on sb.binding_id = m.im_binding_id
      left join channels ch on ch.im_binding_id = m.im_binding_id and ch.channel_id = m.channel_id
      left join thread_roots tr
        on tr.im_binding_id = m.im_binding_id
        and tr.channel_id = m.channel_id
        and tr.thread_key = m.thread_key
      where m.direction = 'inbound'
        ${channelFilter("m")}
    ),
    topic_messages as (
      select * from classified_messages cm where true ${topicFilter("cm")}
    ),
    title_sessions as (
      select
        s.id,
        s.im_binding_id,
        s.channel_id,
        s.kind,
        s.conversation_kind,
        s.manual_title,
        s.generated_title,
        s.ended_at,
        s.created_at,
        case
          when s.conversation_kind = 'dm' then null
          else coalesce(tr.root_external_id, s.thread_key)
        end as topic_key
      from sessions s
      inner join scoped_bindings sb on sb.binding_id = s.im_binding_id
      left join thread_roots tr
        on tr.im_binding_id = s.im_binding_id
        and tr.channel_id = s.channel_id
        and tr.thread_key = s.thread_key
      where (s.kind = 'thread' or (s.kind = 'channel' and s.conversation_kind = 'dm'))
        ${channelFilter("s")}
    ),
    topic_sessions as (
      select distinct on (ts.im_binding_id, ts.channel_id, ts.topic_key) ts.*
      from title_sessions ts
      where true ${topicFilter("ts")}
      order by ts.im_binding_id, ts.channel_id, ts.topic_key, (ts.ended_at is null) desc, (ts.kind = 'channel') desc, ts.created_at desc, ts.id desc
    ),
    channel_sessions as (
      select distinct on (s.im_binding_id, s.channel_id)
        s.im_binding_id,
        s.channel_id,
        s.ended_at
      from sessions s
      inner join scoped_bindings sb on sb.binding_id = s.im_binding_id
      where s.kind = 'channel'
        ${channelFilter("s")}
      order by s.im_binding_id, s.channel_id, (s.ended_at is null) desc, s.created_at desc, s.id desc
    ),
    thread_owned as (
      select distinct d.message_id
      from im_message_deliveries d
      inner join topic_messages tm on tm.id = d.message_id
      inner join sessions s on s.id = d.session_id
      where s.kind = 'thread'
    ),
    accepted_windows as (
      select
        d.id,
        lead(d.accepted_at) over (partition by d.session_id order by d.accepted_at, d.id) as next_accepted_at
      from im_message_deliveries d
      inner join sessions ds on ds.id = d.session_id
      inner join scoped_bindings sb on sb.binding_id = ds.im_binding_id
      where d.state = 'accepted'
        ${channelFilter("ds")}
    ),
    executions as (
      select
        d.id,
        d.session_id,
        d.attention,
        d.state,
        d.accepted_at,
        aw.next_accepted_at,
        tm.im_binding_id,
        tm.channel_id,
        tm.topic_key,
        case when d.state = 'steered' then root.reported_at else d.reported_at end as reported_at,
        (
          d.state = 'accepted'
          and d.reported_at is null
          and d.expires_at > ${input.now.toISOString()}::timestamptz
          and ds.ended_at is null
          and aw.next_accepted_at is null
        ) as is_running,
        greatest(
          tm.occurred_at,
          coalesce(d.accepted_at, tm.occurred_at),
          coalesce(d.steered_at, tm.occurred_at),
          coalesce(case when d.state = 'steered' then root.reported_at else d.reported_at end, tm.occurred_at),
          coalesce(
            case when d.state = 'expired' and d.reason = ${TASK_CANCELLED_DELIVERY_REASON} then d.expires_at end,
            tm.occurred_at
          )
        ) as activity_at
      from im_message_deliveries d
      inner join topic_messages tm on tm.id = d.message_id
      inner join sessions ds on ds.id = d.session_id
      left join im_message_deliveries root on root.id = d.steer_target_delivery_id
      left join thread_owned tw on tw.message_id = d.message_id
      left join accepted_windows aw on aw.id = d.id
      where not (d.state = 'expired' and d.reason = 'superseded_revision')
        and not (d.attention = 'ambient' and ds.kind = 'channel' and tw.message_id is not null)
    ),
    topics as (
      select
        im_binding_id,
        channel_id,
        topic_key,
        bool_or(is_running) as has_running,
        bool_or(state = 'pending') as has_pending,
        max(activity_at) as last_execution_at,
        (array_agg(id order by activity_at desc, id desc))[1] as latest_execution_id
      from executions
      group by im_binding_id, channel_id, topic_key
      having bool_or(attention = 'direct')
    ),
    message_topics as (
      select
        im_binding_id,
        channel_id,
        topic_key,
        min(occurred_at) as anchor_at,
        bool_or(thread_key is not null) as has_thread,
        (array_agg(id order by occurred_at asc, provider_revision_key asc, id asc))[1] as anchor_id,
        (array_agg(external_message_id order by occurred_at asc, provider_revision_key asc, id asc))[1] as anchor_external_id
      from topic_messages
      group by im_binding_id, channel_id, topic_key
    )
  `;
}

/**
 * How a withdrawal ended: the topic's remaining pending deliveries were all expired; a Turn is
 * running; no row was still pending under the lock, either because another cancel withdrew the
 * whole queue first (`already_cancelled`) or because the rest was rejected or lapsed (`left_queue`);
 * a worker holds a live claim on a pending row (`in_flight`); a pending row was handed to a Computer
 * that has not answered yet (`awaiting_computer`); or nothing was pending to begin with.
 */
type WithdrawalOutcome =
  | "withdrawn"
  | "running"
  | "already_cancelled"
  | "left_queue"
  | "in_flight"
  | "awaiting_computer"
  | "nothing";

export interface LockedDeliveryRow extends Record<string, unknown> {
  id: string;
  state: string;
  reason: string | null;
  /** A worker's claim lease that has not lapsed: it is dispatching the row right now. */
  claimed: boolean;
  /** A dispatch correlation: the row was handed to a Computer whose answer has not arrived. */
  dispatched: boolean;
  topicRunning: boolean;
}

/**
 * Why the locked rows of a topic that are still `pending` cannot be withdrawn, or undefined when
 * they can. A running Turn refuses first. Rows that left `pending` under the lock — withdrawn by a
 * concurrent cancel, rejected by a worker, or lapsed — are set aside: they are what the queue no
 * longer holds, and the verdict is about what it still holds. Among the remaining pending rows a
 * live claim outranks a bare dispatch correlation, since a worker is acting on that row now; with
 * neither, the remaining rows are withdrawable. When nothing remains pending, the Task is already
 * cancelled if every row was withdrawn with the cancelled reason, and has left the queue otherwise.
 */
export function withdrawalRefusal(
  rows: readonly LockedDeliveryRow[],
): Exclude<WithdrawalOutcome, "withdrawn"> | undefined {
  if (rows.length === 0) return "nothing";
  if (rows.some((row) => row.topicRunning)) return "running";
  const pending = rows.filter((row) => row.state === "pending");
  if (pending.length === 0) {
    const withdrawn = rows.every((row) => row.state === "expired" && row.reason === TASK_CANCELLED_DELIVERY_REASON);
    return withdrawn ? "already_cancelled" : "left_queue";
  }
  if (pending.some((row) => row.claimed)) return "in_flight";
  if (pending.some((row) => row.dispatched)) return "awaiting_computer";
  return undefined;
}

function taskNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}

function taskNotQueued(detail: string): AuthServiceError {
  return new AuthServiceError("TASK_NOT_QUEUED", "deterministic", `${detail}, so there is nothing to cancel`, 409);
}

export class TaskService {
  readonly #now: () => Date;

  constructor(
    readonly database: DatabaseClient,
    options: TaskServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

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

  async get(accountId: string, taskId: string, options: GetTaskOptions): Promise<TaskDetail> {
    const cursor = parseCursor(options.cursor);
    const scope = await this.#scopeOfMessage(accountId, taskId);
    if (!scope) throw taskNotFound();
    const [[row], turns, internalSessions, ownerSessionIds] = await Promise.all([
      this.#summaryRows(accountId, { scope, limit: 1 }),
      this.#turnRows(accountId, scope, cursor, options.limit + 1),
      this.#internalSessionRows(accountId, scope),
      this.#ownerSessionIds(accountId, scope),
    ]);
    if (!row) throw taskNotFound();
    const page = turns.slice(0, options.limit);
    const last = page.at(-1);
    const relatedSessionIds = [...new Set([...ownerSessionIds, ...internalSessions.map(({ id }) => id)])];
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
      internalSessions: internalSessions.map((session) => ({
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

  /**
   * Set or clear the Account-owned manual title of a Task. The id may be the Task's own id (a
   * message of the topic) or one of its Sessions. The title is stored on the Session the Task reads
   * it from: the topic's thread Session, or the channel Session of a private chat. A top-level group
   * request nobody replied to has no such Session and cannot be renamed yet.
   */
  async updateTitle(accountId: string, id: string, title: string | null): Promise<TaskSummary> {
    const normalizedTitle = title === null ? null : TaskTitleSchema.parse(title);
    const scope = (await this.#scopeOfSession(accountId, id)) ?? (await this.#scopeOfMessage(accountId, id));
    if (!scope) throw taskNotFound();
    const titleSessionId = await this.#titleSessionId(accountId, scope);
    if (!titleSessionId) throw taskNotFound();
    const [updated] = await this.database
      .update(sessions)
      .set({ manualTitle: normalizedTitle })
      .where(
        and(
          eq(sessions.id, titleSessionId),
          sql`exists (
            select 1
            from im_bindings b
            inner join agents a on a.id = b.agent_id
            where b.id = ${sessions.imBindingId}
              and a.created_by_user_id = ${accountId}::uuid
              and a.status <> 'deleted'
          )`,
        ),
      )
      .returning({ id: sessions.id });
    if (!updated) throw taskNotFound();
    const [row] = await this.#summaryRows(accountId, { scope, limit: 1 });
    if (!row) throw taskNotFound();
    return toSummary(row);
  }

  /**
   * Withdraw a queued Task before any of it runs. The id may be the Task's own id or one of its
   * Sessions. The withdrawal is all or nothing: every pending delivery of the topic is expired
   * with the cancelled reason, which keeps it out of the delivery worker's reach for good (the
   * worker claims only `pending` rows, and recovers expired ones only while they carry a dispatch
   * correlation, which a never-dispatched row does not have), or none of them is touched.
   *
   * Only a `queued` Task cancels. A Task that has started, or that already finished, is refused
   * with 409 so the caller re-reads its state instead; a Task that is already `cancelled` is a
   * no-op success, so a repeated cancel is harmless — whether it repeats after the first one or
   * races it under the lock. A delivery a worker is dispatching right now — one carrying a live
   * claim lease or a dispatch correlation — cannot be withdrawn, because the Runtime may already
   * be running it; while the topic has one, nothing of it is withdrawn and the answer is a 409
   * that says which, so a success always leaves the Task `cancelled` rather than partly queued.
   * A row that a worker rejected, or that lapsed, while the cancel waited for the lock is not
   * queued any more and is left as the worker left it; the rows still pending beside it are
   * withdrawn as usual. When nothing is pending any more, the refusal names the status the Task
   * now reads — unless that status is `cancelled`, which is the documented no-op success.
   */
  async cancel(accountId: string, id: string): Promise<TaskSummary> {
    const scope = (await this.#scopeOfMessage(accountId, id)) ?? (await this.#scopeOfSession(accountId, id));
    if (!scope) throw taskNotFound();
    const [before] = await this.#summaryRows(accountId, { scope, limit: 1 });
    if (!before) throw taskNotFound();
    const status = taskStatus(before);
    if (status === "cancelled") return toSummary(before);
    if (status !== "queued") throw taskNotQueued(`The Task is ${status}, not queued`);
    const outcome = await this.#withdrawQueuedDeliveries(accountId, scope);
    if (outcome === "running") throw taskNotQueued("The Task is running, not queued");
    if (outcome === "in_flight") throw taskNotQueued("The Task's queued message is already being delivered");
    if (outcome === "awaiting_computer")
      throw taskNotQueued("The Task's queued message was handed to a Computer that has not reported back yet");
    const [after] = await this.#summaryRows(accountId, { scope, limit: 1 });
    if (!after) throw taskNotFound();
    // Nothing left to withdraw: another cancel got there first, or the queue drained some other way.
    // A message that arrived after the locked read can leave the Task queued again; say so rather
    // than contradicting the status the caller is about to re-read.
    const settled = taskStatus(after);
    if (outcome !== "withdrawn" && settled !== "cancelled")
      throw taskNotQueued(
        settled === "queued"
          ? "The Task's queue changed while it was being cancelled"
          : `The Task is ${settled}, not queued`,
      );
    return toSummary(after);
  }

  /**
   * Store one best-effort generated title without ever replacing a manual override. A false
   * result means the task disappeared or a manual title won the race.
   */
  async saveGeneratedTitle(sessionId: string, title: string): Promise<boolean> {
    const normalizedTitle = TaskTitleSchema.parse(title);
    const [updated] = await this.database
      .update(sessions)
      .set({ generatedTitle: normalizedTitle })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.manualTitle)))
      .returning({ id: sessions.id });
    return updated !== undefined;
  }

  /**
   * The topic a stored message belongs to, or undefined when it is outside the Account. The
   * channel is read by primary key first so the classification only touches that channel; the
   * Account check happens inside the CTE chain, which is empty for a foreign binding.
   */
  async #scopeOfMessage(accountId: string, messageId: string): Promise<TopicScope | undefined> {
    const located = await this.database.execute<ChannelScope & Record<string, unknown>>(sql`
      select m.im_binding_id as "bindingId", m.channel_id as "channelId"
      from im_messages m
      where m.id = ${messageId}::uuid
    `);
    const [channel] = [...located];
    if (!channel) return undefined;
    const rows = await this.database.execute<ScopeRow>(sql`
      with ${topicCtes({ accountId, scope: { bindingId: channel.bindingId, channelId: channel.channelId }, now: this.#now() })}
      select
        cm.im_binding_id as "bindingId",
        cm.channel_id as "channelId",
        cm.topic_key as "topicKey"
      from classified_messages cm
      where cm.id = ${messageId}::uuid
      limit 1
    `);
    const [row] = [...rows];
    return row ? { bindingId: row.bindingId, channelId: row.channelId, topicKey: row.topicKey } : undefined;
  }

  /** The topic a Session's title applies to; a group's channel Session titles nothing. */
  async #scopeOfSession(accountId: string, sessionId: string): Promise<TopicScope | undefined> {
    const located = await this.database.execute<ChannelScope & Record<string, unknown>>(sql`
      select s.im_binding_id as "bindingId", s.channel_id as "channelId"
      from sessions s
      where s.id = ${sessionId}::uuid
    `);
    const [channel] = [...located];
    if (!channel) return undefined;
    const rows = await this.database.execute<ScopeRow>(sql`
      with ${topicCtes({ accountId, scope: { bindingId: channel.bindingId, channelId: channel.channelId }, now: this.#now() })}
      select
        ts.im_binding_id as "bindingId",
        ts.channel_id as "channelId",
        ts.topic_key as "topicKey"
      from title_sessions ts
      where ts.id = ${sessionId}::uuid
      limit 1
    `);
    const [row] = [...rows];
    return row ? { bindingId: row.bindingId, channelId: row.channelId, topicKey: row.topicKey } : undefined;
  }

  /** Every Session whose conversation belongs to the topic: its thread Sessions, or all of a private chat's. */
  async #ownerSessionIds(accountId: string, scope: TopicScope): Promise<string[]> {
    const rows = await this.database.execute<{ id: string } & Record<string, unknown>>(sql`
      with ${topicCtes({ accountId, scope, now: this.#now() })}
      select ts.id from title_sessions ts where ts.topic_key is not distinct from ${scope.topicKey}
    `);
    return [...rows].map(({ id }) => id);
  }

  /**
   * Expire every pending delivery of the topic, or none. The transaction first locks the
   * topic's pending rows: the worker's claim steps around locked rows (`for update skip
   * locked`), and its acceptance of a row it already claimed waits behind the lock, so what the
   * locked read shows is what the update acts on. A lock that waited behind a worker's write
   * returns the row as the worker left it: a claim taken in the meantime refuses the whole
   * withdrawal, while a row that is no longer pending is set aside and only the rows still
   * pending are withdrawn — an already withdrawn or rejected row is never stamped again. A lock
   * that waited behind another cancel sees every row withdrawn with the cancelled reason, and
   * reports the Task as already cancelled rather than refusing. A claim whose lease lapsed belongs
   * to a worker that is gone, and is withdrawn like an unclaimed row — exactly as any worker may
   * take such a row again. A topic with a running Turn is never withdrawn either, however the
   * summary read before the transaction looked.
   *
   * The withdrawn row expires at the cancel instant rather than at its original deadline: that
   * is when it left the queue, and the instant the topic's status derivation orders it by, so the
   * cancel outranks every Turn that finished before it. Retention counts from the same column,
   * so a withdrawn row is kept for the retention window after the cancel, as a lapsed one is kept
   * after its deadline.
   */
  async #withdrawQueuedDeliveries(accountId: string, scope: TopicScope): Promise<WithdrawalOutcome> {
    const now = this.#now();
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.execute<LockedDeliveryRow>(sql`
        with ${topicCtes({ accountId, scope, now })}
        select
          d.id,
          d.state,
          d.reason,
          (
            d.last_error_code like ${`${DISPATCH_CLAIM_PREFIX}%`}
            and d.next_attempt_at > ${now.toISOString()}::timestamptz
          ) as "claimed",
          (d.dispatch_request_id is not null) as "dispatched",
          exists (select 1 from executions e where e.is_running) as "topicRunning"
        from im_message_deliveries d
        where d.id in (select e.id from executions e where e.state = 'pending')
        for update of d
      `);
      const rows = [...locked];
      const refusal = withdrawalRefusal(rows);
      if (refusal) return refusal;
      const pending = rows.filter((row) => row.state === "pending");
      const withdrawn = await transaction
        .update(imMessageDeliveries)
        .set({ state: "expired", reason: TASK_CANCELLED_DELIVERY_REASON, expiresAt: now })
        .where(
          inArray(
            imMessageDeliveries.id,
            pending.map((row) => row.id),
          ),
        )
        .returning({ id: imMessageDeliveries.id });
      if (withdrawn.length !== pending.length) throw new Error("A locked queued delivery was not withdrawn");
      return "withdrawn";
    });
  }

  /** The Session a topic reads its manual and generated title from, if it has one. */
  async #titleSessionId(accountId: string, scope: TopicScope): Promise<string | undefined> {
    const rows = await this.database.execute<{ id: string } & Record<string, unknown>>(sql`
      with ${topicCtes({ accountId, scope, now: this.#now() })}
      select ts.id from topic_sessions ts limit 1
    `);
    return [...rows][0]?.id;
  }

  async #turnRows(
    accountId: string,
    scope: TopicScope,
    cursor: { at: Date; id: string } | undefined,
    limit: number,
  ): Promise<TaskTurnRow[]> {
    const rows = await this.database.execute<TaskTurnRow>(sql`
      with ${topicCtes({ accountId, scope, now: this.#now() })}
      select
        e.id as "deliveryId",
        d.attention,
        d.state as "deliveryState",
        e.is_running as "isRunning",
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
      from executions e
      inner join im_message_deliveries d on d.id = e.id
      inner join im_messages m on m.id = d.message_id
      left join im_message_deliveries root on root.id = d.steer_target_delivery_id
      where true
        ${cursor ? sql`and (m.occurred_at, d.id) < (${cursorTimestamp(cursor)}::timestamptz, ${cursor.id}::uuid)` : sql``}
      order by m.occurred_at desc, d.id desc
      limit ${limit}
    `);
    return [...rows];
  }

  /**
   * Internal Sessions of a topic: those that inherited the topic's scope from a thread or private
   * chat Session, plus those a group's channel Session spawned while it was running one of the
   * topic's Turns, with their descendants. A channel Session runs one Turn at a time, so the
   * creation instant falls inside exactly one Turn's window.
   */
  async #internalSessionRows(accountId: string, scope: TopicScope): Promise<InternalSessionRow[]> {
    const rows = await this.database.execute<InternalSessionRow>(sql`
      with recursive ${topicCtes({ accountId, scope, now: this.#now() })},
      inherited as (
        select s.id
        from sessions s
        left join thread_roots tr
          on tr.im_binding_id = s.im_binding_id
          and tr.channel_id = s.channel_id
          and tr.thread_key = s.thread_key
        where s.kind = 'internal'
          and s.im_binding_id = ${scope.bindingId}::uuid
          and s.channel_id = ${scope.channelId}
          and ${
            scope.topicKey === null
              ? sql`s.conversation_kind = 'dm'`
              : sql`coalesce(tr.root_external_id, s.thread_key) = ${scope.topicKey}`
          }
      ),
      spawned as (
        select s.id
        from sessions s
        inner join executions e on e.session_id = s.created_by_session_id
        inner join sessions creator on creator.id = e.session_id and creator.kind = 'channel'
        where s.kind = 'internal'
          and e.accepted_at is not null
          and s.created_at >= e.accepted_at
          and (e.reported_at is null or s.created_at <= e.reported_at)
          and (e.next_accepted_at is null or s.created_at < e.next_accepted_at)
        union all
        select child.id
        from sessions child
        inner join spawned parent on child.created_by_session_id = parent.id
      )
      select
        s.id,
        s.created_by_session_id as "createdBySessionId",
        s.runtime_model as "runtimeModel",
        s.runtime_reasoning_effort as "runtimeReasoningEffort",
        s.ended_at as "endedAt",
        s.created_at as "createdAt"
      from sessions s
      where s.id in (select id from inherited union select id from spawned)
      order by s.created_at asc, s.id asc
    `);
    return [...rows];
  }

  async #summaryRows(
    accountId: string,
    options: {
      agentId?: string;
      cursor?: { at: Date; id: string };
      kind?: "channel" | "thread";
      limit: number;
      scope?: TopicScope;
    },
  ): Promise<TaskSummaryRow[]> {
    const rows = await this.database.execute<TaskSummaryRow>(sql`
      with ${topicCtes({ accountId, agentId: options.agentId, scope: options.scope, now: this.#now() })},
      page as (
        select
          t.im_binding_id,
          t.channel_id,
          t.topic_key,
          t.has_running,
          t.has_pending,
          t.latest_execution_id,
          mt.anchor_id,
          mt.anchor_at,
          mt.anchor_external_id,
          (t.topic_key is not null and mt.has_thread) as is_thread,
          greatest(mt.anchor_at, coalesce(t.last_execution_at, mt.anchor_at)) as last_activity_at
        from topics t
        inner join message_topics mt on ${sameTopic("mt", "t")}
        where true
          ${options.kind === "channel" ? sql`and not (t.topic_key is not null and mt.has_thread)` : sql``}
          ${options.kind === "thread" ? sql`and (t.topic_key is not null and mt.has_thread)` : sql``}
          ${
            options.cursor
              ? sql`and (greatest(mt.anchor_at, coalesce(t.last_execution_at, mt.anchor_at)), mt.anchor_id) < (${cursorTimestamp(options.cursor)}::timestamptz, ${options.cursor.id}::uuid)`
              : sql``
          }
        order by last_activity_at desc, mt.anchor_id desc
        limit ${options.limit}
      )
      select
        p.anchor_id as id,
        sb.agent_id as "agentId",
        sb.agent_name as "agentName",
        sb.agent_display_name as "agentDisplayName",
        sb.runtime_provider as "runtimeProvider",
        sb.provider,
        coalesce(ch.conversation_kind, 'channel') as "conversationKind",
        case when p.is_thread then 'thread' else 'channel' end as "sessionKind",
        p.channel_id as "channelId",
        case when p.is_thread then p.topic_key else null end as "threadKey",
        p.anchor_at as "createdAt",
        case when ts.id is not null then ts.ended_at else cs.ended_at end as "endedAt",
        ts.manual_title as "manualTitle",
        ts.generated_title as "generatedTitle",
        p.last_activity_at as "lastActivityAt",
        title.content ->> 'fallbackText' as "fallbackText",
        title.content as "titleContent",
        sb.external_bot_id as "addressedExternalId",
        p.has_running as "hasRunning",
        p.has_pending as "hasPending",
        le.state as "deliveryState",
        le_delivery.reason as "deliveryReason",
        le.is_running as "latestRunning",
        le.reported_at as "reportedAt",
        case when le.state = 'steered' then le_root.turn_report else le_delivery.turn_report end as "turnReport"
      from page p
      inner join scoped_bindings sb on sb.binding_id = p.im_binding_id
      left join channels ch on ch.im_binding_id = p.im_binding_id and ch.channel_id = p.channel_id
      left join channel_sessions cs on cs.im_binding_id = p.im_binding_id and cs.channel_id = p.channel_id
      left join topic_sessions ts on ${sameTopic("ts", "p")}
      left join executions le on le.id = p.latest_execution_id
      left join im_message_deliveries le_delivery on le_delivery.id = p.latest_execution_id
      left join im_message_deliveries le_root on le_root.id = le_delivery.steer_target_delivery_id
      left join lateral (
        select m.content
        from im_messages m
        where m.im_binding_id = p.im_binding_id
          and m.channel_id = p.channel_id
          and m.external_message_id = p.anchor_external_id
          and m.direction = 'inbound'
        order by m.occurred_at desc, m.provider_revision_key desc, m.id desc
        limit 1
      ) title on true
      order by p.last_activity_at desc, p.anchor_id desc
    `);
    return [...rows];
  }
}
