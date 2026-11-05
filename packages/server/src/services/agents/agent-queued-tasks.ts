import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { AMBIENT_TTL_MS } from "../im/im-queue-policy.js";
import { liveDeliveryExists } from "../tasks/task-sql.js";

type QueuedTaskExecutor = Pick<DatabaseClient, "execute">;

/**
 * The Agents' live channel and thread Sessions. The literal predicates keep each branch on its partial
 * active-Session index, so the Internal Sessions a busy binding accumulates are not read.
 */
function liveSessions(agentIds: readonly string[], kind: "channel" | "thread") {
  return sql`
    select binding.agent_id, session.id, session.kind, session.conversation_kind, session.channel_id
    from im_bindings binding
    inner join sessions session on session.im_binding_id = binding.id
    where binding.agent_id = any(${`{${agentIds.join(",")}}`}::uuid[])
      and binding.status <> 'disabled'
      and session.kind = ${sql.raw(`'${kind}'`)}
      and session.ended_at is null
  `;
}

/**
 * Whether a live Session holds a pending delivery that makes its Task wait: a direct one; an unaddressed
 * follow-up the inbox kept for the direct window (the same inference as `hadDirectRetention`); or a message
 * overheard in a Session somebody addressed directly, unless it is the channel Session's observer copy of a
 * message a Thread Session owns. Those are the Task list's qualification and execution rules.
 */
const sessionIsWaiting = sql`(
  exists (
    select 1 from im_message_deliveries direct_pending
    where direct_pending.session_id = live.id
      and direct_pending.attention = 'direct'
      and direct_pending.state = 'pending'
  )
  or exists (
    select 1
    from im_message_deliveries overheard
    inner join im_messages message on message.id = overheard.message_id
    where overheard.session_id = live.id
      and overheard.attention = 'ambient'
      and overheard.state = 'pending'
      and (
        overheard.expires_at - message.received_at > ${AMBIENT_TTL_MS} * interval '1 millisecond'
        or (
          ${liveDeliveryExists("live", "direct")}
          and not (
            live.kind = 'channel'
            and exists (
              select 1
              from im_message_deliveries owner
              inner join sessions owner_session on owner_session.id = owner.session_id
              where owner.message_id = overheard.message_id
                and owner_session.kind = 'thread'
            )
          )
        )
      )
  )
)`;

/**
 * How many Tasks of each Agent are waiting, in one statement inside the caller's snapshot. A Task is one
 * Session, or a whole private chat; it waits when one of its live Sessions holds a qualifying pending delivery
 * and none holds a Turn still running. No Task rollup is read, so this differs from the Task list in the two
 * ways `docs/system/agent-usage.md` lists, and the read grows with the Agents' live Sessions, which have no
 * upper bound; the same page names the Issue tracking that.
 */
export async function readQueuedTaskCounts(
  executor: QueuedTaskExecutor,
  agentIds: readonly string[],
  now: Date,
): Promise<Map<string, number>> {
  const rows = await executor.execute<{ agentId: string; queuedTaskCount: number } & Record<string, unknown>>(sql`
    with live as materialized (
      ${liveSessions(agentIds, "channel")}
      union all
      ${liveSessions(agentIds, "thread")}
    ),
    running as materialized (
      select distinct session_id
      from im_message_deliveries
      where state = 'accepted' and reported_at is null and expires_at > ${now.toISOString()}::timestamptz
    ),
    session_work as materialized (
      select live.*, ${sessionIsWaiting} as waiting, live.id in (select session_id from running) as is_running
      from live
    ),
    tasks as (
      select
        agent_id,
        case when conversation_kind = 'dm' then channel_id else id::text end as task_key,
        bool_or(waiting) as waiting,
        bool_or(is_running) as is_running
      from session_work
      where waiting or is_running
      group by agent_id, task_key
    )
    select agent_id as "agentId", count(*)::int as "queuedTaskCount"
    from tasks
    where waiting and not is_running
    group by agent_id
  `);
  return new Map(rows.map((row) => [row.agentId, row.queuedTaskCount]));
}
