import { type NormalizedInboundImEvent, NormalizedInboundImEventSchema } from "@opentag/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  feishuConnectionLeases,
  feishuIntegrationIdentities,
  imConversations,
  imMessageDeliveries,
  imMessageEvents,
  imMessageResources,
  imMessages,
  integrationCredentials,
  integrations,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";

const DIRECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AMBIENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface IngestResult {
  duplicate: boolean;
  messageId?: string;
  revision?: number;
  deliveryIds: string[];
}

export class ImMessageInbox {
  readonly #afterAdmissionFence: (() => Promise<void>) | undefined;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { now?: () => Date; afterAdmissionFence?: () => Promise<void> } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#afterAdmissionFence = options.afterAdmissionFence;
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
      const [scope] = await transaction
        .select({ integration: integrations, credential: integrationCredentials, agent: agents })
        .from(integrations)
        .innerJoin(integrationCredentials, eq(integrationCredentials.integrationId, integrations.id))
        .innerJoin(agents, eq(agents.id, integrations.agentId))
        .where(
          and(
            eq(integrations.id, integrationId),
            isNull(integrations.disabledAt),
            isNull(agents.deletedAt),
            eq(integrationCredentials.generation, credentialGeneration),
          ),
        )
        .limit(1);
      if (!scope) throw new Error("INTEGRATION_GENERATION_STALE");
      if (admissionFence) {
        const [lease] = await transaction
          .select({ integrationId: feishuConnectionLeases.integrationId })
          .from(feishuConnectionLeases)
          .where(
            and(
              eq(feishuConnectionLeases.integrationId, integrationId),
              eq(feishuConnectionLeases.holderInstanceId, admissionFence.holderInstanceId),
              eq(feishuConnectionLeases.fencingEpoch, admissionFence.fencingEpoch),
              sql`${feishuConnectionLeases.expiresAt} > now()`,
            ),
          )
          .limit(1)
          .for("share");
        if (!lease) throw new Error("FEISHU_CONNECTION_LEASE_STALE");
        await this.#afterAdmissionFence?.();
      }
      if (scope.integration.provider === "feishu") {
        const [identity] = await transaction
          .select({ appId: feishuIntegrationIdentities.appId, tenantKey: feishuIntegrationIdentities.tenantKey })
          .from(feishuIntegrationIdentities)
          .where(eq(feishuIntegrationIdentities.integrationId, integrationId))
          .limit(1)
          .for("update");
        if (!identity || identity.appId !== event.externalAppId) throw new Error("FEISHU_BINDING_IDENTITY_MISMATCH");
        const observedTenant = event.externalTenantId === event.externalAppId ? null : event.externalTenantId;
        if (observedTenant && identity.tenantKey !== null && identity.tenantKey !== observedTenant) {
          throw new Error("FEISHU_TENANT_IDENTITY_MISMATCH");
        }
        if (observedTenant && identity.tenantKey === null) {
          await transaction
            .update(feishuIntegrationIdentities)
            .set({ tenantKey: observedTenant })
            .where(
              and(
                eq(feishuIntegrationIdentities.integrationId, integrationId),
                isNull(feishuIntegrationIdentities.tenantKey),
              ),
            );
        }
      }

      const [eventAdmission] = await transaction
        .insert(imMessageEvents)
        .values({
          integrationId,
          providerEventId: event.providerEventId,
          revisionKey: event.message.revisionKey,
          operation: event.message.operation,
          receivedAt: now,
          occurredAt: event.message.occurredAt,
        })
        .onConflictDoNothing()
        .returning({ id: imMessageEvents.id });
      if (!eventAdmission) return { duplicate: true, deliveryIds: [] };

      const [conversation] = await transaction
        .insert(imConversations)
        .values({
          integrationId,
          externalId: event.conversation.externalId,
          kind: event.conversation.kind,
          displayName: event.conversation.displayName ?? null,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [imConversations.integrationId, imConversations.externalId],
          set: {
            kind: event.conversation.kind,
            displayName: event.conversation.displayName ?? null,
            detachedAt: null,
            lastSeenAt: now,
          },
        })
        .returning();
      if (!conversation) throw new Error("IM conversation upsert did not return a row");

      // Different provider event types can describe the same external
      // message/revision. Serialize by the stable provider identity before
      // reading the canonical row so concurrent deliveries converge too.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${conversation.id}:${event.message.externalId}`}, 0))`,
      );

      const [existingMessage] = await transaction
        .select()
        .from(imMessages)
        .where(
          and(
            eq(imMessages.conversationId, conversation.id),
            eq(imMessages.externalMessageId, event.message.externalId),
          ),
        )
        .limit(1)
        .for("update");

      const outOfOrderRevision =
        existingMessage !== undefined && event.message.occurredAt.getTime() < existingMessage.occurredAt.getTime();
      const duplicateRevision =
        existingMessage !== undefined &&
        (event.message.operation === "created" ||
          existingMessage.currentRevisionKey === event.message.revisionKey ||
          outOfOrderRevision);
      const revision = existingMessage ? existingMessage.currentRevision + (duplicateRevision ? 0 : 1) : 1;
      const deletedAt = event.message.operation === "deleted" ? event.message.occurredAt : null;
      const editedAt =
        event.message.operation === "edited" ? event.message.occurredAt : (existingMessage?.editedAt ?? null);
      const [message] = existingMessage
        ? duplicateRevision
          ? [existingMessage]
          : await transaction
              .update(imMessages)
              .set({
                currentRevision: revision,
                currentRevisionKey: event.message.revisionKey,
                threadKey: event.message.threadKey ?? null,
                replyToExternalId: event.message.replyToExternalId ?? null,
                authorKind: event.message.author.kind,
                authorExternalId: event.message.author.externalId,
                authorDisplayName: event.message.author.displayName ?? null,
                content: event.message.content,
                occurredAt: event.message.occurredAt,
                editedAt,
                deletedAt,
              })
              .where(eq(imMessages.id, existingMessage.id))
              .returning()
        : await transaction
            .insert(imMessages)
            .values({
              conversationId: conversation.id,
              externalMessageId: event.message.externalId,
              currentRevision: revision,
              currentRevisionKey: event.message.revisionKey,
              direction: "inbound",
              threadKey: event.message.threadKey ?? null,
              replyToExternalId: event.message.replyToExternalId ?? null,
              authorKind: event.message.author.kind,
              authorExternalId: event.message.author.externalId,
              authorDisplayName: event.message.author.displayName ?? null,
              content: event.message.content,
              occurredAt: event.message.occurredAt,
              editedAt,
              deletedAt,
            })
            .returning();
      if (!message) throw new Error("IM message write did not return a row");
      await transaction
        .update(imMessageEvents)
        .set({ messageId: message.id })
        .where(eq(imMessageEvents.id, eventAdmission.id));

      if (!duplicateRevision && revision > 1) {
        await transaction
          .update(imMessageDeliveries)
          .set({ state: "expired", reason: "superseded" })
          .where(
            and(
              eq(imMessageDeliveries.messageId, message.id),
              eq(imMessageDeliveries.state, "pending"),
              sql`${imMessageDeliveries.messageRevision} < ${revision}`,
            ),
          );
      }

      if (!duplicateRevision) {
        for (const [ordinal, resource] of event.message.resources.entries()) {
          await transaction.insert(imMessageResources).values({
            messageId: message.id,
            messageRevision: revision,
            providerResourceKey: resource.providerResourceKey,
            kind: resource.kind,
            filename: resource.filename,
            mediaType: resource.mediaType,
            sizeBytes: resource.sizeBytes,
            ordinal,
            availability:
              resource.sizeBytes !== null && resource.sizeBytes > 25 * 1024 * 1024 ? "too_large" : "available",
          });
        }
      }

      const identity = await this.#botExternalId(transaction, integrationId, scope.integration.provider);
      const isSelf = event.message.author.kind === "bot" && event.message.author.externalId === identity;
      if (isSelf) return { duplicate: duplicateRevision, messageId: message.id, revision, deliveryIds: [] };
      const direct =
        event.conversation.kind === "dm" || event.mentions.some((mention) => mention.externalId === identity);
      const deliveries: Array<{ sessionId: string; attention: "direct" | "ambient"; generation: number }> = [];
      const channel = await this.#ensureChatSession(
        transaction,
        conversation.id,
        "channel",
        null,
        scope.agent.computerId,
        now,
      );

      if (event.message.threadKey) {
        const existingThread = await this.#findChatSession(
          transaction,
          conversation.id,
          "thread",
          event.message.threadKey,
        );
        if (existingThread || direct) {
          const thread =
            existingThread ??
            (await this.#ensureChatSession(
              transaction,
              conversation.id,
              "thread",
              event.message.threadKey,
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

      const deliveryIds: string[] = [];
      for (const delivery of deliveries) {
        const [created] = await transaction
          .insert(imMessageDeliveries)
          .values({
            messageId: message.id,
            messageRevision: revision,
            sessionId: delivery.sessionId,
            attention: delivery.attention,
            placementGeneration: delivery.generation,
            nextAttemptAt: now,
            expiresAt: new Date(now.getTime() + (delivery.attention === "direct" ? DIRECT_TTL_MS : AMBIENT_TTL_MS)),
          })
          .onConflictDoNothing()
          .returning({ id: imMessageDeliveries.id });
        if (created) deliveryIds.push(created.id);
        await this.#expireOverflow(transaction, delivery.sessionId, delivery.attention);
      }
      await transaction
        .update(integrations)
        .set({ lastInboundAt: now, updatedAt: now })
        .where(eq(integrations.id, integrationId));
      return { duplicate: duplicateRevision, messageId: message.id, revision, deliveryIds };
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
        order by m.occurred_at desc, d.id desc
        offset ${capacity}
      )
      update im_message_deliveries
      set state = 'expired', reason = 'capacity'
      where id in (select id from overflow)
    `);
  }

  async #botExternalId(
    transaction: DatabaseTransaction,
    integrationId: string,
    provider: "feishu" | "slack",
  ): Promise<string> {
    if (provider === "feishu") {
      const result = await transaction.execute<{ bot_open_id: string }>(
        sql`select bot_open_id from feishu_integration_identities where integration_id = ${integrationId}`,
      );
      const id = result[0]?.bot_open_id;
      if (!id) throw new Error("Feishu Integration identity is missing");
      return id;
    }
    const result = await transaction.execute<{ bot_user_id: string }>(
      sql`select bot_user_id from slack_integration_identities where integration_id = ${integrationId}`,
    );
    const id = result[0]?.bot_user_id;
    if (!id) throw new Error("Slack Integration identity is missing");
    return id;
  }

  async #findChatSession(
    transaction: DatabaseTransaction,
    conversationId: string,
    kind: "channel" | "thread",
    threadKey: string | null,
  ): Promise<{ id: string; generation: number } | undefined> {
    const [row] = await transaction
      .select({ id: sessions.id, generation: sessionPlacements.generation })
      .from(sessions)
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .where(
        and(
          eq(sessions.conversationId, conversationId),
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
    conversationId: string,
    kind: "channel" | "thread",
    threadKey: string | null,
    computerId: string,
    now: Date,
  ): Promise<{ id: string; generation: number }> {
    const existing = await this.#findChatSession(transaction, conversationId, kind, threadKey);
    if (existing) return existing;
    const [created] = await transaction
      .insert(sessions)
      .values({ conversationId, kind, threadKey, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: sessions.id });
    const sessionId = created?.id ?? (await this.#findSessionId(transaction, conversationId, kind, threadKey));
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
    conversationId: string,
    kind: "channel" | "thread",
    threadKey: string | null,
  ): Promise<string | undefined> {
    const [row] = await transaction
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.conversationId, conversationId),
          eq(sessions.kind, kind),
          threadKey === null ? isNull(sessions.threadKey) : eq(sessions.threadKey, threadKey),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    return row?.id;
  }
}
