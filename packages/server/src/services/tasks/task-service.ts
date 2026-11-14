import type {
  ListTaskRepliesResponse,
  ListTasksResponse,
  TaskCollaborationMessage,
  TaskDetail,
  TaskDetailPage,
  TaskDetailSection,
  TaskInternalSession,
  TaskSummary,
  TaskTurn,
} from "@opentag/shared";
import {
  TASK_CANCELLED_DELIVERY_REASON,
  TASK_DETAIL_ALL_SECTIONS,
  TASK_SECTION_DEFAULT_LIMIT,
  TASK_SECTION_MAX_LIMIT,
  TaskTitleSchema,
} from "@opentag/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { imMessageDeliveries, sessions } from "../../db/schema/index.js";
import { DISPATCH_CLAIM_PREFIX } from "../../runtime/im-delivery-claim.js";
import { AuthServiceError } from "../auth/index.js";
import { cursorText, cursorTimestamp, encodeCursor, parseCursor, type TaskCursor } from "./task-cursor.js";
import {
  type CollaborationMessageRow,
  type InternalSessionRow,
  type TaskReplyRow,
  type TaskSummaryRow,
  type TaskTurnRow,
  taskStatus,
  toCollaborationMessage,
  toInternalSession,
  toReply,
  toSummary,
  toTurn,
} from "./task-rows.js";
import {
  type ChannelScope,
  messageOwnerTaskId,
  relatedSessionCtes,
  type TaskScope,
  taskCtes,
  taskPageCtes,
  taskQualifies,
  threadRootExternalId,
} from "./task-sql.js";

export { TaskQueryError } from "./task-error.js";
export type { TaskScope } from "./task-sql.js";

export { TASK_SECTION_DEFAULT_LIMIT, TASK_SECTION_MAX_LIMIT };

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

export interface TaskSectionOptions {
  cursor?: string;
  limit?: number;
}

/**
 * A first page request names the sections it will render. The Server reads only those, so a
 * conversation view never pays for the Internal Session or collaboration history it discards.
 */
export interface TaskDetailOptions extends TaskSectionOptions {
  sections?: readonly TaskDetailSection[];
}

export interface TaskServiceOptions {
  now?: () => Date;
}

/** Either the pool or a transaction of it; every Task read is written against this intersection. */
type QueryExecutor = DatabaseClient | DatabaseTransaction;

interface ScopeRow extends Record<string, unknown> {
  bindingId: string;
  channelId: string;
  taskId: string;
}

interface LocatedSessionRow extends Record<string, unknown> {
  sessionId: string;
  bindingId: string;
  channelId: string;
}

function sectionLimit(limit: number | undefined): number {
  if (limit === undefined) return TASK_SECTION_DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), TASK_SECTION_MAX_LIMIT);
}

/**
 * A Task is a read-only projection over one chat Session's stored IM messages and deliveries. A
 * group's channel Session is one Task, each thread Session is its own Task, and a private chat is
 * one Task. A Task is listed only once somebody addressed the Agent directly in it (or, for a
 * thread, in its root message); overheard-only chatter is not a Task. Nothing here changes
 * delivery, Session materialization, or the runtime.
 *
 * Reads are split by cost. The list decides its page from the Task rollups and enriches only the
 * qualified rows. The legacy detail (`get`) still returns every related Internal Session and
 * collaboration message in one answer; the bounded detail (`detail` and the three section readers)
 * is the contract new callers use, and each section keeps its own keyset cursor.
 */
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
    const rows = await this.#summaryRows(this.database, accountId, {
      ...options,
      cursor,
      limit: options.limit + 1,
    });
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      tasks: page.map(toSummary),
      nextCursor: rows.length > options.limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    };
  }

  /**
   * The complete legacy detail: the Task summary plus every Turn of the requested page and every
   * related Internal Session and collaboration message. It is kept for callers written against the
   * original contract — its section arrays are not bounded, which is why `detail` exists.
   */
  async get(accountId: string, taskId: string, options: GetTaskOptions): Promise<TaskDetail> {
    const cursor = parseCursor(options.cursor);
    const scope = await this.#scopeOf(this.database, accountId, taskId);
    if (!scope) throw taskNotFound();
    const [[row], turns, internalSessions, collaboration] = await Promise.all([
      this.#summaryRows(this.database, accountId, { scope, limit: 1 }),
      this.#turnRows(this.database, accountId, scope, cursor, options.limit + 1),
      this.#internalSessionRows(this.database, accountId, scope, {}),
      this.#collaborationRows(this.database, accountId, scope, {}),
    ]);
    if (!row) throw taskNotFound();
    const page = turns.slice(0, options.limit);
    const last = page.at(-1);
    return {
      task: toSummary(row),
      turns: page.map(toTurn),
      internalSessions: internalSessions.map(toInternalSession),
      collaborationMessages: collaboration.map(toCollaborationMessage),
      nextCursor: turns.length > options.limit && last ? encodeCursor(last.cursorAt, last.deliveryId) : null,
    };
  }

  /**
   * The bounded detail: one page of the sections the caller names — all three by default — each with
   * its own cursor. A reader that needs more of a section follows that section's cursor instead of
   * re-reading a conversation, and a reader that renders only the conversation asks for the Turns
   * alone, so it never reads history it would discard. Authorization and every requested section
   * come from one read snapshot.
   */
  async detail(accountId: string, taskId: string, options: TaskDetailOptions = {}): Promise<TaskDetailPage> {
    const limit = sectionLimit(options.limit);
    const sections = options.sections ?? TASK_DETAIL_ALL_SECTIONS;
    const wanted = (section: TaskDetailSection) => sections.includes(section);
    return this.#readSnapshot(accountId, taskId, async (executor, scope) => {
      const [row] = await this.#summaryRows(executor, accountId, { scope, limit: 1 });
      const page: TaskDetailPage = { task: toSummary(requireRow(row)) };
      if (wanted("turns"))
        page.turns = turnPage(await this.#turnRows(executor, accountId, scope, undefined, limit + 1), limit);
      if (wanted("internal-sessions"))
        page.internalSessions = internalSessionPage(
          await this.#internalSessionRows(executor, accountId, scope, { limit: limit + 1 }),
          limit,
        );
      if (wanted("collaboration-messages"))
        page.collaborationMessages = collaborationPage(
          await this.#collaborationRows(executor, accountId, scope, { limit: limit + 1 }),
          limit,
        );
      return page;
    });
  }

  async listTurns(
    accountId: string,
    taskId: string,
    options: TaskSectionOptions,
  ): Promise<{ items: TaskTurn[]; nextCursor: string | null }> {
    const limit = sectionLimit(options.limit);
    const cursor = parseCursor(options.cursor);
    return this.#readSnapshot(accountId, taskId, async (executor, scope) =>
      turnPage(await this.#turnRows(executor, accountId, scope, cursor, limit + 1), limit),
    );
  }

  async listInternalSessions(
    accountId: string,
    taskId: string,
    options: TaskSectionOptions,
  ): Promise<{ items: TaskInternalSession[]; nextCursor: string | null }> {
    const limit = sectionLimit(options.limit);
    const cursor = parseCursor(options.cursor);
    return this.#readSnapshot(accountId, taskId, async (executor, scope) =>
      internalSessionPage(
        await this.#internalSessionRows(executor, accountId, scope, { cursor, limit: limit + 1 }),
        limit,
      ),
    );
  }

  async listCollaborationMessages(
    accountId: string,
    taskId: string,
    options: TaskSectionOptions,
  ): Promise<{ items: TaskCollaborationMessage[]; nextCursor: string | null }> {
    const limit = sectionLimit(options.limit);
    const cursor = parseCursor(options.cursor);
    return this.#readSnapshot(accountId, taskId, async (executor, scope) =>
      collaborationPage(await this.#collaborationRows(executor, accountId, scope, { cursor, limit: limit + 1 }), limit),
    );
  }

  /**
   * Set or clear the Account-owned manual title of a Task. The id may be anything that resolves to
   * the Task (see `#scopeOf`). The title is stored on the Session the Task reads it from, which is
   * the Task's own id.
   */
  async updateTitle(accountId: string, id: string, title: string | null): Promise<TaskSummary> {
    const normalizedTitle = title === null ? null : TaskTitleSchema.parse(title);
    const scope = await this.#scopeOf(this.database, accountId, id);
    if (!scope) throw taskNotFound();
    const [updated] = await this.database
      .update(sessions)
      .set({ manualTitle: normalizedTitle })
      .where(
        and(
          eq(sessions.id, scope.taskId),
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
    const [row] = await this.#summaryRows(this.database, accountId, { scope, limit: 1 });
    if (!row) throw taskNotFound();
    return toSummary(row);
  }

  /**
   * Withdraw a queued Task before any of it runs. The id may be the Task's own id or one of its
   * Sessions. The withdrawal is all or nothing: every pending delivery of the Task is expired
   * with the cancelled reason, which keeps it out of the delivery worker's reach for good (the
   * worker claims only `pending` rows, and recovers expired ones only while they carry a dispatch
   * correlation, which a never-dispatched row does not have), or none of them is touched.
   *
   * Only a `queued` Task cancels. A Task that has started, or that already finished, is refused
   * with 409 so the caller re-reads its state instead; a Task that is already `cancelled` is a
   * no-op success, so a repeated cancel is harmless — whether it repeats after the first one or
   * races it under the lock. A delivery a worker is dispatching right now — one carrying a live
   * claim lease or a dispatch correlation — cannot be withdrawn, because the Runtime may already
   * be running it; while the Task has one, nothing of it is withdrawn and the answer is a 409
   * that says which, so a success always leaves the Task `cancelled` rather than partly queued.
   * A row that a worker rejected, or that lapsed, while the cancel waited for the lock is not
   * queued any more and is left as the worker left it; the rows still pending beside it are
   * withdrawn as usual. When nothing is pending any more, the refusal names the status the Task
   * now reads — unless that status is `cancelled`, which is the documented no-op success.
   */
  async cancel(accountId: string, id: string): Promise<TaskSummary> {
    const scope = await this.#scopeOf(this.database, accountId, id);
    if (!scope) throw taskNotFound();
    const [before] = await this.#summaryRows(this.database, accountId, { scope, limit: 1 });
    if (!before) throw taskNotFound();
    const status = taskStatus(before);
    if (status === "cancelled") return toSummary(before);
    if (status !== "queued") throw taskNotQueued(`The Task is ${status}, not queued`);
    const { outcome, after } = await this.#withdrawQueuedDeliveries(accountId, scope);
    if (outcome === "running") throw taskNotQueued("The Task is running, not queued");
    if (outcome === "in_flight") throw taskNotQueued("The Task's queued message is already being delivered");
    if (outcome === "awaiting_computer")
      throw taskNotQueued("The Task's queued message was handed to a Computer that has not reported back yet");
    if (!after) throw taskNotFound();
    // Nothing left to withdraw: another cancel got there first, or the queue drained some other way.
    // The summary was read under the admission lock, so it is the state the withdrawal left; say what
    // it is rather than contradicting the status the caller is about to re-read.
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
   * The Task's platform-confirmed outbound replies, newest first with an independent
   * `(occurred_at, id)` keyset cursor. The id resolves to its Task like every other Task read, and
   * the replies are attributed to Sessions from stored IM data only; no runtime, Sandbox, worker,
   * or Pi state is consulted, and no delivery is ever created by the write side of this feature.
   * An empty page means there is no captured record, never proof that nothing was sent.
   */
  async listReplies(accountId: string, taskId: string, options: GetTaskOptions): Promise<ListTaskRepliesResponse> {
    const cursor = parseCursor(options.cursor);
    return this.database.transaction(
      async (transaction) => {
        const scope = await this.#scopeOf(transaction, accountId, taskId);
        if (!scope) throw taskNotFound();
        const rows = await this.#replyRows(transaction, accountId, scope, cursor, options.limit + 1);
        const page = rows.slice(0, options.limit);
        const last = page.at(-1);
        return {
          items: page.map(toReply),
          nextCursor: rows.length > options.limit && last ? encodeCursor(last.cursorAt, last.id) : null,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * Whether the Session ID on an IM failure message may link to its Task, read for the Account that
   * owns the Session's Agent. The Session resolves to its Task exactly as the Task routes resolve
   * it (`#scopeOf`: a chat Session, or the chat Session at the root of an internal Session's creator
   * chain), and the Task must then qualify under the same rule list and detail apply
   * (`taskQualifies`). A Session whose Task does not qualify, such as an ambient-only group channel
   * Session or an internal Session rooted at one, therefore keeps a plain ID instead of linking
   * to a detail page that answers 404.
   *
   * This runs on every render of a failure message, so it never reads the `tasks` rollup: the
   * creator chain is walked once, and qualification is a set of bounded index-range existence probes
   * that each stop at their first row, also when the history holds only superseded deliveries,
   * instead of deriving the Task's status over its whole history.
   */
  async hasLinkableTask(sessionId: string): Promise<boolean> {
    return this.database.transaction(
      async (transaction) => {
        const located = await this.#locateSession(transaction, sessionId);
        if (!located) return false;
        const owners = await transaction.execute<{ accountId: string } & Record<string, unknown>>(sql`
          select a.created_by_user_id as "accountId"
          from im_bindings b
          inner join agents a on a.id = b.agent_id
          where b.id = ${located.bindingId}::uuid
        `);
        const owner = [...owners][0];
        if (!owner) return false;
        const scope = await this.#scopeOfSession(transaction, owner.accountId, located);
        if (!scope) return false;
        const rows = await transaction.execute<{ qualifies: boolean } & Record<string, unknown>>(sql`
          with ${taskCtes({ accountId: owner.accountId, scope, now: this.#now() })}
          select ${taskQualifies()} as "qualifies"
        `);
        return [...rows][0]?.qualifies === true;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * One read-only Repeatable Read transaction: authorization, the summary and every section see one
   * snapshot, and its executor is the only connection the statements use. Nothing here performs
   * external I/O, so the transaction never spans a wait.
   */
  async #readSnapshot<T>(
    accountId: string,
    taskId: string,
    read: (executor: DatabaseTransaction, scope: TaskScope) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(
      async (transaction) => {
        const scope = await this.#scopeOf(transaction, accountId, taskId);
        if (!scope) throw taskNotFound();
        return read(transaction, scope);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * The Task an id names, or undefined when it is outside the Account. The id may be a chat Session
   * (a Task's own id, or another Session of a private chat), an internal Session (its Task is the
   * Task of the chat Session at the root of its creator chain), or a stored message (the Task of
   * the Session that owns its execution, a thread Session before the channel Session's observer
   * copy; a message no execution names belongs to the Session that owned its thread or channel when
   * it was stored). Message ids are what older Task links and the retired `Session <shortId>` reply footers carry, so
   * they keep resolving. The Session or message is read by primary key first so the Task lookup
   * only touches that channel; the Account check happens inside the CTE chain, which is empty for a
   * foreign binding.
   */
  async #scopeOf(executor: QueryExecutor, accountId: string, id: string): Promise<TaskScope | undefined> {
    const located = await this.#locateSession(executor, id);
    if (located) return this.#scopeOfSession(executor, accountId, located);
    const now = this.#now();
    const messages = await executor.execute<ChannelScope & Record<string, unknown>>(sql`
      select m.im_binding_id as "bindingId", m.channel_id as "channelId"
      from im_messages m
      where m.id = ${id}::uuid
    `);
    const [channel] = [...messages];
    if (!channel) return undefined;
    const rows = await executor.execute<ScopeRow>(sql`
      with ${taskCtes({ accountId, scope: channel, now })}
      select m.im_binding_id as "bindingId", m.channel_id as "channelId", ${messageOwnerTaskId("m")} as "taskId"
      from im_messages m
      where m.id = ${id}::uuid
        and exists (select 1 from scoped_bindings sb where sb.binding_id = m.im_binding_id)
      limit 1
    `);
    return scopeFrom([...rows][0]);
  }

  /** The Task of an already located chat Session, or undefined when it is outside the Account. */
  async #scopeOfSession(
    executor: QueryExecutor,
    accountId: string,
    located: LocatedSessionRow,
  ): Promise<TaskScope | undefined> {
    const rows = await executor.execute<ScopeRow>(sql`
      with ${taskCtes({ accountId, scope: { bindingId: located.bindingId, channelId: located.channelId }, now: this.#now() })}
      select ts.im_binding_id as "bindingId", ts.channel_id as "channelId", ts.task_id as "taskId"
      from task_sessions ts
      where ts.id = ${located.sessionId}::uuid
      limit 1
    `);
    return scopeFrom([...rows][0]);
  }

  /**
   * The chat Session an id names directly: a chat Session itself, the chat Session at the root of an
   * internal Session's creator chain, or the Session that owns a message's execution. No
   * authorization happens here; `#scopeOf` reads the result through the Account's bindings.
   */
  async #locateSession(executor: QueryExecutor, id: string): Promise<LocatedSessionRow | undefined> {
    const rows = await executor.execute<LocatedSessionRow>(sql`
      with recursive chain as (
        select s.id, s.kind, s.created_by_session_id, s.im_binding_id, s.channel_id, 0 as depth
        from sessions s
        where s.id = ${id}::uuid
        union all
        select p.id, p.kind, p.created_by_session_id, p.im_binding_id, p.channel_id, c.depth + 1
        from sessions p
        inner join chain c on p.id = c.created_by_session_id
        where c.kind = 'internal'
      )
      select located."sessionId", located."bindingId", located."channelId"
      from (
        (
          select c.id as "sessionId", c.im_binding_id as "bindingId", c.channel_id as "channelId", 0 as source
          from chain c
          where c.kind in ('channel', 'thread')
          order by c.depth asc
          limit 1
        )
        union all
        (
          select s.id, s.im_binding_id, s.channel_id, 1 as source
          from im_message_deliveries d
          inner join sessions s on s.id = d.session_id
          where d.message_id = ${id}::uuid
            and s.kind in ('channel', 'thread')
          order by (s.kind = 'thread') desc, (d.attention = 'direct') desc, s.created_at desc, d.id desc
          limit 1
        )
      ) located
      order by located.source asc
      limit 1
    `);
    return [...rows][0];
  }

  /**
   * Expire every pending delivery of the Task, or none. The transaction first holds the Task's
   * binding against IM admission, so no new pending delivery can join the Task while it runs and
   * the summary it returns is read before any can. It then locks the Task's pending rows: the
   * worker's claim steps around locked rows (`for update skip
   * locked`), and its acceptance of a row it already claimed waits behind the lock, so what the
   * locked read shows is what the update acts on. A lock that waited behind a worker's write
   * returns the row as the worker left it: a claim taken in the meantime, or a row the worker
   * accepted or steered into a Turn, refuses the whole withdrawal as running, while a row that
   * was withdrawn, rejected or lapsed is set aside and only the rows still pending are withdrawn
   * — an already withdrawn or rejected row is never stamped again. A lock
   * that waited behind another cancel sees every row withdrawn with the cancelled reason, and
   * reports the Task as already cancelled rather than refusing. A claim whose lease lapsed belongs
   * to a worker that is gone, and is withdrawn like an unclaimed row — exactly as any worker may
   * take such a row again. A Task with a running Turn is never withdrawn either, however the
   * summary read before the transaction looked.
   *
   * The withdrawn row expires at the cancel instant rather than at its original deadline: that
   * is when it left the queue, and the instant the Task's status derivation orders it by, so the
   * cancel outranks every Turn that finished before it. Retention counts from the same column,
   * so a withdrawn row is kept for the retention window after the cancel, as a lapsed one is kept
   * after its deadline.
   */
  async #withdrawQueuedDeliveries(
    accountId: string,
    scope: TaskScope,
  ): Promise<{ outcome: WithdrawalOutcome; after?: TaskSummaryRow }> {
    const now = this.#now();
    return this.database.transaction(async (transaction) => {
      // The linearization point with IM admission. Every pending delivery is created by the inbound
      // path while it holds its binding row `FOR UPDATE` (after the Agent custody fence, the Agent and
      // the Computer), so holding the binding `FOR SHARE` here means no admission into this Task is
      // in flight: one that committed first is visible to the locked read below, and one that starts
      // later waits until this cancel commits and is queued after it. Locking the existing pending
      // rows alone cannot do that, because a row inserted after the read's snapshot is never locked.
      // The binding comes before every delivery lock, the order the binding lifecycle and the
      // maintenance settlement already use (Agent, binding, Sessions, deliveries).
      const [binding] = [
        ...(await transaction.execute<{ id: string } & Record<string, unknown>>(sql`
          select b.id from im_bindings b where b.id = ${scope.bindingId}::uuid for share
        `)),
      ];
      if (!binding) return { outcome: "nothing" };
      const locked = await transaction.execute<LockedDeliveryRow>(sql`
        with ${taskCtes({ accountId, scope, now })}
        select
          d.id,
          d.state,
          d.reason,
          (
            d.last_error_code like ${`${DISPATCH_CLAIM_PREFIX}%`}
            and d.next_attempt_at > ${now.toISOString()}::timestamptz
          ) as "claimed",
          (d.dispatch_request_id is not null) as "dispatched",
          exists (select 1 from executions e where e.is_running) as "taskRunning"
        from im_message_deliveries d
        where d.id in (select e.id from executions e where e.state = 'pending')
        for update of d
      `);
      const rows = [...locked];
      // The summary is read before the admission lock is released, so a `200` reports the state this
      // withdrawal left rather than a message admitted after it.
      const summary = async () => {
        const [row] = await this.#summaryRows(transaction, accountId, { scope, limit: 1 });
        return row;
      };
      const refusal = withdrawalRefusal(rows);
      if (refusal === "running" || refusal === "in_flight" || refusal === "awaiting_computer")
        return { outcome: refusal };
      if (refusal) return { outcome: refusal, after: await summary() };
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
      return { outcome: "withdrawn", after: await summary() };
    });
  }

  /** Newest first with an independent `(occurred_at, delivery id)` keyset cursor. */
  async #turnRows(
    executor: QueryExecutor,
    accountId: string,
    scope: TaskScope,
    cursor: TaskCursor | undefined,
    limit: number,
  ): Promise<TaskTurnRow[]> {
    const rows = await executor.execute<TaskTurnRow>(sql`
      with ${taskCtes({ accountId, scope, now: this.#now() })}
      select
        e.id as "deliveryId",
        e.attention,
        e.state as "deliveryState",
        e.is_running as "isRunning",
        e.attempt_count::int as "attemptCount",
        e.accepted_at as "acceptedAt",
        e.steered_at as "steeredAt",
        e.expires_at as "expiresAt",
        e.reason,
        e.last_error_code as "lastErrorCode",
        e.turn_id as "turnId",
        e.turn_report as "turnReport",
        e.reported_at as "reportedAt",
        e.steer_target_delivery_id as "absorbedByDeliveryId",
        e.steer_target_turn_id as "absorbedByTurnId",
        m.id as "messageId",
        m.external_message_id as "externalMessageId",
        m.operation,
        m.author_kind as "authorKind",
        m.author_display_name as "authorDisplayName",
        m.content,
        m.occurred_at as "occurredAt",
        ${cursorText(sql`m.occurred_at`)} as "cursorAt"
      from executions e
      inner join im_messages m on m.id = e.message_id
      where true
        ${cursor ? sql`and (m.occurred_at, e.id) < (${cursorTimestamp(cursor)}, ${cursor.id}::uuid)` : sql``}
      order by m.occurred_at desc, e.id desc
      limit ${limit}
    `);
    return [...rows];
  }

  /**
   * Captured outbound messages of one resolved Task, newest first. A captured reply names no
   * Session, so it belongs to the Session that owned its thread or channel when it was stored (see
   * `messageOwnerTaskId`): a reply in a thread whose thread Session already existed is that thread
   * Task's, and anything else in the channel is the channel Session's. A private chat takes the
   * whole conversation, as it does inbound.
   */
  async #replyRows(
    executor: QueryExecutor,
    accountId: string,
    scope: TaskScope,
    cursor: TaskCursor | undefined,
    limit: number,
  ): Promise<TaskReplyRow[]> {
    const rows = await executor.execute<TaskReplyRow>(sql`
      with ${taskCtes({ accountId, scope: { bindingId: scope.bindingId, channelId: scope.channelId }, now: this.#now() })}
      select
        m.id,
        b.provider,
        m.channel_id as "channelId",
        m.external_message_id as "externalMessageId",
        m.author_kind as "authorKind",
        m.author_display_name as "authorDisplayName",
        m.content,
        m.occurred_at as "occurredAt",
        ${cursorText(sql`m.occurred_at`)} as "cursorAt"
      from im_messages m
      inner join im_bindings b on b.id = m.im_binding_id
      where m.im_binding_id = ${scope.bindingId}::uuid
        and m.channel_id = ${scope.channelId}
        and m.direction = 'outbound'
        and m.operation = 'created'
        and ${messageOwnerTaskId("m")} = ${scope.taskId}::uuid
        ${cursor ? sql`and (m.occurred_at, m.id) < (${cursorTimestamp(cursor)}, ${cursor.id}::uuid)` : sql``}
      order by m.occurred_at desc, m.id desc
      limit ${limit}
    `);
    return [...rows];
  }

  /**
   * Internal Sessions of a Task, earliest first with an `(created_at, id)` keyset cursor: every
   * internal Session the Task's own Sessions created, with their descendants, ended ones included.
   * Each row carries a title — its stored title, or the start of the first collaboration message it
   * received, which is the work it was created for — and its latest activity: its creation, its
   * end, or the newest collaboration message it sent or received.
   * The page is cut on the related identities, so a Task with a hundred thousand related Sessions
   * resolves only the page's rows.
   */
  async #internalSessionRows(
    executor: QueryExecutor,
    accountId: string,
    scope: TaskScope,
    page: { cursor?: TaskCursor; limit?: number },
  ): Promise<InternalSessionRow[]> {
    const rows = await executor.execute<InternalSessionRow>(sql`
      with recursive ${taskCtes({ accountId, scope, now: this.#now() })},
      ${relatedSessionCtes()}
      select
        s.id,
        s.created_by_session_id as "createdBySessionId",
        s.runtime_model as "runtimeModel",
        s.runtime_reasoning_effort as "runtimeReasoningEffort",
        s.ended_at as "endedAt",
        s.created_at as "createdAt",
        coalesce(s.manual_title, s.generated_title) as "title",
        first_message.content as "firstMessage",
        greatest(s.created_at, s.ended_at, latest_received.created_at, latest_sent.created_at) as "lastActivityAt",
        ${cursorText(sql`s.created_at`)} as "cursorAt"
      from (
        -- The keyset order and the page are decided on the related identities alone; only the rows
        -- that survive resolve their Session, so the page never joins the whole related set.
        select r.id
        from internal_related r
        where true
          ${page.cursor ? sql`and (r.created_at, r.id) > (${cursorTimestamp(page.cursor)}, ${page.cursor.id}::uuid)` : sql``}
        order by r.created_at asc, r.id asc
        ${page.limit === undefined ? sql`` : sql`limit ${page.limit}`}
      ) p
      inner join sessions s on s.id = p.id
      -- What the Session was asked to do: the whole body of the first collaboration message it
      -- received. The Server collapses it to one line and caps it, with JavaScript's Unicode
      -- whitespace, so the SQL and the mapper never disagree on what a space is. The body is bounded:
      -- the schema caps it at 16 KiB (session_messages_content_bounds) and only one message per page
      -- row is read.
      left join lateral (
        select m.content
        from session_messages m
        where m.target_session_id = s.id
        order by m.created_at asc, m.id asc
        limit 1
      ) first_message on true
      -- Latest activity reads only the newest message on each side, each a reverse probe of its own
      -- index (session_messages_target_created_idx, session_messages_source_created_idx), so the
      -- enrichment never aggregates a Session's message history.
      left join lateral (
        select m.created_at
        from session_messages m
        where m.target_session_id = s.id
        order by m.created_at desc, m.id desc
        limit 1
      ) latest_received on true
      left join lateral (
        select m.created_at
        from session_messages m
        where m.source_session_id = s.id
        order by m.created_at desc, m.id desc
        limit 1
      ) latest_sent on true
      where s.kind = 'internal'
      order by s.created_at asc, s.id asc
    `);
    return [...rows];
  }

  /**
   * Collaboration messages exchanged by the Task's own Sessions and its Internal Sessions, oldest
   * first with an `(created_at, id)` keyset cursor. A message names its source Session, or a
   * Server-scheduled origin instead of one, so both directions are matched inside SQL: a join on the
   * source and a join on the target, so each side is a relational membership test that can use its
   * own index rather than a linear search through an id array. Each side's first page is merged by
   * `UNION` before the final keyset page is cut, so a message whose source and target are both
   * related is read once and can never consume two page slots.
   */
  async #collaborationRows(
    executor: QueryExecutor,
    accountId: string,
    scope: TaskScope,
    page: { cursor?: TaskCursor; limit?: number },
  ): Promise<CollaborationMessageRow[]> {
    const keyset = page.cursor
      ? sql`and (m.created_at, m.id) > (${cursorTimestamp(page.cursor)}, ${page.cursor.id}::uuid)`
      : sql``;
    const limit = page.limit === undefined ? sql`` : sql`limit ${page.limit}`;
    const rows = await executor.execute<CollaborationMessageRow>(sql`
      with recursive ${taskCtes({ accountId, scope, now: this.#now() })},
      ${relatedSessionCtes()},
      -- One relational join per side, each able to use its own source or target index. Each side is
      -- materialized without the page limit, so the planner costs it as the whole join (a hash or
      -- merge join) rather than as a fast-start ordered scan probing every related Session per row;
      -- each side is then cut to the page on its own, so the UNION that keeps a message whose source
      -- and target are both related only once de-duplicates at most two pages, not the history.
      source_matches as materialized (
        select m.id, m.created_at
        from session_messages m
        inner join related_sessions r on r.id = m.source_session_id
        where true ${keyset}
      ),
      target_matches as materialized (
        select m.id, m.created_at
        from session_messages m
        inner join related_sessions r on r.id = m.target_session_id
        where true ${keyset}
      )
      select
        sm.id,
        sm.source_session_id as "sourceSessionId",
        sm.scheduled_origin as "scheduledOrigin",
        sm.target_session_id as "targetSessionId",
        sm.content,
        sm.last_outcome as "outcome",
        sm.attempt_count as "attemptCount",
        sm.last_error_code as "lastErrorCode",
        sm.created_at as "createdAt",
        sm.updated_at as "updatedAt",
        ${cursorText(sql`sm.created_at`)} as "cursorAt"
      from (
        -- The page is cut on the message identity alone; only the rows that survive resolve their
        -- stored content, by primary key, in the page's own order.
        select matched.id, matched.created_at
        from (
          (select sc.id, sc.created_at from source_matches sc order by sc.created_at asc, sc.id asc ${limit})
          union
          (select tg.id, tg.created_at from target_matches tg order by tg.created_at asc, tg.id asc ${limit})
        ) matched
        order by matched.created_at asc, matched.id asc
        ${limit}
      ) p
      inner join session_messages sm on sm.id = p.id
      order by p.created_at asc, p.id asc
    `);
    return [...rows];
  }

  /**
   * The Task list page and the Task summary of one Task, in one statement each: the rollups decide
   * which Tasks qualify, the keyset order cuts the page, and only then does each qualified row
   * resolve its Agent, Session, title message and title text. Nothing here reads more Sessions or
   * messages than the page holds.
   *
   * A Task is titled from its root message: a thread's root message when it is stored, and
   * otherwise the earliest message somebody addressed to the Agent in the Task. The latest stored
   * revision of that message supplies the text.
   */
  async #summaryRows(
    executor: QueryExecutor,
    accountId: string,
    options: {
      agentId?: string;
      cursor?: TaskCursor;
      kind?: "channel" | "thread";
      limit: number;
      scope?: TaskScope;
    },
  ): Promise<TaskSummaryRow[]> {
    const rows = await executor.execute<TaskSummaryRow>(sql`
      with ${taskCtes({ accountId, agentId: options.agentId, scope: options.scope, now: this.#now(), rollups: true })},
      ${taskPageCtes({
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit: options.limit,
      })}
      select
        p.task_id as id,
        sb.agent_id as "agentId",
        sb.agent_name as "agentName",
        sb.agent_display_name as "agentDisplayName",
        sb.agent_avatar_source_url as "agentAvatarSourceUrl",
        sb.runtime_provider as "runtimeProvider",
        sb.provider,
        ts.conversation_kind as "conversationKind",
        case when ts.kind = 'thread' and ts.conversation_kind <> 'dm' then 'thread' else 'channel' end as "sessionKind",
        ts.channel_id as "channelId",
        case when ts.kind = 'thread' and ts.conversation_kind <> 'dm' then ts.thread_key else null end as "threadKey",
        case
          when title.provider_context ->> 'chatMode' in ('group', 'topic', 'p2p')
            then title.provider_context ->> 'chatMode'
          else null
        end as "chatMode",
        case
          when title.provider_context ->> 'groupMessageType' in ('chat', 'thread')
            then title.provider_context ->> 'groupMessageType'
          else null
        end as "groupMessageType",
        coalesce(least(first_direct.occurred_at, ts.created_at), ts.created_at) as "createdAt",
        ts.ended_at as "endedAt",
        ts.manual_title as "manualTitle",
        ts.generated_title as "generatedTitle",
        p.last_activity_at as "lastActivityAt",
        title.content ->> 'fallbackText' as "fallbackText",
        title.content as "titleContent",
        sb.external_bot_id as "addressedExternalId",
        p.has_running as "hasRunning",
        p.has_pending as "hasPending",
        p.latest_state as "deliveryState",
        p.latest_reason as "deliveryReason",
        p.latest_running as "latestRunning",
        p.latest_reported_at as "reportedAt",
        p.latest_turn_report as "turnReport",
        ${cursorText(sql`p.last_activity_at`)} as "cursorAt"
      from page p
      inner join task_sessions ts on ts.id = p.task_id
      inner join scoped_bindings sb on sb.binding_id = ts.im_binding_id
      left join lateral (
        select m.external_message_id, m.occurred_at
        from task_sessions member
        inner join im_message_deliveries d on d.session_id = member.id
        inner join im_messages m on m.id = d.message_id
        where member.task_id = p.task_id
          and member.im_binding_id = ts.im_binding_id
          and member.channel_id = ts.channel_id
          and d.attention = 'direct'
          and not (d.state = 'expired' and d.reason = 'superseded_revision')
        order by m.occurred_at asc, m.id asc
        limit 1
      ) first_direct on true
      left join lateral (
        select m.content, m.provider_context
        from im_messages m
        where m.im_binding_id = ts.im_binding_id
          and m.channel_id = ts.channel_id
          and m.direction = 'inbound'
          and m.external_message_id = coalesce(
            case when ts.kind = 'thread' and ts.conversation_kind <> 'dm' then ${threadRootExternalId("ts")} end,
            first_direct.external_message_id
          )
        order by m.occurred_at desc, m.provider_revision_key desc, m.id desc
        limit 1
      ) root_title on true
      left join lateral (
        select m.content, m.provider_context
        from im_messages m
        where root_title.content is null
          and m.im_binding_id = ts.im_binding_id
          and m.channel_id = ts.channel_id
          and m.direction = 'inbound'
          and m.external_message_id = first_direct.external_message_id
        order by m.occurred_at desc, m.provider_revision_key desc, m.id desc
        limit 1
      ) direct_title on true
      cross join lateral (
        select
          coalesce(root_title.content, direct_title.content) as content,
          coalesce(root_title.provider_context, direct_title.provider_context) as provider_context
      ) title
      order by p.last_activity_at desc, p.task_id desc
    `);
    return [...rows];
  }
}

function scopeFrom(row: ScopeRow | undefined): TaskScope | undefined {
  if (!row?.taskId) return undefined;
  return { bindingId: row.bindingId, channelId: row.channelId, taskId: row.taskId };
}

function requireRow(row: TaskSummaryRow | undefined): TaskSummaryRow {
  // The scope resolved from a stored message the Account owns, so its summary cannot be missing.
  if (!row) throw taskNotFound();
  return row;
}

function turnPage(rows: TaskTurnRow[], limit: number): { items: TaskTurn[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toTurn),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.deliveryId) : null,
  };
}

function internalSessionPage(
  rows: InternalSessionRow[],
  limit: number,
): { items: TaskInternalSession[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toInternalSession),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
  };
}

function collaborationPage(
  rows: CollaborationMessageRow[],
  limit: number,
): { items: TaskCollaborationMessage[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toCollaborationMessage),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
  };
}

function taskNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}

function taskNotQueued(detail: string): AuthServiceError {
  return new AuthServiceError("TASK_NOT_QUEUED", "deterministic", `${detail}, so there is nothing to cancel`, 409);
}

/**
 * How a withdrawal ended: the Task's remaining pending deliveries were all expired; a Turn is
 * running; no row was still pending under the lock, either because another cancel withdrew the
 * whole queue first (`already_cancelled`) or because the rest was rejected or lapsed (`left_queue`);
 * a worker holds a live claim on a pending row (`in_flight`); a pending row was handed to a Computer
 * that has not answered yet (`awaiting_computer`); or nothing was pending to begin with.
 */
export type WithdrawalOutcome =
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
  taskRunning: boolean;
}

/**
 * Why the locked rows of a Task that are still `pending` cannot be withdrawn, or undefined when
 * they can. A running Turn refuses first — including one the locked read is the first to see: an
 * `accepted` or `steered` row is not an exit from the queue but a Turn that took the message while
 * the cancel waited, so the Task is running however the pre-transaction summary looked. Rows that
 * left `pending` under the lock — withdrawn by a concurrent cancel, rejected by a worker, or
 * lapsed — are set aside: they are what the queue no longer holds, and the verdict is about what
 * it still holds. Among the remaining pending rows a
 * live claim outranks a bare dispatch correlation, since a worker is acting on that row now; with
 * neither, the remaining rows are withdrawable. When nothing remains pending, the Task is already
 * cancelled if every row was withdrawn with the cancelled reason, and has left the queue otherwise.
 */
export function withdrawalRefusal(
  rows: readonly LockedDeliveryRow[],
): Exclude<WithdrawalOutcome, "withdrawn"> | undefined {
  if (rows.length === 0) return "nothing";
  if (rows.some((row) => row.taskRunning)) return "running";
  // `accepted` / `steered` are not exits from the queue: a Turn took the message, so the Task is
  // running however the pre-transaction summary looked.
  if (rows.some((row) => row.state === "accepted" || row.state === "steered")) return "running";
  const pending = rows.filter((row) => row.state === "pending");
  if (pending.length === 0) {
    const withdrawn = rows.every((row) => row.state === "expired" && row.reason === TASK_CANCELLED_DELIVERY_REASON);
    return withdrawn ? "already_cancelled" : "left_queue";
  }
  if (pending.some((row) => row.claimed)) return "in_flight";
  if (pending.some((row) => row.dispatched)) return "awaiting_computer";
  return undefined;
}
