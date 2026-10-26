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
  privateConversation,
  relatedSessionCtes,
  type TopicScope,
  topicCtes,
  topicKeyExpression,
  topicPageCtes,
} from "./task-sql.js";

export { TaskQueryError } from "./task-error.js";
export type { TopicScope } from "./task-sql.js";

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
  topicKey: string | null;
}

function sectionLimit(limit: number | undefined): number {
  if (limit === undefined) return TASK_SECTION_DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), TASK_SECTION_MAX_LIMIT);
}

/**
 * A Task is a read-only projection over stored IM messages and their deliveries. Inside a group,
 * channel, or multi-person direct message it is one topic: the root message plus the reply chain
 * around it. A private chat is one Task. A topic is listed only once somebody addressed the Agent
 * directly; overheard-only chatter is not a Task. Nothing here changes delivery, Session
 * materialization, or the runtime.
 *
 * Reads are split by cost. The list decides its page from the topic rollups and enriches only the
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
    const scope = await this.#scopeOfMessage(this.database, accountId, taskId);
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
   * Set or clear the Account-owned manual title of a Task. The id may be the Task's own id (a
   * message of the topic) or one of its Sessions. The title is stored on the Session the Task reads
   * it from: the topic's thread Session, or the channel Session of a private chat. A top-level group
   * request nobody replied to has no such Session and cannot be renamed yet.
   */
  async updateTitle(accountId: string, id: string, title: string | null): Promise<TaskSummary> {
    const normalizedTitle = title === null ? null : TaskTitleSchema.parse(title);
    const scope =
      (await this.#scopeOfSession(accountId, id)) ?? (await this.#scopeOfMessage(this.database, accountId, id));
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
    const [row] = await this.#summaryRows(this.database, accountId, { scope, limit: 1 });
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
    const scope =
      (await this.#scopeOfMessage(this.database, accountId, id)) ?? (await this.#scopeOfSession(accountId, id));
    if (!scope) throw taskNotFound();
    const [before] = await this.#summaryRows(this.database, accountId, { scope, limit: 1 });
    if (!before) throw taskNotFound();
    const status = taskStatus(before);
    if (status === "cancelled") return toSummary(before);
    if (status !== "queued") throw taskNotQueued(`The Task is ${status}, not queued`);
    const outcome = await this.#withdrawQueuedDeliveries(accountId, scope);
    if (outcome === "running") throw taskNotQueued("The Task is running, not queued");
    if (outcome === "in_flight") throw taskNotQueued("The Task's queued message is already being delivered");
    if (outcome === "awaiting_computer")
      throw taskNotQueued("The Task's queued message was handed to a Computer that has not reported back yet");
    const [after] = await this.#summaryRows(this.database, accountId, { scope, limit: 1 });
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
   * The Task's platform-confirmed outbound replies, newest first with an independent
   * `(occurred_at, id)` keyset cursor. The anchor is an authorized stored inbound message, and its
   * scope is resolved from stored IM data only — the binding's Account ownership, the message's
   * channel, and its native conversation and thread/root context. No runtime Session, Sandbox,
   * worker, or Pi state is consulted, so captured replies are readable before any execution, and
   * no delivery is ever created by the write side of this feature. An empty page means there is no
   * captured record, never proof that nothing was sent.
   */
  async listReplies(accountId: string, taskId: string, options: GetTaskOptions): Promise<ListTaskRepliesResponse> {
    const cursor = parseCursor(options.cursor);
    const scope = await this.#replyScopeOfMessage(accountId, taskId);
    if (!scope) throw taskNotFound();
    const rows = await this.#replyRows(scope, cursor, options.limit + 1);
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page.map(toReply),
      nextCursor: rows.length > options.limit && last ? encodeCursor(last.cursorAt, last.id) : null,
    };
  }

  /**
   * One read-only Repeatable Read transaction: authorization, the summary and every section see one
   * snapshot, and its executor is the only connection the statements use. Nothing here performs
   * external I/O, so the transaction never spans a wait.
   */
  async #readSnapshot<T>(
    accountId: string,
    taskId: string,
    read: (executor: DatabaseTransaction, scope: TopicScope) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(
      async (transaction) => {
        const scope = await this.#scopeOfMessage(transaction, accountId, taskId);
        if (!scope) throw taskNotFound();
        return read(transaction, scope);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * The topic a stored message belongs to, or undefined when it is outside the Account. The
   * channel is read by primary key first so the classification only touches that channel; the
   * Account check happens inside the CTE chain, which is empty for a foreign binding.
   */
  async #scopeOfMessage(
    executor: QueryExecutor,
    accountId: string,
    messageId: string,
  ): Promise<TopicScope | undefined> {
    const located = await executor.execute<ChannelScope & Record<string, unknown>>(sql`
      select m.im_binding_id as "bindingId", m.channel_id as "channelId"
      from im_messages m
      where m.id = ${messageId}::uuid
    `);
    const [channel] = [...located];
    if (!channel) return undefined;
    const rows = await executor.execute<ScopeRow>(sql`
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

  /**
   * The Task scope of an authorized stored inbound-message anchor, from stored IM data only: the
   * binding's Account ownership, the anchor's channel, and its native conversation and
   * thread/root context. This is deliberately not `#scopeOfMessage`: the runtime CTE chain reads
   * chat Sessions, and a captured reply must be readable while no Session exists — the normal case
   * for a first confirmed send. Private context comes from the stored provider context, and any
   * unknown or group context keeps a concrete topic key rather than widening to the channel.
   */
  async #replyScopeOfMessage(accountId: string, messageId: string): Promise<TopicScope | undefined> {
    const rows = await this.database.execute<ScopeRow>(sql`
      with anchor as (
        select
          m.im_binding_id,
          m.channel_id,
          m.thread_key,
          m.external_message_id,
          m.provider_context
        from im_messages m
        inner join im_bindings b on b.id = m.im_binding_id
        inner join agents a on a.id = b.agent_id
        where m.id = ${messageId}::uuid
          and m.direction = 'inbound'
          and a.created_by_user_id = ${accountId}::uuid
          and a.status <> 'deleted'
        limit 1
      ),
      thread_roots as (
        select distinct on (m.im_binding_id, m.channel_id, m.thread_key)
          m.im_binding_id,
          m.channel_id,
          m.thread_key,
          m.provider_context ->> 'rootId' as root_external_id
        from im_messages m
        inner join anchor an on an.im_binding_id = m.im_binding_id and an.channel_id = m.channel_id
        where m.direction = 'inbound'
          and m.thread_key is not null
          and m.provider_context ->> 'rootId' is not null
          and m.provider_context ->> 'rootId' <> m.thread_key
        order by m.im_binding_id, m.channel_id, m.thread_key, m.occurred_at asc, m.provider_revision_key asc, m.id asc
      )
      select
        an.im_binding_id as "bindingId",
        an.channel_id as "channelId",
        case
          when ${privateConversation("an")} then null
          else ${topicKeyExpression("an", "tr")}
        end as "topicKey"
      from anchor an
      left join thread_roots tr
        on tr.im_binding_id = an.im_binding_id
        and tr.channel_id = an.channel_id
        and tr.thread_key = an.thread_key
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

  /**
   * Expire every pending delivery of the topic, or none. The transaction first locks the
   * topic's pending rows: the worker's claim steps around locked rows (`for update skip
   * locked`), and its acceptance of a row it already claimed waits behind the lock, so what the
   * locked read shows is what the update acts on. A lock that waited behind a worker's write
   * returns the row as the worker left it: a claim taken in the meantime, or a row the worker
   * accepted or steered into a Turn, refuses the whole withdrawal as running, while a row that
   * was withdrawn, rejected or lapsed is set aside and only the rows still pending are withdrawn
   * — an already withdrawn or rejected row is never stamped again. A lock
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

  /** Newest first with an independent `(occurred_at, delivery id)` keyset cursor. */
  async #turnRows(
    executor: QueryExecutor,
    accountId: string,
    scope: TopicScope,
    cursor: TaskCursor | undefined,
    limit: number,
  ): Promise<TaskTurnRow[]> {
    const rows = await executor.execute<TaskTurnRow>(sql`
      with ${topicCtes({ accountId, scope, now: this.#now() })}
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
   * Captured outbound messages of one resolved Task scope. The topic classification is the same
   * expression the anchor resolved with — the same-binding inbound thread-root mapping first, then
   * the record's own captured native root, then its thread key and its own id — so an outbound
   * record lands in exactly the topic its thread belongs to, including a first reply whose thread
   * has no inbound mapping yet, and a record that cannot be proven to belong is not shown. A
   * private chat (null topic key) takes the whole conversation, as it does inbound.
   */
  async #replyRows(scope: TopicScope, cursor: TaskCursor | undefined, limit: number): Promise<TaskReplyRow[]> {
    const rows = await this.database.execute<TaskReplyRow>(sql`
      with thread_roots as (
        select distinct on (m.im_binding_id, m.channel_id, m.thread_key)
          m.im_binding_id,
          m.channel_id,
          m.thread_key,
          m.provider_context ->> 'rootId' as root_external_id
        from im_messages m
        where m.im_binding_id = ${scope.bindingId}::uuid
          and m.channel_id = ${scope.channelId}
          and m.direction = 'inbound'
          and m.thread_key is not null
          and m.provider_context ->> 'rootId' is not null
          and m.provider_context ->> 'rootId' <> m.thread_key
        order by m.im_binding_id, m.channel_id, m.thread_key, m.occurred_at asc, m.provider_revision_key asc, m.id asc
      )
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
      left join thread_roots tr
        on tr.im_binding_id = m.im_binding_id
        and tr.channel_id = m.channel_id
        and tr.thread_key = m.thread_key
      where m.im_binding_id = ${scope.bindingId}::uuid
        and m.channel_id = ${scope.channelId}
        and m.direction = 'outbound'
        and m.operation = 'created'
        ${scope.topicKey === null ? sql`` : sql`and ${topicKeyExpression("m", "tr")} = ${scope.topicKey}`}
        ${cursor ? sql`and (m.occurred_at, m.id) < (${cursorTimestamp(cursor)}, ${cursor.id}::uuid)` : sql``}
      order by m.occurred_at desc, m.id desc
      limit ${limit}
    `);
    return [...rows];
  }

  /**
   * Internal Sessions of a topic, earliest first with an `(created_at, id)` keyset cursor: those that
   * inherited the topic's scope from a thread or private chat Session, plus those a group's channel
   * Session spawned while it was running one of the topic's Turns, with their descendants. A channel
   * Session runs one Turn at a time, so the creation instant falls inside exactly one Turn's window.
   * The page is cut on the related identities, so a topic with a hundred thousand related Sessions
   * resolves only the page's rows.
   *
   * The spawn window is read from the delivery that owns it: each Turn's `(accepted_at, id)` window
   * is the period between its acceptance and the next acceptance in that Session, and the candidates
   * are found through the sessions creator index. Joining every execution to every internal Session
   * instead — the shape this replaces — pairs the whole history with itself before a single row is
   * discarded.
   */
  async #internalSessionRows(
    executor: QueryExecutor,
    accountId: string,
    scope: TopicScope,
    page: { cursor?: TaskCursor; limit?: number },
  ): Promise<InternalSessionRow[]> {
    const rows = await executor.execute<InternalSessionRow>(sql`
      with recursive ${topicCtes({ accountId, scope, now: this.#now() })},
      ${relatedSessionCtes(scope)}
      select
        s.id,
        s.created_by_session_id as "createdBySessionId",
        s.runtime_model as "runtimeModel",
        s.runtime_reasoning_effort as "runtimeReasoningEffort",
        s.ended_at as "endedAt",
        s.created_at as "createdAt",
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
      where s.kind = 'internal'
      order by s.created_at asc, s.id asc
    `);
    return [...rows];
  }

  /**
   * Collaboration messages exchanged by the topic's own Sessions and its Internal Sessions, oldest
   * first with an `(created_at, id)` keyset cursor. A message names its source Session, or a
   * Server-scheduled origin instead of one, so both directions are matched inside SQL. Both matches
   * are one predicate on the same row rather than two joined branches, so a message whose source and
   * target are both related is read once and can never consume two page slots.
   */
  async #collaborationRows(
    executor: QueryExecutor,
    accountId: string,
    scope: TopicScope,
    page: { cursor?: TaskCursor; limit?: number },
  ): Promise<CollaborationMessageRow[]> {
    const rows = await executor.execute<CollaborationMessageRow>(sql`
      with recursive ${topicCtes({ accountId, scope, now: this.#now() })},
      ${relatedSessionCtes(scope)}
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
        -- The page is cut on the message identity alone, so it reads an ordered index rather than
        -- every message body; only the rows that survive resolve their stored content.
        select m.id
        from session_messages m
        where (
            m.source_session_id = any (array(select id from related_sessions))
            or m.target_session_id = any (array(select id from related_sessions))
          )
          ${page.cursor ? sql`and (m.created_at, m.id) > (${cursorTimestamp(page.cursor)}, ${page.cursor.id}::uuid)` : sql``}
        order by m.created_at asc, m.id asc
        ${page.limit === undefined ? sql`` : sql`limit ${page.limit}`}
      ) p
      inner join session_messages sm on sm.id = p.id
      order by sm.created_at asc, sm.id asc
    `);
    return [...rows];
  }

  /**
   * The Task list page and the Task summary of one topic, in one statement each: the rollups decide
   * which topics qualify, the keyset order cuts the page, and only then does each qualified row
   * resolve its Agent, channel, title Session and title text. Nothing here reads more Sessions or
   * messages than the page holds.
   */
  async #summaryRows(
    executor: QueryExecutor,
    accountId: string,
    options: {
      agentId?: string;
      cursor?: TaskCursor;
      kind?: "channel" | "thread";
      limit: number;
      scope?: TopicScope;
    },
  ): Promise<TaskSummaryRow[]> {
    const rows = await executor.execute<TaskSummaryRow>(sql`
      with ${topicCtes({ accountId, agentId: options.agentId, scope: options.scope, now: this.#now(), rollups: true })},
      ${topicPageCtes({
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit: options.limit,
      })}
      select
        p.anchor_id as id,
        sb.agent_id as "agentId",
        sb.agent_name as "agentName",
        sb.agent_display_name as "agentDisplayName",
        sb.agent_avatar_source_url as "agentAvatarSourceUrl",
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
        p.latest_state as "deliveryState",
        p.latest_reason as "deliveryReason",
        p.latest_running as "latestRunning",
        p.latest_reported_at as "reportedAt",
        p.latest_turn_report as "turnReport",
        ${cursorText(sql`p.last_activity_at`)} as "cursorAt"
      from page p
      inner join scoped_bindings sb on sb.binding_id = p.im_binding_id
      left join channels ch on ch.im_binding_id = p.im_binding_id and ch.channel_id = p.channel_id
      left join channel_sessions cs on cs.im_binding_id = p.im_binding_id and cs.channel_id = p.channel_id
      left join lateral (
        select ts.id, ts.manual_title, ts.generated_title, ts.ended_at
        from topic_sessions ts
        where ts.im_binding_id = p.im_binding_id
          and ts.channel_id = p.channel_id
          and (ts.topic_key = p.topic_key or (ts.topic_key is null and p.topic_key is null))
        limit 1
      ) ts on true
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
 * How a withdrawal ended: the topic's remaining pending deliveries were all expired; a Turn is
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
  topicRunning: boolean;
}

/**
 * Why the locked rows of a topic that are still `pending` cannot be withdrawn, or undefined when
 * they can. A running Turn refuses first — including one the locked read is the first to see: an
 * `accepted` or `steered` row is not an exit from the queue but a Turn that took the message while
 * the cancel waited, so the topic is running however the pre-transaction summary looked. Rows that
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
  if (rows.some((row) => row.topicRunning)) return "running";
  // `accepted` / `steered` are not exits from the queue: a Turn took the message, so the topic is
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
