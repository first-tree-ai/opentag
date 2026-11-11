import { createHash } from "node:crypto";
import type {
  AgentScheduleLastDispatch,
  CloudModelOptions,
  ImConversationKind,
  InternalSessionRuntimeOverrides,
  Session,
  SessionCliListItem,
  SessionCliListQuery,
  SessionCliListResponse,
  SessionKind,
  SessionMessageScheduledOrigin,
  SessionPlacement,
} from "@opentag/shared";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agentSchedules,
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  sessionDescendants,
  sessionMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { CloudModelCatalog } from "../sandboxes/cloud-model-catalog.js";
import { markEndedDescendantsInactive } from "./session-closure.js";
import {
  deliveryFailureNoticeMessageId,
  isDeliveryFailureNotice,
  renderDeliveryFailureNotice,
  SESSION_MESSAGE_HELD_CODE,
  SESSION_MESSAGE_TARGET_STOPPED_CODE,
} from "./session-held-delivery.js";
import { isRunOutcomeNotice } from "./session-run-outcome-notice.js";

type SessionRow = typeof sessions.$inferSelect;
type PlacementRow = typeof sessionPlacements.$inferSelect;
type SessionMessageRow = typeof sessionMessages.$inferSelect;
type SessionScope = Pick<SessionRow, "imBindingId" | "channelId" | "conversationKind" | "threadKey">;
type AuthorityComputer = Pick<
  typeof computers.$inferSelect,
  "id" | "ownerAccountId" | "currentInstallationId" | "currentInstanceId" | "kind"
>;

interface SourceAgentAuthority {
  agentId: string;
  agentOwnerId: string;
  session: SessionScope & { id: string };
}

interface LockedCollaborationAuthority {
  agentId: string;
  agentOwnerId: string;
  sessions: SessionRow[];
  placements: PlacementRow[];
  computers: AuthorityComputer[];
}

function sameSessionScope(left: SessionScope, right: SessionScope): boolean {
  return (
    left.imBindingId === right.imBindingId &&
    left.channelId === right.channelId &&
    left.conversationKind === right.conversationKind &&
    left.threadKey === right.threadKey
  );
}

interface ActiveSessionAuthority {
  session: SessionRow;
  placement: PlacementRow;
  agentId: string;
  computerId: string;
  computerKind: "local" | "cloud";
  connectionInstanceId: string;
  installationId: string;
}

function hashSessionMessage(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function internalSessionInputMatches(target: SessionRow, input: CreateInternalSessionWithMessageInput): boolean {
  return (
    target.kind === "internal" &&
    target.createdBySessionId === input.creatorSessionId &&
    target.runtimeModel === (input.overrides?.model ?? null) &&
    target.runtimeReasoningEffort === (input.overrides?.reasoningEffort ?? null) &&
    target.runtimeMaxDurationMs === (input.overrides?.maxDurationMs ?? null)
  );
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
  userTaskSource?: import("./session-cli-proof-service.js").SessionCliSourceContext["userTaskSource"];
  creatorSessionId: string;
  creatorInstallationId: string;
  creatorConnectionInstanceId: string;
  creatorComputerId: string;
  creatorPlacementGeneration: number;
  messageId: string;
  initialMessage: string;
  overrides?: InternalSessionRuntimeOverrides;
}

export interface StopInternalSessionInput {
  sourceSessionId: string;
  sourceInstallationId: string;
  sourceConnectionInstanceId: string;
  sourceComputerId: string;
  sourcePlacementGeneration: number;
  targetSessionId: string;
}

/** Where an ended internal Session's execution side lives, to tell it to stop. */
export interface InternalSessionStopTarget {
  agentId: string;
  computerId: string;
  computerKind: "local" | "cloud";
  creatorSessionId: string;
  installationId: string;
  placementGeneration: number;
  sessionId: string;
}

export interface StoppedInternalSession {
  target: InternalSessionStopTarget;
  /** The target and all its descendants, including any that ended earlier, so a repeated stop reaches them too. */
  targets: InternalSessionStopTarget[];
  alreadyStopped: boolean;
  /** The target's descendants: fixed once it has ended, so what a notice says about them does not change. */
  descendantCount: number;
  stoppedDescendantCount: number;
  /** Computers where a notice about a message held for a stopped Session now waits. */
  heldNoticeComputerIds: string[];
}

export interface AuthorizeAndRecordSessionMessageInput {
  userTaskSource?: import("./session-cli-proof-service.js").SessionCliSourceContext["userTaskSource"];
  messageId: string;
  sourceSessionId: string;
  sourceInstallationId: string;
  sourceConnectionInstanceId: string;
  sourceComputerId: string;
  sourcePlacementGeneration: number;
  targetSessionId: string;
  content: string;
  /** The Server derived this ID itself, so it may record a new row in the reserved version 5 space. */
  serverDerivedId?: boolean;
}

export interface AuthorizedSessionMessageRoute {
  agentId: string;
  imBindingId: string;
  sourceSessionId: string;
  sourceConnectionInstanceId: string;
  sourcePlacementGeneration: number;
  sourceComputerId: string;
  targetSessionId: string;
  targetInstallationId: string;
  targetComputerId: string;
  /** Where the target executes: the Local runtime registry or the per-Sandbox Cloud Runner. */
  targetComputerKind: "local" | "cloud";
  targetPlacementGeneration: number;
  targetSessionKind: SessionKind;
  targetCreatorSessionId: string | null;
}

/** The target-only authority a held message is redelivered under; the sender is no longer checked. */
export type AuthorizedHeldMessageRoute = Omit<
  AuthorizedSessionMessageRoute,
  "sourceSessionId" | "sourceComputerId" | "sourcePlacementGeneration" | "sourceConnectionInstanceId"
>;

export interface HeldSessionMessage {
  id: string;
  sourceSessionId: string | null;
  scheduledOrigin: SessionMessageScheduledOrigin | null;
  targetSessionId: string;
  targetCreatorSessionId: string | null;
  /** Null only for an expired message whose target lost its binding; it is never redelivered. */
  agentId: string | null;
  content: string;
  attemptCount: number;
  createdAt: Date;
  lastAttemptAt: Date | null;
}

export interface HeldSweepMessage extends HeldSessionMessage {
  computerId: string | null;
  targetEnded: boolean;
}

export interface HeldSweepCursor {
  createdAt: Date;
  id: string;
}

/**
 * Literal, not bound: PostgreSQL can only prove a partial index applies when it sees these values, and a
 * prepared statement's generic plan would not.
 */
const HELD_ROW = sql`${sessionMessages.lastOutcome} = 'unknown' and ${sessionMessages.lastErrorCode} = ${sql.raw(`'${SESSION_MESSAGE_HELD_CODE}'`)}`;

const HELD_MESSAGE_COLUMNS = {
  id: sessionMessages.id,
  sourceSessionId: sessionMessages.sourceSessionId,
  scheduledOrigin: sessionMessages.scheduledOrigin,
  targetSessionId: sessionMessages.targetSessionId,
  targetCreatorSessionId: sessions.createdBySessionId,
  agentId: imBindings.agentId,
  content: sessionMessages.content,
  attemptCount: sessionMessages.attemptCount,
  createdAt: sessionMessages.createdAt,
  lastAttemptAt: sessionMessages.lastAttemptAt,
};

export interface SessionMessageAttempt {
  route: AuthorizedSessionMessageRoute;
  message: SessionMessageRow;
  deduplicated: boolean;
  attemptCount: number | null;
}

/*
 * Scheduled dispatch authority. A Server-scheduled message has NO source Session: the trusted
 * claim already wrote the durable message row, so the dispatch route carries only the pinned
 * target's authority facts, and the final admission re-verifies them under the existing lock
 * order — Agent -> IM binding -> target Session -> placement -> Computer — extended with the
 * schedule row LAST. Management mutations take only the schedule row lock, so the two lock
 * directions can never deadlock, and whichever side holds the schedule row first decides the
 * pause/delete versus send race.
 */
export interface AuthorizedScheduledMessageRoute {
  agentId: string;
  imBindingId: string;
  targetSessionId: string;
  targetSessionKind: SessionKind;
  /** Null for a visible target. A reconcile of an internal target must name it. */
  targetCreatorSessionId: string | null;
  targetInstallationId: string;
  targetComputerId: string;
  targetComputerKind: "local" | "cloud";
  targetPlacementGeneration: number;
}

/** Permanent target failures auto-disable the schedule; temporary ones skip only this occurrence. */
export type ScheduledTargetPermanentCode = "agent_deleted" | "binding_invalid" | "target_invalid";
export type ScheduledTargetTemporaryCode = "agent_suspended" | "authority_unavailable";

export type ScheduledMessageRouteResolution =
  | { kind: "route"; route: AuthorizedScheduledMessageRoute }
  | { kind: "permanent"; code: ScheduledTargetPermanentCode }
  | { kind: "temporary"; code: ScheduledTargetTemporaryCode };

/** Why the final scheduled-dispatch admission refused the send; every value is a stable code. */
export type ScheduledDispatchAdmissionFailure =
  | "schedule_deleted"
  | "schedule_disabled"
  | "schedule_changed"
  | "dispatch_not_marked"
  | ScheduledTargetPermanentCode
  | ScheduledTargetTemporaryCode;

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

/**
 * Version 5 UUIDs are the Server's own: it derives them for the messages it writes (Run outcome notices,
 * schedule occurrences), and `session_messages.id` is global, so a caller who computes one could otherwise
 * occupy the ID and suppress the real message. This applies to new rows only. A row already under such an ID
 * goes through the normal identity check, so a caller can still resolve an uncertain write from before this
 * rule with its original ID.
 */
function assertOrdinaryMessageIdFree(messageId: string): void {
  if (messageId[14] === "5") {
    throw new SessionServiceError("SESSION_MESSAGE_ID_RESERVED", "Version 5 message IDs are reserved for the Server");
  }
}

/** How far up the creation chain a Run outcome notice looks for an active Session. */
const RUN_OUTCOME_NOTICE_MAX_CHAIN_DEPTH = 32;

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
  readonly #cloudModelCatalog: CloudModelCatalog | undefined;
  readonly #cloudSourceConnection:
    | ((input: { computerId: string; connectionInstanceId: string; sessionId: string }) => boolean)
    | undefined;
  readonly #now: () => Date;
  readonly #logger?: Pick<ServiceLogger, "info">;

  constructor(
    database: DatabaseClient,
    options: {
      afterPlacementLock?: () => Promise<void>;
      /**
       * The one Server-owned Router model catalog; consulted only when a new internal Session
       * carries an explicit model override onto a Cloud placement, and only read OUTSIDE the
       * transaction so no row lock is held across the network.
       */
      cloudModelCatalog?: CloudModelCatalog;
      /**
       * Cloud source liveness evidence: whether the exact current execution-eligible Runner
       * connection for a Cloud Session's Sandbox allocation still holds. A Cloud Computer's own
       * row is a logical always-online identity and never proves an execution connection.
       */
      cloudSourceConnection?: (input: {
        computerId: string;
        connectionInstanceId: string;
        sessionId: string;
      }) => boolean;
      now?: () => Date;
      logger?: Pick<ServiceLogger, "info">;
    } = {},
  ) {
    this.#database = database;
    this.#afterPlacementLock = options.afterPlacementLock;
    this.#cloudModelCatalog = options.cloudModelCatalog;
    this.#cloudSourceConnection = options.cloudSourceConnection;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
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
    const modelOverride = input.overrides?.model;
    // Pre-load the Router model snapshot OUTSIDE the transaction when an explicit override could
    // target a Cloud placement: the unlocked pre-read derives the creator's Computer kind, and the
    // locked authority check inside the transaction re-derives it (the kind is immutable and the
    // placement is re-verified), so no lock is ever held across the catalog's network read.
    let catalogSnapshot: CloudModelOptions | undefined;
    if (modelOverride !== undefined && this.#cloudModelCatalog) {
      const creatorKind = await this.#sessionComputerKind(input.creatorSessionId);
      if (creatorKind === "cloud") catalogSnapshot = await this.#cloudModelCatalog.list();
    }
    return this.#database.transaction(async (transaction) => {
      const agent = await this.#lockSourceAgent(transaction, input.creatorSessionId);
      const [targetHint] = await transaction
        .select({ targetSessionId: sessionMessages.targetSessionId })
        .from(sessionMessages)
        .where(
          and(eq(sessionMessages.id, input.messageId), eq(sessionMessages.sourceSessionId, input.creatorSessionId)),
        )
        .limit(1);
      const authority = await this.#lockCollaborationAuthority(transaction, agent, targetHint?.targetSessionId);
      const creator = this.#activeSource(authority, {
        sessionId: input.creatorSessionId,
        installationId: input.creatorInstallationId,
        connectionInstanceId: input.creatorConnectionInstanceId,
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
        const target = await this.#activeTarget(transaction, authority, existing.targetSessionId, creator.session);
        if (!internalSessionInputMatches(target.session, input)) {
          throw new SessionServiceError("SESSION_MESSAGE_CONFLICT", "The Session message ID has conflicting input");
        }
        const attempt = await this.#beginAttempt(transaction, existing);
        await this.#recordSessionActivity(transaction, attempt.message, [input.creatorSessionId]);
        return {
          session: toSession(target.session),
          placement: toPlacement(target.placement),
          route: this.#route(creator, target),
          message: attempt.message,
          deduplicated: attempt.attemptCount === null,
          attemptCount: attempt.attemptCount,
        };
      }
      assertOrdinaryMessageIdFree(input.messageId);
      // Model admission runs only on the create path: a deduplicated replay returns its recorded
      // Session without re-validating, so a model the Router stopped offering (or a Router outage)
      // never breaks the idempotent retry of an already-created internal Session.
      assertCloudSessionModel(creator.computerKind, modelOverride, catalogSnapshot);
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
          computerId: creator.placement.computerId,
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
          userTaskSource: input.userTaskSource ?? null,
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
        descendantActive: true,
      });
      await transaction.execute(sql`
        insert into session_descendants (
          ancestor_session_id,
          descendant_session_id,
          depth,
          last_message_created_at,
          last_message_id,
          last_delivery_outcome,
          task_preview,
          descendant_active
        )
        select
          ancestor_session_id,
          ${created.id}::uuid,
          depth + 1,
          ${message.createdAt.toISOString()}::timestamptz,
          ${message.id}::uuid,
          ${attempt.message.lastOutcome},
          ${taskPreview},
          true
        from session_descendants
        where descendant_session_id = ${input.creatorSessionId}::uuid
      `);
      await this.#recordSessionActivity(transaction, attempt.message, [input.creatorSessionId]);
      const target = {
        session: created,
        placement,
        computerId: creator.computerId,
        computerKind: creator.computerKind,
        installationId: creator.installationId,
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
      const agent = await this.#lockSourceAgent(transaction, input.sourceSessionId);
      const authority = await this.#lockCollaborationAuthority(transaction, agent, input.targetSessionId);
      const source = this.#activeSource(authority, {
        sessionId: input.sourceSessionId,
        installationId: input.sourceInstallationId,
        connectionInstanceId: input.sourceConnectionInstanceId,
        computerId: input.sourceComputerId,
        placementGeneration: input.sourcePlacementGeneration,
      });
      const target = await this.#activeTarget(transaction, authority, input.targetSessionId, source.session);
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
        if (!input.serverDerivedId) assertOrdinaryMessageIdFree(input.messageId);
        const now = this.#now();
        [message] = await transaction
          .insert(sessionMessages)
          .values({
            id: input.messageId,
            sourceSessionId: input.sourceSessionId,
            userTaskSource: input.userTaskSource ?? null,
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

  /**
   * Ends an internal Session and every Session below it for good, on behalf of an ancestor in its creation
   * chain. The commit is what stops them: from here their proofs no longer authenticate and no message reaches
   * them; telling their execution side is the caller's job, after commit. A Session that already ended answers
   * the same way, so a stop whose execution side was not reached can be repeated.
   */
  async stopInternalSession(input: StopInternalSessionInput): Promise<StoppedInternalSession> {
    return this.#database.transaction(async (transaction) => {
      const agent = await this.#lockSourceAgent(transaction, input.sourceSessionId);
      const [link] = await transaction
        .select({ depth: sessionDescendants.depth })
        .from(sessionDescendants)
        .where(
          and(
            eq(sessionDescendants.ancestorSessionId, input.sourceSessionId),
            eq(sessionDescendants.descendantSessionId, input.targetSessionId),
          ),
        )
        .limit(1);
      if (!link) {
        throw new SessionServiceError("SESSION_STOP_NOT_ANCESTOR", "Only an ancestor can stop an internal Session");
      }
      // Creating a Session takes the Agent lock held here, so this tree cannot grow until the commit, and
      // after it every Session in the tree has lost the authority to create one.
      const descendants = await transaction
        .select({ id: sessionDescendants.descendantSessionId })
        .from(sessionDescendants)
        .where(eq(sessionDescendants.ancestorSessionId, input.targetSessionId));
      const treeIds = [input.targetSessionId, ...descendants.map(({ id }) => id)];
      const authority = await this.#lockCollaborationAuthority(transaction, agent, treeIds);
      this.#activeSource(authority, {
        sessionId: input.sourceSessionId,
        installationId: input.sourceInstallationId,
        connectionInstanceId: input.sourceConnectionInstanceId,
        computerId: input.sourceComputerId,
        placementGeneration: input.sourcePlacementGeneration,
      });
      const liveIds = authority.sessions.map(({ id }) => id).filter((id) => treeIds.includes(id));
      if (liveIds.length > 0) {
        await transaction
          .update(sessions)
          .set({ endedAt: this.#now(), revision: sql`${sessions.revision} + 1` })
          .where(and(inArray(sessions.id, liveIds), isNull(sessions.endedAt)));
        await markEndedDescendantsInactive(transaction, { sessionIds: liveIds });
      }
      // Messages first, then schedules: the order every outcome write with a schedule summary takes.
      const heldNoticeComputerIds = await this.#settleHeldForStoppedSessions(transaction, input, treeIds);
      // Stopped Sessions' schedules stop with them, and can't be resumed. On a repeated stop this finds none.
      await transaction
        .update(agentSchedules)
        .set({
          enabled: false,
          nextTriggerAt: null,
          revision: sql`${agentSchedules.revision} + 1`,
          updatedAt: this.#now(),
        })
        .where(and(inArray(agentSchedules.targetSessionId, treeIds), eq(agentSchedules.enabled, true)));
      const targets = await this.#internalStopTargets(transaction, inArray(sessions.id, treeIds), treeIds.length);
      const target = targets.find(({ sessionId }) => sessionId === input.targetSessionId);
      if (!target) throw new SessionServiceError("SESSION_TARGET_UNAVAILABLE", "The target Session is not available");
      return {
        target,
        targets,
        alreadyStopped: !liveIds.includes(input.targetSessionId),
        descendantCount: descendants.length,
        stoppedDescendantCount: liveIds.filter((id) => id !== input.targetSessionId).length,
        heldNoticeComputerIds,
      };
    });
  }

  /**
   * A stopped Session will never run its held messages, so they end with the stop rather than expiring a day
   * later. The bumped attempt makes a hand-off still in flight lose its write. The Session that asked for the
   * stop already knows, and one stopped with it can't hear; any other sender was told `accepted` and hears
   * now, in the same commit. Answers the Computers where such a notice now waits.
   */
  async #settleHeldForStoppedSessions(
    transaction: DatabaseTransaction,
    input: StopInternalSessionInput,
    stoppedIds: readonly string[],
  ): Promise<string[]> {
    const now = this.#now();
    const settled = await transaction
      .update(sessionMessages)
      .set({
        lastOutcome: "rejected",
        lastErrorCode: SESSION_MESSAGE_TARGET_STOPPED_CODE,
        attemptCount: sql`${sessionMessages.attemptCount} + 1`,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(and(inArray(sessionMessages.targetSessionId, [...stoppedIds]), HELD_ROW))
      .returning({
        id: sessionMessages.id,
        sourceSessionId: sessionMessages.sourceSessionId,
        targetSessionId: sessionMessages.targetSessionId,
        content: sessionMessages.content,
        scheduledOrigin: sessionMessages.scheduledOrigin,
      });
    if (settled.length === 0) return [];
    await transaction
      .update(sessionDescendants)
      .set({ lastDeliveryOutcome: "rejected" })
      .where(
        inArray(
          sessionDescendants.lastMessageId,
          settled.map(({ id }) => id),
        ),
      );
    const computerIds = new Set<string>();
    for (const message of settled) {
      // A scheduled message has no sender, so its schedule's summary is where the answer shows.
      if (message.scheduledOrigin)
        await this.#writeStoppedScheduleSummary(transaction, message.id, message.scheduledOrigin, now);
      const sender = message.sourceSessionId;
      if (!sender || sender === input.sourceSessionId || stoppedIds.includes(sender)) continue;
      if (isRunOutcomeNotice(message) || isDeliveryFailureNotice(message)) continue;
      const recorded = await this.#insertDeliveryFailureNotice(transaction, {
        noticeId: deliveryFailureNoticeMessageId(message.id),
        failedTargetSessionId: message.targetSessionId,
        senderSessionId: sender,
        content: renderDeliveryFailureNotice({
          messageId: message.id,
          targetSessionId: message.targetSessionId,
          code: SESSION_MESSAGE_TARGET_STOPPED_CODE,
        }),
      });
      if (recorded) computerIds.add(recorded.computerId);
    }
    return [...computerIds];
  }

  /**
   * Internal Sessions that ended recently on this Computer. A stop cannot reach a disconnected Computer and
   * nothing durable records that, so its reconnect is told again; repeating a stop is harmless. Bounded by
   * the Computer's placements, and read only when it registers.
   */
  async recentlyEndedInternalSessions(
    computerId: string,
    since: Date,
    limit: number,
  ): Promise<InternalSessionStopTarget[]> {
    return this.#internalStopTargets(
      this.#database,
      and(eq(sessionPlacements.computerId, computerId), gte(sessions.endedAt, since)),
      limit,
    );
  }

  async #internalStopTargets(
    executor: DatabaseClient | DatabaseTransaction,
    predicate: SQL | undefined,
    limit = 1,
  ): Promise<InternalSessionStopTarget[]> {
    const rows = await executor
      .select({
        agentId: imBindings.agentId,
        computerId: sessionPlacements.computerId,
        computerKind: computers.kind,
        creatorSessionId: sessions.createdBySessionId,
        installationId: computers.currentInstallationId,
        placementGeneration: sessionPlacements.generation,
        sessionId: sessions.id,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(and(eq(sessions.kind, "internal"), predicate))
      .orderBy(desc(sessions.endedAt))
      .limit(limit);
    return rows.flatMap((row) => (row.creatorSessionId ? [{ ...row, creatorSessionId: row.creatorSessionId }] : []));
  }

  /**
   * Who hears that a message's Run did not complete: its sender, whatever kind of Session the target
   * is. A message with no other sender (scheduled, or sent to itself) and a notice that itself failed
   * go to an internal target's creator instead, so notices can only climb the creation tree from
   * there and never bounce between two Sessions. A recipient that has ended is replaced by the
   * nearest active Session up its own creation chain, so the notice still reaches someone.
   *
   * An unlocked eligibility read: the reported message must be stored and addressed to that active
   * Session. The facts only select the notice route; the subsequent `authorizeAndRecordMessage`
   * re-proves every authority under the normal lock order.
   */
  async resolveRunOutcomeNotice(input: {
    childSessionId: string;
    messageId: string;
  }): Promise<{ recipientSessionId: string; installationId: string } | undefined> {
    const [row] = await this.#database
      .select({
        creatorSessionId: sessions.createdBySessionId,
        installationId: computers.currentInstallationId,
        content: sessionMessages.content,
        kind: sessions.kind,
        sourceSessionId: sessionMessages.sourceSessionId,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(
        and(
          eq(sessionMessages.id, input.messageId),
          eq(sessionMessages.targetSessionId, input.childSessionId),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    const stored = { id: input.messageId, sourceSessionId: row.sourceSessionId, content: row.content };
    const isNotice = isRunOutcomeNotice(stored) || isDeliveryFailureNotice(stored);
    const sender = !isNotice && row.sourceSessionId !== input.childSessionId ? row.sourceSessionId : null;
    const candidate = sender ?? (row.kind === "internal" ? row.creatorSessionId : null);
    const recipientSessionId = candidate ? await this.#firstActiveCreator(candidate, input.childSessionId) : undefined;
    return recipientSessionId ? { recipientSessionId, installationId: row.installationId } : undefined;
  }

  /**
   * The candidate when it is still active, else the nearest active Session up its creation chain: a
   * sender that has ended leaves the work to whoever created it. The chain never reaches the reporting
   * Session itself (a notice to itself would tell it nothing) and gives up past a bounded depth.
   */
  async #firstActiveCreator(candidate: string, reporterSessionId: string): Promise<string | undefined> {
    let current: string | null = candidate;
    for (let depth = 0; current !== null && current !== reporterSessionId; depth += 1) {
      if (depth >= RUN_OUTCOME_NOTICE_MAX_CHAIN_DEPTH) return undefined;
      const [row] = await this.#database
        .select({ creatorSessionId: sessions.createdBySessionId, endedAt: sessions.endedAt })
        .from(sessions)
        .where(eq(sessions.id, current))
        .limit(1);
      if (!row) return undefined;
      if (row.endedAt === null) return current;
      current = row.creatorSessionId;
    }
    return undefined;
  }

  async withCollaborationDispatchAdmission<T>(
    route: AuthorizedSessionMessageRoute,
    operation: (onDispatched: () => void) => Promise<T>,
  ): Promise<{ admitted: false } | { admitted: true; result: Promise<T> }> {
    return this.#admitDispatch((transaction) => this.#authorityAdmits(transaction, route), operation);
  }

  /**
   * The final admission for a held message. The sender was authorized when the message was recorded and
   * may since have restarted or ended, so this proves only the target's current authority.
   */
  async withHeldDispatchAdmission<T>(
    route: AuthorizedHeldMessageRoute,
    operation: (onDispatched: () => void) => Promise<T>,
  ): Promise<{ admitted: false } | { admitted: true; result: Promise<T> }> {
    const targetRoute: AuthorizedSessionMessageRoute = {
      ...route,
      sourceSessionId: route.targetSessionId,
      sourceComputerId: route.targetComputerId,
      sourcePlacementGeneration: route.targetPlacementGeneration,
      sourceConnectionInstanceId: "",
    };
    return this.#admitDispatch(async (transaction) => {
      const agent = await this.#agentAndBindingAdmit(transaction, targetRoute);
      if (!agent) return false;
      const placements = await this.#sessionsAndPlacementsAdmit(transaction, targetRoute);
      if (!placements) return false;
      return this.#computersAdmit(transaction, targetRoute, placements, agent.createdByUserId);
    }, operation);
  }

  /** Whether an older held message must be delivered to this target first. */
  async hasOlderHeldMessage(
    targetSessionId: string,
    message: { id: string; createdAt: Date },
    cutoff: Date,
  ): Promise<boolean> {
    const [row] = await this.#database
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.targetSessionId, targetSessionId),
          gt(sessionMessages.createdAt, cutoff),
          eq(sessionMessages.lastOutcome, "unknown"),
          eq(sessionMessages.lastErrorCode, SESSION_MESSAGE_HELD_CODE),
          sql`(${sessionMessages.createdAt}, ${sessionMessages.id}) < (${message.createdAt.toISOString()}::timestamptz, ${message.id}::uuid)`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Active Sessions on a Computer that hold messages, one page at a time, through the held index. A message
   * to an ended target is settled by the sweep instead.
   */
  async listHeldTargetsForComputer(
    computerId: string,
    cutoff: Date,
    afterTargetSessionId: string | null,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.#database
      .selectDistinct({ id: sessionMessages.targetSessionId })
      .from(sessionMessages)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessionMessages.targetSessionId))
      .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
      .where(
        and(
          HELD_ROW,
          gt(sessionMessages.createdAt, cutoff),
          eq(sessionPlacements.computerId, computerId),
          isNull(sessions.endedAt),
          afterTargetSessionId ? gt(sessionMessages.targetSessionId, afterTargetSessionId) : undefined,
        ),
      )
      .orderBy(sessionMessages.targetSessionId)
      .limit(limit);
    return rows.map(({ id }) => id);
  }

  /** One target's held messages, oldest first. */
  async listHeldMessagesForTarget(targetSessionId: string, cutoff: Date, limit: number): Promise<HeldSessionMessage[]> {
    return this.#database
      .select(HELD_MESSAGE_COLUMNS)
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(
        and(
          eq(sessionMessages.targetSessionId, targetSessionId),
          gt(sessionMessages.createdAt, cutoff),
          eq(sessionMessages.lastOutcome, "unknown"),
          eq(sessionMessages.lastErrorCode, SESSION_MESSAGE_HELD_CODE),
        ),
      )
      .orderBy(sessionMessages.createdAt, sessionMessages.id)
      .limit(limit);
  }

  /**
   * Whether one more message fits in the hold. Each count stops at its limit, and both read the held index.
   * The message itself never counts: a hand-off past its send budget is already marked held when it asks.
   * Concurrent sends may each see room, so the limits can be passed by the sends in flight.
   */
  async heldHasRoom(
    targetSessionId: string,
    computerId: string,
    cutoff: Date,
    limits: { perTarget: number; perComputer: number },
    messageId: string,
  ): Promise<boolean> {
    const [target] = await this.#database.select({ count: sql<number>`count(*)::int` }).from(
      this.#database
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .where(
          and(
            eq(sessionMessages.targetSessionId, targetSessionId),
            gt(sessionMessages.createdAt, cutoff),
            ne(sessionMessages.id, messageId),
            HELD_ROW,
          ),
        )
        .limit(limits.perTarget)
        .as("held_target"),
    );
    if ((target?.count ?? 0) >= limits.perTarget) return false;
    const [computer] = await this.#database.select({ count: sql<number>`count(*)::int` }).from(
      this.#database
        .select({ id: sessionMessages.id })
        .from(sessionMessages)
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessionMessages.targetSessionId))
        .where(
          and(
            eq(sessionPlacements.computerId, computerId),
            gt(sessionMessages.createdAt, cutoff),
            ne(sessionMessages.id, messageId),
            HELD_ROW,
          ),
        )
        .limit(limits.perComputer)
        .as("held_computer"),
    );
    return (computer?.count ?? 0) < limits.perComputer;
  }

  /**
   * One page of every held message in `(created_at, id)` order through the held index. The keyset also gets
   * the sweep past a row it could not settle.
   */
  async sweepHeldMessages(cursor: HeldSweepCursor | null, limit: number): Promise<HeldSweepMessage[]> {
    return this.#database
      .select({
        ...HELD_MESSAGE_COLUMNS,
        computerId: sessionPlacements.computerId,
        targetEnded: sql<boolean>`${sessions.endedAt} is not null`,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
      .leftJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .leftJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessionMessages.targetSessionId))
      .where(
        and(
          HELD_ROW,
          cursor
            ? sql`(${sessionMessages.createdAt}, ${sessionMessages.id}) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(sessionMessages.createdAt, sessionMessages.id)
      .limit(limit);
  }

  /**
   * Fence one redelivery. The held code stays until a final answer is written, so a Server that crashes
   * after this write still redelivers; the Client deduplicates by message ID.
   */
  async beginHeldAttempt(messageId: string, attemptCount: number): Promise<number | undefined> {
    const now = this.#now();
    const [updated] = await this.#database
      .update(sessionMessages)
      .set({ attemptCount: attemptCount + 1, lastAttemptAt: now, updatedAt: now })
      .where(
        and(
          eq(sessionMessages.id, messageId),
          eq(sessionMessages.attemptCount, attemptCount),
          eq(sessionMessages.lastOutcome, "unknown"),
          eq(sessionMessages.lastErrorCode, SESSION_MESSAGE_HELD_CODE),
        ),
      )
      .returning({ attemptCount: sessionMessages.attemptCount });
    return updated?.attemptCount;
  }

  /** Mark an attempt that is still unanswered as held; a final answer already written is left alone. */
  async markMessageHeld(messageId: string, attemptCount: number): Promise<void> {
    await this.#database
      .update(sessionMessages)
      .set({ lastErrorCode: SESSION_MESSAGE_HELD_CODE, updatedAt: this.#now() })
      .where(
        and(
          eq(sessionMessages.id, messageId),
          eq(sessionMessages.attemptCount, attemptCount),
          eq(sessionMessages.lastOutcome, "unknown"),
          isNull(sessionMessages.lastErrorCode),
        ),
      );
  }

  /** The facts that decide whether a held scheduled occurrence is still the one to deliver. */
  async readHeldSchedule(scheduleId: string): Promise<
    | {
        enabled: boolean;
        revision: number;
        prompt: string;
        lastDispatch: AgentScheduleLastDispatch | null;
      }
    | undefined
  > {
    const [row] = await this.#database
      .select({
        enabled: agentSchedules.enabled,
        revision: agentSchedules.revision,
        prompt: agentSchedules.prompt,
        lastDispatch: agentSchedules.lastDispatch,
      })
      .from(agentSchedules)
      .where(eq(agentSchedules.id, scheduleId))
      .limit(1);
    return row;
  }

  /** The occurrence of this schedule before the given one, through the target and time index. */
  async readPreviousScheduledOutcome(
    targetSessionId: string,
    scheduleId: string,
    message: { id: string; createdAt: Date },
  ): Promise<{ outcome: SessionMessageOutcome; code: string | null } | null> {
    const [row] = await this.#database
      .select({ outcome: sessionMessages.lastOutcome, code: sessionMessages.lastErrorCode })
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.targetSessionId, targetSessionId),
          sql`${sessionMessages.scheduledOrigin} ->> 'scheduleId' = ${scheduleId}`,
          sql`(${sessionMessages.createdAt}, ${sessionMessages.id}) < (${message.createdAt.toISOString()}::timestamptz, ${message.id}::uuid)`,
        ),
      )
      .orderBy(desc(sessionMessages.createdAt), desc(sessionMessages.id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Record the Server's notice to a sender whose message was given up. It is written as held, so it
   * waits for the sender's Client like any other message. The notice comes from the failed target,
   * which supplies the source the row requires. Answers the sender's Computer when a Local notice now
   * waits there, and undefined when the sender cannot receive one.
   */
  async recordDeliveryFailureNotice(input: {
    noticeId: string;
    failedTargetSessionId: string;
    senderSessionId: string;
    content: string;
  }): Promise<{ computerId: string } | undefined> {
    return this.#database.transaction((transaction) => this.#insertDeliveryFailureNotice(transaction, input));
  }

  async #writeStoppedScheduleSummary(
    transaction: DatabaseTransaction,
    messageId: string,
    origin: SessionMessageScheduledOrigin,
    now: Date,
  ): Promise<void> {
    const summary: AgentScheduleLastDispatch = {
      scheduledFor: origin.scheduledFor,
      attemptedAt: now.toISOString(),
      messageId,
      outcome: "rejected",
      code: SESSION_MESSAGE_TARGET_STOPPED_CODE,
    };
    await transaction
      .update(agentSchedules)
      .set({ lastDispatch: summary })
      .where(
        and(
          eq(agentSchedules.id, origin.scheduleId),
          sql`${agentSchedules.lastDispatch} ->> 'messageId' = ${messageId}`,
        ),
      );
  }

  async #insertDeliveryFailureNotice(
    transaction: DatabaseTransaction,
    input: { noticeId: string; failedTargetSessionId: string; senderSessionId: string; content: string },
  ): Promise<{ computerId: string } | undefined> {
    const [sender] = await transaction
      .select({
        endedAt: sessions.endedAt,
        computerId: sessionPlacements.computerId,
        computerKind: computers.kind,
      })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(eq(sessions.id, input.senderSessionId))
      .limit(1);
    if (!sender || sender.endedAt !== null || sender.computerKind !== "local") return undefined;
    const now = this.#now();
    const [message] = await transaction
      .insert(sessionMessages)
      .values({
        id: input.noticeId,
        sourceSessionId: input.failedTargetSessionId,
        targetSessionId: input.senderSessionId,
        content: input.content,
        contentHash: hashSessionMessage(input.content),
        lastOutcome: "unknown",
        lastErrorCode: SESSION_MESSAGE_HELD_CODE,
        attemptCount: 1,
        lastAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (message) await this.#recordSessionActivity(transaction, message, [input.senderSessionId]);
    return { computerId: sender.computerId };
  }

  async #admitDispatch<T>(
    admits: (transaction: DatabaseTransaction) => Promise<boolean>,
    operation: (onDispatched: () => void) => Promise<T>,
  ): Promise<{ admitted: false } | { admitted: true; result: Promise<T> }> {
    return this.#database.transaction(async (transaction) => {
      if (!(await admits(transaction))) return { admitted: false } as const;
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

  /** Every durable authority a collaboration dispatch must prove while its rows are locked. */
  async #authorityAdmits(transaction: DatabaseTransaction, route: AuthorizedSessionMessageRoute): Promise<boolean> {
    const agent = await this.#agentAndBindingAdmit(transaction, route);
    if (!agent) return false;
    const placements = await this.#sessionsAndPlacementsAdmit(transaction, route);
    if (!placements) return false;
    if (!(await this.#computersAdmit(transaction, route, placements, agent.createdByUserId))) return false;
    return this.#sourceConnectionAdmits(transaction, route);
  }

  async #agentAndBindingAdmit(
    transaction: DatabaseTransaction,
    route: AuthorizedSessionMessageRoute,
  ): Promise<{ createdByUserId: string } | undefined> {
    const [agent] = await transaction
      .select({ createdByUserId: agents.createdByUserId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, route.agentId))
      .limit(1)
      .for("update");
    if (agent?.status !== "active") {
      this.#logAdmissionRejection(route, "SESSION_COLLABORATION_ADMISSION_AGENT_INACTIVE");
      return undefined;
    }
    const [binding] = await transaction
      .select({ agentId: imBindings.agentId, status: imBindings.status })
      .from(imBindings)
      .where(eq(imBindings.id, route.imBindingId))
      .limit(1)
      .for("update");
    if (binding?.agentId !== route.agentId || binding.status !== "active") {
      this.#logAdmissionRejection(route, "SESSION_COLLABORATION_ADMISSION_BINDING_INVALID");
      return undefined;
    }
    return { createdByUserId: agent.createdByUserId };
  }

  async #sessionsAndPlacementsAdmit(
    transaction: DatabaseTransaction,
    route: AuthorizedSessionMessageRoute,
  ): Promise<{ computerId: string; generation: number; sessionId: string }[] | undefined> {
    const sessionIds = [...new Set([route.sourceSessionId, route.targetSessionId])].sort();
    const sessionRows = await transaction
      .select({ id: sessions.id, imBindingId: sessions.imBindingId, endedAt: sessions.endedAt })
      .from(sessions)
      .where(inArray(sessions.id, sessionIds))
      .orderBy(sessions.id)
      .for("update");
    if (
      sessionRows.length !== sessionIds.length ||
      sessionRows.some(({ endedAt, imBindingId }) => endedAt !== null || imBindingId !== route.imBindingId)
    ) {
      this.#logAdmissionRejection(route, "SESSION_COLLABORATION_ADMISSION_AUTHORITY_SESSION_INVALID");
      return undefined;
    }
    const placementRows = await transaction
      .select({
        computerId: sessionPlacements.computerId,
        generation: sessionPlacements.generation,
        sessionId: sessionPlacements.sessionId,
      })
      .from(sessionPlacements)
      .where(inArray(sessionPlacements.sessionId, sessionIds))
      .orderBy(sessionPlacements.sessionId)
      .for("update");
    const sourcePlacement = placementRows.find(({ sessionId }) => sessionId === route.sourceSessionId);
    const targetPlacement = placementRows.find(({ sessionId }) => sessionId === route.targetSessionId);
    if (
      placementRows.length !== sessionIds.length ||
      sourcePlacement?.computerId !== route.sourceComputerId ||
      sourcePlacement.generation !== route.sourcePlacementGeneration ||
      targetPlacement?.computerId !== route.targetComputerId ||
      targetPlacement.generation !== route.targetPlacementGeneration
    ) {
      this.#logAdmissionRejection(route, "SESSION_COLLABORATION_ADMISSION_PLACEMENT_INVALID");
      return undefined;
    }
    return placementRows;
  }

  async #computersAdmit(
    transaction: DatabaseTransaction,
    route: AuthorizedSessionMessageRoute,
    placements: readonly { computerId: string }[],
    agentOwnerId: string,
  ): Promise<boolean> {
    const computerIds = [...new Set(placements.map(({ computerId }) => computerId))].sort();
    const computerRows = await transaction
      .select({ id: computers.id, ownerAccountId: computers.ownerAccountId })
      .from(computers)
      .where(inArray(computers.id, computerIds))
      .orderBy(computers.id)
      .for("update");
    if (
      computerRows.length !== computerIds.length ||
      computerRows.some(({ ownerAccountId }) => ownerAccountId !== agentOwnerId)
    ) {
      this.#logAdmissionRejection(route, "SESSION_COLLABORATION_ADMISSION_COMPUTER_OWNERSHIP_INVALID");
      return false;
    }
    return true;
  }

  async #sourceConnectionAdmits(
    transaction: DatabaseTransaction,
    route: AuthorizedSessionMessageRoute,
  ): Promise<boolean> {
    const [sourceComputer] = await transaction
      .select({
        currentInstanceId: computers.currentInstanceId,
        kind: computers.kind,
      })
      .from(computers)
      .where(eq(computers.id, route.sourceComputerId))
      .limit(1)
      .for("update");
    const sourceConnectionCurrent = this.#connectionIsCurrent({
      computerId: route.sourceComputerId,
      computerKind: sourceComputer?.kind,
      connectionInstanceId: route.sourceConnectionInstanceId,
      localCurrentInstanceId: sourceComputer?.currentInstanceId,
      sessionId: route.sourceSessionId,
    });
    if (!sourceComputer || !sourceConnectionCurrent) {
      this.#logAdmissionRejection(route, "SESSION_COLLABORATION_ADMISSION_SOURCE_INSTANCE_STALE");
      return false;
    }
    return true;
  }

  #logAdmissionRejection(route: AuthorizedSessionMessageRoute, code: string): void {
    this.#logger?.info(
      {
        agentId: route.agentId,
        code,
        imBindingId: route.imBindingId,
        sourceComputerId: route.sourceComputerId,
        sourceSessionId: route.sourceSessionId,
        targetComputerId: route.targetComputerId,
        targetComputerKind: route.targetComputerKind,
        targetSessionId: route.targetSessionId,
      },
      "Session collaboration dispatch admission rejected",
    );
  }

  async recordMessageOutcome(input: {
    messageId: string;
    attemptCount: number;
    outcome: SessionMessageOutcome;
    errorCode?: string;
    /**
     * Scheduled hand-off summary write-back: applied only while the schedule's latest summary
     * still points at exactly this occurrence (scheduleId + scheduledFor + messageId), so a late
     * receipt can never overwrite a newer claim's summary. Never touches enabled/revision/next.
     */
    scheduleSummary?: { scheduleId: string; scheduledFor: string; attemptedAt: string };
    /** Write only if the message is still held, so giving it up cannot replace a committed answer. */
    expectHeld?: boolean;
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
        .where(
          and(
            eq(sessionMessages.id, input.messageId),
            eq(sessionMessages.attemptCount, input.attemptCount),
            input.expectHeld
              ? and(
                  eq(sessionMessages.lastOutcome, "unknown"),
                  eq(sessionMessages.lastErrorCode, SESSION_MESSAGE_HELD_CODE),
                )
              : undefined,
            // A scheduled Runner receipt is durable custody. A later dispatch timeout or
            // transport error cannot revoke that fact, even if authorization is still minting.
            input.outcome === "accepted"
              ? undefined
              : or(isNull(sessionMessages.scheduledOrigin), sql`${sessionMessages.lastOutcome} <> 'accepted'`),
          ),
        )
        .returning({ id: sessionMessages.id, scheduledOrigin: sessionMessages.scheduledOrigin });
      if (!updated) return false;
      await transaction
        .update(sessionDescendants)
        .set({ lastDeliveryOutcome: input.outcome })
        .where(eq(sessionDescendants.lastMessageId, input.messageId));
      // A Run that already failed is the last word on this occurrence: its report may be gone by the
      // time a slower hand-off result arrives, so nothing would write the reason again.
      const keepsRunFailure = sql`not coalesce(${agentSchedules.lastDispatch} ->> 'outcome' = 'accepted' and ${agentSchedules.lastDispatch} ->> 'code' is not null, false)`;
      if (input.scheduleSummary) {
        const summary: AgentScheduleLastDispatch = {
          scheduledFor: input.scheduleSummary.scheduledFor,
          attemptedAt: input.scheduleSummary.attemptedAt,
          messageId: input.messageId,
          outcome: input.outcome,
          code: input.errorCode ?? null,
        };
        await transaction
          .update(agentSchedules)
          .set({ lastDispatch: summary })
          .where(
            and(
              eq(agentSchedules.id, input.scheduleSummary.scheduleId),
              sql`${agentSchedules.lastDispatch} ->> 'scheduledFor' = ${input.scheduleSummary.scheduledFor}`,
              sql`${agentSchedules.lastDispatch} ->> 'messageId' = ${input.messageId}`,
              keepsRunFailure,
            ),
          );
      } else if (input.outcome === "accepted" && updated.scheduledOrigin) {
        // Cloud records accepted custody before sending the verified frame. It can finish
        // after the dispatch budget expires, so update the latest summary here as well.
        await transaction
          .update(agentSchedules)
          .set({
            lastDispatch: sql`${agentSchedules.lastDispatch} || jsonb_build_object('outcome', 'accepted', 'code', null)`,
          })
          .where(
            and(
              eq(agentSchedules.id, updated.scheduledOrigin.scheduleId),
              sql`${agentSchedules.lastDispatch} ->> 'scheduledFor' = ${updated.scheduledOrigin.scheduledFor}`,
              sql`${agentSchedules.lastDispatch} ->> 'messageId' = ${input.messageId}`,
              keepsRunFailure,
            ),
          );
      }
      return true;
    });
  }

  /** Read the terminal custody fact after an uncertain write lost its race to acceptance. */
  async hasAcceptedScheduledMessage(messageId: string, attemptCount: number): Promise<boolean> {
    const [row] = await this.#database
      .select({ id: sessionMessages.id })
      .from(sessionMessages)
      .where(
        and(
          eq(sessionMessages.id, messageId),
          eq(sessionMessages.attemptCount, attemptCount),
          isNotNull(sessionMessages.scheduledOrigin),
          eq(sessionMessages.lastOutcome, "accepted"),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /* ------------------------------------------------------------------------------------------
   * Scheduled dispatch (Server-scheduled origin): the trusted one-shot hand-off helpers. None of
   * these accept a caller-supplied origin; only the internal scheduler constructs them.
   * ---------------------------------------------------------------------------------------- */

  /**
   * The scheduled claim's fence: its hand-off attempt moves `attempt_count` 0 -> 1 atomically. Only a
   * held occurrence is offered again, through `beginHeldAttempt`. A missing, ordinary-origin, or
   * already-fenced row answers `undefined` so the caller can never send it.
   */
  async beginScheduledMessageAttempt(messageId: string): Promise<SessionMessageRow | undefined> {
    const now = this.#now();
    const [updated] = await this.#database
      .update(sessionMessages)
      .set({ attemptCount: 1, lastAttemptAt: now, lastOutcome: "unknown", lastErrorCode: null, updatedAt: now })
      .where(
        and(
          eq(sessionMessages.id, messageId),
          eq(sessionMessages.attemptCount, 0),
          isNotNull(sessionMessages.scheduledOrigin),
        ),
      )
      .returning();
    return updated;
  }

  /**
   * Resolve the pinned target's dispatch route without taking any lock. Used by the claim (inside
   * its transaction, where it must never take authority locks while holding the schedule row) and
   * by the dispatch (whose final admission re-verifies every fact under locks). Classification is
   * deliberate: a deleted Agent, a disabled or foreign binding, and an ended or missing target are
   * permanent and auto-disable the schedule; a suspended Agent or a binding mid-reauthorization
   * skips only this occurrence.
   */
  async resolveScheduledMessageRoute(
    targetSessionId: string,
    agentId: string,
    executor: DatabaseClient | DatabaseTransaction = this.#database,
  ): Promise<ScheduledMessageRouteResolution> {
    const [row] = await executor
      .select({
        sessionId: sessions.id,
        sessionKind: sessions.kind,
        sessionCreatorId: sessions.createdBySessionId,
        sessionEndedAt: sessions.endedAt,
        bindingId: imBindings.id,
        bindingAgentId: imBindings.agentId,
        bindingStatus: imBindings.status,
        bindingDisabledAt: imBindings.disabledAt,
        agentStatus: agents.status,
        placementComputerId: sessionPlacements.computerId,
        placementGeneration: sessionPlacements.generation,
        computerKind: computers.kind,
        computerInstallationId: computers.currentInstallationId,
      })
      .from(sessions)
      .leftJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .leftJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .leftJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(eq(sessions.id, targetSessionId))
      .limit(1);
    if (!row) return { kind: "permanent", code: "target_invalid" };
    if (row.agentStatus === null || row.agentStatus === "deleted") return { kind: "permanent", code: "agent_deleted" };
    if (
      row.bindingId === null ||
      row.bindingAgentId !== agentId ||
      row.bindingStatus === "disabled" ||
      row.bindingDisabledAt !== null
    ) {
      return { kind: "permanent", code: "binding_invalid" };
    }
    if (row.sessionEndedAt !== null) return { kind: "permanent", code: "target_invalid" };
    if (
      row.placementComputerId === null ||
      row.placementGeneration === null ||
      row.computerKind === null ||
      row.computerInstallationId === null
    ) {
      return { kind: "permanent", code: "target_invalid" };
    }
    if (row.agentStatus === "suspended") return { kind: "temporary", code: "agent_suspended" };
    if (row.bindingStatus !== "active") return { kind: "temporary", code: "authority_unavailable" };
    return {
      kind: "route",
      route: {
        agentId,
        imBindingId: row.bindingId,
        targetSessionId: row.sessionId,
        targetSessionKind: row.sessionKind,
        targetCreatorSessionId: row.sessionCreatorId,
        targetInstallationId: row.computerInstallationId,
        targetComputerId: row.placementComputerId,
        targetComputerKind: row.computerKind,
        targetPlacementGeneration: row.placementGeneration,
      },
    };
  }

  /**
   * Auto-disable when a permanently invalid fixed target is found outside the admission (the route
   * could not even be built). Only the schedule row lock is taken — never authority locks — and the
   * permanent facts are re-verified before the disable; the revision bumps exactly like a
   * management edit. The occurrence summary itself is written by the conditional outcome
   * write-back that follows.
   */
  async disableScheduleForInvalidTarget(scheduleId: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          id: agentSchedules.id,
          agentId: agentSchedules.agentId,
          targetSessionId: agentSchedules.targetSessionId,
          enabled: agentSchedules.enabled,
          nextTriggerAt: agentSchedules.nextTriggerAt,
          revision: agentSchedules.revision,
        })
        .from(agentSchedules)
        .where(eq(agentSchedules.id, scheduleId))
        .limit(1)
        .for("update");
      if (!row) return;
      if (!row.enabled && row.nextTriggerAt === null) return;
      const resolution = await this.resolveScheduledMessageRoute(row.targetSessionId, row.agentId, transaction);
      if (resolution.kind !== "permanent") return;
      await transaction
        .update(agentSchedules)
        .set({ enabled: false, nextTriggerAt: null, revision: row.revision + 1, updatedAt: this.#now() })
        .where(eq(agentSchedules.id, row.id));
    });
  }

  /**
   * The final pre-send admission for a scheduled hand-off. Reuses the existing dispatch lock order
   * — Agent, IM binding, target Session, placement, Computer — and extends it with the schedule
   * row LAST, verifying the target authority chain and that the schedule still exists, is enabled,
   * and carries exactly the revision the claim froze. The locks are held only until the transport
   * marks its send (`onDispatched`), never across the Runtime receipt or business execution, so a
   * concurrent pause/delete waits only through the send mark and a committed pause/delete makes
   * the admission reject with zero frames sent. Permanent target failures auto-disable the
   * schedule in place.
   */
  async withScheduledDispatchAdmission<T>(
    route: AuthorizedScheduledMessageRoute,
    fence: { scheduleId: string; revision: number },
    operation: (onDispatched: () => void) => Promise<T>,
  ): Promise<{ admitted: true; result: Promise<T> } | { admitted: false; reason: ScheduledDispatchAdmissionFailure }> {
    return this.#database.transaction(async (transaction) => {
      const rows = await lockScheduledAdmissionRows(transaction, route, fence.scheduleId, this.#afterPlacementLock);
      const verdict = verdictScheduledAdmission(rows, route, fence);
      if (verdict.kind === "disable") {
        // Permanent target failure: auto-disable in place; the row is never resurrected. The
        // verdict guarantees the row exists for this branch.
        const row = rows.scheduleRow;
        if (row && (row.enabled || row.nextTriggerAt !== null)) {
          await transaction
            .update(agentSchedules)
            .set({
              enabled: false,
              nextTriggerAt: null,
              revision: row.revision + 1,
              updatedAt: this.#now(),
            })
            .where(eq(agentSchedules.id, row.id));
        }
        return this.#rejectScheduledAdmission(route, fence, verdict.code);
      }
      if (verdict.kind === "reject") return this.#rejectScheduledAdmission(route, fence, verdict.reason);

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
      if (!(await waitForSendMark(dispatched, SCHEDULED_SEND_MARK_TIMEOUT_MS))) {
        // The send never confirmed the frame inside the admission window: refuse it and commit, so
        // the authority locks are released instead of being held for the whole stall.
        return this.#rejectScheduledAdmission(route, fence, "dispatch_not_marked");
      }
      return { admitted: true, result } as const;
    });
  }

  #rejectScheduledAdmission(
    route: AuthorizedScheduledMessageRoute,
    fence: { scheduleId: string; revision: number },
    reason: ScheduledDispatchAdmissionFailure,
  ): { admitted: false; reason: ScheduledDispatchAdmissionFailure } {
    this.#logger?.info(
      {
        agentId: route.agentId,
        code: reason,
        scheduleId: fence.scheduleId,
        targetComputerId: route.targetComputerId,
        targetSessionId: route.targetSessionId,
      },
      "Scheduled message dispatch admission rejected",
    );
    return { admitted: false, reason };
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
      stoppedAt: Date | string | null;
    };
    // Stopped Sessions are history the active indexes do not carry on purpose: asking for them sorts this
    // ancestor's closure rows, read through the primary key, which stays bounded by its own descendants.
    const rows = await this.#database.execute<ListRow>(sql`
      select
        link.descendant_session_id as "sessionId",
        child.created_by_session_id as "parentSessionId",
        child.created_at as "createdAt",
        link.last_message_created_at as "lastMessageAt",
        link.last_message_id as "lastMessageId",
        link.last_delivery_outcome as "lastDeliveryOutcome",
        link.task_preview as "taskPreview",
        child.ended_at as "stoppedAt"
      from session_descendants link
      inner join sessions child on child.id = link.descendant_session_id
      where link.ancestor_session_id = ${sourceSessionId}::uuid
        ${
          // An older binary ends a Session without maintaining the closure flag. The derived predicate
          // keeps that row out of the page and bounds the extra work to the drift, not to the history.
          query.includeStopped ? sql`` : sql`and link.descendant_active and child.ended_at is null`
        }
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
        ...(query.includeStopped && row.stoppedAt ? { stoppedAt: new Date(row.stoppedAt).toISOString() } : {}),
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
        .set({
          computerId,
          generation,
          updatedAt: now,
        })
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

  async #lockSourceAgent(transaction: DatabaseTransaction, sourceSessionId: string): Promise<SourceAgentAuthority> {
    const [source] = await transaction
      .select({
        agentId: agents.id,
        agentOwnerId: agents.createdByUserId,
        session: {
          id: sessions.id,
          imBindingId: sessions.imBindingId,
          channelId: sessions.channelId,
          conversationKind: sessions.conversationKind,
          threadKey: sessions.threadKey,
        },
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(
        and(
          eq(sessions.id, sourceSessionId),
          isNull(sessions.endedAt),
          eq(imBindings.status, "active"),
          eq(agents.status, "active"),
        ),
      )
      .limit(1)
      .for("update", { of: agents });
    if (!source) throw new SessionServiceError("SESSION_SOURCE_UNAVAILABLE", "The source Session is not active");
    return source;
  }

  async #lockCollaborationAuthority(
    transaction: DatabaseTransaction,
    source: SourceAgentAuthority,
    target?: string | readonly string[],
  ): Promise<LockedCollaborationAuthority> {
    const targetSessionIds = target === undefined ? [] : typeof target === "string" ? [target] : target;
    const [binding] = await transaction
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(
        and(
          eq(imBindings.id, source.session.imBindingId),
          eq(imBindings.agentId, source.agentId),
          eq(imBindings.status, "active"),
        ),
      )
      .for("update");
    if (!binding) throw new SessionServiceError("SESSION_SOURCE_UNAVAILABLE", "The source Session is not active");
    const lockedSessions = await transaction
      .select()
      .from(sessions)
      .where(
        and(
          isNull(sessions.endedAt),
          or(
            eq(sessions.id, source.session.id),
            targetSessionIds.length > 0
              ? and(
                  inArray(sessions.id, [...targetSessionIds]),
                  eq(sessions.imBindingId, source.session.imBindingId),
                  eq(sessions.channelId, source.session.channelId),
                  eq(sessions.conversationKind, source.session.conversationKind),
                  source.session.threadKey === null
                    ? isNull(sessions.threadKey)
                    : eq(sessions.threadKey, source.session.threadKey),
                )
              : undefined,
          ),
        ),
      )
      .orderBy(sessions.id)
      .for("no key update");
    const lockedSource = lockedSessions.find((session) => session.id === source.session.id);
    if (!lockedSource || !sameSessionScope(lockedSource, source.session)) {
      throw new SessionServiceError("SESSION_SOURCE_UNAVAILABLE", "The source Session is not active");
    }
    const placements = await transaction
      .select()
      .from(sessionPlacements)
      .where(
        inArray(
          sessionPlacements.sessionId,
          lockedSessions.map((session) => session.id),
        ),
      )
      .orderBy(sessionPlacements.sessionId)
      .for("update");
    const lockedComputers = await transaction
      .select({
        id: computers.id,
        ownerAccountId: computers.ownerAccountId,
        currentInstallationId: computers.currentInstallationId,
        currentInstanceId: computers.currentInstanceId,
        kind: computers.kind,
      })
      .from(computers)
      .where(inArray(computers.id, [...new Set(placements.map((placement) => placement.computerId))]))
      .orderBy(computers.id)
      .for("update");
    return {
      agentId: source.agentId,
      agentOwnerId: source.agentOwnerId,
      sessions: lockedSessions,
      placements,
      computers: lockedComputers,
    };
  }

  #activeSource(
    authority: LockedCollaborationAuthority,
    input: {
      sessionId: string;
      installationId: string;
      connectionInstanceId: string;
      computerId: string;
      placementGeneration: number;
    },
  ): ActiveSessionAuthority {
    const session = authority.sessions.find((row) => row.id === input.sessionId);
    const placement = authority.placements.find((row) => row.sessionId === input.sessionId);
    const computer = authority.computers.find((row) => row.id === placement?.computerId);
    if (!session || !placement || !computer) {
      throw new SessionServiceError("SESSION_SOURCE_UNAVAILABLE", "The source Session is not active");
    }
    if (computer.ownerAccountId !== authority.agentOwnerId) {
      throw new SessionServiceError("SESSION_SOURCE_UNAVAILABLE", "The source Session Computer requires Agent rebind");
    }
    if (
      computer.currentInstallationId !== input.installationId ||
      computer.id !== input.computerId ||
      placement.generation !== input.placementGeneration
    ) {
      throw new SessionServiceError("SESSION_PLACEMENT_STALE", "The source Session placement is stale");
    }
    // The connection evidence differs by Computer kind: a Local Computer proves it with its own
    // current connection; a Cloud Computer is a logical always-online identity, so the proof is
    // the exact current execution-eligible Runner connection for the Session's allocation.
    const connectionCurrent = this.#connectionIsCurrent({
      computerId: computer.id,
      computerKind: computer.kind,
      connectionInstanceId: input.connectionInstanceId,
      localCurrentInstanceId: computer.currentInstanceId,
      sessionId: session.id,
    });
    if (!connectionCurrent) {
      throw new SessionServiceError("SESSION_PLACEMENT_STALE", "The source Session placement is stale");
    }
    return {
      session,
      placement,
      agentId: authority.agentId,
      computerId: computer.id,
      computerKind: computer.kind,
      installationId: computer.currentInstallationId,
      connectionInstanceId: input.connectionInstanceId,
    };
  }

  /**
   * Exact-connection evidence for one source Session: Cloud authority is the current
   * execution-eligible Runner connection; Local authority is the Computer's own current
   * connection. A Cloud Computer's logical online state is never execution evidence.
   */
  #connectionIsCurrent(input: {
    computerId: string;
    computerKind: "local" | "cloud" | undefined;
    connectionInstanceId: string;
    localCurrentInstanceId: string | null | undefined;
    sessionId: string;
  }): boolean {
    if (input.computerKind === "cloud") {
      return (
        this.#cloudSourceConnection?.({
          computerId: input.computerId,
          connectionInstanceId: input.connectionInstanceId,
          sessionId: input.sessionId,
        }) === true
      );
    }
    return input.localCurrentInstanceId === input.connectionInstanceId;
  }

  async #activeTarget(
    transaction: DatabaseTransaction,
    authority: LockedCollaborationAuthority,
    targetSessionId: string,
    sourceSession: SessionRow,
  ): Promise<{
    session: SessionRow;
    placement: PlacementRow;
    computerId: string;
    computerKind: "local" | "cloud";
    installationId: string;
  }> {
    const session = authority.sessions.find((row) => row.id === targetSessionId);
    const placement = authority.placements.find((row) => row.sessionId === targetSessionId);
    const computer = authority.computers.find((row) => row.id === placement?.computerId);
    if (session && placement && computer) {
      if (computer.ownerAccountId !== authority.agentOwnerId) {
        throw new SessionServiceError(
          "SESSION_TARGET_UNAVAILABLE",
          "The target Session Computer requires Agent rebind",
        );
      }
      return {
        session,
        placement,
        computerId: computer.id,
        computerKind: computer.kind,
        installationId: computer.currentInstallationId,
      };
    }
    // Foreign-scope targets must retain their error precedence without joining the lock chain.
    const [target] = await transaction
      .select({
        session: sessions,
        placement: sessionPlacements,
        agentCreatedByUserId: agents.createdByUserId,
        installationId: computers.currentInstallationId,
        computerKind: computers.kind,
        computerOwnerAccountId: computers.ownerAccountId,
        computerId: computers.id,
      })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(and(eq(sessions.id, targetSessionId), isNull(sessions.endedAt)))
      .limit(1);
    if (!target) throw new SessionServiceError("SESSION_TARGET_UNAVAILABLE", "The target Session is not active");
    if (target.computerOwnerAccountId !== target.agentCreatedByUserId) {
      throw new SessionServiceError("SESSION_TARGET_UNAVAILABLE", "The target Session Computer requires Agent rebind");
    }
    if (!sameSessionScope(target.session, sourceSession)) {
      throw new SessionServiceError("SESSION_SCOPE_MISMATCH", "The target Session has a different collaboration scope");
    }
    throw new SessionServiceError("SESSION_TARGET_UNAVAILABLE", "The target Session is not active");
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
    target: {
      session: SessionRow;
      placement: PlacementRow;
      computerId: string;
      computerKind: "local" | "cloud";
      installationId: string;
    },
  ): AuthorizedSessionMessageRoute {
    return {
      agentId: source.agentId,
      imBindingId: source.session.imBindingId,
      sourceSessionId: source.session.id,
      sourceConnectionInstanceId: source.connectionInstanceId,
      sourcePlacementGeneration: source.placement.generation,
      sourceComputerId: source.computerId,
      targetSessionId: target.session.id,
      targetInstallationId: target.installationId,
      targetComputerId: target.computerId,
      targetComputerKind: target.computerKind,
      targetPlacementGeneration: target.placement.generation,
      targetSessionKind: target.session.kind,
      targetCreatorSessionId: target.session.createdBySessionId,
    };
  }

  /** Unlocked kind read of the Computer a Session is placed on; missing rows resolve undefined. */
  async #sessionComputerKind(sessionId: string): Promise<"local" | "cloud" | undefined> {
    const [row] = await this.#database
      .select({ kind: computers.kind })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(and(eq(sessions.id, sessionId), isNull(sessions.endedAt)))
      .limit(1);
    return row?.kind;
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
    // Placement derives the Computer from the Agent, so an Agent that has none cannot host a Session.
    if (agent.computerId === null) {
      throw new SessionServiceError("AGENT_COMPUTER_NOT_BOUND", "The Agent is not bound to a Computer");
    }
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
          .values({
            sessionId: session.id,
            computerId,
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

/** The locked rows behind one scheduled dispatch admission, taken in the global lock order. */
interface ScheduledAdmissionRows {
  agent: { createdByUserId: string; status: "active" | "suspended" | "deleted" } | undefined;
  binding:
    | {
        agentId: string;
        disabledAt: Date | null;
        status: "provisioning" | "active" | "reauthorization_required" | "error" | "disabled";
      }
    | undefined;
  target: { endedAt: Date | null; imBindingId: string } | undefined;
  placement: { computerId: string; generation: number } | undefined;
  computer: { ownerAccountId: string } | undefined;
  scheduleRow: { id: string; enabled: boolean; nextTriggerAt: Date | null; revision: number } | undefined;
}

/**
 * How long the admission waits for the transport to mark its send before it refuses the dispatch.
 * The admission holds the Agent, IM binding, Session, placement, and Computer row locks until that
 * mark, so a stalled send blocks every other writer of those rows: a management pause or delete, a
 * placement move, and an inbound IM transaction all wait behind it. A send normally marks in
 * milliseconds.
 */
const SCHEDULED_SEND_MARK_TIMEOUT_MS = 5_000;

/** True once the transport marks its send; false when the admission deadline expires first. */
export async function waitForSendMark(marked: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([marked.then(() => true), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Lock the full dispatch authority chain in the existing order — Agent, IM binding, target
 * Session, placement, Computer — and the schedule row LAST. A claim inserts a message while
 * holding the schedule row, which implicitly takes a KEY SHARE lock on the target Session for
 * its foreign key. The admission takes NO KEY UPDATE on that Session, compatible with KEY SHARE,
 * while still excluding Session end/delete; the separate placement lock protects placement changes.
 */
async function lockScheduledAdmissionRows(
  transaction: DatabaseTransaction,
  route: AuthorizedScheduledMessageRoute,
  scheduleId: string,
  afterPlacementLock?: () => Promise<void>,
): Promise<ScheduledAdmissionRows> {
  const [agent] = await transaction
    .select({ createdByUserId: agents.createdByUserId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, route.agentId))
    .limit(1)
    .for("update");
  const [binding] = await transaction
    .select({ agentId: imBindings.agentId, disabledAt: imBindings.disabledAt, status: imBindings.status })
    .from(imBindings)
    .where(eq(imBindings.id, route.imBindingId))
    .limit(1)
    .for("update");
  const [target] = await transaction
    .select({ endedAt: sessions.endedAt, imBindingId: sessions.imBindingId })
    .from(sessions)
    .where(eq(sessions.id, route.targetSessionId))
    .limit(1)
    .for("no key update");
  const [placement] = await transaction
    .select({ computerId: sessionPlacements.computerId, generation: sessionPlacements.generation })
    .from(sessionPlacements)
    .where(eq(sessionPlacements.sessionId, route.targetSessionId))
    .limit(1)
    .for("update");
  await afterPlacementLock?.();
  const [computer] = await transaction
    .select({ ownerAccountId: computers.ownerAccountId })
    .from(computers)
    .where(eq(computers.id, route.targetComputerId))
    .limit(1)
    .for("update");
  const [scheduleRow] = await transaction
    .select({
      id: agentSchedules.id,
      enabled: agentSchedules.enabled,
      nextTriggerAt: agentSchedules.nextTriggerAt,
      revision: agentSchedules.revision,
    })
    .from(agentSchedules)
    .where(eq(agentSchedules.id, scheduleId))
    .limit(1)
    .for("update");
  return { agent, binding, target, placement, computer, scheduleRow };
}

type ScheduledAdmissionVerdict =
  | { kind: "admit" }
  | { kind: "reject"; reason: ScheduledDispatchAdmissionFailure }
  | { kind: "disable"; code: ScheduledTargetPermanentCode };

/** Permanent target failure: a deleted Agent, a disabled/foreign binding, or an ended target Session. */
function permanentScheduledAdmissionFailure(
  agent: ScheduledAdmissionRows["agent"],
  binding: ScheduledAdmissionRows["binding"],
  target: ScheduledAdmissionRows["target"],
  route: AuthorizedScheduledMessageRoute,
): ScheduledTargetPermanentCode | undefined {
  if (!agent || agent.status === "deleted") return "agent_deleted";
  if (!binding || binding.agentId !== route.agentId || binding.status === "disabled" || binding.disabledAt !== null) {
    return "binding_invalid";
  }
  if (!target || target.endedAt !== null || target.imBindingId !== route.imBindingId) return "target_invalid";
  return undefined;
}

/**
 * The admission verdict. The schedule gate (exists, enabled, frozen revision) is checked after the
 * permanent-target classification and before transient authority gaps, so a committed pause,
 * resume, edit, or delete always wins against a not-yet-sent dispatch.
 */
function verdictScheduledAdmission(
  rows: ScheduledAdmissionRows,
  route: AuthorizedScheduledMessageRoute,
  fence: { scheduleId: string; revision: number },
): ScheduledAdmissionVerdict {
  const permanent = permanentScheduledAdmissionFailure(rows.agent, rows.binding, rows.target, route);
  if (permanent) {
    return rows.scheduleRow ? { kind: "disable", code: permanent } : { kind: "reject", reason: "schedule_deleted" };
  }
  const { scheduleRow, placement, computer, agent, binding } = rows;
  if (!scheduleRow) return { kind: "reject", reason: "schedule_deleted" };
  if (!scheduleRow.enabled) return { kind: "reject", reason: "schedule_disabled" };
  if (scheduleRow.revision !== fence.revision) return { kind: "reject", reason: "schedule_changed" };
  // The permanent classification above already returned when any of these rows is absent.
  if (agent?.status !== "active") return { kind: "reject", reason: "agent_suspended" };
  if (binding?.status !== "active") return { kind: "reject", reason: "authority_unavailable" };
  if (
    !placement ||
    placement.computerId !== route.targetComputerId ||
    placement.generation !== route.targetPlacementGeneration
  ) {
    return { kind: "reject", reason: "authority_unavailable" };
  }
  if (!computer || computer.ownerAccountId !== agent.createdByUserId) {
    return { kind: "reject", reason: "authority_unavailable" };
  }
  return { kind: "admit" };
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

function assertCloudSessionModel(
  computerKind: "cloud" | "local",
  model: string | undefined,
  snapshot: CloudModelOptions | undefined,
): void {
  if (model === undefined || computerKind !== "cloud") return;
  if (!snapshot?.available) {
    throw new SessionServiceError("SESSION_MODEL_CATALOG_UNAVAILABLE", "The Cloud model list could not be confirmed");
  }
  if (!snapshot.models.includes(model)) {
    throw new SessionServiceError("SESSION_MODEL_UNAVAILABLE", "The model is not offered by the Cloud model Router");
  }
}
