import { createHash } from "node:crypto";
import type {
  ImConversationKind,
  InternalSessionRuntimeOverrides,
  Session,
  SessionCliListItem,
  SessionCliListQuery,
  SessionCliListResponse,
  SessionKind,
  SessionPlacement,
} from "@opentag/shared";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  imBindings,
  imMessageDeliveries,
  sessionDescendants,
  sessionMessages,
  sessionPlacements,
  sessions,
  workspaceComputers,
} from "../../db/schema/index.js";
import { projectedComputerId } from "../computers/ownership-projections.js";

type SessionRow = typeof sessions.$inferSelect;
type PlacementRow = typeof sessionPlacements.$inferSelect;
type SessionMessageRow = typeof sessionMessages.$inferSelect;

interface ActiveSessionAuthority {
  session: SessionRow;
  placement: PlacementRow;
  agentId: string;
  computerId: string;
  connectionInstanceId: string;
  workspaceComputerId: string;
}

function hashSessionMessage(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface EnsureChatSessionInTransactionInput {
  imBindingId: string;
  channelId: string;
  conversationKind: ImConversationKind;
  kind: Exclude<SessionKind, "internal">;
  threadKey?: string;
  workspaceComputerId: string;
  now: Date;
}

export interface CreateInternalSessionWithMessageInput {
  creatorSessionId: string;
  creatorComputerId: string;
  creatorConnectionInstanceId: string;
  creatorWorkspaceComputerId: string;
  creatorPlacementGeneration: number;
  messageId: string;
  initialMessage: string;
  overrides?: InternalSessionRuntimeOverrides;
}

export interface AuthorizeAndRecordSessionMessageInput {
  messageId: string;
  sourceSessionId: string;
  sourceComputerId: string;
  sourceConnectionInstanceId: string;
  sourceWorkspaceComputerId: string;
  sourcePlacementGeneration: number;
  targetSessionId: string;
  content: string;
}

export interface AuthorizedSessionMessageRoute {
  agentId: string;
  imBindingId: string;
  sourceSessionId: string;
  sourceConnectionInstanceId: string;
  sourcePlacementGeneration: number;
  sourceWorkspaceComputerId: string;
  targetSessionId: string;
  targetComputerId: string;
  targetWorkspaceComputerId: string;
  targetPlacementGeneration: number;
  targetSessionKind: SessionKind;
  targetCreatorSessionId: string | null;
}

export interface SessionMessageAttempt {
  route: AuthorizedSessionMessageRoute;
  message: SessionMessageRow;
  deduplicated: boolean;
  attemptCount: number | null;
}

export interface CreateInternalSessionWithMessageResult extends SessionMessageAttempt {
  session: Session;
  placement: SessionPlacement;
}

export type SessionMessageOutcome = "accepted" | "rejected" | "unknown" | "unreachable";

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    imBindingId: row.imBindingId,
    channelId: row.channelId,
    conversationKind: row.conversationKind,
    kind: row.kind,
    threadKey: row.threadKey,
    createdBySessionId: row.createdBySessionId,
    runtimeModel: row.runtimeModel,
    runtimeReasoningEffort: row.runtimeReasoningEffort,
    runtimeMaxDurationMs: row.runtimeMaxDurationMs,
    endedAt: row.endedAt?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPlacement(row: PlacementRow): SessionPlacement {
  return {
    sessionId: row.sessionId,
    workspaceComputerId: row.workspaceComputerId,
    generation: row.generation,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class SessionServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class SessionService {
  readonly #database: DatabaseClient;
  readonly #afterPlacementLock: (() => Promise<void>) | undefined;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { afterPlacementLock?: () => Promise<void>; now?: () => Date } = {}) {
    this.#database = database;
    this.#afterPlacementLock = options.afterPlacementLock;
    this.#now = options.now ?? (() => new Date());
  }

  async ensureChatSession(
    scope: { imBindingId: string; channelId: string; conversationKind: ImConversationKind },
    kind: Exclude<SessionKind, "internal">,
    threadKey?: string,
  ): Promise<{ session: Session; placement: SessionPlacement }> {
    return this.#database.transaction(async (transaction) => {
      const workspaceComputerId = await this.#resolveComputer(transaction, scope.imBindingId);
      return this.ensureChatSessionInTransaction(transaction, {
        ...scope,
        kind,
        ...(threadKey ? { threadKey } : {}),
        workspaceComputerId,
        now: this.#now(),
      });
    });
  }

  async ensureChatSessionInTransaction(
    transaction: DatabaseTransaction,
    input: EnsureChatSessionInTransactionInput,
  ): Promise<{ session: Session; placement: SessionPlacement }> {
    if (input.kind === "channel" && input.threadKey !== undefined) {
      throw new SessionServiceError("SESSION_SCOPE_INVALID", "A channel Session cannot have a thread key");
    }
    if (input.kind === "thread" && !input.threadKey) {
      throw new SessionServiceError("SESSION_SCOPE_INVALID", "A thread Session requires a thread key");
    }

    const existing = await this.#findActive(
      transaction,
      input.imBindingId,
      input.channelId,
      input.kind,
      input.threadKey,
    );
    if (existing) return this.#withPlacement(transaction, existing, input.workspaceComputerId, input.now);

    const [created] = await transaction
      .insert(sessions)
      .values({
        imBindingId: input.imBindingId,
        channelId: input.channelId,
        conversationKind: input.conversationKind,
        kind: input.kind,
        threadKey: input.threadKey ?? null,
        createdAt: input.now,
      })
      .onConflictDoNothing()
      .returning();
    const session =
      created ?? (await this.#findActive(transaction, input.imBindingId, input.channelId, input.kind, input.threadKey));
    if (!session) throw new Error("Active Session ensure did not converge");
    return this.#withPlacement(transaction, session, input.workspaceComputerId, input.now);
  }

  async createInternalSessionWithMessage(
    input: CreateInternalSessionWithMessageInput,
  ): Promise<CreateInternalSessionWithMessageResult> {
    return this.#database.transaction(async (transaction) => {
      const creator = await this.#activeSource(transaction, {
        sessionId: input.creatorSessionId,
        computerId: input.creatorComputerId,
        connectionInstanceId: input.creatorConnectionInstanceId,
        workspaceComputerId: input.creatorWorkspaceComputerId,
        placementGeneration: input.creatorPlacementGeneration,
      });
      const contentHash = hashSessionMessage(input.initialMessage);
      const [existing] = await transaction
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.id, input.messageId))
        .limit(1)
        .for("update");
      if (existing) {
        this.#assertMessageIdentity(existing, input.creatorSessionId, existing.targetSessionId, input.initialMessage);
        const target = await this.#activeTarget(transaction, existing.targetSessionId, creator.session);
        if (
          target.session.kind !== "internal" ||
          target.session.createdBySessionId !== input.creatorSessionId ||
          target.session.runtimeModel !== (input.overrides?.model ?? null) ||
          target.session.runtimeReasoningEffort !== (input.overrides?.reasoningEffort ?? null) ||
          target.session.runtimeMaxDurationMs !== (input.overrides?.maxDurationMs ?? null)
        ) {
          throw new SessionServiceError("SESSION_MESSAGE_CONFLICT", "The Session message ID has conflicting input");
        }
        const attempt = await this.#beginAttempt(transaction, existing);
        return {
          session: toSession(target.session),
          placement: toPlacement(target.placement),
          route: this.#route(creator, target),
          message: attempt.message,
          deduplicated: attempt.attemptCount === null,
          attemptCount: attempt.attemptCount,
        };
      }
      const now = this.#now();
      const [created] = await transaction
        .insert(sessions)
        .values({
          imBindingId: creator.session.imBindingId,
          channelId: creator.session.channelId,
          conversationKind: creator.session.conversationKind,
          kind: "internal",
          threadKey: creator.session.threadKey,
          createdBySessionId: input.creatorSessionId,
          runtimeModel: input.overrides?.model ?? null,
          runtimeReasoningEffort: input.overrides?.reasoningEffort ?? null,
          runtimeMaxDurationMs: input.overrides?.maxDurationMs ?? null,
          createdAt: now,
        })
        .returning();
      if (!created) throw new Error("Internal Session insert did not return a row");
      const [placement] = await transaction
        .insert(sessionPlacements)
        .values({
          sessionId: created.id,
          workspaceComputerId: creator.placement.workspaceComputerId,
          computerId: await projectedComputerId(transaction, creator.placement.workspaceComputerId),
          generation: 1,
          updatedAt: now,
        })
        .returning();
      if (!placement) throw new Error("Session placement insert did not return a row");
      const [message] = await transaction
        .insert(sessionMessages)
        .values({
          id: input.messageId,
          sourceSessionId: input.creatorSessionId,
          targetSessionId: created.id,
          content: input.initialMessage,
          contentHash,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!message) {
        const [conflicting] = await transaction
          .select()
          .from(sessionMessages)
          .where(eq(sessionMessages.id, input.messageId))
          .limit(1)
          .for("update");
        if (conflicting) {
          this.#assertMessageIdentity(
            conflicting,
            input.creatorSessionId,
            conflicting.targetSessionId,
            input.initialMessage,
          );
        }
        throw new SessionServiceError("SESSION_MESSAGE_CONFLICT", "The Session message ID is already in use");
      }
      const attempt = await this.#beginAttempt(transaction, message);
      const taskPreview = truncateUtf8(input.initialMessage, 256);
      await transaction.insert(sessionDescendants).values({
        ancestorSessionId: input.creatorSessionId,
        descendantSessionId: created.id,
        depth: 1,
        lastMessageCreatedAt: message.createdAt,
        lastMessageId: message.id,
        lastDeliveryOutcome: attempt.message.lastOutcome,
        taskPreview,
      });
      await transaction.execute(sql`
        insert into session_descendants (
          ancestor_session_id,
          descendant_session_id,
          depth,
          last_message_created_at,
          last_message_id,
          last_delivery_outcome,
          task_preview
        )
        select
          ancestor_session_id,
          ${created.id}::uuid,
          depth + 1,
          ${message.createdAt.toISOString()}::timestamptz,
          ${message.id}::uuid,
          ${attempt.message.lastOutcome},
          ${taskPreview}
        from session_descendants
        where descendant_session_id = ${input.creatorSessionId}::uuid
      `);
      const target = {
        session: created,
        placement,
        computerId: creator.computerId,
        workspaceComputerId: creator.workspaceComputerId,
      };
      return {
        session: toSession(created),
        placement: toPlacement(placement),
        route: this.#route(creator, target),
        message: attempt.message,
        deduplicated: false,
        attemptCount: attempt.attemptCount,
      };
    });
  }

  async authorizeAndRecordMessage(input: AuthorizeAndRecordSessionMessageInput): Promise<SessionMessageAttempt> {
    return this.#database.transaction(async (transaction) => {
      const source = await this.#activeSource(transaction, {
        sessionId: input.sourceSessionId,
        computerId: input.sourceComputerId,
        connectionInstanceId: input.sourceConnectionInstanceId,
        workspaceComputerId: input.sourceWorkspaceComputerId,
        placementGeneration: input.sourcePlacementGeneration,
      });
      const target = await this.#activeTarget(transaction, input.targetSessionId, source.session);
      const [existing] = await transaction
        .select()
        .from(sessionMessages)
        .where(eq(sessionMessages.id, input.messageId))
        .limit(1)
        .for("update");
      let message = existing;
      if (message) {
        this.#assertMessageIdentity(message, input.sourceSessionId, input.targetSessionId, input.content);
      } else {
        const now = this.#now();
        [message] = await transaction
          .insert(sessionMessages)
          .values({
            id: input.messageId,
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
            content: input.content,
            contentHash: hashSessionMessage(input.content),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();
        if (!message) {
          [message] = await transaction
            .select()
            .from(sessionMessages)
            .where(eq(sessionMessages.id, input.messageId))
            .limit(1)
            .for("update");
          if (message) {
            this.#assertMessageIdentity(message, input.sourceSessionId, input.targetSessionId, input.content);
          }
        }
      }
      if (!message) throw new Error("Session message insert did not return a row");
      const attempt = await this.#beginAttempt(transaction, message);
      await this.#recordSessionActivity(transaction, attempt.message, [input.sourceSessionId, input.targetSessionId]);
      return {
        route: this.#route(source, target),
        message: attempt.message,
        deduplicated: attempt.attemptCount === null,
        attemptCount: attempt.attemptCount,
      };
    });
  }

  async withCollaborationDispatchAdmission<T>(
    route: AuthorizedSessionMessageRoute,
    operation: (onDispatched: () => void) => Promise<T>,
  ): Promise<{ admitted: false } | { admitted: true; result: Promise<T> }> {
    return this.#database.transaction(async (transaction) => {
      const [agent] = await transaction
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, route.agentId))
        .limit(1)
        .for("update");
      if (agent?.status !== "active") return { admitted: false } as const;

      const [binding] = await transaction
        .select({ agentId: imBindings.agentId, status: imBindings.status })
        .from(imBindings)
        .where(eq(imBindings.id, route.imBindingId))
        .limit(1)
        .for("update");
      if (binding?.agentId !== route.agentId || binding.status !== "active") return { admitted: false } as const;

      const authoritySessionIds = [...new Set([route.sourceSessionId, route.targetSessionId])].sort();
      const authoritySessions = await transaction
        .select({ id: sessions.id, imBindingId: sessions.imBindingId, endedAt: sessions.endedAt })
        .from(sessions)
        .where(inArray(sessions.id, authoritySessionIds))
        .orderBy(sessions.id)
        .for("update");
      if (
        authoritySessions.length !== authoritySessionIds.length ||
        authoritySessions.some(({ endedAt, imBindingId }) => endedAt !== null || imBindingId !== route.imBindingId)
      ) {
        return { admitted: false } as const;
      }

      const authorityPlacementIds = [...new Set([route.sourceSessionId, route.targetSessionId])].sort();
      const authorityPlacements = await transaction
        .select({
          generation: sessionPlacements.generation,
          sessionId: sessionPlacements.sessionId,
          workspaceComputerId: sessionPlacements.workspaceComputerId,
        })
        .from(sessionPlacements)
        .where(inArray(sessionPlacements.sessionId, authorityPlacementIds))
        .orderBy(sessionPlacements.sessionId)
        .for("update");
      const sourcePlacement = authorityPlacements.find(({ sessionId }) => sessionId === route.sourceSessionId);
      const targetPlacement = authorityPlacements.find(({ sessionId }) => sessionId === route.targetSessionId);
      if (
        authorityPlacements.length !== authorityPlacementIds.length ||
        sourcePlacement?.workspaceComputerId !== route.sourceWorkspaceComputerId ||
        sourcePlacement.generation !== route.sourcePlacementGeneration ||
        targetPlacement?.workspaceComputerId !== route.targetWorkspaceComputerId ||
        targetPlacement.generation !== route.targetPlacementGeneration
      ) {
        return { admitted: false } as const;
      }

      const [sourceComputer] = await transaction
        .select({
          currentInstanceId: workspaceComputers.currentInstanceId,
          revokedAt: workspaceComputers.revokedAt,
        })
        .from(workspaceComputers)
        .where(eq(workspaceComputers.id, route.sourceWorkspaceComputerId))
        .limit(1)
        .for("update");
      if (
        !sourceComputer ||
        sourceComputer.revokedAt !== null ||
        sourceComputer.currentInstanceId !== route.sourceConnectionInstanceId
      ) {
        return { admitted: false } as const;
      }

      let markDispatched: () => void = () => undefined;
      const dispatched = new Promise<void>((resolve) => {
        markDispatched = resolve;
      });
      let result: Promise<T>;
      try {
        result = operation(markDispatched);
      } catch (error) {
        markDispatched();
        throw error;
      }
      void result.catch(() => markDispatched());
      await dispatched;
      return { admitted: true, result } as const;
    });
  }

  async recordMessageOutcome(input: {
    messageId: string;
    attemptCount: number;
    outcome: SessionMessageOutcome;
    errorCode?: string;
  }): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const now = this.#now();
      const [updated] = await transaction
        .update(sessionMessages)
        .set({
          lastOutcome: input.outcome,
          lastErrorCode: input.errorCode ?? null,
          updatedAt: now,
        })
        .where(and(eq(sessionMessages.id, input.messageId), eq(sessionMessages.attemptCount, input.attemptCount)))
        .returning({ id: sessionMessages.id });
      if (!updated) return false;
      await transaction
        .update(sessionDescendants)
        .set({ lastDeliveryOutcome: input.outcome })
        .where(eq(sessionDescendants.lastMessageId, input.messageId));
      return true;
    });
  }

  async listInternalSessions(sourceSessionId: string, query: SessionCliListQuery): Promise<SessionCliListResponse> {
    const cursor = query.cursor ? decodeListCursor(query.cursor) : undefined;
    const since = query.since ? new Date(query.since) : undefined;
    type ListRow = {
      sessionId: string;
      parentSessionId: string;
      createdAt: Date | string;
      lastMessageAt: Date | string;
      lastMessageId: string;
      lastDeliveryOutcome: SessionCliListItem["lastDeliveryOutcome"];
      taskPreview: string;
    };
    const rows = await this.#database.execute<ListRow>(sql`
      select
        link.descendant_session_id as "sessionId",
        child.created_by_session_id as "parentSessionId",
        child.created_at as "createdAt",
        link.last_message_created_at as "lastMessageAt",
        link.last_message_id as "lastMessageId",
        link.last_delivery_outcome as "lastDeliveryOutcome",
        link.task_preview as "taskPreview"
      from session_descendants link
      inner join sessions child on child.id = link.descendant_session_id
      where link.ancestor_session_id = ${sourceSessionId}::uuid
        and child.ended_at is null
        ${query.recursive ? sql`` : sql`and link.depth = 1`}
        ${since ? sql`and link.last_message_created_at >= ${since.toISOString()}::timestamptz` : sql``}
        ${
          cursor
            ? sql`and (link.last_message_created_at, link.last_message_id, link.descendant_session_id) < (${cursor.at.toISOString()}::timestamptz, ${cursor.messageId}::uuid, ${cursor.sessionId}::uuid)`
            : sql``
        }
      order by link.last_message_created_at desc, link.last_message_id desc, link.descendant_session_id desc
      limit ${query.limit + 1}
    `);
    const page = [...rows].slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        sessionId: row.sessionId,
        parentSessionId: row.parentSessionId,
        createdAt: new Date(row.createdAt).toISOString(),
        lastMessageAt: new Date(row.lastMessageAt).toISOString(),
        lastDeliveryOutcome: row.lastDeliveryOutcome,
        taskPreview: truncateUtf8(row.taskPreview, 256),
      })),
      ...(rows.length > query.limit && last
        ? { nextCursor: encodeListCursor(new Date(last.lastMessageAt), last.lastMessageId, last.sessionId) }
        : {}),
    };
  }

  async #recordSessionActivity(
    transaction: DatabaseTransaction,
    message: SessionMessageRow,
    sessionIds: readonly string[],
  ): Promise<void> {
    await transaction.execute(sql`
      update session_descendants
      set
        last_message_created_at = ${message.createdAt.toISOString()}::timestamptz,
        last_message_id = ${message.id}::uuid,
        last_delivery_outcome = ${message.lastOutcome}
      where descendant_session_id in (${sql.join(
        [...new Set(sessionIds)].map((sessionId) => sql`${sessionId}::uuid`),
        sql`, `,
      )})
        and (last_message_created_at, last_message_id) <= (
          ${message.createdAt.toISOString()}::timestamptz,
          ${message.id}::uuid
        )
    `);
  }

  async movePlacement(sessionId: string, workspaceComputerId: string): Promise<SessionPlacement> {
    return this.#database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ placement: sessionPlacements })
        .from(sessionPlacements)
        .innerJoin(sessions, eq(sessions.id, sessionPlacements.sessionId))
        .where(and(eq(sessionPlacements.sessionId, sessionId), isNull(sessions.endedAt)))
        .limit(1)
        .for("update", { of: sessionPlacements });
      if (!current) throw new SessionServiceError("SESSION_NOT_FOUND", "The Session placement was not found");
      await this.#afterPlacementLock?.();

      const [uncertainCustody] = await transaction
        .select({ id: imMessageDeliveries.id, state: imMessageDeliveries.state })
        .from(imMessageDeliveries)
        .where(
          and(
            eq(imMessageDeliveries.sessionId, sessionId),
            or(
              and(eq(imMessageDeliveries.state, "accepted"), isNull(imMessageDeliveries.reportedAt)),
              and(
                inArray(imMessageDeliveries.state, ["pending", "expired"]),
                isNotNull(imMessageDeliveries.dispatchRequestId),
              ),
            ),
          ),
        )
        .limit(1);
      if (uncertainCustody) {
        throw new SessionServiceError(
          uncertainCustody.state === "accepted"
            ? "SESSION_PLACEMENT_CUSTODY_PENDING"
            : "SESSION_PLACEMENT_CUSTODY_UNCERTAIN",
          uncertainCustody.state === "accepted"
            ? "The Session has accepted runtime custody that must report before placement can move"
            : "The Session has an unresolved runtime dispatch that must reconcile before placement can move",
        );
      }

      const generation = current.placement.generation + 1;
      const now = this.#now();
      await transaction
        .update(imMessageDeliveries)
        .set({
          placementGeneration: generation,
          nextAttemptAt: now,
          lastErrorCode: "IM_DELIVERY_PLACEMENT_MOVED",
        })
        .where(and(eq(imMessageDeliveries.sessionId, sessionId), eq(imMessageDeliveries.state, "pending")));
      const [placement] = await transaction
        .update(sessionPlacements)
        .set({
          workspaceComputerId,
          computerId: (await projectedComputerId(transaction, workspaceComputerId)) ?? null,
          generation,
          updatedAt: now,
        })
        .where(eq(sessionPlacements.sessionId, sessionId))
        .returning();
      if (!placement) throw new SessionServiceError("SESSION_NOT_FOUND", "The Session placement was not found");
      return toPlacement(placement);
    });
  }

  async assertPlacement(sessionId: string, workspaceComputerId: string, generation: number): Promise<void> {
    const [placement] = await this.#database
      .select({ sessionId: sessionPlacements.sessionId })
      .from(sessionPlacements)
      .innerJoin(sessions, eq(sessions.id, sessionPlacements.sessionId))
      .where(
        and(
          eq(sessionPlacements.sessionId, sessionId),
          eq(sessionPlacements.workspaceComputerId, workspaceComputerId),
          eq(sessionPlacements.generation, generation),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    if (!placement) throw new SessionServiceError("SESSION_PLACEMENT_STALE", "The Session placement is stale");
  }

  async #activeSource(
    transaction: DatabaseTransaction,
    input: {
      sessionId: string;
      computerId: string;
      connectionInstanceId: string;
      workspaceComputerId: string;
      placementGeneration: number;
    },
  ): Promise<ActiveSessionAuthority> {
    const [source] = await transaction
      .select({
        session: sessions,
        placement: sessionPlacements,
        agentId: agents.id,
        computerId: workspaceComputers.computerId,
        connectionInstanceId: workspaceComputers.currentInstanceId,
        workspaceComputerId: workspaceComputers.id,
      })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(
        workspaceComputers,
        and(
          eq(workspaceComputers.workspaceId, agents.workspaceId),
          eq(workspaceComputers.id, sessionPlacements.workspaceComputerId),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .where(
        and(
          eq(sessions.id, input.sessionId),
          isNull(sessions.endedAt),
          eq(imBindings.status, "active"),
          eq(agents.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    if (!source) throw new SessionServiceError("SESSION_SOURCE_UNAVAILABLE", "The source Session is not active");
    if (
      source.computerId !== input.computerId ||
      source.connectionInstanceId !== input.connectionInstanceId ||
      source.workspaceComputerId !== input.workspaceComputerId ||
      source.placement.generation !== input.placementGeneration
    ) {
      throw new SessionServiceError("SESSION_PLACEMENT_STALE", "The source Session placement is stale");
    }
    return { ...source, connectionInstanceId: input.connectionInstanceId };
  }

  async #activeTarget(
    transaction: DatabaseTransaction,
    targetSessionId: string,
    sourceSession: SessionRow,
  ): Promise<{ session: SessionRow; placement: PlacementRow; computerId: string; workspaceComputerId: string }> {
    const [target] = await transaction
      .select({
        session: sessions,
        placement: sessionPlacements,
        computerId: workspaceComputers.computerId,
        workspaceComputerId: workspaceComputers.id,
      })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(
        workspaceComputers,
        and(
          eq(workspaceComputers.workspaceId, agents.workspaceId),
          eq(workspaceComputers.id, sessionPlacements.workspaceComputerId),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .where(and(eq(sessions.id, targetSessionId), isNull(sessions.endedAt)))
      .limit(1)
      .for("update");
    if (!target) throw new SessionServiceError("SESSION_TARGET_UNAVAILABLE", "The target Session is not active");
    if (
      target.session.imBindingId !== sourceSession.imBindingId ||
      target.session.channelId !== sourceSession.channelId ||
      target.session.conversationKind !== sourceSession.conversationKind ||
      target.session.threadKey !== sourceSession.threadKey
    ) {
      throw new SessionServiceError("SESSION_SCOPE_MISMATCH", "The target Session has a different collaboration scope");
    }
    return target;
  }

  #assertMessageIdentity(
    message: SessionMessageRow,
    sourceSessionId: string,
    targetSessionId: string,
    content: string,
  ): void {
    if (
      message.sourceSessionId !== sourceSessionId ||
      message.targetSessionId !== targetSessionId ||
      message.contentHash !== hashSessionMessage(content) ||
      message.content !== content
    ) {
      throw new SessionServiceError("SESSION_MESSAGE_CONFLICT", "The Session message ID has conflicting input");
    }
  }

  async #beginAttempt(
    transaction: DatabaseTransaction,
    message: SessionMessageRow,
  ): Promise<{ message: SessionMessageRow; attemptCount: number | null }> {
    if (message.lastOutcome === "accepted" || message.lastOutcome === "rejected") {
      return { message, attemptCount: null };
    }
    const now = this.#now();
    const [updated] = await transaction
      .update(sessionMessages)
      .set({
        attemptCount: message.attemptCount + 1,
        lastAttemptAt: now,
        lastOutcome: "unknown",
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(and(eq(sessionMessages.id, message.id), eq(sessionMessages.attemptCount, message.attemptCount)))
      .returning();
    if (!updated) throw new Error("Session message attempt did not acquire its fence");
    return { message: updated, attemptCount: updated.attemptCount };
  }

  #route(
    source: ActiveSessionAuthority,
    target: { session: SessionRow; placement: PlacementRow; computerId: string; workspaceComputerId: string },
  ): AuthorizedSessionMessageRoute {
    return {
      agentId: source.agentId,
      imBindingId: source.session.imBindingId,
      sourceSessionId: source.session.id,
      sourceConnectionInstanceId: source.connectionInstanceId,
      sourcePlacementGeneration: source.placement.generation,
      sourceWorkspaceComputerId: source.workspaceComputerId,
      targetSessionId: target.session.id,
      targetComputerId: target.computerId,
      targetWorkspaceComputerId: target.workspaceComputerId,
      targetPlacementGeneration: target.placement.generation,
      targetSessionKind: target.session.kind,
      targetCreatorSessionId: target.session.createdBySessionId,
    };
  }

  async #resolveComputer(transaction: DatabaseTransaction, imBindingId: string): Promise<string> {
    const [candidate] = await transaction
      .select({ agentId: agents.id })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(eq(imBindings.id, imBindingId))
      .limit(1);
    if (!candidate) throw new SessionServiceError("IM_BINDING_NOT_ACTIVE", "The IM binding is not active");
    const [agent] = await transaction
      .select({ workspaceComputerId: agents.workspaceComputerId })
      .from(agents)
      .where(and(eq(agents.id, candidate.agentId), eq(agents.status, "active")))
      .limit(1)
      .for("update");
    if (!agent) throw new SessionServiceError("AGENT_NOT_ACTIVE", "The Agent is not active");
    const [binding] = await transaction
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(
        and(eq(imBindings.id, imBindingId), eq(imBindings.agentId, candidate.agentId), eq(imBindings.status, "active")),
      )
      .limit(1);
    if (!binding) throw new SessionServiceError("IM_BINDING_NOT_ACTIVE", "The IM binding is not active");
    return agent.workspaceComputerId;
  }

  async #findActive(
    transaction: DatabaseTransaction,
    imBindingId: string,
    channelId: string,
    kind: Exclude<SessionKind, "internal">,
    threadKey?: string,
  ): Promise<SessionRow | undefined> {
    const [session] = await transaction
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.imBindingId, imBindingId),
          eq(sessions.channelId, channelId),
          eq(sessions.kind, kind),
          kind === "channel" ? isNull(sessions.threadKey) : eq(sessions.threadKey, threadKey ?? ""),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    return session;
  }

  async #withPlacement(
    transaction: DatabaseTransaction,
    session: SessionRow,
    workspaceComputerId: string,
    now = this.#now(),
  ): Promise<{ session: Session; placement: SessionPlacement }> {
    const [existing] = await transaction
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, session.id))
      .limit(1);
    const placement =
      existing ??
      (
        await transaction
          .insert(sessionPlacements)
          .values({
            sessionId: session.id,
            workspaceComputerId,
            computerId: await projectedComputerId(transaction, workspaceComputerId),
            generation: 1,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning()
      )[0];
    if (placement) return { session: toSession(session), placement: toPlacement(placement) };
    const [converged] = await transaction
      .select()
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, session.id))
      .limit(1);
    if (!converged) throw new Error("Session placement ensure did not converge");
    return { session: toSession(session), placement: toPlacement(converged) };
  }
}

function encodeListCursor(at: Date, messageId: string, sessionId: string): string {
  return Buffer.from(JSON.stringify({ v: 2, at: at.toISOString(), messageId, sessionId }), "utf8").toString(
    "base64url",
  );
}

function decodeListCursor(cursor: string): { at: Date; messageId: string; sessionId: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("v" in value) ||
      value.v !== 2 ||
      !("at" in value) ||
      typeof value.at !== "string" ||
      Number.isNaN(new Date(value.at).getTime()) ||
      !("messageId" in value) ||
      typeof value.messageId !== "string" ||
      !isUuid(value.messageId) ||
      !("sessionId" in value) ||
      typeof value.sessionId !== "string" ||
      !isUuid(value.sessionId)
    ) {
      throw new Error("invalid");
    }
    return { at: new Date(value.at), messageId: value.messageId, sessionId: value.sessionId };
  } catch {
    throw new SessionServiceError("SESSION_CURSOR_INVALID", "The Session list cursor is invalid");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}…`, "utf8") > maxBytes) break;
    result += character;
  }
  return `${result}…`;
}
