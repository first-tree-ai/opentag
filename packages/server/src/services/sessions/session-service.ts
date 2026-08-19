import type { Session, SessionKind, SessionPlacement } from "@opentag/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, imConversations, integrations, sessionPlacements, sessions } from "../../db/schema/index.js";

type SessionRow = typeof sessions.$inferSelect;
type PlacementRow = typeof sessionPlacements.$inferSelect;

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind,
    threadKey: row.threadKey,
    createdBySessionId: row.createdBySessionId,
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
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async ensureChatSession(
    conversationId: string,
    kind: Exclude<SessionKind, "internal">,
    threadKey?: string,
  ): Promise<{ session: Session; placement: SessionPlacement }> {
    if (kind === "channel" && threadKey !== undefined) {
      throw new SessionServiceError("SESSION_SCOPE_INVALID", "A channel Session cannot have a thread key");
    }
    if (kind === "thread" && !threadKey) {
      throw new SessionServiceError("SESSION_SCOPE_INVALID", "A thread Session requires a thread key");
    }

    return this.#database.transaction(async (transaction) => {
      const computerId = await this.#resolveComputer(transaction, conversationId);
      const existing = await this.#findActive(transaction, conversationId, kind, threadKey);
      if (existing) return this.#withPlacement(transaction, existing, computerId);

      const [created] = await transaction
        .insert(sessions)
        .values({ conversationId, kind, threadKey: threadKey ?? null, createdAt: this.#now() })
        .onConflictDoNothing()
        .returning();
      const session = created ?? (await this.#findActive(transaction, conversationId, kind, threadKey));
      if (!session) throw new Error("Active Session ensure did not converge");
      return this.#withPlacement(transaction, session, computerId);
    });
  }

  async createInternalSession(creatorSessionId: string): Promise<{ session: Session; placement: SessionPlacement }> {
    return this.#database.transaction(async (transaction) => {
      const [creator] = await transaction
        .select({ session: sessions, computerId: sessionPlacements.computerId })
        .from(sessions)
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
        .where(and(eq(sessions.id, creatorSessionId), isNull(sessions.endedAt)))
        .limit(1)
        .for("update");
      if (!creator) throw new SessionServiceError("SESSION_NOT_ACTIVE", "The creator Session is not active");
      const [created] = await transaction
        .insert(sessions)
        .values({
          conversationId: creator.session.conversationId,
          kind: "internal",
          threadKey: creator.session.threadKey,
          createdBySessionId: creatorSessionId,
          createdAt: this.#now(),
        })
        .returning();
      if (!created) throw new Error("Internal Session insert did not return a row");
      const [placement] = await transaction
        .insert(sessionPlacements)
        .values({ sessionId: created.id, computerId: creator.computerId, generation: 1, updatedAt: this.#now() })
        .returning();
      if (!placement) throw new Error("Session placement insert did not return a row");
      return { session: toSession(created), placement: toPlacement(placement) };
    });
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
    const [placement] = await this.#database
      .update(sessionPlacements)
      .set({ computerId, generation: sql`${sessionPlacements.generation} + 1`, updatedAt: this.#now() })
      .where(eq(sessionPlacements.sessionId, sessionId))
      .returning();
    if (!placement) throw new SessionServiceError("SESSION_NOT_FOUND", "The Session placement was not found");
    return toPlacement(placement);
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

  async #resolveComputer(transaction: DatabaseTransaction, conversationId: string): Promise<string> {
    const [scope] = await transaction
      .select({ computerId: agents.computerId })
      .from(imConversations)
      .innerJoin(integrations, eq(integrations.id, imConversations.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .where(
        and(
          eq(imConversations.id, conversationId),
          isNull(imConversations.detachedAt),
          isNull(integrations.disabledAt),
        ),
      )
      .limit(1);
    if (!scope) throw new SessionServiceError("CONVERSATION_NOT_ACTIVE", "The IM conversation is not active");
    return scope.computerId;
  }

  async #findActive(
    transaction: DatabaseTransaction,
    conversationId: string,
    kind: Exclude<SessionKind, "internal">,
    threadKey?: string,
  ): Promise<SessionRow | undefined> {
    const [session] = await transaction
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.conversationId, conversationId),
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
          .values({ sessionId: session.id, computerId, generation: 1, updatedAt: this.#now() })
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
