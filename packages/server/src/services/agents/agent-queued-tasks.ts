import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { DatabaseClient } from "../../db/client.js";
import { imBindings, imMessageDeliveries, sessions } from "../../db/schema/index.js";
import { AMBIENT_TTL_MS } from "../im/im-queue-policy.js";
import { liveDeliveryExists } from "../tasks/task-sql.js";

type QueuedTaskExecutor = Pick<DatabaseClient, "execute" | "select" | "selectDistinct">;

/** One array parameter: the Session list has no upper bound, and a bind parameter per id stops at the protocol's. */
function anyId(column: SQL | typeof imMessageDeliveries.sessionId, ids: readonly string[]): SQL {
  return sql`${column} = any(${`{${ids.join(",")}}`}::uuid[])`;
}

/**
 * The live channel and thread Sessions of the listed Agents. The literal predicates keep each branch on
 * its partial active-Session index, so the Internal Sessions a busy binding accumulates are not read.
 */
function readLiveSessions(executor: QueuedTaskExecutor, agentIds: readonly string[]) {
  const branch = (kind: "channel" | "thread") =>
    executor
      .select({
        agentId: imBindings.agentId,
        sessionId: sessions.id,
        conversationKind: sessions.conversationKind,
        channelId: sessions.channelId,
      })
      .from(imBindings)
      .innerJoin(sessions, eq(sessions.imBindingId, imBindings.id))
      .where(
        and(
          inArray(imBindings.agentId, agentIds),
          sql`${imBindings.status} <> 'disabled'`,
          sql`${sessions.kind} = ${sql.raw(`'${kind}'`)}`,
          isNull(sessions.endedAt),
        ),
      );
  return unionAll(branch("channel"), branch("thread"));
}

/**
 * Which pending `ambient` deliveries make their Session wait. An unaddressed follow-up the inbox kept for
 * the direct window continues a request (the same inference as `hadDirectRetention`). Any other overheard
 * message counts only in a Session somebody addressed directly, and never as the channel Session's
 * observer copy of a message a Thread Session owns: the Task list's qualification and execution rules.
 */
async function readWaitingAmbientSessions(
  executor: QueuedTaskExecutor,
  deliveryIds: readonly string[],
): Promise<string[]> {
  const rows = await executor.execute<{ sessionId: string } & Record<string, unknown>>(sql`
    select distinct delivery.session_id as "sessionId"
    from im_message_deliveries delivery
    inner join im_messages message on message.id = delivery.message_id
    inner join sessions session on session.id = delivery.session_id
    where ${anyId(sql`delivery.id`, deliveryIds)}
      and (
        delivery.expires_at - message.received_at > ${AMBIENT_TTL_MS} * interval '1 millisecond'
        or (
          ${liveDeliveryExists("session", "direct")}
          and not (
            session.kind = 'channel'
            and exists (
              select 1
              from im_message_deliveries owner
              inner join sessions owner_session on owner_session.id = owner.session_id
              where owner.message_id = delivery.message_id
                and owner_session.kind = 'thread'
            )
          )
        )
      )
  `);
  return rows.map((row) => row.sessionId);
}

/** Which of these Sessions hold a qualifying pending delivery, and which hold a Turn still running. */
async function readSessionWork(executor: QueuedTaskExecutor, sessionIds: readonly string[], now: Date) {
  const deliveries = await executor
    .select({
      id: imMessageDeliveries.id,
      sessionId: imMessageDeliveries.sessionId,
      state: imMessageDeliveries.state,
      attention: imMessageDeliveries.attention,
    })
    .from(imMessageDeliveries)
    .where(
      and(
        anyId(imMessageDeliveries.sessionId, sessionIds),
        sql`(${imMessageDeliveries.state} = 'pending'
          or (${imMessageDeliveries.state} = 'accepted'
            and ${imMessageDeliveries.reportedAt} is null
            and ${imMessageDeliveries.expiresAt} > ${now.toISOString()}::timestamptz))`,
      ),
    );
  const waiting = new Set<string>();
  const running = new Set<string>();
  const ambient: string[] = [];
  for (const delivery of deliveries) {
    if (delivery.state === "accepted") running.add(delivery.sessionId);
    else if (delivery.attention === "direct") waiting.add(delivery.sessionId);
    else ambient.push(delivery.id);
  }
  if (ambient.length > 0) {
    for (const sessionId of await readWaitingAmbientSessions(executor, ambient)) waiting.add(sessionId);
  }
  return { waiting, running };
}

/**
 * How many Tasks of each Agent are waiting, read in steps inside the caller's snapshot: the Agents' live
 * Sessions, then those Sessions' pending and unreported deliveries, then the qualification of any pending
 * `ambient` delivery. A Task is one Session, or a whole private chat; it waits when one of its Sessions
 * holds a qualifying pending delivery and none holds a Turn still running. No Task rollup is read, so this
 * differs from the Task list in the two ways `docs/system/agent-usage.md` lists, and the read grows with
 * the Agents' live Sessions, which have no upper bound; the same page names the Issue tracking that.
 */
export async function readQueuedTaskCounts(
  executor: QueuedTaskExecutor,
  agentIds: readonly string[],
  now: Date,
): Promise<Map<string, number>> {
  const live = await readLiveSessions(executor, agentIds);
  if (live.length === 0) return new Map();
  const { waiting, running } = await readSessionWork(
    executor,
    live.map((session) => session.sessionId),
    now,
  );
  const taskKey = (session: (typeof live)[number]) =>
    session.conversationKind === "dm" ? `${session.agentId}:${session.channelId}` : session.sessionId;
  const runningTasks = new Set(live.filter((session) => running.has(session.sessionId)).map(taskKey));
  const waitingTasks = new Map<string, string>();
  for (const session of live) {
    const key = taskKey(session);
    if (waiting.has(session.sessionId) && !runningTasks.has(key)) waitingTasks.set(key, session.agentId);
  }
  const counts = new Map<string, number>();
  for (const agentId of waitingTasks.values()) counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
  return counts;
}
