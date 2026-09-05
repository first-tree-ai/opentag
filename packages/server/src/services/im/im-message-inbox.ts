import { ImContentV1Schema, type NormalizedInboundImEvent, NormalizedInboundImEventSchema } from "@opentag/shared";
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
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
import { threadRootExternalId } from "./provider-thread-context.js";

const DIRECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AMBIENT_TTL_MS = 24 * 60 * 60 * 1000;
const TASK_TITLE_GENERATION_TIMEOUT_MS = 3_000;

type DeliveryAttention = "direct" | "ambient";

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
  readonly #beforeReliableThreadRootLookup: (() => void) | undefined;
  readonly #beforeSupersedeDeliveries: (() => Promise<void>) | undefined;
  readonly #beforeOverflowExpiry: (() => Promise<void>) | undefined;
  readonly #database: DatabaseClient;
  readonly #logger: Pick<ServiceLogger, "error"> | undefined;
  readonly #now: () => Date;
  readonly #onTaskCreated: ((request: TaskTitleGenerationRequest) => Promise<void> | void) | undefined;
  readonly #overflowPasses = new Map<string, Promise<void>>();
  readonly #sessions: SessionService;

  constructor(
    database: DatabaseClient,
    options: {
      now?: () => Date;
      afterAdmissionFence?: () => Promise<void>;
      afterMessageAuthority?: () => Promise<void>;
      beforeReliableThreadRootLookup?: () => void;
      beforeSupersedeDeliveries?: () => Promise<void>;
      beforeOverflowExpiry?: () => Promise<void>;
      logger?: Pick<ServiceLogger, "error">;
      onTaskCreated?: (request: TaskTitleGenerationRequest) => Promise<void> | void;
    } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onTaskCreated = options.onTaskCreated;
    this.#afterAdmissionFence = options.afterAdmissionFence;
    this.#afterMessageAuthority = options.afterMessageAuthority;
    this.#beforeReliableThreadRootLookup = options.beforeReliableThreadRootLookup;
    this.#beforeSupersedeDeliveries = options.beforeSupersedeDeliveries;
    this.#beforeOverflowExpiry = options.beforeOverflowExpiry;
    this.#logger = options.logger;
    this.#sessions = new SessionService(database, { now: this.#now });
  }

  async ingest(
    imBindingId: string,
    credentialGeneration: number,
    rawEvent: NormalizedInboundImEvent,
    admissionFence?: { provider: "feishu"; holderInstanceId: string; fencingEpoch: number },
    telemetry?: { provider: "feishu" | "slack" },
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
        try {
          const result = await this.#database.transaction(async (transaction) => {
            const finish = (result: IngestResult, outcome: string): IngestResult => {
              setActiveSpanAttributes({
                ...imAttrs({
                  messageId: result.messageId,
                  deliveryCount: result.deliveryIds.length,
                  duplicate: result.duplicate,
                }),
                ...outcomeAttrs(outcome),
              });
              return result;
            };
            const now = this.#now();
            const [candidate] = await transaction
              .select({ agentId: imBindings.agentId })
              .from(imBindings)
              .where(eq(imBindings.id, imBindingId))
              .limit(1);
            if (!candidate) {
              throw new ImInboundPersistenceError("IM_INBOUND_BINDING_STALE", "IM_BINDING_GENERATION_STALE");
            }
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
              throw new ImInboundPersistenceError(
                "IM_INBOUND_IDENTITY_MISMATCH",
                "IM_BINDING_BINDING_IDENTITY_MISMATCH",
              );
            }
            if (scope.imBinding.externalTeamId !== null && scope.imBinding.externalTeamId !== event.externalTeamId) {
              throw new ImInboundPersistenceError(
                "IM_INBOUND_IDENTITY_MISMATCH",
                "IM_BINDING_WORKSPACE_IDENTITY_MISMATCH",
              );
            }
            const isSelf =
              event.message.author.isSelf === true ||
              (event.message.author.kind === "bot" &&
                event.message.author.externalId === scope.imBinding.externalBotId);
            if (isSelf) return finish({ duplicate: false, deliveryIds: [] }, "self_message");
            await transaction.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`im-message:${imBindingId}:${event.conversation.externalId}:${event.message.externalId}`}, 0))`,
            );
            await this.#afterMessageAuthority?.();
            const [previousCurrent] = await transaction
              .select({
                id: imMessages.id,
                threadKey: imMessages.threadKey,
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
                    })
                    .from(imMessageDeliveries)
                    .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
                    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
                    .where(
                      and(
                        eq(imMessageDeliveries.messageId, previousCurrent.id),
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
              event.conversation.kind === "unknown"
                ? (previousCurrent?.threadKey ?? null)
                : (event.message.threadKey ?? null);
            const content = ImContentV1Schema.parse({
              ...event.message.content,
              resources: event.message.resources.map((resource, ordinal) => ({
                ...resource,
                ordinal,
                availability:
                  resource.sizeBytes != null && resource.sizeBytes > 25 * 1024 * 1024 ? "too_large" : "available",
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
                receivedAt: now,
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
              return finish({ duplicate: true, messageId: existing?.id, deliveryIds: [] }, "duplicate");
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
              return finish({ duplicate: false, messageId: created.id, deliveryIds: [] }, "stale_revision");
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
                and(
                  eq(imMessageDeliveries.state, "pending"),
                  inArray(imMessageDeliveries.messageId, supersededMessageIds),
                ),
              );

            if (conversationKind === null) {
              return finish({ duplicate: false, messageId: created.id, deliveryIds: [] }, "no_delivery");
            }
            if (agent.status !== "active") {
              return finish({ duplicate: false, messageId: created.id, deliveryIds: [] }, "agent_inactive");
            }
            // A Session is placed on the Agent's Computer, so an Agent that has none has nowhere to
            // run. The message is still recorded; only the delivery it cannot receive is withheld.
            if (agentComputerId === null) {
              return finish({ duplicate: false, messageId: created.id, deliveryIds: [] }, "agent_computer_not_bound");
            }
            if (!agentCanExecute) {
              return finish({ duplicate: false, messageId: created.id, deliveryIds: [] }, "agent_rebind_required");
            }
            const direct =
              conversationKind === "dm" ||
              event.mentions.some((mention) => mention.externalId === scope.imBinding.externalBotId);
            const deliveries: Array<{ sessionId: string; attention: "direct" | "ambient"; generation: number }> = [];
            if (event.conversation.kind === "unknown") {
              deliveries.push(
                ...inheritedDeliveries.map(({ sessionId, attention, generation }) => ({
                  sessionId,
                  attention,
                  generation,
                })),
              );
            } else {
              if (threadKey) {
                const existingThread = await this.#findChatSession(
                  transaction,
                  imBindingId,
                  event.conversation.externalId,
                  "thread",
                  threadKey,
                );
                const endedThreadExists = existingThread
                  ? false
                  : await this.#hasEndedThreadSession(
                      transaction,
                      imBindingId,
                      event.conversation.externalId,
                      threadKey,
                    );
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
                const threadWasDirect = existingThread
                  ? await this.#threadSessionWasDirect(transaction, existingThread.id)
                  : false;
                const directContinuity = direct || threadWasDirect || rootWasDirect;
                const shouldDeliverThread = existingThread
                  ? directContinuity || scope.agent.receiveMode === "all_message"
                  : direct || (!endedThreadExists && (rootWasDirect || scope.agent.receiveMode === "all_message"));
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
                    attention: directContinuity ? "direct" : "ambient",
                    generation: thread.generation,
                  });
                }
                if (scope.agent.receiveMode === "all_message") {
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
              } else if (direct || scope.agent.receiveMode === "all_message") {
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
            }

            const deliveryIds: string[] = [];
            for (const delivery of deliveries) {
              const [deliveryRow] = await transaction
                .insert(imMessageDeliveries)
                .values({
                  messageId: created.id,
                  sessionId: delivery.sessionId,
                  attention: delivery.attention,
                  placementGeneration: delivery.generation,
                  nextAttemptAt: now,
                  expiresAt: new Date(
                    now.getTime() + (delivery.attention === "direct" ? DIRECT_TTL_MS : AMBIENT_TTL_MS),
                  ),
                })
                .onConflictDoNothing()
                .returning({ id: imMessageDeliveries.id });
              if (deliveryRow) deliveryIds.push(deliveryRow.id);
              overflowCandidates.set(this.#overflowKey(delivery.sessionId, delivery.attention), delivery);
            }
            if (direct && threadKey === null) {
              const pendingThreadMessages = await transaction
                .select({
                  id: imMessages.id,
                  externalMessageId: imMessages.externalMessageId,
                  threadKey: imMessages.threadKey,
                  providerContext: imMessages.providerContext,
                  occurredAt: imMessages.occurredAt,
                  providerRevisionKey: imMessages.providerRevisionKey,
                })
                .from(imMessages)
                .where(
                  and(
                    eq(imMessages.imBindingId, imBindingId),
                    eq(imMessages.channelId, event.conversation.externalId),
                    eq(imMessages.direction, "inbound"),
                    isNotNull(imMessages.threadKey),
                    or(gt(imMessages.occurredAt, created.occurredAt), eq(imMessages.occurredAt, created.occurredAt)),
                  ),
                )
                .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id));
              const reliableRootsByThreadKey = new Map<string, string>();
              for (const pending of pendingThreadMessages) {
                if (!pending.threadKey || reliableRootsByThreadKey.has(pending.threadKey)) continue;
                const reliableRootExternalId = threadRootExternalId(pending.providerContext);
                if (reliableRootExternalId) {
                  reliableRootsByThreadKey.set(pending.threadKey, reliableRootExternalId);
                }
              }
              const seenExternalMessageIds = new Set<string>();
              for (const pending of pendingThreadMessages) {
                if (seenExternalMessageIds.has(pending.externalMessageId)) continue;
                seenExternalMessageIds.add(pending.externalMessageId);
                if (
                  !pending.threadKey ||
                  reliableRootsByThreadKey.get(pending.threadKey) !== event.message.externalId ||
                  (await this.#hasEndedThreadSession(
                    transaction,
                    imBindingId,
                    event.conversation.externalId,
                    pending.threadKey,
                  ))
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
                const [upgraded] = await transaction
                  .update(imMessageDeliveries)
                  .set({
                    attention: "direct",
                    expiresAt: new Date(now.getTime() + DIRECT_TTL_MS),
                  })
                  .where(
                    and(
                      eq(imMessageDeliveries.messageId, pending.id),
                      eq(imMessageDeliveries.sessionId, thread.id),
                      eq(imMessageDeliveries.state, "pending"),
                      eq(imMessageDeliveries.attention, "ambient"),
                      isNull(imMessageDeliveries.dispatchRequestId),
                      isNull(imMessageDeliveries.dispatchInputHash),
                      isNull(imMessageDeliveries.dispatchPayload),
                      isNull(imMessageDeliveries.inputHash),
                    ),
                  )
                  .returning({ id: imMessageDeliveries.id });
                if (!upgraded)
                  await transaction
                    .insert(imMessageDeliveries)
                    .values({
                      messageId: pending.id,
                      sessionId: thread.id,
                      attention: "direct",
                      placementGeneration: thread.generation,
                      nextAttemptAt: now,
                      expiresAt: new Date(now.getTime() + DIRECT_TTL_MS),
                    })
                    .onConflictDoNothing();
                const candidate = { sessionId: thread.id, attention: "direct" as const };
                overflowCandidates.set(this.#overflowKey(candidate.sessionId, candidate.attention), candidate);
              }
            }
            await this.#retainOverflowCandidates(transaction, overflowCandidates);
            return finish(
              { duplicate: false, messageId: created.id, deliveryIds },
              deliveryIds.length > 0 ? "persisted" : "no_delivery",
            );
          });
          for (const candidate of overflowCandidates.values()) {
            this.#queueOverflowExpiry(candidate);
          }
          for (const request of createdTasks.values()) {
            const controller = new AbortController();
            const timer = setTimeout(
              () => controller.abort("task_title_generation_timeout"),
              TASK_TITLE_GENERATION_TIMEOUT_MS,
            );
            timer.unref();
            void Promise.resolve(this.#onTaskCreated?.({ ...request, signal: controller.signal }))
              .catch(() => undefined)
              .finally(() => clearTimeout(timer));
          }
          return result;
        } catch (error) {
          setActiveSpanAttributes(outcomeAttrs("failed", classifyImInboundPersistenceError(error)));
          throw error;
        }
      },
    );
  }

  #overflowKey(sessionId: string, attention: DeliveryAttention): string {
    return `${sessionId}:${attention}`;
  }

  async #hasOverflow(
    transaction: DatabaseTransaction,
    sessionId: string,
    attention: DeliveryAttention,
  ): Promise<boolean> {
    const capacity = attention === "direct" ? 100 : 500;
    const [row] = await transaction
      .select({ count: sql<number>`count(*)` })
      .from(imMessageDeliveries)
      .where(
        and(
          eq(imMessageDeliveries.sessionId, sessionId),
          eq(imMessageDeliveries.attention, attention),
          eq(imMessageDeliveries.state, "pending"),
          isNull(imMessageDeliveries.reason),
        ),
      );
    return Number(row?.count ?? 0) > capacity;
  }

  async #retainOverflowCandidates(
    transaction: DatabaseTransaction,
    candidates: Map<string, OverflowCandidate>,
  ): Promise<void> {
    for (const candidate of candidates.values()) {
      if (await this.#hasOverflow(transaction, candidate.sessionId, candidate.attention)) continue;
      candidates.delete(this.#overflowKey(candidate.sessionId, candidate.attention));
    }
  }

  #queueOverflowExpiry(candidate: OverflowCandidate): void {
    const key = this.#overflowKey(candidate.sessionId, candidate.attention);
    if (this.#overflowPasses.has(key)) return;
    const pass = Promise.resolve()
      .then(async () => {
        await this.#beforeOverflowExpiry?.();
        await this.#database.transaction((transaction) =>
          this.#expireOverflow(transaction, candidate.sessionId, candidate.attention),
        );
      })
      .catch((error: unknown) => {
        this.#logger?.error(
          { err: error, sessionId: candidate.sessionId, attention: candidate.attention },
          "IM message inbox overflow expiry failed",
        );
      })
      .finally(() => {
        this.#overflowPasses.delete(key);
      });
    this.#overflowPasses.set(key, pass);
  }

  async #expireOverflow(
    transaction: DatabaseTransaction,
    sessionId: string,
    attention: DeliveryAttention,
  ): Promise<void> {
    const capacity = attention === "direct" ? 100 : 500;
    await transaction.execute(sql`
      with overflow as (
        select d.id
        from im_message_deliveries d
        join im_messages m on m.id = d.message_id
        where d.session_id = ${sessionId}
          and d.attention = ${attention}
          and d.state = 'pending'
          and d.reason is null
        order by m.occurred_at desc, d.id desc
        offset ${capacity}
      )
      update im_message_deliveries
      set state = 'expired'::im_delivery_state,
          reason = 'capacity'
      where id in (select id from overflow)
        and state = 'pending'
        and reason is null
    `);
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
    const contexts = await transaction
      .select({ providerContext: imMessages.providerContext })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, imBindingId),
          eq(imMessages.channelId, channelId),
          eq(imMessages.threadKey, threadKey),
          eq(imMessages.direction, "inbound"),
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id));
    for (const row of contexts) {
      const rootExternalId = threadRootExternalId(row.providerContext);
      if (rootExternalId) return rootExternalId;
    }
    return undefined;
  }
}
