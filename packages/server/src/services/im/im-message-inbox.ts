import type { ImContentV1 } from "@opentag/shared";
import { ImContentV1Schema, type NormalizedInboundImEvent, NormalizedInboundImEventSchema } from "@opentag/shared";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { imAttrs, outcomeAttrs, setActiveSpanAttributes, withSpan } from "../../observability/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { SessionService } from "../sessions/index.js";
import { createImFeedbackTarget } from "./im-feedback-store.js";
import { IM_DUPLICATE_PENDING_REASON, IM_QUEUE_CAPACITY, repeatsPendingInput } from "./im-queue-policy.js";
import { threadRootExternalId } from "./provider-thread-context.js";

const DIRECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AMBIENT_TTL_MS = 24 * 60 * 60 * 1000;
const TASK_TITLE_GENERATION_TIMEOUT_MS = 3_000;

type DeliveryAttention = "direct" | "ambient";

/** Direct continuity keeps an unaddressed Thread follow-up for the direct window. */
function deliveryRetentionMs(delivery: { attention: DeliveryAttention; continuity?: boolean }): number {
  return delivery.attention === "direct" || delivery.continuity === true ? DIRECT_TTL_MS : AMBIENT_TTL_MS;
}

/**
 * Whether an inherited delivery was retained for the direct window, so a revision (edit or recall) of
 * an unaddressed Thread follow-up keeps its continuity retention. Deliveries do not persist continuity,
 * but they are written on the message's `receivedAt` clock and only an out-of-order direct root extends
 * them; task cancellation shortens one to now, and a cancelled delivery has no continuity to keep.
 */
function hadDirectRetention(expiresAt: Date, receivedAt: Date | undefined): boolean {
  return receivedAt !== undefined && expiresAt.getTime() - receivedAt.getTime() > AMBIENT_TTL_MS;
}

interface OverflowCandidate {
  sessionId: string;
  attention: DeliveryAttention;
}

export interface IngestResult {
  duplicate: boolean;
  messageId?: string;
  deliveryIds: string[];
}

export interface TaskTitleGenerationRequest {
  sessionId: string;
  sourceText: string;
  signal?: AbortSignal;
}

interface ChatSessionPlacement {
  id: string;
  generation: number;
}

interface EnsureChatSessionInput {
  imBindingId: string;
  channelId: string;
  conversationKind: "channel" | "dm" | "group_dm";
  kind: "channel" | "thread";
  threadKey?: string;
  computerId: string;
  now: Date;
}

interface CreatedChatSession extends ChatSessionPlacement {
  created: boolean;
}

function recordCreatedTask(
  createdTasks: Map<string, TaskTitleGenerationRequest>,
  session: CreatedChatSession,
  sourceText: string,
): void {
  if (!session.created) return;
  createdTasks.set(session.id, { sessionId: session.id, sourceText });
}

export type ImInboundPersistenceErrorCode =
  | "IM_INBOUND_BINDING_STALE"
  | "IM_INBOUND_DATABASE_FAILED"
  | "IM_INBOUND_FENCE_STALE"
  | "IM_INBOUND_IDENTITY_MISMATCH";

export class ImInboundPersistenceError extends Error {
  constructor(
    readonly code: Exclude<ImInboundPersistenceErrorCode, "IM_INBOUND_DATABASE_FAILED">,
    message: string,
  ) {
    super(message);
    this.name = "ImInboundPersistenceError";
  }
}

export function classifyImInboundPersistenceError(error: unknown): ImInboundPersistenceErrorCode {
  return error instanceof ImInboundPersistenceError ? error.code : "IM_INBOUND_DATABASE_FAILED";
}

export class ImMessageInbox {
  readonly #afterAdmissionFence: (() => Promise<void>) | undefined;
  readonly #afterMessageAuthority: (() => Promise<void>) | undefined;
  readonly #afterOverflowExpiry: (() => Promise<void>) | undefined;
  readonly #beforeReliableThreadRootLookup: (() => void) | undefined;
  readonly #beforeSupersedeDeliveries: (() => Promise<void>) | undefined;
  readonly #beforeOverflowExpiry: (() => Promise<void>) | undefined;
  readonly #database: DatabaseClient;
  readonly #logger: Pick<ServiceLogger, "error"> | undefined;
  readonly #now: () => Date;
  readonly #onDeliveryChanged: ((deliveryId: string) => void) | undefined;
  readonly #onTaskCreated: ((request: TaskTitleGenerationRequest) => Promise<void> | void) | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #work = new Map<Promise<unknown>, AbortController | undefined>();
  readonly #overflowPasses = new Map<string, Promise<void>>();
  readonly #overflowRechecks = new Map<string, OverflowCandidate>();
  readonly #sessions: SessionService;

  constructor(
    database: DatabaseClient,
    options: {
      now?: () => Date;
      afterAdmissionFence?: () => Promise<void>;
      afterMessageAuthority?: () => Promise<void>;
      afterOverflowExpiry?: () => Promise<void>;
      beforeReliableThreadRootLookup?: () => void;
      beforeSupersedeDeliveries?: () => Promise<void>;
      beforeOverflowExpiry?: () => Promise<void>;
      logger?: Pick<ServiceLogger, "error">;
      onDeliveryChanged?: (deliveryId: string) => void;
      onTaskCreated?: (request: TaskTitleGenerationRequest) => Promise<void> | void;
    } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onTaskCreated = options.onTaskCreated;
    this.#onDeliveryChanged = options.onDeliveryChanged;
    this.#afterAdmissionFence = options.afterAdmissionFence;
    this.#afterMessageAuthority = options.afterMessageAuthority;
    this.#afterOverflowExpiry = options.afterOverflowExpiry;
    this.#beforeReliableThreadRootLookup = options.beforeReliableThreadRootLookup;
    this.#beforeSupersedeDeliveries = options.beforeSupersedeDeliveries;
    this.#beforeOverflowExpiry = options.beforeOverflowExpiry;
    this.#logger = options.logger;
    this.#sessions = new SessionService(database, { now: this.#now });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#overflowRechecks.clear();
    for (const controller of this.#work.values()) controller?.abort("im_inbox_closed");
    this.#closing = this.#drain();
    return this.#closing;
  }

  async #drain(): Promise<void> {
    while (this.#work.size > 0 || this.#overflowPasses.size > 0) {
      await Promise.allSettled([...this.#work.keys(), ...this.#overflowPasses.values()]);
    }
  }

  #track<T>(operation: Promise<T>, controller?: AbortController): Promise<T> {
    this.#work.set(operation, controller);
    void operation.then(
      () => this.#work.delete(operation),
      () => this.#work.delete(operation),
    );
    return operation;
  }

  #generateTaskTitles(requests: Iterable<TaskTitleGenerationRequest>): void {
    if (!this.#onTaskCreated || this.#closed) return;
    for (const request of requests) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort("task_title_generation_timeout"),
        TASK_TITLE_GENERATION_TIMEOUT_MS,
      );
      timer.unref();
      const operation = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return this.#onTaskCreated?.({ ...request, signal: controller.signal });
        })
        .catch(() => undefined)
        .finally(() => clearTimeout(timer));
      void this.#track(operation, controller);
    }
  }

  async ingest(
    imBindingId: string,
    credentialGeneration: number,
    rawEvent: NormalizedInboundImEvent,
    admissionFence?: { provider: "feishu"; holderInstanceId: string; fencingEpoch: number },
    telemetry?: { provider: "feishu" | "slack"; receivedAt?: Date },
  ): Promise<IngestResult> {
    if (this.#closed) throw new Error("The IM message inbox is closed");
    return this.#track(this.#ingest(imBindingId, credentialGeneration, rawEvent, admissionFence, telemetry));
  }

  async #ingest(
    imBindingId: string,
    credentialGeneration: number,
    rawEvent: NormalizedInboundImEvent,
    admissionFence?: { provider: "feishu"; holderInstanceId: string; fencingEpoch: number },
    telemetry?: { provider: "feishu" | "slack"; receivedAt?: Date },
  ): Promise<IngestResult> {
    const event = NormalizedInboundImEventSchema.parse(rawEvent);
    const provider = telemetry?.provider ?? admissionFence?.provider;
    return withSpan(
      "im.inbound.persist",
      imAttrs({
        provider,
        bindingId: imBindingId,
        providerEventId: event.providerEventId,
        externalMessageId: event.message.externalId,
      }),
      async () => {
        const createdTasks = new Map<string, TaskTitleGenerationRequest>();
        const overflowCandidates = new Map<string, OverflowCandidate>();
        const feedbackDeliveryIds = new Set<string>();
        try {
          const result = await this.#database.transaction(async (transaction) => {
            const now = this.#now();
            const receivedAt = telemetry?.receivedAt ?? now;
            const { agent, agentComputerId, agentCanExecute, scope } = await this.#acquireAndVerifyBindingScope(
              transaction,
              imBindingId,
              credentialGeneration,
              event,
              admissionFence,
              now,
            );
            if (isSelfAuthor(event, scope.imBinding.externalBotId)) {
              return finishIngestResult({ duplicate: false, deliveryIds: [] }, "self_message");
            }
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`im-message:${imBindingId}:${event.conversation.externalId}:${event.message.externalId}`}, 0))`,
            );
            await this.#afterMessageAuthority?.();
            const messageResolution = await this.#insertOrDeduplicateMessage(
              transaction,
              imBindingId,
              event,
              receivedAt,
            );
            if (messageResolution.kind !== "current") {
              return finishIngestResult(
                {
                  duplicate: messageResolution.kind === "duplicate",
                  messageId: messageResolution.messageId,
                  deliveryIds: [],
                },
                messageResolution.kind,
              );
            }
            const { created, previousCurrent, inheritedDeliveries, conversationKind, threadKey } = messageResolution;
            const deliverableTarget = resolveDeliverableTarget(
              conversationKind,
              agent.status,
              agentComputerId,
              agentCanExecute,
            );
            if (!deliverableTarget.ok) {
              return finishIngestResult(
                { duplicate: false, messageId: created.id, deliveryIds: [] },
                deliverableTarget.outcome,
              );
            }
            const direct = isDirectMessageOrMention(
              deliverableTarget.conversationKind,
              event,
              scope.imBinding.externalBotId,
            );
            const deliveries = await this.#resolveSessionDeliveries(transaction, {
              imBindingId,
              event,
              conversationKind: deliverableTarget.conversationKind,
              threadKey,
              direct,
              receiveMode: scope.agent.receiveMode,
              agentComputerId: deliverableTarget.agentComputerId,
              previousReceivedAt: previousCurrent?.receivedAt,
              inheritedDeliveries,
              createdTasks,
              now,
            });
            const deliveryIds = await this.#persistDeliveries(
              transaction,
              created,
              deliveries,
              overflowCandidates,
              feedbackDeliveryIds,
              receivedAt,
              now,
            );
            if (direct && threadKey === null) {
              await this.#backfillDirectRootThreadDeliveries(transaction, {
                imBindingId,
                event,
                created,
                conversationKind: deliverableTarget.conversationKind,
                agentComputerId: deliverableTarget.agentComputerId,
                createdTasks,
                feedbackDeliveryIds,
                overflowCandidates,
                receivedAt,
                now,
              });
            }
            await this.#retainOverflowCandidates(transaction, overflowCandidates);
            return finishPersistedIngestResult(created.id, deliveryIds);
          });
          for (const deliveryId of feedbackDeliveryIds) this.#notifyDeliveryChanged(deliveryId);
          for (const candidate of overflowCandidates.values()) {
            this.#queueOverflowExpiry(candidate);
          }
          this.#generateTaskTitles(createdTasks.values());
          return result;
        } catch (error) {
          setActiveSpanAttributes(outcomeAttrs("failed", classifyImInboundPersistenceError(error)));
          throw error;
        }
      },
    );
  }

  async #acquireAndVerifyBindingScope(
    transaction: DatabaseTransaction,
    imBindingId: string,
    credentialGeneration: number,
    event: NormalizedInboundImEvent,
    admissionFence: { provider: "feishu"; holderInstanceId: string; fencingEpoch: number } | undefined,
    now: Date,
  ) {
    const [candidate] = await transaction
      .select({ agentId: imBindings.agentId })
      .from(imBindings)
      .where(eq(imBindings.id, imBindingId))
      .limit(1);
    if (!candidate) {
      throw new ImInboundPersistenceError("IM_INBOUND_BINDING_STALE", "IM_BINDING_GENERATION_STALE");
    }
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`im-agent-custody:${candidate.agentId}`}, 0))`,
    );
    const [agent] = await transaction
      .select({
        computerId: agents.computerId,
        createdByUserId: agents.createdByUserId,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.id, candidate.agentId), ne(agents.status, "deleted")))
      .limit(1)
      .for("update");
    if (!agent) {
      throw new ImInboundPersistenceError("IM_INBOUND_BINDING_STALE", "IM_BINDING_GENERATION_STALE");
    }
    const agentComputerId = agent.computerId;
    const [computer] = agentComputerId
      ? await transaction
          .select({ ownerAccountId: computers.ownerAccountId })
          .from(computers)
          .where(eq(computers.id, agentComputerId))
          .limit(1)
          .for("update")
      : [];
    const agentCanExecute = computer?.ownerAccountId === agent.createdByUserId;
    await transaction
      .update(imBindings)
      .set({ externalTeamId: event.externalTeamId, updatedAt: now })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.provider, "feishu"),
          eq(imBindings.status, "active"),
          eq(imBindings.credentialGeneration, credentialGeneration),
          eq(imBindings.externalAppId, event.externalAppId),
          isNull(imBindings.externalTeamId),
        ),
      );
    const [scope] = await transaction
      .select({
        imBinding: imBindings,
        agent: {
          computerId: agents.computerId,
          receiveMode: agents.receiveMode,
        },
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.status, "active"),
          eq(imBindings.credentialGeneration, credentialGeneration),
          eq(agents.id, candidate.agentId),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1)
      .for("update", { of: imBindings });
    if (!scope) {
      throw new ImInboundPersistenceError("IM_INBOUND_BINDING_STALE", "IM_BINDING_GENERATION_STALE");
    }
    if (admissionFence) {
      if (
        scope.imBinding.provider !== "feishu" ||
        scope.imBinding.connectionOwnerInstanceId !== admissionFence.holderInstanceId ||
        scope.imBinding.connectionFencingEpoch !== admissionFence.fencingEpoch ||
        !scope.imBinding.connectionLeaseExpiresAt ||
        scope.imBinding.connectionLeaseExpiresAt <= now
      ) {
        throw new ImInboundPersistenceError("IM_INBOUND_FENCE_STALE", "FEISHU_CONNECTION_LEASE_STALE");
      }
      await this.#afterAdmissionFence?.();
    }
    if (scope.imBinding.externalAppId !== event.externalAppId) {
      throw new ImInboundPersistenceError("IM_INBOUND_IDENTITY_MISMATCH", "IM_BINDING_BINDING_IDENTITY_MISMATCH");
    }
    if (scope.imBinding.externalTeamId !== null && scope.imBinding.externalTeamId !== event.externalTeamId) {
      throw new ImInboundPersistenceError("IM_INBOUND_IDENTITY_MISMATCH", "IM_BINDING_WORKSPACE_IDENTITY_MISMATCH");
    }
    return { agent, agentComputerId, agentCanExecute, scope };
  }

  async #insertOrDeduplicateMessage(
    transaction: DatabaseTransaction,
    imBindingId: string,
    event: NormalizedInboundImEvent,
    receivedAt: Date,
  ): Promise<
    | { kind: "duplicate"; messageId: string | undefined }
    | { kind: "stale_revision"; messageId: string }
    | {
        kind: "current";
        created: typeof imMessages.$inferSelect;
        previousCurrent: { id: string; threadKey: string | null; receivedAt: Date } | undefined;
        inheritedDeliveries: Array<{
          sessionId: string;
          attention: DeliveryAttention;
          generation: number;
          conversationKind: "channel" | "dm" | "group_dm" | null;
          expiresAt: Date;
        }>;
        conversationKind: "channel" | "dm" | "group_dm" | null;
        threadKey: string | null;
      }
  > {
    const [previousCurrent] = await transaction
      .select({
        id: imMessages.id,
        threadKey: imMessages.threadKey,
        receivedAt: imMessages.receivedAt,
      })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, imBindingId),
          eq(imMessages.channelId, event.conversation.externalId),
          eq(imMessages.externalMessageId, event.message.externalId),
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
      .limit(1);
    const previousConversationKind = previousCurrent
      ? await this.#findConversationKind(transaction, imBindingId, event.conversation.externalId)
      : undefined;
    const inheritedDeliveries =
      previousCurrent && event.conversation.kind === "unknown"
        ? await transaction
            .select({
              sessionId: imMessageDeliveries.sessionId,
              attention: imMessageDeliveries.attention,
              generation: sessionPlacements.generation,
              conversationKind: sessions.conversationKind,
              expiresAt: imMessageDeliveries.expiresAt,
            })
            .from(imMessageDeliveries)
            .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
            .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
            .where(
              and(
                eq(imMessageDeliveries.messageId, previousCurrent.id),
                eq(imMessageDeliveries.attemptOrdinal, 0),
                eq(sessions.imBindingId, imBindingId),
                eq(sessions.channelId, event.conversation.externalId),
                isNull(sessions.endedAt),
              ),
            )
        : [];
    const conversationKind =
      event.conversation.kind === "unknown"
        ? (inheritedDeliveries[0]?.conversationKind ?? previousConversationKind ?? null)
        : event.conversation.kind;
    const threadKey =
      event.conversation.kind === "unknown" ? (previousCurrent?.threadKey ?? null) : (event.message.threadKey ?? null);
    const content = ImContentV1Schema.parse({
      ...event.message.content,
      resources: event.message.resources.map((resource, ordinal) => ({
        ...resource,
        ordinal,
        availability: resourceAvailability(resource),
      })),
    });
    const [created] = await transaction
      .insert(imMessages)
      .values({
        imBindingId,
        providerEventId: event.providerEventId,
        channelId: event.conversation.externalId,
        externalMessageId: event.message.externalId,
        providerRevisionKey: event.message.revisionKey,
        operation: event.message.operation,
        direction: "inbound",
        threadKey,
        replyToExternalId: event.message.replyToExternalId ?? null,
        authorKind: event.message.author.kind,
        authorExternalId: event.message.author.externalId,
        authorDisplayName: event.message.author.displayName ?? null,
        content,
        providerContext: event.providerContext,
        occurredAt: event.message.occurredAt,
        receivedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [existing] = await transaction
        .select({ id: imMessages.id })
        .from(imMessages)
        .where(
          and(
            eq(imMessages.imBindingId, imBindingId),
            or(
              eq(imMessages.providerEventId, event.providerEventId),
              and(
                eq(imMessages.channelId, event.conversation.externalId),
                eq(imMessages.externalMessageId, event.message.externalId),
                eq(imMessages.providerRevisionKey, event.message.revisionKey),
              ),
            ),
          ),
        )
        .limit(1);
      return { kind: "duplicate", messageId: existing?.id };
    }

    const [currentRevision] = await transaction
      .select({ id: imMessages.id })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, imBindingId),
          eq(imMessages.channelId, event.conversation.externalId),
          eq(imMessages.externalMessageId, event.message.externalId),
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
      .limit(1);
    if (currentRevision?.id !== created.id) {
      return { kind: "stale_revision", messageId: created.id };
    }
    await this.#beforeSupersedeDeliveries?.();
    const supersededMessageIds = transaction
      .select({ id: imMessages.id })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, imBindingId),
          eq(imMessages.channelId, event.conversation.externalId),
          eq(imMessages.externalMessageId, event.message.externalId),
          ne(imMessages.id, created.id),
        ),
      );
    await transaction
      .update(imMessageDeliveries)
      .set({ state: "expired", reason: "superseded_revision" })
      .where(
        and(eq(imMessageDeliveries.state, "pending"), inArray(imMessageDeliveries.messageId, supersededMessageIds)),
      );
    return { kind: "current", created, previousCurrent, inheritedDeliveries, conversationKind, threadKey };
  }

  async #resolveSessionDeliveries(
    transaction: DatabaseTransaction,
    input: {
      imBindingId: string;
      event: NormalizedInboundImEvent;
      conversationKind: "channel" | "dm" | "group_dm";
      threadKey: string | null;
      direct: boolean;
      receiveMode: "mention_only" | "all_message";
      agentComputerId: string;
      previousReceivedAt: Date | undefined;
      inheritedDeliveries: Array<{
        sessionId: string;
        attention: DeliveryAttention;
        generation: number;
        expiresAt: Date;
      }>;
      createdTasks: Map<string, TaskTitleGenerationRequest>;
      now: Date;
    },
  ): Promise<
    Array<{
      sessionId: string;
      attention: DeliveryAttention;
      generation: number;
      continuity?: boolean;
    }>
  > {
    const {
      imBindingId,
      event,
      conversationKind,
      threadKey,
      direct,
      receiveMode,
      agentComputerId,
      previousReceivedAt,
      inheritedDeliveries,
      createdTasks,
      now,
    } = input;
    /*
     * Attention states whether this message itself addresses the Agent (a DM or an @-mention).
     * Thread continuity only decides delivery and retention: an unaddressed follow-up in a
     * Thread the Agent was brought into stays ambient, so the Agent judges whether it is meant
     * for it instead of being told it was addressed.
     */
    const deliveries: Array<{
      sessionId: string;
      attention: DeliveryAttention;
      generation: number;
      continuity?: boolean;
    }> = [];
    if (event.conversation.kind === "unknown") {
      deliveries.push(
        ...inheritedDeliveries.map(({ sessionId, attention, generation, expiresAt }) => ({
          sessionId,
          attention,
          generation,
          continuity: hadDirectRetention(expiresAt, previousReceivedAt),
        })),
      );
      return deliveries;
    }
    if (threadKey) {
      return this.#resolveThreadSessionDeliveries(transaction, {
        imBindingId,
        event,
        conversationKind,
        threadKey,
        direct,
        receiveMode,
        agentComputerId,
        createdTasks,
        now,
      });
    }
    if (direct || receiveMode === "all_message") {
      const channel = await this.#ensureChatSession(transaction, {
        imBindingId,
        channelId: event.conversation.externalId,
        conversationKind,
        kind: "channel",
        computerId: agentComputerId,
        now,
      });
      recordCreatedTask(createdTasks, channel, event.message.content.fallbackText);
      deliveries.push({
        sessionId: channel.id,
        attention: direct ? "direct" : "ambient",
        generation: channel.generation,
      });
    }
    return deliveries;
  }

  async #resolveThreadSessionDeliveries(
    transaction: DatabaseTransaction,
    input: {
      imBindingId: string;
      event: NormalizedInboundImEvent;
      conversationKind: "channel" | "dm" | "group_dm";
      threadKey: string;
      direct: boolean;
      receiveMode: "mention_only" | "all_message";
      agentComputerId: string;
      createdTasks: Map<string, TaskTitleGenerationRequest>;
      now: Date;
    },
  ): Promise<
    Array<{
      sessionId: string;
      attention: DeliveryAttention;
      generation: number;
      continuity?: boolean;
    }>
  > {
    const { imBindingId, event, conversationKind, threadKey, direct, receiveMode, agentComputerId, createdTasks, now } =
      input;
    const deliveries: Array<{
      sessionId: string;
      attention: DeliveryAttention;
      generation: number;
      continuity?: boolean;
    }> = [];
    const existingThread = await this.#findChatSession(
      transaction,
      imBindingId,
      event.conversation.externalId,
      "thread",
      threadKey,
    );
    const { directContinuity, shouldDeliverThread } = await this.#evaluateThreadDeliveryEligibility(
      transaction,
      imBindingId,
      event,
      threadKey,
      existingThread,
      direct,
      receiveMode,
    );
    if (shouldDeliverThread) {
      const thread = await this.#ensureOrReuseChatSession(transaction, existingThread, {
        imBindingId,
        channelId: event.conversation.externalId,
        conversationKind,
        kind: "thread",
        threadKey,
        computerId: agentComputerId,
        now,
      });
      recordCreatedTask(createdTasks, thread, event.message.content.fallbackText);
      deliveries.push({
        sessionId: thread.id,
        attention: direct ? "direct" : "ambient",
        generation: thread.generation,
        continuity: directContinuity,
      });
    }
    if (receiveMode === "all_message") {
      const channel = await this.#ensureChatSession(transaction, {
        imBindingId,
        channelId: event.conversation.externalId,
        conversationKind,
        kind: "channel",
        computerId: agentComputerId,
        now,
      });
      recordCreatedTask(createdTasks, channel, event.message.content.fallbackText);
      deliveries.push({ sessionId: channel.id, attention: "ambient", generation: channel.generation });
    }
    return deliveries;
  }

  async #evaluateThreadDeliveryEligibility(
    transaction: DatabaseTransaction,
    imBindingId: string,
    event: NormalizedInboundImEvent,
    threadKey: string,
    existingThread: { id: string; generation: number } | undefined,
    direct: boolean,
    receiveMode: "mention_only" | "all_message",
  ): Promise<{ directContinuity: boolean; shouldDeliverThread: boolean }> {
    const endedThreadExists = existingThread
      ? false
      : await this.#hasEndedThreadSession(transaction, imBindingId, event.conversation.externalId, threadKey);
    const rootExternalId = await this.#reliableThreadRootExternalId(
      transaction,
      imBindingId,
      event.conversation.externalId,
      threadKey,
      event.providerContext,
    );
    const rootWasDirect = rootExternalId
      ? await this.#rootWasDirectToChannelSession(
          transaction,
          imBindingId,
          event.conversation.externalId,
          rootExternalId,
        )
      : false;
    const threadWasDirect = existingThread ? await this.#threadSessionWasDirect(transaction, existingThread.id) : false;
    const directContinuity = direct || threadWasDirect || rootWasDirect;
    const shouldDeliverThread = existingThread
      ? directContinuity || receiveMode === "all_message"
      : direct || (!endedThreadExists && (rootWasDirect || receiveMode === "all_message"));
    return { directContinuity, shouldDeliverThread };
  }

  async #backfillDirectRootThreadDeliveries(
    transaction: DatabaseTransaction,
    input: {
      imBindingId: string;
      event: NormalizedInboundImEvent;
      created: typeof imMessages.$inferSelect;
      conversationKind: "channel" | "dm" | "group_dm";
      agentComputerId: string;
      createdTasks: Map<string, TaskTitleGenerationRequest>;
      feedbackDeliveryIds: Set<string>;
      overflowCandidates: Map<string, OverflowCandidate>;
      receivedAt: Date;
      now: Date;
    },
  ): Promise<void> {
    const {
      imBindingId,
      event,
      created,
      conversationKind,
      agentComputerId,
      createdTasks,
      feedbackDeliveryIds,
      overflowCandidates,
      receivedAt,
      now,
    } = input;
    const rootExternalId = sql<string | null>`nullif(case when ${imMessages.providerContext}->>'provider' = 'slack'
      then ${imMessages.providerContext}->>'threadTs' else ${imMessages.providerContext}->>'rootId' end, '')`;
    const newestFirst = sql`${imMessages.occurredAt} desc, ${imMessages.providerRevisionKey} desc, ${imMessages.id} desc`;
    const rankedMessages = transaction
      .select({
        id: imMessages.id,
        threadKey: imMessages.threadKey,
        revisionRank: sql<number>`row_number() over (
          partition by ${imMessages.externalMessageId} order by ${newestFirst})`.as("revision_rank"),
        rootExternalId: sql<string | null>`first_value(${rootExternalId}) over (
          partition by ${imMessages.threadKey} order by (${rootExternalId} is null), ${newestFirst})`.as(
          "root_external_id",
        ),
      })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, imBindingId),
          eq(imMessages.channelId, event.conversation.externalId),
          eq(imMessages.direction, "inbound"),
          isNotNull(imMessages.threadKey),
          gte(imMessages.occurredAt, created.occurredAt),
        ),
      )
      .as("ranked_thread_messages");
    const pendingThreadMessages = await transaction
      .select()
      .from(imMessages)
      .where(
        inArray(
          imMessages.id,
          transaction
            .select({ id: rankedMessages.id })
            .from(rankedMessages)
            .where(
              and(
                eq(rankedMessages.revisionRank, 1),
                eq(rankedMessages.rootExternalId, event.message.externalId),
                ne(rankedMessages.threadKey, ""),
              ),
            ),
        ),
      )
      .orderBy(asc(imMessages.occurredAt), asc(imMessages.providerRevisionKey), asc(imMessages.id));
    for (const pending of pendingThreadMessages) {
      if (
        !pending.threadKey ||
        (await this.#hasEndedThreadSession(transaction, imBindingId, event.conversation.externalId, pending.threadKey))
      ) {
        continue;
      }
      const thread = await this.#ensureChatSession(transaction, {
        imBindingId,
        channelId: event.conversation.externalId,
        conversationKind,
        kind: "thread",
        threadKey: pending.threadKey,
        computerId: agentComputerId,
        now,
      });
      recordCreatedTask(createdTasks, thread, event.message.content.fallbackText);
      const backfilled = await this.#backfillThreadDelivery(transaction, pending, thread, receivedAt, now);
      for (const id of backfilled) feedbackDeliveryIds.add(id);
      const candidate = { sessionId: thread.id, attention: "ambient" as const };
      overflowCandidates.set(candidate.sessionId, candidate);
    }
  }

  async #backfillThreadDelivery(
    transaction: DatabaseTransaction,
    pending: typeof imMessages.$inferSelect,
    thread: ChatSessionPlacement,
    receivedAt: Date,
    now: Date,
  ): Promise<string[]> {
    const repeated = await repeatsPendingInput(transaction, pending, thread.id, "ambient", now);
    const retention = {
      expiresAt: new Date(receivedAt.getTime() + DIRECT_TTL_MS),
      ...(repeated ? { state: "expired" as const, reason: IM_DUPLICATE_PENDING_REASON } : {}),
    };
    // The direct root establishes continuity for these earlier-committed replies; they
    // stay ambient because they do not address the Agent themselves.
    const [retained] = await transaction
      .update(imMessageDeliveries)
      .set(retention)
      .where(
        and(
          eq(imMessageDeliveries.messageId, pending.id),
          eq(imMessageDeliveries.attemptOrdinal, 0),
          eq(imMessageDeliveries.sessionId, thread.id),
          eq(imMessageDeliveries.state, "pending"),
          isNull(imMessageDeliveries.reason),
          eq(imMessageDeliveries.attention, "ambient"),
          isNull(imMessageDeliveries.dispatchRequestId),
          isNull(imMessageDeliveries.dispatchInputHash),
          isNull(imMessageDeliveries.dispatchPayload),
          isNull(imMessageDeliveries.inputHash),
          isNull(imMessageDeliveries.steerTargetDeliveryId),
          sql`coalesce(${imMessageDeliveries.lastErrorCode}, '') not like 'IM_DELIVERY_CLAIM_%'`,
        ),
      )
      .returning({ id: imMessageDeliveries.id });
    if (!retained) {
      const backfilled = await transaction
        .insert(imMessageDeliveries)
        .values({
          messageId: pending.id,
          sessionId: thread.id,
          attention: "ambient",
          placementGeneration: thread.generation,
          nextAttemptAt: now,
          ...retention,
        })
        .onConflictDoNothing()
        .returning({ id: imMessageDeliveries.id });
      return repeated ? [] : backfilled.map((row) => row.id);
    }
    return [];
  }

  async #persistDeliveries(
    transaction: DatabaseTransaction,
    created: typeof imMessages.$inferSelect,
    deliveries: Array<{ sessionId: string; attention: DeliveryAttention; generation: number; continuity?: boolean }>,
    overflowCandidates: Map<string, OverflowCandidate>,
    feedbackDeliveryIds: Set<string>,
    receivedAt: Date,
    now: Date,
  ): Promise<string[]> {
    const deliveryIds: string[] = [];
    for (const delivery of deliveries) {
      const repeated = await repeatsPendingInput(transaction, created, delivery.sessionId, delivery.attention, now);
      const [deliveryRow] = await transaction
        .insert(imMessageDeliveries)
        .values({
          messageId: created.id,
          sessionId: delivery.sessionId,
          attention: delivery.attention,
          ...(repeated ? { state: "expired" as const, reason: IM_DUPLICATE_PENDING_REASON } : {}),
          placementGeneration: delivery.generation,
          nextAttemptAt: now,
          expiresAt: new Date(receivedAt.getTime() + deliveryRetentionMs(delivery)),
        })
        .onConflictDoNothing()
        .returning({ id: imMessageDeliveries.id });
      if (deliveryRow && !repeated) {
        await createImFeedbackTarget(transaction, deliveryRow.id, now);
        deliveryIds.push(deliveryRow.id);
        feedbackDeliveryIds.add(deliveryRow.id);
      }
      overflowCandidates.set(delivery.sessionId, delivery);
    }
    return deliveryIds;
  }

  #notifyDeliveryChanged(deliveryId: string): void {
    try {
      this.#onDeliveryChanged?.(deliveryId);
    } catch (error) {
      this.#logger?.error({ err: error, deliveryId }, "IM queue feedback scheduling failed");
    }
  }

  async #hasOverflow(transaction: DatabaseTransaction, sessionId: string): Promise<boolean> {
    const rows = await transaction
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .where(
        and(
          eq(imMessageDeliveries.sessionId, sessionId),
          eq(imMessageDeliveries.state, "pending"),
          sql`${imMessageDeliveries.expiresAt} > now()`,
          isNull(imMessageDeliveries.reason),
          isNull(imMessageDeliveries.dispatchRequestId),
          isNull(imMessageDeliveries.steerTargetDeliveryId),
          sql`coalesce(${imMessageDeliveries.lastErrorCode}, '') not like 'IM_DELIVERY_CLAIM_%'`,
          sql`exists (
            select 1 from session_placements p inner join computers c on c.id = p.computer_id
            where p.session_id = ${imMessageDeliveries.sessionId} and c.kind in ('local', 'cloud')
          )`,
        ),
      )
      .limit(1)
      .offset(IM_QUEUE_CAPACITY);
    return rows.length > 0;
  }

  async #retainOverflowCandidates(
    transaction: DatabaseTransaction,
    candidates: Map<string, OverflowCandidate>,
  ): Promise<void> {
    for (const candidate of candidates.values()) {
      if (await this.#hasOverflow(transaction, candidate.sessionId)) continue;
      candidates.delete(candidate.sessionId);
    }
  }

  #queueOverflowExpiry(candidate: OverflowCandidate): void {
    if (this.#closed) return;
    const key = candidate.sessionId;
    if (this.#overflowPasses.has(key)) {
      this.#overflowRechecks.set(key, candidate);
      return;
    }
    const pass = Promise.resolve()
      .then(async () => {
        const hasOverflow = await this.#database.transaction((transaction) =>
          this.#hasOverflow(transaction, candidate.sessionId),
        );
        if (!hasOverflow || this.#closed) return;
        await this.#beforeOverflowExpiry?.();
        if (this.#closed) return;
        const expiredIds = await this.#database.transaction((transaction) =>
          this.#expireOverflow(transaction, candidate.sessionId),
        );
        for (const id of expiredIds) this.#notifyDeliveryChanged(id);
        await this.#afterOverflowExpiry?.();
      })
      .catch((error: unknown) => {
        this.#logger?.error(
          { err: error, sessionId: candidate.sessionId, attention: candidate.attention },
          "IM message inbox overflow expiry failed",
        );
      })
      .finally(() => {
        this.#overflowPasses.delete(key);
        const recheck = this.#overflowRechecks.get(key);
        if (!recheck) return;
        this.#overflowRechecks.delete(key);
        this.#queueOverflowExpiry(recheck);
      });
    this.#overflowPasses.set(key, pass);
  }

  async #expireOverflow(transaction: DatabaseTransaction, sessionId: string): Promise<string[]> {
    const expired = (await transaction.execute(sql`
      with overflow as (
        select d.id
        from im_message_deliveries d
        join im_messages m on m.id = d.message_id
        where d.session_id = ${sessionId}
          and d.state = 'pending' and d.reason is null
          and d.expires_at > now()
          and d.dispatch_request_id is null and d.steer_target_delivery_id is null
          and coalesce(d.last_error_code, '') not like 'IM_DELIVERY_CLAIM_%'
          and exists (
            select 1 from session_placements p inner join computers c on c.id = p.computer_id
            where p.session_id = d.session_id and c.kind in ('local', 'cloud')
          )
        order by m.occurred_at desc, m.provider_revision_key desc, m.id desc
        offset ${IM_QUEUE_CAPACITY}
      )
      update im_message_deliveries as d
      set state = 'expired'::im_delivery_state, reason = 'capacity'
      where d.id in (select id from overflow)
        and d.state = 'pending' and d.reason is null
        and d.expires_at > now()
        and d.dispatch_request_id is null and d.steer_target_delivery_id is null
        and coalesce(d.last_error_code, '') not like 'IM_DELIVERY_CLAIM_%'
      returning d.id
    `)) as Array<{ id: string }>;
    return expired.map((row) => row.id);
  }

  async #findConversationKind(
    transaction: DatabaseTransaction,
    imBindingId: string,
    channelId: string,
  ): Promise<"channel" | "dm" | "group_dm" | undefined> {
    const [row] = await transaction
      .select({ conversationKind: sessions.conversationKind })
      .from(sessions)
      .where(
        and(
          eq(sessions.imBindingId, imBindingId),
          eq(sessions.channelId, channelId),
          eq(sessions.kind, "channel"),
          isNull(sessions.threadKey),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    return row?.conversationKind;
  }

  async #findChatSession(
    transaction: DatabaseTransaction,
    imBindingId: string,
    channelId: string,
    kind: "channel" | "thread",
    threadKey: string | null,
  ): Promise<{ id: string; generation: number } | undefined> {
    const [row] = await transaction
      .select({ id: sessions.id, generation: sessionPlacements.generation })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.imBindingId, imBindingId),
          eq(sessions.channelId, channelId),
          eq(sessions.kind, kind),
          threadKey === null ? isNull(sessions.threadKey) : eq(sessions.threadKey, threadKey),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    return row;
  }

  async #ensureChatSession(
    transaction: DatabaseTransaction,
    input: EnsureChatSessionInput,
  ): Promise<CreatedChatSession> {
    const existing = await this.#findChatSession(
      transaction,
      input.imBindingId,
      input.channelId,
      input.kind,
      input.threadKey ?? null,
    );
    const result = await this.#sessions.ensureChatSessionInTransaction(transaction, input);
    return { id: result.session.id, generation: result.placement.generation, created: existing === undefined };
  }

  async #ensureOrReuseChatSession(
    transaction: DatabaseTransaction,
    existing: ChatSessionPlacement | undefined,
    input: EnsureChatSessionInput,
  ): Promise<CreatedChatSession> {
    if (existing) return { ...existing, created: false };
    return this.#ensureChatSession(transaction, input);
  }

  async #hasEndedThreadSession(
    transaction: DatabaseTransaction,
    imBindingId: string,
    channelId: string,
    threadKey: string,
  ): Promise<boolean> {
    const [row] = await transaction
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.imBindingId, imBindingId),
          eq(sessions.channelId, channelId),
          eq(sessions.kind, "thread"),
          eq(sessions.threadKey, threadKey),
          isNotNull(sessions.endedAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async #rootWasDirectToChannelSession(
    transaction: DatabaseTransaction,
    imBindingId: string,
    channelId: string,
    rootExternalId: string,
  ): Promise<boolean> {
    const [row] = await transaction
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .where(
        and(
          eq(imMessages.imBindingId, imBindingId),
          eq(imMessages.channelId, channelId),
          eq(imMessages.externalMessageId, rootExternalId),
          eq(imMessages.direction, "inbound"),
          eq(imMessageDeliveries.attention, "direct"),
          eq(sessions.imBindingId, imBindingId),
          eq(sessions.channelId, channelId),
          eq(sessions.kind, "channel"),
          isNull(sessions.threadKey),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async #threadSessionWasDirect(transaction: DatabaseTransaction, sessionId: string): Promise<boolean> {
    const [row] = await transaction
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
      .where(
        and(
          eq(imMessageDeliveries.sessionId, sessionId),
          eq(imMessageDeliveries.attention, "direct"),
          eq(imMessages.direction, "inbound"),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async #reliableThreadRootExternalId(
    transaction: DatabaseTransaction,
    imBindingId: string,
    channelId: string,
    threadKey: string,
    currentContext: NormalizedInboundImEvent["providerContext"],
  ): Promise<string | undefined> {
    const current = threadRootExternalId(currentContext);
    if (current) return current;
    this.#beforeReliableThreadRootLookup?.();
    const rootExternalId = sql<string | null>`nullif(case when ${imMessages.providerContext}->>'provider' = 'slack'
      then ${imMessages.providerContext}->>'threadTs' else ${imMessages.providerContext}->>'rootId' end, '')`;
    const [context] = await transaction
      .select({ rootExternalId })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, imBindingId),
          eq(imMessages.channelId, channelId),
          eq(imMessages.threadKey, threadKey),
          eq(imMessages.direction, "inbound"),
          isNotNull(rootExternalId),
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
      .limit(1);
    return context?.rootExternalId ?? undefined;
  }
}

function finishIngestResult(result: IngestResult, outcome: string): IngestResult {
  setActiveSpanAttributes({
    ...imAttrs({
      messageId: result.messageId,
      deliveryCount: result.deliveryIds.length,
      duplicate: result.duplicate,
    }),
    ...outcomeAttrs(outcome),
  });
  return result;
}

function finishPersistedIngestResult(messageId: string, deliveryIds: string[]): IngestResult {
  return finishIngestResult(
    { duplicate: false, messageId, deliveryIds },
    deliveryIds.length > 0 ? "persisted" : "no_delivery",
  );
}

function isSelfAuthor(event: NormalizedInboundImEvent, externalBotId: string | null): boolean {
  return (
    event.message.author.isSelf === true ||
    (event.message.author.kind === "bot" && event.message.author.externalId === externalBotId)
  );
}

function resolveDeliverableTarget(
  conversationKind: "channel" | "dm" | "group_dm" | null,
  agentStatus: string,
  agentComputerId: string | null,
  agentCanExecute: boolean,
):
  | { ok: true; conversationKind: "channel" | "dm" | "group_dm"; agentComputerId: string }
  | { ok: false; outcome: "no_delivery" | "agent_inactive" | "agent_computer_not_bound" | "agent_rebind_required" } {
  if (conversationKind === null) return { ok: false, outcome: "no_delivery" };
  if (agentStatus !== "active") return { ok: false, outcome: "agent_inactive" };
  // A Session is placed on the Agent's Computer, so an Agent that has none has nowhere to
  // run. The message is still recorded; only the delivery it cannot receive is withheld.
  if (agentComputerId === null) return { ok: false, outcome: "agent_computer_not_bound" };
  if (!agentCanExecute) return { ok: false, outcome: "agent_rebind_required" };
  return { ok: true, conversationKind, agentComputerId };
}

function isDirectMessageOrMention(
  conversationKind: "channel" | "dm" | "group_dm",
  event: NormalizedInboundImEvent,
  externalBotId: string | null,
): boolean {
  return conversationKind === "dm" || event.mentions.some((mention) => mention.externalId === externalBotId);
}

function resourceAvailability(resource: NonNullable<ImContentV1["resources"]>[number]) {
  if (resource.availability && resource.availability !== "available") return resource.availability;
  return resource.sizeBytes != null && resource.sizeBytes > 25 * 1024 * 1024 ? "too_large" : "available";
}
