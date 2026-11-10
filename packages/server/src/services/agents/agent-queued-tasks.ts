import { sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { isExecution, liveDeliveryExists, threadRootAddressed } from "../tasks/task-sql.js";

type QueuedTaskExecutor = Pick<DatabaseClient, "execute">;

/**
 * Keeps an `exists` probing row by row from its Session. Without it the planner may decorrelate the probe into a hash
 * of every Account's matching deliveries, which is cheaper to cost on a small table but reads rows this read must not.
 */
const PROBE = sql`offset 0`;

/**
 * The Agents' live channel and thread Sessions, read binding by binding so no other Account's Session enters the plan.
 * The literal predicates keep each branch on its partial active-Session index, so the Internal Sessions a busy binding
 * accumulates are not read.
 */
function liveSessions(
  agentIds: readonly string[],
  kind: "channel" | "thread",
  bindingCondition: ReturnType<typeof sql> = sql`binding.status <> 'disabled'`,
) {
  return sql`
    select binding.agent_id, session.*
    from im_bindings binding
    cross join lateral (
      select session.id, session.im_binding_id, session.kind, session.conversation_kind,
        session.channel_id, session.thread_key
      from sessions session
      where session.im_binding_id = binding.id
        and session.kind = ${sql.raw(`'${kind}'`)}
        and session.ended_at is null
      ${PROBE}
    ) session
    where binding.agent_id = any(${`{${agentIds.join(",")}}`}::uuid[])
      and ${bindingCondition}
  `;
}

export interface WorkingAgentActivityRow {
  agentId: string;
  runningTaskCount: number;
  startedAt: Date;
}

/**
 * The Agents' working and stale unreported-accepted activity in one statement inside the caller's snapshot. The read
 * starts from the listed Agents' active bindings' live channel and thread Sessions via `sessions_active_channel_unique`
 * and `sessions_active_thread_unique` (`offset 0`) and probes `im_message_deliveries_session_unreported_accepted_idx`
 * (`(session_id, accepted_at, id) where state = 'accepted' and reported_at is null`) for each Session's latest
 * unreported Turn, so neither Internal Sessions, historical reported Turns of a hot Session, nor other Accounts'
 * unreported Turns are scanned.
 */
export async function readUnreportedAcceptedActivity(
  executor: QueuedTaskExecutor,
  agentIds: readonly string[],
  recoveryStartedAt: Date,
): Promise<{
  workingRows: WorkingAgentActivityRow[];
  staleAgentIds: string[];
}> {
  // Every probe is costed as if it found work, so a listed Account with many Agents passes the JIT threshold on a read
  // of a few milliseconds, and compiling it took about 450 ms. Both activity reads share one read-only transaction.
  await executor.execute(sql`set local jit = off`);
  const recoveryCutoff = sql`${recoveryStartedAt.toISOString()}::timestamptz`;
  const rows = await executor.execute<
    {
      agentId: string;
      runningTaskCount: number;
      startedAt: Date | string | null;
      hasStale: boolean;
    } & Record<string, unknown>
  >(sql`
    with live as materialized (
      ${liveSessions(agentIds, "channel", sql`binding.status = 'active'`)}
      union all
      ${liveSessions(agentIds, "thread", sql`binding.status = 'active'`)}
    )
    select
      live.agent_id as "agentId",
      count(*) filter (where running.accepted_at >= ${recoveryCutoff})::int as "runningTaskCount",
      max(running.accepted_at) filter (where running.accepted_at >= ${recoveryCutoff}) as "startedAt",
      bool_or(running.accepted_at < ${recoveryCutoff}) as "hasStale"
    from live
    cross join lateral (
      select "im_message_deliveries"."accepted_at" as accepted_at
      from "im_message_deliveries"
      where "im_message_deliveries"."session_id" = live.id
        and "im_message_deliveries"."state" = 'accepted'
        and "im_message_deliveries"."reported_at" is null
      order by "im_message_deliveries"."accepted_at" desc
      limit 1
      ${PROBE}
    ) running
    group by live.agent_id
  `);
  const workingRows: WorkingAgentActivityRow[] = [];
  const staleAgentIds: string[] = [];
  for (const row of rows) {
    if (row.runningTaskCount > 0 && row.startedAt !== null) {
      workingRows.push({
        agentId: row.agentId,
        runningTaskCount: row.runningTaskCount,
        startedAt: row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt),
      });
    }
    if (row.hasStale) {
      staleAgentIds.push(row.agentId);
    }
  }
  return { workingRows, staleAgentIds };
}

/**
 * Whether a live Session holds a pending delivery that makes its Task queue, by the Task list's own rules: a direct
 * delivery, or an overheard one that counts as an execution of a Task somebody addressed. Only a Session with a
 * pending delivery reads the qualification, so it never costs an idle Session more than these index ranges.
 */
const sessionIsWaiting = sql`(
  exists (
    select 1 from im_message_deliveries direct_pending
    where direct_pending.session_id = live.id
      and direct_pending.attention = 'direct'
      and direct_pending.state = 'pending'
    ${PROBE}
  )
  or (
    exists (
      select 1 from im_message_deliveries overheard
      where overheard.session_id = live.id
        and overheard.attention = 'ambient'
        and overheard.state = 'pending'
        and ${isExecution("overheard", "live", PROBE)}
      ${PROBE}
    )
    and (${liveDeliveryExists("live", "direct", PROBE)} or (${threadRootAddressed("live", PROBE)}))
  )
)`;

/**
 * Whether a Session has a Turn still running, by the Task list's rule: accepted and unreported before its deadline, and
 * no later Turn accepted in the Session. It starts from the Session, so no other Account's Turn is read, and it only
 * runs for a Task that is waiting, so reading the Session's accepted history stays bound to work that is queued.
 */
function sessionIsRunning(sessionAlias: string, now: Date) {
  const session = sql.raw(sessionAlias);
  return sql`exists (
    select 1 from im_message_deliveries turn
    where turn.session_id = ${session}.id
      and turn.attention in ('direct', 'ambient')
      and turn.state = 'accepted'
      -- Written so it stays on im_message_deliveries_overflow_idx, which covers attention as well as session_id and state.
      and coalesce(turn.reported_at, 'infinity'::timestamptz) = 'infinity'::timestamptz
      and turn.expires_at > ${now.toISOString()}::timestamptz
      and not exists (
        select 1 from im_message_deliveries later
        where later.session_id = turn.session_id
          and later.attention in ('direct', 'ambient')
          and later.state = 'accepted'
          and (later.accepted_at, later.id) > (turn.accepted_at, turn.id)
        ${PROBE}
      )
    ${PROBE}
  )`;
}

/** Whether another live Session of a waiting private chat runs a Turn; each kind stays on its partial index. */
function siblingIsRunning(kind: "channel" | "thread", now: Date) {
  return sql`exists (
    select 1 from sessions sibling
    where sibling.im_binding_id = waiting.im_binding_id
      and sibling.channel_id = waiting.channel_id
      and sibling.conversation_kind = 'dm'
      and sibling.kind = ${sql.raw(`'${kind}'`)}
      and sibling.ended_at is null
      and sibling.id <> waiting.id
      and ${sessionIsRunning("sibling", now)}
    ${PROBE}
  )`;
}

/**
 * How many Tasks of each Agent are queued, in one statement inside the caller's snapshot, by the Task list's
 * qualification and status rules. A Task is one Session, or a whole private chat. It is queued when one of its live
 * Sessions holds a qualifying pending delivery and none has a Turn running. The read grows with the Agents' live
 * Sessions, which have no upper bound; `docs/system/agent-usage.md` names the Issue tracking that.
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
    waiting as materialized (
      select * from live where ${sessionIsWaiting}
    )
    select waiting.agent_id as "agentId", count(distinct (
      case when waiting.conversation_kind = 'dm' then waiting.channel_id else waiting.id::text end
    ))::int as "queuedTaskCount"
    from waiting
    where not ${sessionIsRunning("waiting", now)}
      and not (
        waiting.conversation_kind = 'dm'
        and (${siblingIsRunning("channel", now)} or ${siblingIsRunning("thread", now)})
      )
    group by waiting.agent_id
  `);
  return new Map(rows.map((row) => [row.agentId, row.queuedTaskCount]));
}
