import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { WebAPIRateLimitedError, WebClient } from "@slack/web-api";
import {
  createFeishuHttpInstance,
  feishuDomainForWorkspaceBrand,
  REDACTING_SDK_LOGGER,
} from "../im-bindings/feishu/adapter.js";
import { FEISHU_POLICY_DENIED_CODE, numericProviderCode } from "../im-bindings/feishu/setup-check.js";
import type { ImBindingService } from "../im-bindings/im-binding-service.js";
import { SLACK_WEB_CLIENT_OPTIONS } from "../im-bindings/slack/default-api-client.js";
import { type ExternalCallPolicy, ExternalCallPolicyError } from "./external-call-policy.js";
import {
  type FeedbackCard,
  feedbackCard,
  feedbackDetailsUrl,
  feishuCardContent,
  holdsFailureIdentity,
  slackCardIdentity,
  slackCardMessage,
  waitingCard,
} from "./im-feedback-card.js";
import { type FeedbackLanguage, originLine, type WaitingNoticeReason } from "./im-feedback-copy.js";
import type {
  FeedbackAction,
  FeedbackMessageContext,
  FeedbackTarget,
  ImFeedbackStore,
  SlackFeedbackScope,
} from "./im-feedback-store.js";
import { renderFeedbackText } from "./im-feedback-text.js";
import { sessionTaskUrl } from "./im-session-link.js";

const FEISHU_SEND_POLICY_DENIED = "IM_FEEDBACK_SEND_POLICY_DENIED";
export const FEISHU_REACTION_POLICY_DENIED = "IM_FEEDBACK_REACTION_POLICY_DENIED";

export class FeedbackProviderError extends Error {
  constructor(
    readonly code: string,
    readonly knownNotApplied: boolean,
    readonly permanent = false,
    readonly retryAfterMs?: number,
    /** Where readback must start when the outcome is unknown; absent means the conversation. */
    readonly readbackCursor?: string,
  ) {
    super(code);
  }
}

/** The provider refused a direct message to the sender, so nothing was sent and the card goes to the conversation. */
class SenderUnreachable extends Error {}

/** The readback cursor of a card whose direct message to the sender has an unknown outcome. */
export const SENDER_READBACK = "sender:";
/** The readback cursor of a card that fell back to the conversation after the sender's direct message was refused. */
export const CONVERSATION_READBACK = "conversation:";

/**
 * The readback of a group card meant for the sender whose leg was never recorded (a crash or a lost acknowledgement):
 * the conversation first, read-only, then the sender's direct message (`either-sender:`).
 */
export const EITHER_READBACK = "either:";
const EITHER_SENDER_READBACK = "either-sender:";

/** Where a send's provider write actually started, so an unknown outcome is read back there. */
interface DeliveryLeg {
  to?: "sender" | "conversation";
}

function withReadback(failure: FeedbackProviderError, leg: DeliveryLeg): FeedbackProviderError {
  if (failure.knownNotApplied) return failure;
  // No provider write started, so nothing can have been sent: retry instead of reading back.
  if (!leg.to) return new FeedbackProviderError("IM_FEEDBACK_SEND_NOT_STARTED", true, false, failure.retryAfterMs);
  const cursor = leg.to === "sender" ? SENDER_READBACK : CONVERSATION_READBACK;
  return new FeedbackProviderError(failure.code, false, failure.permanent, failure.retryAfterMs, cursor);
}
const GROUP_NAME_TIMEOUT_MS = 2_000;
/** Feishu deduplicates a request `uuid` for an hour; readback repeats the send only well inside that window. */
const FEISHU_REQUEST_DEDUP_MS = 50 * 60_000;

/**
 * Failure cards that, in a group, go to the sender's direct message with the Bot (Gandy 11-10). Both waiting
 * notices go there too. Every other card stays in the conversation.
 */
const SENDER_FAILURE_CODES = new Set([
  "input_expired",
  "input_rejected",
  "input_unsupported",
  "provider_quota_exceeded",
]);
export function failureGoesToSender(target: Pick<FeedbackTarget, "errorCode" | "state">): boolean {
  return target.state !== "workspace_blocked" && SENDER_FAILURE_CODES.has(target.errorCode ?? "");
}

/**
 * A Slack card in the sender's direct message keeps that channel in its message ID (`<channel>/<ts>`), because
 * editing it needs the channel. Slack timestamps never hold a slash; a conversation card keeps the plain timestamp.
 */
export function slackCardLocation(target: Pick<FeedbackTarget, "channelId">, messageId: string) {
  const slash = messageId.indexOf("/");
  return slash < 0
    ? { channel: target.channelId, ts: messageId }
    : { channel: messageId.slice(0, slash), ts: messageId.slice(slash + 1) };
}

export class FeedbackCooldownStorageError extends FeedbackProviderError {
  constructor(retryAfterMs = 30_000) {
    super("IM_FEEDBACK_COOLDOWN_UNAVAILABLE", true, false, retryAfterMs);
  }
}

export interface FeedbackTransport {
  reaction(target: FeedbackTarget, desired: FeedbackTarget["desiredReaction"]): Promise<void>;
  post(target: FeedbackTarget, action?: FeedbackAction): Promise<string>;
  postOfflineNotice(target: FeedbackTarget, reason?: WaitingNoticeReason): Promise<void>;
  update(target: FeedbackTarget, action?: FeedbackAction): Promise<void>;
  find(target: FeedbackTarget, cursor?: string): Promise<{ ids: string[]; cursor?: string }>;
}

/** The Bot and conversation a Server-written message goes to, without a native input to reply to. */
export interface ConversationTextTarget {
  bindingGeneration: number;
  bindingId: string;
  channelId: string;
  installationId: string | null;
  provider: "slack" | "feishu";
  /** Slack thread timestamp. On Feishu a thread needs `replyToExternalId` instead. */
  threadKey: string | null;
  replyToExternalId?: string;
}

export class ImFeedbackMessenger implements FeedbackTransport {
  constructor(
    readonly bindings: ImBindingService,
    readonly policy: ExternalCallPolicy,
    readonly publicUrl: string,
    readonly store: Pick<ImFeedbackStore, "slackCooldownRemaining" | "deferSlackInstallation" | "messageContext">,
  ) {}

  async #run<T>(
    operation: string,
    task: (signal: AbortSignal) => Promise<T>,
    options: { maxAttempts: number; timeoutMs: number },
  ): Promise<T> {
    const result = await this.policy.run(
      operation,
      async (signal) => {
        try {
          return { ok: true as const, value: await task(signal) };
        } catch (error) {
          const expected = feedbackCallRejection(operation, error);
          if (expected) return { ok: false as const, error: expected };
          throw error;
        }
      },
      options,
    );
    if (!result.ok) throw result.error;
    return result.value;
  }

  async #slackCall<T>(target: SlackFeedbackScope, task: () => Promise<T>): Promise<T> {
    let remainingMs: number | undefined;
    try {
      remainingMs = await this.store.slackCooldownRemaining(target);
    } catch {
      throw new FeedbackCooldownStorageError();
    }
    if (remainingMs === undefined) throw new FeedbackProviderError("IM_FEEDBACK_BINDING_STALE", true, true);
    if (remainingMs > 0) throw new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, remainingMs);
    try {
      return await task();
    } catch (error) {
      const limited = feedbackRateLimit(error);
      if (!limited) throw error;
      let current: boolean;
      try {
        current = await this.store.deferSlackInstallation(target, limited.retryAfterMs ?? 30_000);
      } catch {
        throw new FeedbackCooldownStorageError(limited.retryAfterMs);
      }
      if (!current) throw new FeedbackProviderError("IM_FEEDBACK_BINDING_STALE", true, true);
      throw limited;
    }
  }

  async #slack(
    target: Pick<FeedbackTarget, "bindingId" | "bindingGeneration" | "installationId">,
    signal: AbortSignal,
  ) {
    const material = await this.bindings.getSlackConnectionMaterial(target.bindingId);
    if (
      !material ||
      material.generation !== target.bindingGeneration ||
      material.installationId !== target.installationId
    )
      throw new FeedbackProviderError("IM_FEEDBACK_BINDING_STALE", true, true);
    return {
      material,
      api: new WebClient(material.botAccessToken, {
        ...SLACK_WEB_CLIENT_OPTIONS,
        fetch: (url, init) =>
          fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
      }),
    };
  }

  async #feishu(target: Pick<FeedbackTarget, "bindingId" | "bindingGeneration">, signal: AbortSignal) {
    const material = await this.bindings.getFeishuConnectionMaterial(target.bindingId);
    if (!material || material.generation !== target.bindingGeneration)
      throw new FeedbackProviderError("IM_FEEDBACK_BINDING_STALE", true, true);
    return {
      material,
      api: new Client({
        appId: material.appId,
        appSecret: material.appSecret,
        domain: feishuDomainForWorkspaceBrand(material.teamBrand),
        logger: REDACTING_SDK_LOGGER,
        loggerLevel: LoggerLevel.error,
        httpInstance: createFeishuHttpInstance(signal),
      }),
    };
  }

  async reaction(target: FeedbackTarget, desired: FeedbackTarget["desiredReaction"]): Promise<void> {
    let writeStarted = false;
    const markWrite = () => {
      const alreadyStarted = writeStarted;
      writeStarted = true;
      return () => {
        writeStarted = alreadyStarted;
      };
    };
    try {
      await this.#run(
        `${target.provider}.feedback.reaction`,
        (signal) =>
          target.provider === "slack"
            ? this.#slackReaction(target, desired, signal, markWrite)
            : this.#feishuReaction(target, desired, signal, markWrite).catch((error: unknown) => {
                if (numericProviderCode(error) === FEISHU_POLICY_DENIED_CODE)
                  throw new FeedbackProviderError(FEISHU_REACTION_POLICY_DENIED, !writeStarted, true);
                throw error;
              }),
        { maxAttempts: 1, timeoutMs: 8_000 },
      );
    } catch (error) {
      if (error instanceof FeedbackCooldownStorageError) throw error;
      if (error instanceof FeedbackProviderError) {
        if (error.knownNotApplied === !writeStarted) throw error;
        throw new FeedbackProviderError(error.code, !writeStarted, error.permanent, error.retryAfterMs);
      }
      if (writeStarted) throw error;
      throw new FeedbackProviderError(
        error instanceof ExternalCallPolicyError ? error.code : "IM_FEEDBACK_REACTION_READ_FAILED",
        true,
      );
    }
  }
  async #slackReaction(
    target: FeedbackTarget,
    desired: FeedbackTarget["desiredReaction"],
    signal: AbortSignal,
    markWrite: () => () => void,
  ): Promise<void> {
    const { api } = await this.#slack(target, signal);
    for (const name of ["eyes", "warning"]) {
      const wanted = desired === (name === "eyes" ? "working" : "warning");
      const input = { channel: target.channelId, timestamp: target.inputExternalId, name };
      try {
        await this.#slackCall(target, async () => {
          signal.throwIfAborted();
          const restoreWriteState = markWrite();
          try {
            await (wanted ? api.reactions.add(input) : api.reactions.remove(input));
          } catch (error) {
            if (feedbackRateLimit(error)) restoreWriteState();
            throw error;
          }
        });
      } catch (error) {
        if (slackErrorCode(error) !== (wanted ? "already_reacted" : "no_reaction")) throw error;
      }
    }
  }
  async #feishuReaction(
    target: FeedbackTarget,
    desired: FeedbackTarget["desiredReaction"],
    signal: AbortSignal,
    markWrite: () => void,
  ): Promise<void> {
    const { api, material } = await this.#feishu(target, signal);
    const reactions = api.im.v1.messageReaction;
    const owned = await ownedFeishuReactions(reactions, material.appId, target.inputExternalId, signal);
    const results = await Promise.allSettled(
      (["OnIt", "CrossMark"] as const).map((emoji) =>
        projectFeishuEmoji(
          reactions,
          target.inputExternalId,
          emoji,
          owned[emoji],
          desired === (emoji === "OnIt" ? "working" : "warning"),
          signal,
          markWrite,
        ),
      ),
    );
    const denied = results.find(
      (result) => result.status === "rejected" && numericProviderCode(result.reason) === FEISHU_POLICY_DENIED_CODE,
    );
    if (denied?.status === "rejected") throw denied.reason;
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  /** Links the card's Session ID to the Session's Task page when the context says that page can be opened. */
  #linked(card: FeedbackCard, context: FeedbackMessageContext): FeedbackCard {
    if (!context.taskAgentId) return card;
    return { ...card, sessionUrl: sessionTaskUrl(this.publicUrl, context.taskAgentId, card.sessionId) };
  }

  async #context(target: FeedbackTarget): Promise<FeedbackMessageContext> {
    try {
      return await this.store.messageContext(target);
    } catch {
      // Nothing has been submitted yet, so this stays a retryable pending send, not an unknown one.
      throw new FeedbackProviderError("IM_FEEDBACK_LANGUAGE_UNAVAILABLE", true);
    }
  }

  /**
   * Sends a card where the conversation expects it: inside the input's thread when it has one, at the
   * top of a direct message without quoting, and in a group as a Feishu quote reply or a Slack channel
   * message. `requestId` is Feishu's send idempotency key.
   */
  async #sendCard(
    target: FeedbackTarget,
    card: FeedbackCard,
    context: FeedbackMessageContext,
    signal: AbortSignal,
    requestId?: string,
  ): Promise<string> {
    if (target.provider === "slack") {
      const { api } = await this.#slack(target, signal);
      const r = await this.#slackCall(target, () =>
        api.chat.postMessage({
          channel: target.channelId,
          ...(target.threadKey ? { thread_ts: target.threadKey } : {}),
          ...slackCardMessage(card, target.id, context.language),
        }),
      );
      if (!r.ok || !r.ts || r.channel !== target.channelId)
        throw new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false);
      return r.ts;
    }
    const { api } = await this.#feishu(target, signal);
    const data = {
      msg_type: "interactive",
      content: feishuCardContent(card, feedbackDetailsUrl(target, this.publicUrl), context.language),
      ...(requestId ? { uuid: requestId } : {}),
    };
    const r =
      context.direct && !target.threadKey
        ? await api.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: { ...data, receive_id: target.channelId },
          })
        : await api.im.v1.message.reply({ path: { message_id: target.inputExternalId }, data });
    if (r.code === FEISHU_POLICY_DENIED_CODE) throw new FeedbackProviderError(FEISHU_SEND_POLICY_DENIED, true, true);
    if (r.code !== 0 || !r.data?.message_id || r.data.chat_id !== target.channelId)
      throw new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false);
    return r.data.message_id;
  }

  /**
   * Sends a card to the sender's direct message with the Bot when `toSender` and the conversation is a group.
   * When the provider refuses that message (the sender is outside the app's availability, is a bot, or the call is
   * rejected), it goes where the conversation expects it. An unknown direct-message outcome never falls back,
   * which could post the card twice; readback then starts in the direct message.
   */
  async #deliver(
    target: FeedbackTarget,
    card: FeedbackCard,
    context: FeedbackMessageContext,
    signal: AbortSignal,
    toSender: boolean,
    leg: DeliveryLeg,
    requestId?: string,
  ): Promise<string> {
    if (toSender && !context.direct) {
      try {
        return await this.#sendToSender(target, card, context, signal, leg, requestId);
      } catch (error) {
        // The outer boundary adds the readback cursor of the leg that started, even after its own deadline.
        if (!(error instanceof SenderUnreachable)) throw error;
      }
    }
    leg.to = "conversation";
    return this.#sendCard(target, card, context, signal, requestId);
  }

  async #sendToSender(
    target: FeedbackTarget,
    card: FeedbackCard,
    context: FeedbackMessageContext,
    signal: AbortSignal,
    leg: DeliveryLeg,
    requestId?: string,
  ): Promise<string> {
    card = await this.#withOrigin(target, card, context, signal);
    if (target.provider === "slack") {
      const { api } = await this.#slack(target, signal);
      const channel = await this.#slackSenderChannel(target, api);
      leg.to = "sender";
      const r = await this.#slackCall(target, () =>
        api.chat
          .postMessage({ channel, ...slackCardMessage(card, target.id, context.language) })
          .catch(rejectedAsUnreachable),
      );
      if (!r.ok || !r.ts)
        throw new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false, false, undefined, SENDER_READBACK);
      return `${channel}/${r.ts}`;
    }
    const sent = await this.#feishuSenderCreate(target, card, context, signal, requestId, leg);
    if (sent === "rejected") throw new SenderUnreachable();
    return sent;
  }

  /** Names the group and message a card is about, since the sender reads it away from that group. */
  async #withOrigin(
    target: FeedbackTarget,
    card: FeedbackCard,
    context: FeedbackMessageContext,
    signal: AbortSignal,
  ): Promise<FeedbackCard> {
    if (context.excerpt === undefined) return card;
    const groupName = await this.#groupNameWithin(target, signal);
    return { ...card, origin: originLine(context.language, context.excerpt, groupName) };
  }

  /**
   * The name is a courtesy: a slow, hung or failed lookup gives up after two seconds, leaving the send most of its
   * deadline, and the card says "in the group" instead.
   */
  async #groupNameWithin(target: FeedbackTarget, signal: AbortSignal): Promise<string | undefined> {
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), GROUP_NAME_TIMEOUT_MS);
    try {
      return await this.#groupName(target, AbortSignal.any([signal, limit.signal]), limit.signal);
    } catch (error) {
      // A cooldown that could not be stored must stop the worker like any other feedback call.
      if (error instanceof FeedbackCooldownStorageError) throw error;
      return undefined;
    } finally {
      clearTimeout(timer);
      limit.abort();
    }
  }

  /**
   * Only the provider read races the courtesy limit. Once Slack answers with a rate limit, the cooldown it records
   * is awaited to the end, so a failure to store it still reaches the worker.
   */
  async #groupName(target: FeedbackTarget, signal: AbortSignal, limit: AbortSignal): Promise<string | undefined> {
    const within = <T>(read: Promise<T>) => Promise.race([read, untilAborted(limit)]);
    if (target.provider === "slack") {
      const { api } = await this.#slack(target, signal);
      const r = await this.#slackCall(target, () => within(api.conversations.info({ channel: target.channelId })));
      return r?.channel?.name || undefined;
    }
    const { api } = await this.#feishu(target, signal);
    const r = await within(api.im.v1.chat.get({ path: { chat_id: target.channelId } }));
    return r?.code === 0 ? r.data?.name || undefined : undefined;
  }

  /** Opening the conversation posts nothing, so any failure here is known not to have sent the card. */
  async #slackSenderChannel(target: FeedbackTarget, api: WebClient): Promise<string> {
    let opened: Awaited<ReturnType<WebClient["conversations"]["open"]>>;
    try {
      opened = await this.#slackCall(target, () =>
        api.conversations.open({ users: target.senderExternalId }).catch(rejectedAsUnreachable),
      );
    } catch (error) {
      if (error instanceof SenderUnreachable || error instanceof FeedbackProviderError) throw error;
      throw new FeedbackProviderError("IM_FEEDBACK_SENDER_OPEN_FAILED", true);
    }
    if (!opened.channel?.id) throw new SenderUnreachable();
    return opened.channel.id;
  }

  /** A Feishu card to the sender's open_id, or `rejected` when Feishu refused it. Bots have no open_id. */
  async #feishuSenderCreate(
    target: FeedbackTarget,
    card: FeedbackCard,
    context: FeedbackMessageContext,
    signal: AbortSignal,
    requestId?: string,
    leg?: DeliveryLeg,
  ): Promise<string | "rejected"> {
    if (!target.senderExternalId.startsWith("ou_")) return "rejected";
    const { api } = await this.#feishu(target, signal);
    let r: Awaited<ReturnType<typeof api.im.v1.message.create>>;
    if (leg) leg.to = "sender";
    try {
      r = await api.im.v1.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: target.senderExternalId,
          msg_type: "interactive",
          content: feishuCardContent(card, feedbackDetailsUrl(target, this.publicUrl), context.language),
          ...(requestId ? { uuid: requestId } : {}),
        },
      });
    } catch (error) {
      if (numericProviderCode(error) === FEISHU_POLICY_DENIED_CODE) throw error;
      if (feishuErrorCode(error) !== undefined) return "rejected";
      throw error;
    }
    if (r.code === FEISHU_POLICY_DENIED_CODE) throw new FeedbackProviderError(FEISHU_SEND_POLICY_DENIED, true, true);
    if (r.code !== 0) return "rejected";
    if (!r.data?.message_id)
      throw new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false, false, undefined, SENDER_READBACK);
    return r.data.message_id;
  }

  async post(target: FeedbackTarget, action?: FeedbackAction): Promise<string> {
    const leg: DeliveryLeg = {};
    try {
      const context = await this.#context(target);
      return await this.#run(
        `${target.provider}.feedback.post`,
        (signal) =>
          this.#deliver(
            target,
            this.#linked(feedbackCard(target, action, context.language, context.runtime), context),
            context,
            signal,
            failureGoesToSender(target),
            leg,
            target.providerRequestId,
          ),
        { maxAttempts: 1, timeoutMs: 8_000 },
      );
    } catch (error) {
      throw withReadback(postFailure(error), leg);
    }
  }

  /**
   * Sends a card outside the failure message identity: `providerRequestId` belongs to the failure
   * message, and Feishu would swallow that later message as a duplicate of this one.
   */
  async postOfflineNotice(target: FeedbackTarget, reason: WaitingNoticeReason = "offline"): Promise<void> {
    const leg: DeliveryLeg = {};
    try {
      const context = await this.#context(target);
      await this.#run(
        `${target.provider}.feedback.offline_notice`,
        (signal) =>
          this.#deliver(
            target,
            this.#linked(waitingCard(context.language, target.sessionId, reason), context),
            context,
            signal,
            true,
            leg,
          ),
        { maxAttempts: 1, timeoutMs: 8_000 },
      );
    } catch (error) {
      throw withReadback(postFailure(error), leg);
    }
  }

  /**
   * One plain message from the Bot into a conversation. No Markdown, mention, or link parsing, and
   * `requestId` is Feishu's send idempotency key; Slack has no equivalent.
   */
  async postConversationText(target: ConversationTextTarget, text: string, requestId: string): Promise<string> {
    try {
      return await this.#run(
        `${target.provider}.feedback.post`,
        async (signal) => {
          if (target.provider === "slack") {
            const { api } = await this.#slack(target, signal);
            const r = await this.#slackCall({ ...target, provider: "slack" }, () =>
              api.chat.postMessage({
                channel: target.channelId,
                ...(target.threadKey ? { thread_ts: target.threadKey } : {}),
                text,
                parse: "none",
                unfurl_links: false,
                unfurl_media: false,
              }),
            );
            if (!r.ok || !r.ts) throw new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false);
            return r.ts;
          }
          const { api } = await this.#feishu(target, signal);
          const data = { msg_type: "text", content: JSON.stringify({ text }), uuid: requestId };
          const r = target.replyToExternalId
            ? await api.im.v1.message.reply({
                path: { message_id: target.replyToExternalId },
                data: { ...data, reply_in_thread: true },
              })
            : await api.im.v1.message.create({
                params: { receive_id_type: "chat_id" },
                data: { ...data, receive_id: target.channelId },
              });
          if (r.code !== 0 || !r.data?.message_id) throw new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false);
          return r.data.message_id;
        },
        { maxAttempts: 1, timeoutMs: 8_000 },
      );
    } catch (error) {
      throw postFailure(error);
    }
  }

  /** Rewrites a plain message that `postConversationText` sent. */
  async updateConversationText(target: ConversationTextTarget, messageId: string, text: string): Promise<void> {
    await this.#run(
      `${target.provider}.feedback.update`,
      async (signal) => {
        if (target.provider === "slack") {
          const { api } = await this.#slack(target, signal);
          const r = await this.#slackCall({ ...target, provider: "slack" }, () =>
            api.chat.update({ channel: target.channelId, ts: messageId, text }),
          );
          if (!r.ok) throw new FeedbackProviderError("IM_FEEDBACK_UPDATE_FAILED", false);
          return;
        }
        const { api } = await this.#feishu(target, signal);
        const r = await api.im.v1.message.update({
          path: { message_id: messageId },
          data: { msg_type: "text", content: JSON.stringify({ text }) },
        });
        if (r.code !== 0) throw new FeedbackProviderError("IM_FEEDBACK_UPDATE_FAILED", false);
      },
      { maxAttempts: 1, timeoutMs: 8_000 },
    );
  }

  /**
   * Refreshes a sent failure message in place, in the format it was sent in: a card stays a card,
   * including one from before plain text (sent with `update_multi`), and a plain-text message stays text,
   * because Feishu cannot turn a text message into a card.
   */
  async update(target: FeedbackTarget, action?: FeedbackAction): Promise<void> {
    const messageId = target.cardMessageId;
    if (!messageId) return;
    const context = await this.#context(target);
    const { language, runtime } = context;
    await this.#run(
      `${target.provider}.feedback.update`,
      async (signal) => {
        if (target.messageFormat === "text_v1") return this.#updateText(target, messageId, action, language, signal);
        const card = this.#linked(feedbackCard(target, action, language, runtime), context);
        if (target.provider === "slack") {
          const { api } = await this.#slack(target, signal);
          const r = await this.#slackCall(target, () =>
            api.chat.update({
              ...slackCardLocation(target, messageId),
              // Clears the text of a card sent before the card moved into an attachment.
              text: "",
              blocks: [],
              ...slackCardMessage(card, target.id, language),
            }),
          );
          if (!r.ok) throw new FeedbackProviderError("IM_FEEDBACK_UPDATE_FAILED", false);
          return;
        }
        const { api } = await this.#feishu(target, signal);
        const r = await api.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: feishuCardContent(card, feedbackDetailsUrl(target, this.publicUrl), language) },
        });
        if (r.code !== 0) throw new FeedbackProviderError("IM_FEEDBACK_UPDATE_FAILED", false);
      },
      { maxAttempts: 1, timeoutMs: 8_000 },
    );
  }
  async #updateText(
    target: FeedbackTarget,
    messageId: string,
    action: FeedbackAction | undefined,
    language: FeedbackLanguage,
    signal: AbortSignal,
  ): Promise<void> {
    const text = renderFeedbackText(target, this.publicUrl, action, language);
    if (target.provider === "slack") {
      const { api } = await this.#slack(target, signal);
      const r = await this.#slackCall(target, () =>
        api.chat.update({ channel: target.channelId, ts: messageId, text }),
      );
      if (!r.ok) throw new FeedbackProviderError("IM_FEEDBACK_UPDATE_FAILED", false);
      return;
    }
    const { api } = await this.#feishu(target, signal);
    const r = await api.im.v1.message.update({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    });
    if (r.code !== 0) throw new FeedbackProviderError("IM_FEEDBACK_UPDATE_FAILED", false);
  }

  /**
   * Bounded readback. Without a cursor (a crash or a lost acknowledgement left no record of the leg), a group card
   * that goes to the sender is looked for in their direct message first.
   */
  async find(target: FeedbackTarget, cursor?: string): Promise<{ ids: string[]; cursor?: string }> {
    const start = cursor ?? ((await this.#mayBeWithSender(target)) ? EITHER_READBACK : undefined);
    return this.#run(
      `${target.provider}.feedback.find`,
      (signal) => {
        const after = (prefix: string) => start?.slice(prefix.length) || undefined;
        if (start?.startsWith(SENDER_READBACK)) return this.#findSender(target, signal, after(SENDER_READBACK));
        if (start?.startsWith(EITHER_SENDER_READBACK))
          return this.#findSender(target, signal, after(EITHER_SENDER_READBACK), EITHER_SENDER_READBACK);
        if (start?.startsWith(EITHER_READBACK)) return this.#findEither(target, signal, after(EITHER_READBACK));
        if (start?.startsWith(CONVERSATION_READBACK))
          return this.#findFallback(target, signal, after(CONVERSATION_READBACK));
        return this.#findConversation(target, signal, start);
      },
      { maxAttempts: 1, timeoutMs: 8_000 },
    );
  }
  /** A card sent before cards went to the sender (plain text) stays in the conversation. */
  async #mayBeWithSender(target: FeedbackTarget): Promise<boolean> {
    if (target.messageFormat === "text_v1" || !failureGoesToSender(target)) return false;
    return !(await this.#context(target)).direct;
  }
  /** The conversation pages of an unrecorded leg, then the sender's direct message. */
  async #findEither(target: FeedbackTarget, signal: AbortSignal, cursor?: string) {
    const result = await this.#findConversation(target, signal, cursor);
    if (result.ids.length > 0) return result;
    return { ids: [], cursor: result.cursor ? `${EITHER_READBACK}${result.cursor}` : EITHER_SENDER_READBACK };
  }
  #findConversation(target: FeedbackTarget, signal: AbortSignal, cursor?: string) {
    return target.provider === "slack"
      ? this.#findSlack(target, signal, cursor)
      : this.#findFeishu(target, signal, cursor);
  }
  /** The conversation, for a card that fell back there; its pages keep the fallback marker. */
  async #findFallback(target: FeedbackTarget, signal: AbortSignal, cursor?: string) {
    const result = await this.#findConversation(target, signal, cursor);
    return { ids: result.ids, ...(result.cursor ? { cursor: `${CONVERSATION_READBACK}${result.cursor}` } : {}) };
  }
  /**
   * Readback in the sender's direct message. Slack reads its history for this Bot's card identity. Feishu cannot
   * name that chat before a send, so it repeats the send under the same request `uuid`, which Feishu answers with
   * the original message when there was one; past its deduplication window nothing is repeated.
   */
  async #findSender(target: FeedbackTarget, signal: AbortSignal, page?: string, prefix = SENDER_READBACK) {
    // After the conversation was already read, an unreachable direct message has nothing left to find.
    const fallback = () => (prefix === SENDER_READBACK ? this.#findFallback(target, signal) : { ids: [] });
    if (target.provider === "feishu") {
      const startedAt = (target.sendStartedAt ?? target.createdAt).getTime();
      if (Date.now() - startedAt > FEISHU_REQUEST_DEDUP_MS) return { ids: [] };
      const context = await this.#context(target);
      const sent = await this.#feishuSenderCreate(
        target,
        await this.#withOrigin(
          target,
          this.#linked(feedbackCard(target, undefined, context.language), context),
          context,
          signal,
        ),
        context,
        signal,
        target.providerRequestId,
      ).catch((error) => {
        if (error instanceof FeedbackProviderError && error.knownNotApplied) return "unknown" as const;
        throw error;
      });
      // A refused direct message means the card fell back to the conversation.
      if (sent === "rejected") return fallback();
      return { ids: sent === "unknown" ? [] : [sent] };
    }
    const { api, material } = await this.#slack(target, signal);
    let channel: string;
    try {
      channel = await this.#slackSenderChannel(target, api);
    } catch (error) {
      if (error instanceof SenderUnreachable) return fallback();
      throw error;
    }
    const identity = slackCardIdentity("failure", target.id);
    const r = await this.#slackCall(target, () =>
      api.conversations.history({
        channel,
        oldest: String(Math.floor((target.sendStartedAt ?? target.createdAt).getTime() / 1000) - 60),
        limit: 100,
        ...(page ? { cursor: page } : {}),
      }),
    );
    if (!r.ok) throw new FeedbackProviderError("IM_FEEDBACK_READBACK_FAILED", false);
    const ids = (r.messages ?? [])
      .filter(
        (m) =>
          m.user === material.botUserId &&
          (m.attachments ?? []).flatMap((a) => a.blocks ?? []).some((b) => b.block_id === identity),
      )
      .flatMap((m) => (m.ts ? [`${channel}/${m.ts}`] : []));
    const next = r.response_metadata?.next_cursor;
    return { ids, ...(next ? { cursor: `${prefix}${next}` } : {}) };
  }
  async #findSlack(target: FeedbackTarget, signal: AbortSignal, cursor?: string) {
    const { api, material } = await this.#slack(target, signal);
    const identity = slackCardIdentity("failure", target.id);
    const plan = slackReadbackPlan(target, cursor);
    const r = await this.#slackCall(target, () =>
      plan.replies
        ? api.conversations.replies({
            channel: target.channelId,
            ts: target.threadKey ?? target.inputExternalId,
            limit: 100,
            ...(plan.page ? { cursor: plan.page } : {}),
          })
        : api.conversations.history({
            channel: target.channelId,
            // A minute of slack for clock skew between this Server and Slack.
            oldest: String(Math.floor((target.sendStartedAt ?? target.createdAt).getTime() / 1000) - 60),
            limit: 100,
            ...(plan.page ? { cursor: plan.page } : {}),
          }),
    );
    if (!r.ok) throw new FeedbackProviderError("IM_FEEDBACK_READBACK_FAILED", false);
    const ids = (r.messages ?? [])
      .filter(
        (m) =>
          m.user === material.botUserId &&
          (target.messageFormat === "text_v1"
            ? holdsFailureIdentity(m.text ?? "", target.id)
            : // A card carries its identity in a hidden block ID, in an attachment or (before attachments) at the top.
              [...(m.blocks ?? []), ...(m.attachments ?? []).flatMap((a) => a.blocks ?? [])].some(
                (b) => b.block_id === identity,
              )),
      )
      .flatMap((m) => (m.ts ? [m.ts] : []));
    const next = plan.next(r.response_metadata?.next_cursor || undefined);
    return { ids, ...(next ? { cursor: next } : {}) };
  }
  async #findFeishu(target: FeedbackTarget, signal: AbortSignal, cursor?: string) {
    const { api, material } = await this.#feishu(target, signal);
    const r = await api.im.v1.message.list({
      params: {
        container_id_type: target.threadKey ? "thread" : "chat",
        container_id: target.threadKey ?? target.channelId,
        // Feishu rejects the whole request above fifty.
        page_size: 50,
        ...(!target.threadKey
          ? { start_time: String(Math.floor((target.sendStartedAt ?? target.createdAt).getTime() / 1000)) }
          : {}),
        sort_type: "ByCreateTimeAsc",
        ...(cursor ? { page_token: cursor } : {}),
      },
    });
    if (r.code !== 0 || !r.data) throw new FeedbackProviderError("IM_FEEDBACK_READBACK_FAILED", false);
    const ids = (r.data.items ?? [])
      .filter(
        (m) =>
          m.sender?.sender_type === "app" &&
          [material.appId, material.botOpenId].includes(m.sender.id) &&
          holdsFailureIdentity(m.body?.content ?? "", target.id),
      )
      .flatMap((m) => (m.message_id ? [m.message_id] : []));
    return { ids, ...(r.data.has_more && r.data.page_token ? { cursor: r.data.page_token } : {}) };
  }
}

/**
 * Where Slack readback looks next. A card goes to the channel unless the input was in a thread, but a card
 * from before the text period went into the input's replies, and both share `interactive_v1`. Such a target
 * reads the input's replies first and then the channel; its cursor says which (`replies:` or `history:`).
 */
function slackReadbackPlan(target: FeedbackTarget, cursor?: string) {
  if (target.threadKey || target.messageFormat === "text_v1")
    return { replies: true, page: cursor, next: (page?: string) => page };
  const [phase, page] = cursor ? [cursor.slice(0, cursor.indexOf(":")), cursor.slice(cursor.indexOf(":") + 1)] : [];
  if (phase === "history")
    return { replies: false, page: page || undefined, next: (more?: string) => more && `history:${more}` };
  return { replies: true, page: page || undefined, next: (more?: string) => (more ? `replies:${more}` : "history:") };
}

function feedbackCallRejection(operation: string, error: unknown): FeedbackProviderError | undefined {
  if (
    error instanceof FeedbackCooldownStorageError ||
    (error instanceof FeedbackProviderError && (error.code === "IM_FEEDBACK_BINDING_STALE" || error.permanent))
  ) {
    return error;
  }
  if (operation.startsWith("slack.")) return feedbackRateLimit(error);
  if (
    (operation === "feishu.feedback.post" || operation === "feishu.feedback.offline_notice") &&
    numericProviderCode(error) === FEISHU_POLICY_DENIED_CODE
  ) {
    return new FeedbackProviderError(FEISHU_SEND_POLICY_DENIED, true, true);
  }
}

function feedbackRateLimit(error: unknown): FeedbackProviderError | undefined {
  if (error instanceof FeedbackProviderError && error.code === "IM_FEEDBACK_RATE_LIMITED") return error;
  if (error instanceof WebAPIRateLimitedError || slackErrorCode(error) === "ratelimited")
    return new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, slackRetryAfter(error));
}

/** A Slack platform rejection of a direct-message call: nothing was sent. Rate limits stay rate limits. */
function rejectedAsUnreachable(error: unknown): never {
  if (slackErrorCode(error) !== undefined && slackErrorCode(error) !== "ratelimited") throw new SenderUnreachable();
  throw error;
}

/** The Feishu error code of an HTTP error response, which means Feishu answered and refused the call. */
/** Resolves with nothing once the signal aborts: the end of an optional read's time. */
function untilAborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

function feishuErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("response" in error)) return;
  const data = (error as { response?: { data?: { code?: unknown } } }).response?.data;
  return typeof data?.code === "number" && data.code !== 0 ? data.code : undefined;
}

function slackErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return;
  const data = error.data;
  return data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : undefined;
}

type FeishuReactions = Client["im"]["v1"]["messageReaction"];
type FeishuReactionItem = NonNullable<Awaited<ReturnType<FeishuReactions["list"]>>["data"]>["items"][number];
type FeedbackEmoji = "OnIt" | "CrossMark";
function collectOwnedFeishuReactions(
  owned: Record<FeedbackEmoji, Set<string>>,
  items: FeishuReactionItem[],
  appId: string,
): void {
  for (const item of items) {
    const emoji = item.reaction_type?.emoji_type;
    if (
      (emoji === "OnIt" || emoji === "CrossMark") &&
      item.operator?.operator_type === "app" &&
      item.operator.operator_id === appId &&
      item.reaction_id
    )
      owned[emoji].add(item.reaction_id);
  }
}
async function ownedFeishuReactions(
  api: FeishuReactions,
  appId: string,
  messageId: string,
  signal: AbortSignal,
): Promise<Record<FeedbackEmoji, Set<string>>> {
  const owned = { OnIt: new Set<string>(), CrossMark: new Set<string>() };
  let page: string | undefined;
  const seen = new Set<string>();
  do {
    signal.throwIfAborted();
    const response = await api.list({
      path: { message_id: messageId },
      params: { page_size: 50, ...(page ? { page_token: page } : {}) },
    });
    if (response.code !== 0 || !response.data) {
      throw feishuReactionResponseError(response.code, "IM_FEEDBACK_REACTION_READ_FAILED");
    }
    collectOwnedFeishuReactions(owned, response.data.items, appId);
    page = response.data.has_more ? response.data.page_token : undefined;
    if (response.data.has_more && (!page || seen.has(page) || seen.size >= 100))
      throw new FeedbackProviderError("IM_FEEDBACK_REACTION_PAGINATION_INVALID", false);
    if (page) seen.add(page);
  } while (page);
  return owned;
}
async function projectFeishuEmoji(
  api: FeishuReactions,
  messageId: string,
  emoji: FeedbackEmoji,
  owned: Set<string>,
  wanted: boolean,
  signal: AbortSignal,
  markWrite: () => void,
): Promise<void> {
  signal.throwIfAborted();
  if (wanted && owned.size === 0) {
    markWrite();
    const response = await api.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
    if (response.code !== 0) {
      throw feishuReactionResponseError(response.code, "IM_FEEDBACK_REACTION_WRITE_FAILED");
    }
  }
  if (wanted) return;
  for (const id of owned) {
    signal.throwIfAborted();
    markWrite();
    const response = await api.delete({ path: { message_id: messageId, reaction_id: id } });
    if (response.code !== 0) {
      throw feishuReactionResponseError(response.code, "IM_FEEDBACK_REACTION_WRITE_FAILED");
    }
  }
}

function feishuReactionResponseError(code: number | undefined, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function slackRetryAfter(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "retryAfter" in error &&
    typeof error.retryAfter === "number" &&
    Number.isFinite(error.retryAfter) &&
    error.retryAfter > 0
  )
    return Math.ceil(error.retryAfter * 1_000);
  return 30_000;
}

function postFailure(error: unknown): FeedbackProviderError {
  if (error instanceof FeedbackProviderError) return error;
  if (error instanceof ExternalCallPolicyError && error.phase === "circuit")
    return new FeedbackProviderError("IM_PROVIDER_CIRCUIT_OPEN", true, false, 30_000);
  if (error instanceof ExternalCallPolicyError && error.phase === "admission")
    return new FeedbackProviderError(error.code, true);
  const code = slackErrorCode(error);
  const permanent = [
    "invalid_auth",
    "token_revoked",
    "missing_scope",
    "channel_not_found",
    "not_in_channel",
    "invalid_blocks",
    "invalid_arguments",
  ].includes(code ?? "");
  if (permanent) return new FeedbackProviderError("IM_FEEDBACK_SEND_REJECTED", true, true);
  return new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false);
}
