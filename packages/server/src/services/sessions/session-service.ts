import { createHash } from "node:crypto";
import type {
  ImConversationKind,
  InternalSessionRuntimeOverrides,
  Session,
  SessionKind,
  SessionPlacement,
} from "@opentag/shared";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  imBindings,
  imMessageDeliveries,
  sessionMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";

type SessionRow = typeof sessions.$inferSelect;
type PlacementRow = typeof sessionPlacements.$inferSelect;
type SessionMessageRow = typeof sessionMessages.$inferSelect;

interface ActiveSessionAuthority {
  session: SessionRow;
  placement: PlacementRow;
  agentId: string;
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
  computerId: string;
  now: Date;
}

export interface CreateInternalSessionWithMessageInput {
  creatorSessionId: string;
  creatorComputerId: string;
  creatorPlacementGeneration: number;
  messageId: string;
  initialMessage: string;
  overrides?: InternalSessionRuntimeOverrides;
}

export interface AuthorizeAndRecordSessionMessageInput {
  messageId: string;
  sourceSessionId: string;
  sourceComputerId: string;
  sourcePlacementGeneration: number;
  targetSessionId: string;
  content: string;
}

export interface AuthorizedSessionMessageRoute {
  agentId: string;
  sourceSessionId: string;
  targetSessionId: string;
  targetComputerId: string;
  targetPlacementGeneration: number;
  targetSessionKind: SessionKind;
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
    computerId: row.computerId,
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
      const computerId = await this.#resolveComputer(transaction, scope.imBindingId);
      return this.ensureChatSessionInTransaction(transaction, {
        ...scope,
        kind,
        ...(threadKey ? { threadKey } : {}),
        computerId,
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
    if (existing) return this.#withPlacement(transaction, existing, input.computerId, input.now);

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
    return this.#withPlacement(transaction, session, input.computerId, input.now);
  }

  async createInternalSessionWithMessage(
    input: CreateInternalSessionWithMessageInput,
  ): Promise<CreateInternalSessionWithMessageResult> {
    return this.#database.transaction(async (transaction) => {
      const creator = await this.#activeSource(transaction, {
        sessionId: input.creatorSessionId,
        computerId: input.creatorComputerId,
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
        .values({ sessionId: created.id, computerId: creator.placement.computerId, generation: 1, updatedAt: now })
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
      const target = { session: created, placement };
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
      return {
        route: this.#route(source, target),
        message: attempt.message,
        deduplicated: attempt.attemptCount === null,
        attemptCount: attempt.attemptCount,
      };
    });
  }

  async recordMessageOutcome(input: {
    messageId: string;
    attemptCount: number;
    outcome: SessionMessageOutcome;
    errorCode?: string;
  }): Promise<boolean> {
    const now = this.#now();
    const [updated] = await this.#database
      .update(sessionMessages)
      .set({
        lastOutcome: input.outcome,
        lastErrorCode: input.errorCode ?? null,
        updatedAt: now,
      })
      .where(and(eq(sessionMessages.id, input.messageId), eq(sessionMessages.attemptCount, input.attemptCount)))
      .returning({ id: sessionMessages.id });
    return updated !== undefined;
  }

  async end(sessionId: string): Promise<Session> {
    return this.#database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .for("update");
      if (!current) throw new SessionServiceError("SESSION_NOT_FOUND", "The Session was not found");
      if (current.endedAt) return toSession(current);
      const [ended] = await transaction
        .update(sessions)
        .set({ endedAt: this.#now(), revision: sql`${sessions.revision} + 1` })
        .where(eq(sessions.id, sessionId))
        .returning();
      if (!ended) throw new Error("Session end did not return a row");
      return toSession(ended);
    });
  }

  async movePlacement(sessionId: string, computerId: string): Promise<SessionPlacement> {
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
        .set({ computerId, generation, updatedAt: now })
        .where(eq(sessionPlacements.sessionId, sessionId))
        .returning();
      if (!placement) throw new SessionServiceError("SESSION_NOT_FOUND", "The Session placement was not found");
      return toPlacement(placement);
    });
  }

  async assertPlacement(sessionId: string, computerId: string, generation: number): Promise<void> {
    const [placement] = await this.#database
      .select({ sessionId: sessionPlacements.sessionId })
      .from(sessionPlacements)
      .innerJoin(sessions, eq(sessions.id, sessionPlacements.sessionId))
      .where(
        and(
          eq(sessionPlacements.sessionId, sessionId),
          eq(sessionPlacements.computerId, computerId),
          eq(sessionPlacements.generation, generation),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    if (!placement) throw new SessionServiceError("SESSION_PLACEMENT_STALE", "The Session placement is stale");
  }

  async #activeSource(
    transaction: DatabaseTransaction,
    input: { sessionId: string; computerId: string; placementGeneration: number },
  ): Promise<ActiveSessionAuthority> {
    const [source] = await transaction
      .select({ session: sessions, placement: sessionPlacements, agentId: agents.id })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
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
    if (source.placement.computerId !== input.computerId || source.placement.generation !== input.placementGeneration) {
      throw new SessionServiceError("SESSION_PLACEMENT_STALE", "The source Session placement is stale");
    }
    return source;
  }

  async #activeTarget(
    transaction: DatabaseTransaction,
    targetSessionId: string,
    sourceSession: SessionRow,
  ): Promise<{ session: SessionRow; placement: PlacementRow }> {
    const [target] = await transaction
      .select({ session: sessions, placement: sessionPlacements })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
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
    target: { session: SessionRow; placement: PlacementRow },
  ): AuthorizedSessionMessageRoute {
    return {
      agentId: source.agentId,
      sourceSessionId: source.session.id,
      targetSessionId: target.session.id,
      targetComputerId: target.placement.computerId,
      targetPlacementGeneration: target.placement.generation,
      targetSessionKind: target.session.kind,
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
      .select({ computerId: agents.computerId })
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
    return agent.computerId;
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
    computerId: string,
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
          .values({ sessionId: session.id, computerId, generation: 1, updatedAt: now })
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
