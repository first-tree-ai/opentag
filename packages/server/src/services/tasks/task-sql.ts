import { TASK_CANCELLED_DELIVERY_REASON } from "@opentag/shared";
import { type SQL, sql } from "drizzle-orm";

/**
 * The topic filter shared by every Task read.
 *
 * `scoped_bindings` is the authorization boundary: it keeps only the bindings of Agents the Account
 * owns and has not deleted, so a foreign binding yields an empty CTE chain rather than a row. The
 * rest classifies each stored inbound message and each chat Session into a topic:
 * `coalesce(thread root, thread_key, external_message_id)` inside a group, channel, or multi-person
 * direct message, and NULL for a private chat, whose whole conversation is one Task.
 *
 * `executions` is one topic delivery that counts as an execution: the channel Session's ambient
 * observer copy of a message a thread Session owns is left out, as is a delivery a newer revision of
 * its message superseded. A Turn counts as running only while it is the Session's latest
 * acceptance: the successor lookup runs for the few live deliveries that satisfy the cheap
 * predicates first, never for the whole history. Its `activity_at` is the latest instant the
 * delivery contributed — the message itself, an acceptance or a steering, a report, or a
 * withdrawal — and orders the topic's latest execution, so the status read is by precedence and
 * not by arrival.
 *
 * Every CTE here is a plain relational expression: the joins that pair rollups with their page carry
 * equality predicates on the topic identity (see `topicPageCtes`), never a NULL-safe residual over
 * whole tables. A private chat's NULL topic key is matched in a separate branch instead.
 */
export interface TopicScope {
  bindingId: string;
  channelId: string;
  /** Null for a private chat, whose whole conversation is one Task. */
  topicKey: string | null;
}

/** A channel-wide scope, used to classify one message or Session before its topic is known. */
export type ChannelScope = Pick<TopicScope, "bindingId" | "channelId">;

export interface TopicQueryInput {
  accountId: string;
  agentId?: string;
  scope?: TopicScope | ChannelScope;
  now: Date;
  /** Rollup CTEs (`topics`, `message_topics`) are only needed by the list page. */
  rollups?: boolean;
}

/**
 * Stored private-conversation context: a Feishu p2p chat or a Slack IM is one Task with no topic
 * key, so its whole channel is in scope. Any other or missing context stays a group topic and must
 * never widen to the whole channel.
 */
export function privateConversation(alias: string): SQL {
  return sql`(${sql.raw(alias)}.provider_context ->> 'chatType' = 'p2p'
    or ${sql.raw(alias)}.provider_context ->> 'channelType' = 'im')`;
}

/**
 * The topic key of one stored message inside a group channel. The inbound thread-root mapping comes
 * first, exactly as Task detail and list classify inbound messages; then comes a threaded message's
 * own captured native root, which is what lets a first outbound reply land in the topic before any
 * inbound thread mapping exists; then the thread key and the message itself. A message with no
 * thread context is a root of its own, so its root field never re-classifies it.
 */
export function topicKeyExpression(messageAlias: string, rootAlias: string): SQL {
  return sql`coalesce(
    ${sql.raw(rootAlias)}.root_external_id,
    case when ${sql.raw(messageAlias)}.thread_key is not null
      then ${sql.raw(messageAlias)}.provider_context ->> 'rootId' end,
    ${sql.raw(messageAlias)}.thread_key,
    ${sql.raw(messageAlias)}.external_message_id
  )`;
}

/** `a.topicKey = b.topicKey`, or both NULL, for two relations already narrowed to one channel. */
export function sameTopic(left: string, right: string): SQL {
  return sql`(${sql.raw(left)}.topic_key = ${sql.raw(right)}.topic_key
    or (${sql.raw(left)}.topic_key is null and ${sql.raw(right)}.topic_key is null))`;
}

/**
 * The CTE chain every Task read shares. Callers name the parts they select from; PostgreSQL does not
 * evaluate an unreferenced CTE, so the chain can stay whole without costing a read that does not use
 * a part of it.
 */
export function topicCtes(input: TopicQueryInput): SQL {
  const channelFilter = (alias: string) =>
    input.scope ? sql`and ${sql.raw(alias)}.channel_id = ${input.scope.channelId}` : sql``;
  const topicFilter = (alias: string) =>
    input.scope && "topicKey" in input.scope
      ? sql`and ${sql.raw(alias)}.topic_key is not distinct from ${input.scope.topicKey}`
      : sql``;
  const rollups = input.rollups
    ? sql`,
      topics as (
        select distinct on (im_binding_id, channel_id, topic_key)
          im_binding_id,
          channel_id,
          topic_key,
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
          window w as (partition by e.im_binding_id, e.channel_id, e.topic_key)
        ) ranked
        where has_direct
        order by im_binding_id, channel_id, topic_key, activity_at desc, id desc
      ),
      message_topics as (
        select distinct on (im_binding_id, channel_id, topic_key)
          im_binding_id,
          channel_id,
          topic_key,
          anchor_at,
          has_thread,
          id as anchor_id,
          external_message_id as anchor_external_id
        from (
          select
            tm.*,
            min(tm.occurred_at) over w as anchor_at,
            bool_or(tm.thread_key is not null) over w as has_thread
          from topic_messages tm
          window w as (partition by tm.im_binding_id, tm.channel_id, tm.topic_key)
        ) ranked
        order by im_binding_id, channel_id, topic_key, occurred_at asc, provider_revision_key asc, id asc
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
        tm.im_binding_id,
        tm.channel_id,
        tm.topic_key,
        root.id as steer_target_delivery_id,
        root.turn_id as steer_target_turn_id,
        case when d.state = 'steered' then root.reported_at else d.reported_at end as reported_at,
        case when d.state = 'steered' then root.turn_report else d.turn_report end as turn_report,
        case
          when d.state = 'accepted'
            and d.reported_at is null
            and d.expires_at > ${input.now.toISOString()}::timestamptz
            and ds.ended_at is null
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
      where not (d.state = 'expired' and d.reason = 'superseded_revision')
        and not (d.attention = 'ambient' and ds.kind = 'channel' and tw.message_id is not null)
    )
    ${rollups}
  `;
}

/**
 * The list's page CTE. Two disjoint branches carry the topic identity: a concrete topic key joins on
 * all three identity columns, while a private chat's NULL key joins on the binding and channel alone
 * with both keys known NULL. The second branch is what turns the former NULL-safe residual over the
 * whole topic set into a hash join over one row per private chat.
 */
export function topicPageCtes(input: {
  kind?: "channel" | "thread";
  cursor?: { at: string; id: string };
  limit: number;
}): SQL {
  const kindFilter = sql`
    ${input.kind === "channel" ? sql`and not (mt.topic_key is not null and mt.has_thread)` : sql``}
    ${input.kind === "thread" ? sql`and (mt.topic_key is not null and mt.has_thread)` : sql``}
  `;
  const branch = (nullKeys: boolean) => sql`
    select
      mt.im_binding_id,
      mt.channel_id,
      mt.topic_key,
      t.has_running,
      t.has_pending,
      t.latest_execution_id,
      t.latest_state,
      t.latest_reason,
      t.latest_running,
      t.latest_reported_at,
      t.latest_turn_report,
      mt.anchor_id,
      mt.anchor_at,
      mt.anchor_external_id,
      (mt.topic_key is not null and mt.has_thread) as is_thread,
      greatest(mt.anchor_at, coalesce(t.last_execution_at, mt.anchor_at)) as last_activity_at
    from message_topics mt
    inner join topics t
      on t.im_binding_id = mt.im_binding_id
      and t.channel_id = mt.channel_id
      ${nullKeys ? sql`and t.topic_key is null` : sql`and t.topic_key = mt.topic_key`}
    where ${nullKeys ? sql`mt.topic_key is null` : sql`mt.topic_key is not null`}
      ${kindFilter}
  `;
  return sql`
    topic_page as (
      ${branch(false)}
      union all
      ${branch(true)}
    ),
    page as (
      select *
      from topic_page
      where true
        ${input.cursor ? sql`and (last_activity_at, anchor_id) < (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)` : sql``}
      order by last_activity_at desc, anchor_id desc
      limit ${input.limit}
    )
  `;
}

/**
 * The Sessions whose work belongs to one topic: those that inherited its scope, those a channel
 * Session spawned inside one of its Turn windows (with their descendants), and the Sessions that
 * carry the topic's title and replies. Each identity is produced once, so a message that names two
 * related Sessions is read once.
 *
 * `spawned_roots` walks from the Turn window to its candidates through the sessions creator index,
 * and only for the windows that can hold one: the reverse direction — every internal Session joined
 * to every execution — is what made the hot detail pair a whole history with itself before
 * discarding it. Internal Sessions carry their creator's channel, so the earliest child per creator
 * is read from the topic's channel alone. The window closes at the next
 * acceptance of that Session, compared as the exact `(accepted_at, id)` pair, so a Turn whose
 * successor was accepted at the same instant still ends there.
 */
export function relatedSessionCtes(scope: TopicScope): SQL {
  const ownerTopic = scope.topicKey === null ? sql`ts.topic_key is null` : sql`ts.topic_key = ${scope.topicKey}`;
  return sql`
    inherited as (
      select s.id, s.created_at
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
    creator_children as (
      select s.created_by_session_id as session_id, min(s.created_at) as first_created_at
      from sessions s
      where s.kind = 'internal'
        and s.im_binding_id = ${scope.bindingId}::uuid
        and s.channel_id = ${scope.channelId}
      group by s.created_by_session_id
    ),
    spawned_roots as (
      select s.id, s.created_at
      from executions e
      inner join sessions creator on creator.id = e.session_id and creator.kind = 'channel'
      inner join creator_children cc on cc.session_id = e.session_id
      cross join lateral (
        select s.id, s.created_at
        from sessions s
        where s.kind = 'internal'
          and s.created_by_session_id = e.session_id
          and s.created_at between e.accepted_at and coalesce(e.reported_at, 'infinity'::timestamptz)
          and not exists (
            select 1
            from im_message_deliveries later
            where later.session_id = e.session_id
              and later.state = 'accepted'
              and (later.accepted_at, later.id) > (e.accepted_at, e.id)
              and later.accepted_at <= s.created_at
          )
      ) s
      where e.accepted_at is not null
        -- A window that ends before the creator's earliest child cannot hold one. Dropping those
        -- executions here keeps the successor lookup off the history: the fixture's 50,000 windows
        -- all end before the Sessions they would have spawned, so nothing is probed at all.
        and coalesce(e.reported_at, 'infinity'::timestamptz) >= cc.first_created_at
    ),
    spawned as (
      select id, created_at from spawned_roots
      union all
      select child.id, child.created_at
      from sessions child
      inner join spawned parent on child.created_by_session_id = parent.id
    ),
    internal_related as (
      select id, created_at from inherited
      union
      select id, created_at from spawned
    ),
    owner_sessions as (
      select ts.id
      from title_sessions ts
      where ts.im_binding_id = ${scope.bindingId}::uuid
        and ts.channel_id = ${scope.channelId}
        and ${ownerTopic}
    ),
    related_sessions as (
      select id from internal_related
      union
      select id from owner_sessions
    )
  `;
}
