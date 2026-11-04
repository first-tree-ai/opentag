import { TASK_CANCELLED_DELIVERY_REASON } from "@opentag/shared";
import { type SQL, sql } from "drizzle-orm";

/**
 * The Task filter shared by every Task read.
 *
 * A Task is one chat Session. A group's channel Session is one Task and each thread Session is its
 * own Task; a private chat (`dm` conversation) is one Task across all of its Sessions, identified by
 * the Session it reads its title and status from — the live one first, the channel Session before a
 * thread. Every chat Session carries the id of the Task it belongs to as `task_id`, which for a group
 * Session is its own id.
 *
 * `scoped_bindings` is the authorization boundary: it keeps only the bindings of Agents the Account
 * owns and has not deleted, so a foreign binding yields an empty CTE chain rather than a row.
 *
 * `executions` is one delivery to a Task's Session that counts as an execution: the channel
 * Session's ambient observer copy of a message a thread Session owns is left out, as is a delivery a
 * newer revision of its message superseded. A Turn counts as running only while it is the Session's
 * latest acceptance: the successor lookup runs for the few live deliveries that satisfy the cheap
 * predicates first, never for the whole history. Its `activity_at` is the latest instant the
 * delivery contributed — the message itself, an acceptance or a steering, a report, or a
 * withdrawal — and orders the Task's latest execution, so the status read is by precedence and not
 * by arrival.
 */
export interface TaskScope {
  bindingId: string;
  channelId: string;
  /** The Task's id: the Session it reads its title and status from. */
  taskId: string;
}

/** A channel-wide scope, used to resolve one Session or message before its Task is known. */
export type ChannelScope = Pick<TaskScope, "bindingId" | "channelId">;

export interface TaskQueryInput {
  accountId: string;
  agentId?: string;
  scope?: TaskScope | ChannelScope;
  now: Date;
  /** The rollup CTE (`tasks`) is only needed by the list page and the summary. */
  rollups?: boolean;
}

/**
 * The external id of a group thread Session's root message: the inbound thread-root mapping of its
 * thread key first (a Feishu thread key is not a message id), and the thread key itself otherwise
 * (Slack's `thread_ts` is the root message's own id).
 */
export function threadRootExternalId(sessionAlias: string): SQL {
  const s = sql.raw(sessionAlias);
  return sql`coalesce(
    (
      select m.provider_context ->> 'rootId'
      from im_messages m
      where m.im_binding_id = ${s}.im_binding_id
        and m.channel_id = ${s}.channel_id
        and m.thread_key = ${s}.thread_key
        and m.direction = 'inbound'
        and m.provider_context ->> 'rootId' is not null
        and m.provider_context ->> 'rootId' <> m.thread_key
      order by m.occurred_at asc, m.provider_revision_key asc, m.id asc
      limit 1
    ),
    ${s}.thread_key
  )`;
}

/**
 * The chat Session that owns a stored message which no execution names, such as a captured outbound
 * reply: in a private chat the Task's own Session; in a group the newest thread Session of the
 * message's thread that existed when the message was stored, otherwise the newest channel Session
 * that existed then. A reply the channel Session sent into a thread before anybody answered there
 * therefore stays with the channel Session, and a quote reply that carries no thread Session's key
 * stays in the channel. The outer query must expose `task_sessions`.
 */
export function messageOwnerTaskId(messageAlias: string): SQL {
  const m = sql.raw(messageAlias);
  return sql`(
    select ts.task_id
    from task_sessions ts
    where ts.im_binding_id = ${m}.im_binding_id
      and ts.channel_id = ${m}.channel_id
      and (ts.kind = 'channel' or ts.conversation_kind = 'dm' or ts.thread_key = ${m}.thread_key)
    order by
      (ts.conversation_kind = 'dm') desc,
      (ts.kind = 'thread' and ts.created_at <= ${m}.received_at) desc,
      (ts.kind = 'channel' and ts.created_at <= ${m}.received_at) desc,
      (ts.kind = 'channel') desc,
      ts.created_at desc,
      ts.id desc
    limit 1
  )`;
}

/**
 * The CTE chain every Task read shares. Callers name the parts they select from; PostgreSQL does not
 * evaluate an unreferenced CTE, so the chain can stay whole without costing a read that does not use
 * a part of it.
 */
export function taskCtes(input: TaskQueryInput): SQL {
  const channelFilter = (alias: string) =>
    input.scope
      ? sql`and ${sql.raw(alias)}.im_binding_id = ${input.scope.bindingId}::uuid and ${sql.raw(alias)}.channel_id = ${input.scope.channelId}`
      : sql``;
  const rollups = input.rollups
    ? sql`,
      tasks as (
        select distinct on (task_id)
          task_id,
          has_running,
          has_pending,
          last_execution_at,
          id as latest_execution_id,
          state as latest_state,
          reason as latest_reason,
          is_running as latest_running,
          reported_at as latest_reported_at,
          turn_report as latest_turn_report
        from (
          select
            e.*,
            bool_or(e.is_running) over w as has_running,
            bool_or(e.state = 'pending') over w as has_pending,
            bool_or(e.attention = 'direct') over w as has_direct,
            max(e.activity_at) over w as last_execution_at
          from executions e
          window w as (partition by e.task_id)
        ) ranked
        where case
          when has_direct then true
          -- A thread Session nobody addressed directly is still a Task when its root message was
          -- addressed to the Agent: the conversation continues the request that started it.
          else exists (
            select 1
            from task_sessions ts
            inner join im_messages rm
              on rm.im_binding_id = ts.im_binding_id
              and rm.channel_id = ts.channel_id
              and rm.external_message_id = ${threadRootExternalId("ts")}
              and rm.direction = 'inbound'
            inner join im_message_deliveries rd on rd.message_id = rm.id and rd.attention = 'direct'
            where ts.id = ranked.task_id
              and ts.kind = 'thread'
              and ts.conversation_kind <> 'dm'
          )
        end
        order by task_id, activity_at desc, id desc
      )
    `
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
        b.bot_avatar_url as agent_avatar_source_url,
        a.runtime_provider
      from im_bindings b
      inner join agents a on a.id = b.agent_id
      where a.created_by_user_id = ${input.accountId}::uuid
        and a.status <> 'deleted'
        ${input.agentId ? sql`and a.id = ${input.agentId}::uuid` : sql``}
        ${input.scope ? sql`and b.id = ${input.scope.bindingId}::uuid` : sql``}
    ),
    task_sessions as (
      select
        s.id,
        s.im_binding_id,
        s.channel_id,
        s.kind,
        s.conversation_kind,
        s.thread_key,
        s.manual_title,
        s.generated_title,
        s.ended_at,
        s.created_at,
        coalesce(dm.id, s.id) as task_id
      from sessions s
      inner join scoped_bindings sb on sb.binding_id = s.im_binding_id
      left join lateral (
        select r.id
        from sessions r
        where s.conversation_kind = 'dm'
          and r.im_binding_id = s.im_binding_id
          and r.channel_id = s.channel_id
          and r.kind in ('channel', 'thread')
        order by (r.ended_at is null) desc, (r.kind = 'channel') desc, r.created_at desc, r.id desc
        limit 1
      ) dm on true
      where s.kind in ('channel', 'thread')
        ${channelFilter("s")}
    ),
    scoped_sessions as (
      select * from task_sessions ts
      where true ${input.scope && "taskId" in input.scope ? sql`and ts.task_id = ${input.scope.taskId}::uuid` : sql``}
    ),
    executions as (
      select
        d.id,
        d.session_id,
        d.message_id,
        d.attention,
        d.state,
        d.accepted_at,
        d.steered_at,
        d.expires_at,
        d.attempt_count,
        d.turn_id,
        d.reason,
        d.last_error_code,
        ss.task_id,
        m.occurred_at,
        root.id as steer_target_delivery_id,
        root.turn_id as steer_target_turn_id,
        case when d.state = 'steered' then root.reported_at else d.reported_at end as reported_at,
        case when d.state = 'steered' then root.turn_report else d.turn_report end as turn_report,
        case
          when d.state = 'accepted'
            and d.reported_at is null
            and d.expires_at > ${input.now.toISOString()}::timestamptz
            and ss.ended_at is null
          then not exists (
            select 1
            from im_message_deliveries later
            where later.session_id = d.session_id
              and later.state = 'accepted'
              and (later.accepted_at, later.id) > (d.accepted_at, d.id)
          )
          else false
        end as is_running,
        greatest(
          m.occurred_at,
          coalesce(d.accepted_at, m.occurred_at),
          coalesce(d.steered_at, m.occurred_at),
          coalesce(case when d.state = 'steered' then root.reported_at else d.reported_at end, m.occurred_at),
          coalesce(
            case when d.state = 'expired' and d.reason = ${TASK_CANCELLED_DELIVERY_REASON} then d.expires_at end,
            m.occurred_at
          )
        ) as activity_at
      from scoped_sessions ss
      inner join im_message_deliveries d on d.session_id = ss.id
      inner join im_messages m on m.id = d.message_id
      left join im_message_deliveries root on root.id = d.steer_target_delivery_id
      where not (d.state = 'expired' and d.reason = 'superseded_revision')
        and not (
          d.attention = 'ambient'
          and ss.kind = 'channel'
          and exists (
            select 1
            from im_message_deliveries owner
            inner join sessions os on os.id = owner.session_id
            where owner.message_id = d.message_id
              and os.kind = 'thread'
          )
        )
    )
    ${rollups}
  `;
}

/**
 * The list's page CTE: the rollups decide which Tasks qualify, the keyset order cuts the page, and
 * only the page's rows go on to resolve their title and source facts.
 */
export function taskPageCtes(input: {
  kind?: "channel" | "thread";
  cursor?: { at: string; id: string };
  limit: number;
}): SQL {
  const kindFilter = sql`
    ${input.kind === "channel" ? sql`and (ts.kind = 'channel' or ts.conversation_kind = 'dm')` : sql``}
    ${input.kind === "thread" ? sql`and (ts.kind = 'thread' and ts.conversation_kind <> 'dm')` : sql``}
  `;
  return sql`
    task_page as (
      select
        t.*,
        ts.im_binding_id,
        ts.channel_id,
        ts.created_at as task_created_at,
        greatest(ts.created_at, coalesce(t.last_execution_at, ts.created_at)) as last_activity_at
      from tasks t
      inner join task_sessions ts on ts.id = t.task_id
      where true ${kindFilter}
    ),
    page as (
      select *
      from task_page
      where true
        ${input.cursor ? sql`and (last_activity_at, task_id) < (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)` : sql``}
      order by last_activity_at desc, task_id desc
      limit ${input.limit}
    )
  `;
}

/**
 * The Sessions whose work belongs to one Task: the Task's own chat Sessions and every internal
 * Session they created, with their descendants. Each identity is produced once, so a message that
 * names two related Sessions is read once. The walk follows the sessions creator index from the
 * Task's Sessions down, so it reads only the Task's own tree.
 */
export function relatedSessionCtes(): SQL {
  return sql`
    internal_related as (
      select child.id, child.created_at
      from sessions child
      inner join scoped_sessions ss on child.created_by_session_id = ss.id
      where child.kind = 'internal'
      union
      select child.id, child.created_at
      from sessions child
      inner join internal_related parent on child.created_by_session_id = parent.id
      where child.kind = 'internal'
    ),
    related_sessions as (
      select id from internal_related
      union
      select id from scoped_sessions
    )
  `;
}
