import { ImContentV1Schema, type NormalizedInboundImEvent, NormalizedInboundImEventSchema } from "@opentag/shared";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  imMessageDeliveries,
  imMessages,
  integrations,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";

const DIRECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AMBIENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface IngestResult {
  duplicate: boolean;
  messageId?: string;
  deliveryIds: string[];
}

export class ImMessageInbox {
  readonly #afterAdmissionFence: (() => Promise<void>) | undefined;
  readonly #afterMessageAuthority: (() => Promise<void>) | undefined;
  readonly #beforeSupersedeDeliveries: (() => Promise<void>) | undefined;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(
    database: DatabaseClient,
    options: {
      now?: () => Date;
      afterAdmissionFence?: () => Promise<void>;
      afterMessageAuthority?: () => Promise<void>;
      beforeSupersedeDeliveries?: () => Promise<void>;
    } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#afterAdmissionFence = options.afterAdmissionFence;
    this.#afterMessageAuthority = options.afterMessageAuthority;
    this.#beforeSupersedeDeliveries = options.beforeSupersedeDeliveries;
  }

  async ingest(
    integrationId: string,
    credentialGeneration: number,
    rawEvent: NormalizedInboundImEvent,
    admissionFence?: { provider: "feishu"; holderInstanceId: string; fencingEpoch: number },
  ): Promise<IngestResult> {
    const event = NormalizedInboundImEventSchema.parse(rawEvent);
    return this.#database.transaction(async (transaction) => {
      const now = this.#now();
      await transaction
        .update(integrations)
        .set({ externalTeamId: event.externalTeamId, updatedAt: now })
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.provider, "feishu"),
            eq(integrations.status, "active"),
            eq(integrations.credentialGeneration, credentialGeneration),
            eq(integrations.externalAppId, event.externalAppId),
            isNull(integrations.externalTeamId),
          ),
        );
      const [scope] = await transaction
        .select({ integration: integrations, agent: agents })
        .from(integrations)
        .innerJoin(agents, eq(agents.id, integrations.agentId))
        .where(
          and(
            eq(integrations.id, integrationId),
            eq(integrations.status, "active"),
            eq(integrations.credentialGeneration, credentialGeneration),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1)
        .for("share", { of: integrations });
      if (!scope) throw new Error("INTEGRATION_GENERATION_STALE");
      if (admissionFence) {
        if (
          scope.integration.provider !== "feishu" ||
          scope.integration.connectionOwnerInstanceId !== admissionFence.holderInstanceId ||
          scope.integration.connectionFencingEpoch !== admissionFence.fencingEpoch ||
          !scope.integration.connectionLeaseExpiresAt ||
          scope.integration.connectionLeaseExpiresAt <= now
        ) {
          throw new Error("FEISHU_CONNECTION_LEASE_STALE");
        }
        await this.#afterAdmissionFence?.();
      }
      if (scope.integration.externalAppId !== event.externalAppId) {
        throw new Error("INTEGRATION_BINDING_IDENTITY_MISMATCH");
      }
      if (scope.integration.externalTeamId !== null && scope.integration.externalTeamId !== event.externalTeamId) {
        throw new Error("INTEGRATION_TEAM_IDENTITY_MISMATCH");
      }
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`im-message:${integrationId}:${event.conversation.externalId}:${event.message.externalId}`}, 0))`,
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
            eq(imMessages.integrationId, integrationId),
            eq(imMessages.channelId, event.conversation.externalId),
            eq(imMessages.externalMessageId, event.message.externalId),
          ),
        )
        .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
        .limit(1);
      const previousConversationKind = previousCurrent
        ? await this.#findConversationKind(transaction, integrationId, event.conversation.externalId)
        : undefined;
      const inheritedDeliveries =
        previousCurrent && event.conversation.kind === "unknown"
          ? await transaction
              .select({
                sessionId: imMessageDeliveries.sessionId,
                attention: imMessageDeliveries.attention,
                generation: sessionPlacements.generation,
              })
              .from(imMessageDeliveries)
              .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
              .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
              .where(
                and(
                  eq(imMessageDeliveries.messageId, previousCurrent.id),
                  eq(sessions.integrationId, integrationId),
                  eq(sessions.channelId, event.conversation.externalId),
                  isNull(sessions.endedAt),
                ),
              )
          : [];
      const conversationKind =
        event.conversation.kind === "unknown" ? (previousConversationKind ?? null) : event.conversation.kind;
      const threadKey =
        event.conversation.kind === "unknown"
          ? (previousCurrent?.threadKey ?? null)
          : (event.message.threadKey ?? null);
      const content = ImContentV1Schema.parse({
        ...event.message.content,
        resources: event.message.resources.map((resource, ordinal) => ({
          ...resource,
          ordinal,
          availability: resource.sizeBytes != null && resource.sizeBytes > 25 * 1024 * 1024 ? "too_large" : "available",
        })),
      });
      const [created] = await transaction
        .insert(imMessages)
        .values({
          integrationId,
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
              eq(imMessages.integrationId, integrationId),
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
        return { duplicate: true, messageId: existing?.id, deliveryIds: [] };
      }

      const [currentRevision] = await transaction
        .select({ id: imMessages.id })
        .from(imMessages)
        .where(
          and(
            eq(imMessages.integrationId, integrationId),
            eq(imMessages.channelId, event.conversation.externalId),
            eq(imMessages.externalMessageId, event.message.externalId),
          ),
        )
        .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
        .limit(1);
      if (currentRevision?.id !== created.id) {
        return { duplicate: false, messageId: created.id, deliveryIds: [] };
      }
      await this.#beforeSupersedeDeliveries?.();
      const supersededMessageIds = transaction
        .select({ id: imMessages.id })
        .from(imMessages)
        .where(
          and(
            eq(imMessages.integrationId, integrationId),
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

      const isSelf =
        event.message.author.kind === "bot" && event.message.author.externalId === scope.integration.externalBotId;
      if (isSelf) return { duplicate: false, messageId: created.id, deliveryIds: [] };
      if (conversationKind === null) return { duplicate: false, messageId: created.id, deliveryIds: [] };
      const direct =
        conversationKind === "dm" ||
        event.mentions.some((mention) => mention.externalId === scope.integration.externalBotId);
      const deliveries: Array<{ sessionId: string; attention: "direct" | "ambient"; generation: number }> = [];
      if (event.conversation.kind === "unknown") {
        deliveries.push(...inheritedDeliveries);
      } else {
        const channel = await this.#ensureChatSession(
          transaction,
          integrationId,
          event.conversation.externalId,
          conversationKind,
          "channel",
          null,
          scope.agent.computerId,
          now,
        );
        if (threadKey) {
          const existingThread = await this.#findChatSession(
            transaction,
            integrationId,
            event.conversation.externalId,
            "thread",
            threadKey,
          );
          if (existingThread || direct) {
            const thread =
              existingThread ??
              (await this.#ensureChatSession(
                transaction,
                integrationId,
                event.conversation.externalId,
                conversationKind,
                "thread",
                threadKey,
                scope.agent.computerId,
                now,
              ));
            deliveries.push({ sessionId: thread.id, attention: "direct", generation: thread.generation });
          }
          if (scope.agent.receiveMode === "all_message") {
            deliveries.push({ sessionId: channel.id, attention: "ambient", generation: channel.generation });
          }
        } else if (direct) {
          deliveries.push({ sessionId: channel.id, attention: "direct", generation: channel.generation });
        } else if (scope.agent.receiveMode === "all_message") {
          deliveries.push({ sessionId: channel.id, attention: "ambient", generation: channel.generation });
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
            expiresAt: new Date(now.getTime() + (delivery.attention === "direct" ? DIRECT_TTL_MS : AMBIENT_TTL_MS)),
          })
          .onConflictDoNothing()
          .returning({ id: imMessageDeliveries.id });
        if (deliveryRow) deliveryIds.push(deliveryRow.id);
        await this.#expireOverflow(transaction, delivery.sessionId, delivery.attention);
      }
      return { duplicate: false, messageId: created.id, deliveryIds };
    });
  }

  async #expireOverflow(
    transaction: DatabaseTransaction,
    sessionId: string,
    attention: "direct" | "ambient",
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
    `);
  }

  async #findConversationKind(
    transaction: DatabaseTransaction,
    integrationId: string,
    channelId: string,
  ): Promise<"channel" | "dm" | "group_dm" | undefined> {
    const [row] = await transaction
      .select({ conversationKind: sessions.conversationKind })
      .from(sessions)
      .where(
        and(
          eq(sessions.integrationId, integrationId),
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
    integrationId: string,
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
          eq(sessions.integrationId, integrationId),
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
    integrationId: string,
    channelId: string,
    conversationKind: "channel" | "dm" | "group_dm",
    kind: "channel" | "thread",
    threadKey: string | null,
    computerId: string,
    now: Date,
  ): Promise<{ id: string; generation: number }> {
    const existing = await this.#findChatSession(transaction, integrationId, channelId, kind, threadKey);
    if (existing) return existing;
    const [created] = await transaction
      .insert(sessions)
      .values({ integrationId, channelId, conversationKind, kind, threadKey, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: sessions.id });
    const sessionId =
      created?.id ?? (await this.#findSessionId(transaction, integrationId, channelId, kind, threadKey));
    if (!sessionId) throw new Error("Session ensure did not converge");
    const [placement] = await transaction
      .insert(sessionPlacements)
      .values({ sessionId, computerId, generation: 1, updatedAt: now })
      .onConflictDoNothing()
      .returning({ generation: sessionPlacements.generation });
    if (placement) return { id: sessionId, generation: placement.generation };
    const [currentPlacement] = await transaction
      .select({ generation: sessionPlacements.generation })
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, sessionId))
      .limit(1);
    if (!currentPlacement) throw new Error("Session placement ensure did not converge");
    return { id: sessionId, generation: currentPlacement.generation };
  }

  async #findSessionId(
    transaction: DatabaseTransaction,
    integrationId: string,
    channelId: string,
    kind: "channel" | "thread",
    threadKey: string | null,
  ): Promise<string | undefined> {
    const [row] = await transaction
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.integrationId, integrationId),
          eq(sessions.channelId, channelId),
          eq(sessions.kind, kind),
          threadKey === null ? isNull(sessions.threadKey) : eq(sessions.threadKey, threadKey),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    return row?.id;
  }
}
