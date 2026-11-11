import { randomUUID } from "node:crypto";
import type { TurnReportRequest } from "@opentag/shared";
import { and, count, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { PARKED_DELIVERY_CODE } from "../../db/im-delivery-work.js";
import {
  agentRuntimeConfigs,
  agents,
  computers,
  imBindings,
  imFeedbackActions,
  imFeedbackTargets,
  imMessageDeliveries,
  imMessages,
  sandboxes,
  sessionPlacements,
  sessions,
  slackInstallations,
  users,
} from "../../db/schema/index.js";
import { COMPUTER_PRESENCE_TIMEOUT_MS } from "../computers/cloud-computer.js";
import { type FeedbackLanguage, feedbackLanguage, messageExcerpt } from "./im-feedback-copy.js";

export type FeedbackTarget = typeof imFeedbackTargets.$inferSelect & {
  batchRetryBlocked?: boolean;
  /** Messages in a frozen initial batch, the root included; set with `batchRetryBlocked`. */
  batchSize?: number;
  /** A quota failure's reset time, read from the Turn report the Client sent; never stored on the target. */
  retryAt?: string;
};
export type SlackFeedbackScope = Pick<FeedbackTarget, "provider" | "installationId" | "bindingGeneration">;
export type FeedbackAction = typeof imFeedbackActions.$inferSelect;
export interface FeedbackSettlement {
  reaction?: FeedbackTarget["appliedReaction"];
  cardMessageId?: string;
  cardState?: FeedbackTarget["cardState"];
  cardRevision?: number;
  reconciliationCursor?: string | null;
  delayMs?: number;
  errorCode?: string;
  stale?: boolean;
  dormant?: boolean;
}
export interface FeedbackRuntime {
  /** `cloud` for an Agent on the Cloud Computer, which runs the platform model. */
  tool: "claude-code" | "codex" | "pi" | "cloud";
  model: string | null;
}
export interface FeedbackMessageContext {
  language: FeedbackLanguage;
  direct: boolean;
  /** The start of what the sender wrote, for a card sent to their direct message. */
  excerpt?: string;
  /** The Agent's tool and model as its settings name them, for cards that tell someone what to fix. */
  runtime?: FeedbackRuntime;
}
export const FEEDBACK_ACTION_TTL_MS = 24 * 60 * 60_000;
const DORMANT = new Date("9999-12-31T00:00:00Z");
/** Short disconnects, upgrades and restarts recover silently below this. */
export const OFFLINE_NOTICE_DELAY_MS = 60_000;

export async function createImFeedbackTarget(tx: DatabaseTransaction, deliveryId: string, now: Date): Promise<void> {
  const [row] = await tx
    .select({
      delivery: imMessageDeliveries,
      message: imMessages,
      session: sessions,
      binding: imBindings,
      agent: agents,
      sandbox: sandboxes,
    })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
    .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
    .innerJoin(agents, eq(agents.id, imBindings.agentId))
    .leftJoin(sandboxes, eq(sandboxes.sessionId, sessions.id))
    .where(
      and(
        eq(imMessageDeliveries.id, deliveryId),
        eq(imMessageDeliveries.attention, "direct"),
        eq(imMessages.direction, "inbound"),
        eq(imMessages.authorKind, "human"),
        ne(imMessages.operation, "deleted"),
        ne(sessions.kind, "internal"),
        eq(imBindings.status, "active"),
        sql`not (${sessions.kind} = 'channel' and ${imMessages.threadKey} is not null and exists (select 1 from im_message_deliveries sibling inner join sessions owner on owner.id = sibling.session_id where sibling.message_id = ${imMessages.id} and owner.kind = 'thread' and owner.thread_key = ${imMessages.threadKey}))`,
      ),
    )
    .limit(1);
  if (!row || row.delivery.dispatchPayload?.replyRole === "observer" || row.delivery.reason === "duplicate_pending")
    return;
  await tx
    .insert(imFeedbackTargets)
    .values({
      accountId: row.agent.createdByUserId,
      agentId: row.agent.id,
      bindingId: row.binding.id,
      bindingGeneration: row.binding.credentialGeneration,
      provider: row.binding.provider,
      installationId: row.binding.slackInstallationId,
      messageId: row.message.id,
      sessionId: row.session.id,
      deliveryId,
      turnId: row.delivery.turnId,
      placementGeneration: row.delivery.placementGeneration,
      channelId: row.message.channelId,
      inputExternalId: row.message.externalMessageId,
      threadKey: row.message.threadKey,
      senderExternalId: row.message.authorExternalId,
      cardOwnerDeliveryId: row.delivery.steerTargetDeliveryId ?? deliveryId,
      messageFormat: "interactive_v1",
      sandboxId: row.sandbox?.id,
      environmentGeneration: row.sandbox?.environmentGeneration,
      resourceUid: row.sandbox?.currentResourceUid,
      state: "queued",
      desiredReaction: "none",
      appliedReaction: "none",
      appliedRevision: 1,
      actionsExpireAt: new Date(now.getTime() + FEEDBACK_ACTION_TTL_MS),
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

export async function startImFeedback(tx: DatabaseTransaction, rootDeliveryId: string, now: Date): Promise<void> {
  const rows = await tx
    .select({
      id: imMessageDeliveries.id,
      turnId: imMessageDeliveries.turnId,
      payload: imMessageDeliveries.dispatchPayload,
      sandbox: sandboxes,
    })
    .from(imMessageDeliveries)
    .leftJoin(sandboxes, eq(sandboxes.sessionId, imMessageDeliveries.sessionId))
    .where(
      or(
        eq(imMessageDeliveries.id, rootDeliveryId),
        and(eq(imMessageDeliveries.state, "steered"), eq(imMessageDeliveries.steerTargetDeliveryId, rootDeliveryId)),
      ),
    );
  for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    if (row.payload?.replyRole === "observer") {
      await tx
        .update(imFeedbackTargets)
        .set(observerFeedbackUpdate(now))
        .where(eq(imFeedbackTargets.deliveryId, row.id));
      continue;
    }
    await createImFeedbackTarget(tx, row.id, now);
    await tx
      .update(imFeedbackTargets)
      .set({
        state: "working",
        desiredReaction: "working",
        turnId: row.turnId,
        cardOwnerDeliveryId: rootDeliveryId,
        sandboxId: row.sandbox?.id,
        environmentGeneration: row.sandbox?.environmentGeneration,
        resourceUid: row.sandbox?.currentResourceUid,
        revision: sql`${imFeedbackTargets.revision} + 1`,
        nextAttemptAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(imFeedbackTargets.deliveryId, row.id),
          inArray(imFeedbackTargets.state, ["queued", "working"]),
          ne(imFeedbackTargets.desiredReaction, "working"),
        ),
      );
  }
}

export async function finishImFeedback(tx: DatabaseTransaction, report: TurnReportRequest, now: Date): Promise<void> {
  const rows = await tx
    .select({ target: imFeedbackTargets, reason: imMessageDeliveries.reason, state: imMessageDeliveries.state })
    .from(imFeedbackTargets)
    .innerJoin(imMessageDeliveries, eq(imMessageDeliveries.id, imFeedbackTargets.deliveryId))
    .where(eq(imFeedbackTargets.cardOwnerDeliveryId, report.deliveryId))
    .orderBy(imFeedbackTargets.id);
  for (const { target, reason, state } of rows) {
    if (target.state === "stale" || target.state === "resolved") continue;
    if (isRecoveredChild(target, reason, state, report)) {
      await tx
        .update(imFeedbackTargets)
        .set({
          state: "queued",
          desiredReaction: "none",
          cardOwnerDeliveryId: target.deliveryId,
          nextAttemptAt: now,
          revision: sql`${imFeedbackTargets.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(imFeedbackTargets.id, target.id));
      continue;
    }
    await tx
      .update(imFeedbackTargets)
      .set(terminalFeedbackUpdate(target, report, now))
      .where(eq(imFeedbackTargets.id, target.id));
  }
}

/** The facts both waiting notices read about a target's input, if it is still waiting on its placement. */
async function waitingInput(database: DatabaseClient | DatabaseTransaction, target: FeedbackTarget) {
  const [row] = await database
    .select({
      kind: computers.kind,
      instanceId: computers.currentInstanceId,
      lastSeenAt: computers.lastSeenAt,
      computerCreatedAt: computers.createdAt,
      disconnectedAt: computers.disconnectedAt,
      deletedAt: computers.deletedAt,
      agentStatus: agents.status,
      receivedAt: imMessages.receivedAt,
      deliveryState: imMessageDeliveries.state,
      deliveryGeneration: imMessageDeliveries.placementGeneration,
      placementGeneration: sessionPlacements.generation,
    })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, imMessageDeliveries.sessionId))
    .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
    .innerJoin(agents, eq(agents.id, target.agentId))
    .where(eq(imMessageDeliveries.id, target.deliveryId))
    .limit(1);
  if (
    !row ||
    row.kind !== "local" ||
    row.deletedAt ||
    row.agentStatus !== "active" ||
    row.deliveryState !== "pending" ||
    row.deliveryGeneration !== row.placementGeneration
  )
    return;
  const lastSeenMs = row.lastSeenAt?.getTime() ?? 0;
  return {
    ...row,
    lastSeenMs,
    offlineAt: (now: Date) =>
      row.disconnectedAt !== null ||
      row.instanceId === null ||
      lastSeenMs < now.getTime() - COMPUTER_PRESENCE_TIMEOUT_MS,
  };
}

/**
 * When the current offline period began, if this target's input is parked on a Local Computer that
 * has been offline, by the Web's rule, long enough for a notice.
 */
async function offlinePeriodStart(
  database: DatabaseClient | DatabaseTransaction,
  target: FeedbackTarget,
  now: Date,
): Promise<Date | undefined> {
  const row = await waitingInput(database, target);
  if (!row?.offlineAt(now)) return;
  if (now.getTime() - Math.max(row.receivedAt.getTime(), row.lastSeenMs) < OFFLINE_NOTICE_DELAY_MS) return;
  // A Computer that never connected has been offline since it was created. This baseline must not depend on
  // the input: a later message's receipt would exclude the earlier notice and repeat it within one outage.
  const offlineSince = row.lastSeenAt ?? row.computerCreatedAt;
  // While the Session still waits behind a parked input, a waiting notice sent since that input arrived
  // covers a later outage too: the person already knows this message waits, and a reconnect between the two
  // must not turn the same wait into a second notice.
  // The parked input's own target counts too: it is queued and visited like any other input of the Session.
  const parkedSince = await parkedInputReceivedAt(database, target, { includeOwn: true });
  return parkedSince && parkedSince < offlineSince ? parkedSince : offlineSince;
}

/**
 * When the earliest parked input of the target's Session was received, if one is parked. `includeOwn`
 * counts the target's own input: right for deduplicating a notice, wrong for deciding that the target
 * waits behind another input.
 */
async function parkedInputReceivedAt(
  database: DatabaseClient | DatabaseTransaction,
  target: FeedbackTarget,
  { includeOwn = false }: { includeOwn?: boolean } = {},
): Promise<Date | undefined> {
  const [parked] = await database
    .select({ receivedAt: imMessages.receivedAt })
    .from(imMessageDeliveries)
    .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
    .where(
      and(
        eq(imMessageDeliveries.sessionId, target.sessionId),
        eq(imMessageDeliveries.state, "pending"),
        eq(imMessageDeliveries.lastErrorCode, PARKED_DELIVERY_CODE),
        includeOwn ? undefined : ne(imMessageDeliveries.id, target.deliveryId),
      ),
    )
    .orderBy(imMessages.receivedAt)
    .limit(1);
  return parked?.receivedAt;
}

/**
 * When the input this target waits behind was received, if the target's Computer is online but an
 * earlier dispatch of the same Session is parked (see `PARKED_DELIVERY_CODE`). A parked row keeps
 * custody until its ingress deadline, so every later input of that Session waits up to seven days with
 * nothing to show for it. Only the Session: whether other Sessions of the Agent also wait depends on
 * the Client, and a notice must not claim a wait that is not happening. The parked input's receipt is
 * the period start: one notice per Session for each parked input.
 */
async function parkedPeriodStart(
  database: DatabaseClient | DatabaseTransaction,
  target: FeedbackTarget,
  now: Date,
): Promise<Date | undefined> {
  const row = await waitingInput(database, target);
  if (!row || row.offlineAt(now) || now.getTime() - row.receivedAt.getTime() < OFFLINE_NOTICE_DELAY_MS) return;
  return parkedInputReceivedAt(database, target);
}

export class ImFeedbackStore {
  constructor(
    readonly database: DatabaseClient,
    readonly now: () => Date = () => new Date(),
  ) {}

  async claim(
    excluded: readonly Pick<FeedbackTarget, "bindingId" | "channelId" | "inputExternalId">[] = [],
  ): Promise<FeedbackTarget | undefined> {
    return this.database.transaction(async (tx) => {
      const now = this.now();
      const [target] = await tx
        .select()
        .from(imFeedbackTargets)
        .where(
          and(
            lte(imFeedbackTargets.nextAttemptAt, now),
            or(isNull(imFeedbackTargets.claimExpiresAt), lte(imFeedbackTargets.claimExpiresAt, now)),
            ...excluded.map((target) =>
              or(
                ne(imFeedbackTargets.bindingId, target.bindingId),
                ne(imFeedbackTargets.channelId, target.channelId),
                ne(imFeedbackTargets.inputExternalId, target.inputExternalId),
              ),
            ),
          ),
        )
        .orderBy(imFeedbackTargets.nextAttemptAt, imFeedbackTargets.id)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!target) return;
      const [claimed] = await tx
        .update(imFeedbackTargets)
        .set({
          claimId: randomUUID(),
          claimExpiresAt: new Date(now.getTime() + 90_000),
          cardState: target.cardState === "sending" ? "send_unknown" : target.cardState,
        })
        .where(eq(imFeedbackTargets.id, target.id))
        .returning();
      return claimed ? await withReportedRetry(tx, await withFrozenBatch(tx, claimed)) : undefined;
    });
  }

  async isCurrent(target: FeedbackTarget, withClaim = true): Promise<boolean> {
    const [row] = await this.database
      .select({ id: imFeedbackTargets.id })
      .from(imFeedbackTargets)
      .innerJoin(imBindings, eq(imBindings.id, imFeedbackTargets.bindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(users, eq(users.id, agents.createdByUserId))
      .innerJoin(imMessages, eq(imMessages.id, imFeedbackTargets.messageId))
      .innerJoin(sessions, eq(sessions.id, imFeedbackTargets.sessionId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imFeedbackTargets.installationId))
      .where(
        and(
          eq(imFeedbackTargets.id, target.id),
          withClaim
            ? and(
                eq(imFeedbackTargets.claimId, target.claimId ?? "00000000-0000-0000-0000-000000000000"),
                eq(imFeedbackTargets.revision, target.revision),
                sql`${imFeedbackTargets.claimExpiresAt} > ${this.now().toISOString()}::timestamptz`,
              )
            : undefined,
          eq(imBindings.status, "active"),
          eq(imBindings.provider, target.provider),
          eq(imBindings.credentialGeneration, target.bindingGeneration),
          eq(agents.createdByUserId, target.accountId),
          ne(agents.status, "deleted"),
          isNull(users.suspendedAt),
          sql`not (${sessions.kind} = 'channel' and ${imMessages.threadKey} is not null and exists (select 1 from im_message_deliveries sibling inner join sessions owner on owner.id = sibling.session_id where sibling.message_id = ${imMessages.id} and owner.kind = 'thread' and owner.thread_key = ${imMessages.threadKey}))`,
          ne(imMessages.operation, "deleted"),
          or(
            ne(imBindings.provider, "slack"),
            and(
              eq(slackInstallations.status, "active"),
              eq(imBindings.slackInstallationId, target.installationId ?? "00000000-0000-0000-0000-000000000000"),
              eq(slackInstallations.credentialGeneration, target.bindingGeneration),
            ),
          ),
          sql`not exists (select 1 from im_messages newer where newer.im_binding_id = ${target.bindingId}::uuid and newer.channel_id = ${target.channelId} and newer.external_message_id = ${target.inputExternalId} and (newer.occurred_at, newer.provider_revision_key, newer.id) > (${imMessages.occurredAt}, ${imMessages.providerRevisionKey}, ${imMessages.id}))`,
        ),
      )
      .limit(1);
    return !!row;
  }

  async refreshQueued(target: FeedbackTarget): Promise<FeedbackTarget> {
    if (target.state !== "queued") return target;
    const [delivery] = await this.database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, target.deliveryId));
    if (!delivery) return target;
    const change = await this.#queuedChange(target, delivery);
    if (!change) return target;
    const [updated] = await this.database
      .update(imFeedbackTargets)
      .set(change)
      .where(
        and(
          eq(imFeedbackTargets.id, target.id),
          eq(imFeedbackTargets.claimId, target.claimId ?? "00000000-0000-0000-0000-000000000000"),
          eq(imFeedbackTargets.revision, target.revision),
        ),
      )
      .returning();
    return updated
      ? {
          ...updated,
          batchRetryBlocked: target.batchRetryBlocked,
          batchSize: target.batchSize,
          ...(target.retryAt ? { retryAt: target.retryAt } : {}),
        }
      : target;
  }

  async #queuedChange(target: FeedbackTarget, delivery: typeof imMessageDeliveries.$inferSelect) {
    const now = this.now();
    if (delivery.dispatchPayload?.replyRole === "observer") return observerFeedbackUpdate(now);
    if (["expired", "terminal_rejected"].includes(delivery.state)) return rejectedFeedbackUpdate(delivery, now);
    if (delivery.state !== "accepted" && delivery.state !== "steered") return;
    const root = delivery.steerTargetDeliveryId
      ? (
          await this.database
            .select()
            .from(imMessageDeliveries)
            .where(eq(imMessageDeliveries.id, delivery.steerTargetDeliveryId))
        )[0]
      : delivery;
    if (root?.turnReport) return terminalFeedbackUpdate(target, root.turnReport, now);
    return {
      state: "working" as const,
      desiredReaction: "working" as const,
      turnId: root?.turnId,
      cardOwnerDeliveryId: root?.id ?? target.deliveryId,
      revision: sql`${imFeedbackTargets.revision} + 1`,
      updatedAt: now,
    };
  }

  async desiredReaction(target: FeedbackTarget): Promise<FeedbackTarget["desiredReaction"]> {
    const [latest] = await this.database
      .select({ desired: imFeedbackTargets.desiredReaction })
      .from(imFeedbackTargets)
      .innerJoin(imMessageDeliveries, eq(imMessageDeliveries.id, imFeedbackTargets.deliveryId))
      .where(
        and(
          eq(imFeedbackTargets.bindingId, target.bindingId),
          eq(imFeedbackTargets.bindingGeneration, target.bindingGeneration),
          eq(imFeedbackTargets.messageId, target.messageId),
          ne(imFeedbackTargets.state, "stale"),
        ),
      )
      .orderBy(
        sql`${imMessageDeliveries.attemptOrdinal} desc`,
        sql`${imFeedbackTargets.createdAt} desc`,
        imFeedbackTargets.id,
      )
      .limit(1);
    return latest?.desired ?? "none";
  }

  async markSending(target: FeedbackTarget): Promise<boolean> {
    const rows = await this.database
      .update(imFeedbackTargets)
      // Every new send is a card. A text target that never sent becomes a card here, before any request
      // exists, so readback and later updates match what was actually sent.
      .set({ cardState: "sending", sendStartedAt: this.now(), messageFormat: "interactive_v1" })
      .where(
        and(
          eq(imFeedbackTargets.id, target.id),
          eq(imFeedbackTargets.claimId, target.claimId ?? "00000000-0000-0000-0000-000000000000"),
          eq(imFeedbackTargets.cardState, "pending"),
          isNull(imFeedbackTargets.cardMessageId),
          eq(imFeedbackTargets.revision, target.revision),
        ),
      )
      .returning({ id: imFeedbackTargets.id });
    return rows.length === 1;
  }

  async settle(target: FeedbackTarget, input: FeedbackSettlement): Promise<void> {
    const now = this.now();
    await this.database
      .update(imFeedbackTargets)
      .set({
        ...reactionSettlement(target, input),
        ...cardSettlement(input),
        ...scheduleSettlement(target, input, now),
        ...(target.state === "failed" && (input.cardState ?? target.cardState) === "sent"
          ? { settledAt: target.settledAt ?? now }
          : {}),
        ...(input.stale ? { state: "stale" as const, settledAt: now } : {}),
        claimId: null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(imFeedbackTargets.id, target.id),
          eq(imFeedbackTargets.claimId, target.claimId ?? "00000000-0000-0000-0000-000000000000"),
        ),
      );
  }

  async slackCooldownRemaining(target: SlackFeedbackScope): Promise<number | undefined> {
    if (!target.installationId || target.provider !== "slack") return;
    const [installation] = await this.database
      .select({
        remainingMs: sql<number>`greatest(0, ceil(extract(epoch from (${slackInstallations.workingStatusNotBeforeAt} - statement_timestamp())) * 1000))::double precision`,
      })
      .from(slackInstallations)
      .where(
        and(
          eq(slackInstallations.id, target.installationId),
          eq(slackInstallations.status, "active"),
          eq(slackInstallations.credentialGeneration, target.bindingGeneration),
        ),
      )
      .limit(1);
    return installation?.remainingMs;
  }

  async deferSlackInstallation(target: SlackFeedbackScope, retryAfterMs: number): Promise<boolean> {
    const installationId = target.installationId;
    if (!installationId || target.provider !== "slack") return false;
    return this.database.transaction(async (tx) => {
      const [installation] = await tx
        .select({ id: slackInstallations.id })
        .from(slackInstallations)
        .where(
          and(
            eq(slackInstallations.id, installationId),
            eq(slackInstallations.status, "active"),
            eq(slackInstallations.credentialGeneration, target.bindingGeneration),
          ),
        )
        .for("update");
      if (!installation) return false;
      await tx
        .update(slackInstallations)
        .set({
          workingStatusNotBeforeAt: sql`greatest(${slackInstallations.workingStatusNotBeforeAt}, statement_timestamp() + ${retryAfterMs} * interval '1 millisecond')`,
        })
        .where(eq(slackInstallations.id, installation.id));
      return true;
    });
  }

  /** Language of the exact input revision the target was created for; derived, so edits and retries agree. */
  /** The reader's language, and whether the conversation is a direct message, which decides where a card goes. */
  async messageContext(
    target: Pick<FeedbackTarget, "messageId" | "sessionId"> & Partial<Pick<FeedbackTarget, "agentId">>,
  ): Promise<FeedbackMessageContext> {
    const [message] = await this.database
      .select({ content: imMessages.content })
      .from(imMessages)
      .where(eq(imMessages.id, target.messageId))
      .limit(1);
    const [session] = await this.database
      .select({ conversationKind: sessions.conversationKind })
      .from(sessions)
      .where(eq(sessions.id, target.sessionId))
      .limit(1);
    const [agent] = target.agentId
      ? await this.database
          .select({
            provider: agents.runtimeProvider,
            model: agentRuntimeConfigs.model,
            computerKind: computers.kind,
          })
          .from(agents)
          .leftJoin(agentRuntimeConfigs, eq(agentRuntimeConfigs.agentId, agents.id))
          .leftJoin(computers, eq(computers.id, agents.computerId))
          .where(eq(agents.id, target.agentId))
          .limit(1)
      : [];
    return {
      language: message ? feedbackLanguage(message.content) : "en",
      ...(message ? { excerpt: messageExcerpt(message.content) } : {}),
      direct: session?.conversationKind === "dm",
      ...(agent
        ? { runtime: { tool: agent.computerKind === "cloud" ? "cloud" : agent.provider, model: agent.model ?? null } }
        : {}),
    };
  }

  /**
   * Reserves the one offline notice of this Session and offline period. `computers.last_seen_at` is
   * frozen while a Computer is offline and rewritten on reconnect, so a send started at or after it
   * belongs to the current period. The reservation commits before provider I/O, so a crash loses a
   * notice rather than repeating it. The Session row lock serializes the targets of a Session, and
   * eligibility is read again under it because the Computer can reconnect during the lock wait.
   */
  async reserveOfflineNotice(target: FeedbackTarget): Promise<Date | undefined> {
    return this.#reserveWaitingNotice(target, offlinePeriodStart);
  }

  /**
   * Reserves the one notice of this Session that its input waits behind a parked dispatch, the same
   * way as the offline notice: any send since the parked input's receipt counts, so it is sent once
   * per Session and parked input, and never on top of an offline notice or failure message.
   */
  async reserveParkedNotice(target: FeedbackTarget): Promise<Date | undefined> {
    return this.#reserveWaitingNotice(target, parkedPeriodStart);
  }

  async #reserveWaitingNotice(
    target: FeedbackTarget,
    periodStartOf: (
      database: DatabaseClient | DatabaseTransaction,
      target: FeedbackTarget,
      now: Date,
    ) => Promise<Date | undefined>,
  ): Promise<Date | undefined> {
    if (target.state !== "queued" || target.cardState !== "none") return;
    const now = this.now();
    if ((await periodStartOf(this.database, target, now)) === undefined) return;
    return this.database.transaction(async (tx) => {
      await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, target.sessionId)).for("update");
      const periodStart = await periodStartOf(tx, target, now);
      if (periodStart === undefined) return;
      const [sent] = await tx
        .select({ id: imFeedbackTargets.id })
        .from(imMessageDeliveries)
        .innerJoin(imFeedbackTargets, eq(imFeedbackTargets.deliveryId, imMessageDeliveries.id))
        .where(
          and(eq(imMessageDeliveries.sessionId, target.sessionId), gte(imFeedbackTargets.sendStartedAt, periodStart)),
        )
        .limit(1);
      if (sent) return;
      const [reserved] = await tx
        .update(imFeedbackTargets)
        .set({ sendStartedAt: now })
        .where(
          and(
            eq(imFeedbackTargets.id, target.id),
            eq(imFeedbackTargets.state, "queued"),
            eq(imFeedbackTargets.cardState, "none"),
          ),
        )
        .returning({ id: imFeedbackTargets.id });
      return reserved ? now : undefined;
    });
  }

  /** A send the provider definitely did not apply may be attempted again on a later pass. */
  async releaseOfflineNotice(target: FeedbackTarget, reservedAt: Date): Promise<void> {
    await this.database
      .update(imFeedbackTargets)
      .set({ sendStartedAt: null })
      .where(
        and(
          eq(imFeedbackTargets.id, target.id),
          eq(imFeedbackTargets.sendStartedAt, reservedAt),
          eq(imFeedbackTargets.cardState, "none"),
        ),
      );
  }

  async latestAction(feedbackId: string): Promise<FeedbackAction | undefined> {
    const [action] = await this.database
      .select()
      .from(imFeedbackActions)
      .where(eq(imFeedbackActions.feedbackId, feedbackId))
      .orderBy(sql`${imFeedbackActions.feedbackRevision} desc`)
      .limit(1);
    return action;
  }

  async retain(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - 90 * 24 * 60 * 60_000);
    await this.database.transaction(async (tx) => {
      const rows = await tx
        .select({ id: imFeedbackTargets.id })
        .from(imFeedbackTargets)
        .where(
          and(
            lte(imFeedbackTargets.settledAt, cutoff),
            or(
              inArray(imFeedbackTargets.cardState, ["none", "sent"]),
              and(eq(imFeedbackTargets.state, "stale"), inArray(imFeedbackTargets.cardState, ["pending", "blocked"])),
            ),
            isNull(imFeedbackTargets.claimId),
            sql`not exists (select 1 from im_feedback_actions a where a.feedback_id = ${imFeedbackTargets.id} and a.state in ('confirmed','submitting','checking'))`,
          ),
        )
        .limit(100)
        .for("update", { skipLocked: true });
      if (!rows.length) return;
      const ids = rows.map((r) => r.id);
      await tx.delete(imFeedbackActions).where(inArray(imFeedbackActions.feedbackId, ids));
      await tx.delete(imFeedbackTargets).where(inArray(imFeedbackTargets.id, ids));
    });
  }
}

export async function acknowledgeFeedbackActivity(
  database: DatabaseClient,
  frame: import("@opentag/shared").TurnActivityRequest,
  context: import("../../runtime/runtime-session.js").RuntimeBusinessContext,
): Promise<import("@opentag/shared").TurnActivityResult> {
  const rows = await database.execute(
    sql`select d.id from im_message_deliveries d inner join sessions s on s.id=d.session_id inner join session_placements p on p.session_id=s.id inner join im_bindings b on b.id=s.im_binding_id where d.id=${frame.deliveryId}::uuid and d.session_id=${frame.sessionId}::uuid and d.turn_id=${frame.turnId} and d.report_owner_instance_id=${context.instanceId}::uuid and d.placement_generation=${frame.placementGeneration} and p.generation=${frame.placementGeneration} and p.computer_id=${context.computerId}::uuid and b.agent_id=${frame.agentId}::uuid and d.state='accepted' and d.reported_at is null and s.ended_at is null limit 1`,
  );
  return {
    type: "turn:activity:result",
    requestId: frame.requestId,
    turnId: frame.turnId,
    sequence: frame.sequence,
    status: rows.length && !context.signal.aborted ? "recorded" : "stale_generation",
  };
}

function isRecoveredChild(
  target: FeedbackTarget,
  reason: string | null,
  state: string,
  report: TurnReportRequest,
): boolean {
  return (
    target.deliveryId !== report.deliveryId &&
    report.outcome !== "completed" &&
    reason !== "batch_initial" &&
    state === "pending"
  );
}
function terminalFeedbackUpdate(target: FeedbackTarget, report: TurnReportRequest, now: Date) {
  const failed = report.outcome !== "completed" && report.outcome !== "cancelled";
  const state: FeedbackTarget["state"] = failed
    ? report.errorReason === "workspace_failed"
      ? "workspace_blocked"
      : "failed"
    : "completed";
  return {
    state,
    desiredReaction: failed ? ("warning" as const) : ("none" as const),
    errorCode: failed ? report.errorReason : null,
    effects: report.executionEffects,
    reportHash: report.resultHash,
    actionsExpireAt: new Date(now.getTime() + FEEDBACK_ACTION_TTL_MS),
    cardState:
      failed && target.deliveryId === report.deliveryId
        ? ("pending" as const)
        : !failed && !target.cardMessageId && target.cardState === "pending"
          ? ("none" as const)
          : target.cardState,
    revision: sql`${imFeedbackTargets.revision} + 1`,
    nextAttemptAt: now,
    updatedAt: now,
    settledAt: failed && target.deliveryId === report.deliveryId ? null : now,
  };
}
function reactionSettlement(target: FeedbackTarget, input: FeedbackSettlement) {
  return input.reaction !== undefined ? { appliedReaction: input.reaction, appliedRevision: target.revision } : {};
}
function cardSettlement(input: FeedbackSettlement) {
  return {
    ...(input.cardMessageId
      ? { cardMessageId: sql`coalesce(${imFeedbackTargets.cardMessageId},${input.cardMessageId})` }
      : {}),
    ...(input.cardState
      ? {
          cardState:
            input.cardState === "pending" || input.cardState === "blocked"
              ? sql`case when ${imFeedbackTargets.state} = 'completed' and ${imFeedbackTargets.cardMessageId} is null then 'none' else ${input.cardState} end`
              : input.cardState,
        }
      : {}),
    ...(input.cardRevision !== undefined ? { cardRevision: input.cardRevision } : {}),
    ...(input.reconciliationCursor !== undefined ? { reconciliationCursor: input.reconciliationCursor } : {}),
  };
}
function scheduleSettlement(target: FeedbackTarget, input: FeedbackSettlement, now: Date) {
  const periodic =
    target.state === "queued"
      ? 15_000
      : target.state === "working" || target.state === "workspace_blocked"
        ? 60_000
        : undefined;
  const next =
    input.delayMs !== undefined
      ? new Date(now.getTime() + input.delayMs)
      : periodic
        ? new Date(now.getTime() + periodic)
        : DORMANT;
  return {
    lastErrorCode: input.errorCode ?? null,
    attemptCount: input.errorCode ? sql`${imFeedbackTargets.attemptCount} + 1` : 0,
    nextAttemptAt: sql`case when ${imFeedbackTargets.revision} <> ${target.revision} then ${now.toISOString()}::timestamptz else ${(input.stale || input.dormant ? DORMANT : next).toISOString()}::timestamptz end`,
  };
}

function rejectedFeedbackUpdate(delivery: typeof imMessageDeliveries.$inferSelect, now: Date) {
  const silent = ["cancelled", "duplicate_pending"].includes(delivery.reason ?? "");
  return {
    state: silent ? ("completed" as const) : ("failed" as const),
    desiredReaction: silent ? ("none" as const) : ("warning" as const),
    effects: delivery.dispatchRequestId ? ("may_have_occurred" as const) : ("not_started" as const),
    errorCode: silent ? null : delivery.reason === "ttl" ? "input_expired" : "input_rejected",
    cardState: silent ? ("none" as const) : ("pending" as const),
    settledAt: silent ? now : null,
    revision: sql`${imFeedbackTargets.revision} + 1`,
    updatedAt: now,
  };
}

function observerFeedbackUpdate(now: Date) {
  return {
    state: "stale" as const,
    desiredReaction: "none" as const,
    settledAt: now,
    nextAttemptAt: now,
    revision: sql`${imFeedbackTargets.revision}+1`,
    updatedAt: now,
  };
}

/** A claimed target with its frozen-batch flag and size: the root plus every message batched into it. */
async function withFrozenBatch(tx: DatabaseTransaction, target: FeedbackTarget): Promise<FeedbackTarget> {
  const [row] = await tx
    .select({ members: count() })
    .from(imMessageDeliveries)
    .where(
      and(
        eq(imMessageDeliveries.steerTargetDeliveryId, target.deliveryId),
        eq(imMessageDeliveries.reason, "batch_initial"),
      ),
    );
  const members = row?.members ?? 0;
  return { ...target, batchRetryBlocked: members > 0, ...(members > 0 ? { batchSize: members + 1 } : {}) };
}

/**
 * A quota failure card names when the quota is back if the Client said so. The time travels inside the Turn
 * report the delivery already keeps; it is passed through to the card, not copied anywhere.
 */
async function withReportedRetry(tx: DatabaseTransaction, target: FeedbackTarget): Promise<FeedbackTarget> {
  if (target.errorCode !== "provider_quota_exceeded") return target;
  const [row] = await tx
    .select({ report: imMessageDeliveries.turnReport })
    .from(imMessageDeliveries)
    .where(eq(imMessageDeliveries.id, target.cardOwnerDeliveryId))
    .limit(1);
  const retryAt = row?.report?.retryAt;
  return retryAt ? { ...target, retryAt } : target;
}

export async function hasFrozenFeedbackBatch(
  database: DatabaseClient | DatabaseTransaction,
  deliveryId: string,
): Promise<boolean> {
  const [member] = await database
    .select({ id: imMessageDeliveries.id })
    .from(imMessageDeliveries)
    .where(
      and(eq(imMessageDeliveries.steerTargetDeliveryId, deliveryId), eq(imMessageDeliveries.reason, "batch_initial")),
    )
    .limit(1);
  return !!member;
}
