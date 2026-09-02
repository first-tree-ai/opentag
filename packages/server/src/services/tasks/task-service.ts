import type {
  ImContentV1,
  ListTasksResponse,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  TaskTurn,
  TurnReportRequest,
} from "@opentag/shared";
import { TaskTitleSchema } from "@opentag/shared";
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../../db/client.js";
import { sessionMessages, sessions } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { deriveTaskTitle } from "./task-title.js";

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
  latestRunning: boolean | null;
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
 * ended without a report.
 */
function taskStatus(row: TaskSummaryRow): TaskStatus {
  if (row.endedAt) return "ended";
  if (row.hasRunning) return "running";
  if (row.hasPending) return "queued";
  // Every listed topic has a direct delivery, so a missing latest execution cannot happen.
  if (!row.deliveryState) return "idle";
  if (row.deliveryState === "expired") return "expired";
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
          coalesce(case when d.state = 'steered' then root.reported_at else d.reported_at end, tm.occurred_at)
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
        (array_agg(id order by occurred_at asc, provider_revision_key asc, id asc))[1] as anchor_id,
        (array_agg(external_message_id order by occurred_at asc, provider_revision_key asc, id asc))[1] as anchor_external_id
      from topic_messages
      group by im_binding_id, channel_id, topic_key
    )
  `;
}

function taskNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
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
          greatest(mt.anchor_at, coalesce(t.last_execution_at, mt.anchor_at)) as last_activity_at
        from topics t
        inner join message_topics mt on ${sameTopic("mt", "t")}
        where true
          ${options.kind === "channel" ? sql`and t.topic_key is null` : sql``}
          ${options.kind === "thread" ? sql`and t.topic_key is not null` : sql``}
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
        case when p.topic_key is null then 'channel' else 'thread' end as "sessionKind",
        p.channel_id as "channelId",
        p.topic_key as "threadKey",
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
