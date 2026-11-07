import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { WebAPIRateLimitedError, WebClient } from "@slack/web-api";
import { createFeishuHttpInstance, feishuDomainForWorkspaceBrand } from "../im-bindings/feishu/adapter.js";
import type { ImBindingService } from "../im-bindings/im-binding-service.js";
import { SLACK_WEB_CLIENT_OPTIONS } from "../im-bindings/slack/default-api-client.js";
import { type ExternalCallPolicy, ExternalCallPolicyError } from "./external-call-policy.js";
import { renderFeedbackCard, renderFeedbackText } from "./im-feedback-card.js";
import type { FeedbackLanguage } from "./im-feedback-copy.js";
import type { FeedbackAction, FeedbackTarget, ImFeedbackStore, SlackFeedbackScope } from "./im-feedback-store.js";

export class FeedbackProviderError extends Error {
  constructor(
    readonly code: string,
    readonly knownNotApplied: boolean,
    readonly permanent = false,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

export class FeedbackCooldownStorageError extends FeedbackProviderError {
  constructor(retryAfterMs = 30_000) {
    super("IM_FEEDBACK_COOLDOWN_UNAVAILABLE", true, false, retryAfterMs);
  }
}

export interface FeedbackTransport {
  reaction(target: FeedbackTarget, desired: FeedbackTarget["desiredReaction"]): Promise<void>;
  post(target: FeedbackTarget, action?: FeedbackAction): Promise<string>;
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
    readonly store: Pick<ImFeedbackStore, "slackCooldownRemaining" | "deferSlackInstallation" | "messageLanguage">,
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
          if (
            error instanceof FeedbackCooldownStorageError ||
            (error instanceof FeedbackProviderError && error.code === "IM_FEEDBACK_BINDING_STALE")
          )
            return { ok: false as const, error };
          const limited = operation.startsWith("slack.") ? feedbackRateLimit(error) : undefined;
          if (limited) return { ok: false as const, error: limited };
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
        loggerLevel: LoggerLevel.error,
        httpInstance: createFeishuHttpInstance(signal),
      }),
    };
  }

  async respondSlack(input: {
    installationId: string;
    generation: number;
    token: string;
    channelId: string;
    userId: string;
    threadKey: string;
    result: "recorded" | "unavailable";
  }): Promise<void> {
    await this.#run(
      "slack.feedback.response",
      async (signal) => {
        const api = new WebClient(input.token, {
          ...SLACK_WEB_CLIENT_OPTIONS,
          fetch: (url, init) =>
            fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
        });
        await this.#slackCall(
          { provider: "slack", installationId: input.installationId, bindingGeneration: input.generation },
          () =>
            api.chat.postEphemeral({
              channel: input.channelId,
              user: input.userId,
              thread_ts: input.threadKey,
              text:
                input.result === "recorded"
                  ? "Retry queued. Check the original card for its result."
                  : "This operation is unavailable or changed. Open the original card's current details before deciding again.",
            }),
        );
      },
      { maxAttempts: 1, timeoutMs: 3_000 },
    );
  }

  async reaction(target: FeedbackTarget, desired: FeedbackTarget["desiredReaction"]): Promise<void> {
    await this.#run(
      `${target.provider}.feedback.reaction`,
      (signal) =>
        target.provider === "slack"
          ? this.#slackReaction(target, desired, signal)
          : this.#feishuReaction(target, desired, signal),
      { maxAttempts: 1, timeoutMs: 8_000 },
    );
  }
  async #slackReaction(
    target: FeedbackTarget,
    desired: FeedbackTarget["desiredReaction"],
    signal: AbortSignal,
  ): Promise<void> {
    const { api } = await this.#slack(target, signal);
    for (const name of ["eyes", "warning"]) {
      const wanted = desired === (name === "eyes" ? "working" : "warning");
      try {
        const input = { channel: target.channelId, timestamp: target.inputExternalId, name };
        if (wanted) await this.#slackCall(target, () => api.reactions.add(input));
        else await this.#slackCall(target, () => api.reactions.remove(input));
      } catch (error) {
        if (slackErrorCode(error) !== (wanted ? "already_reacted" : "no_reaction")) throw error;
      }
    }
  }
  async #feishuReaction(
    target: FeedbackTarget,
    desired: FeedbackTarget["desiredReaction"],
    signal: AbortSignal,
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
        ),
      ),
    );
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  async #language(target: FeedbackTarget): Promise<FeedbackLanguage> {
    try {
      return await this.store.messageLanguage(target.messageId);
    } catch {
      // Nothing has been submitted yet, so this stays a retryable pending send, not an unknown one.
      throw new FeedbackProviderError("IM_FEEDBACK_LANGUAGE_UNAVAILABLE", true);
    }
  }

  async post(target: FeedbackTarget, action?: FeedbackAction): Promise<string> {
    try {
      const language = await this.#language(target);
      return await this.#run(
        `${target.provider}.feedback.post`,
        async (signal) => {
          const text =
            target.messageFormat === "text_v1"
              ? renderFeedbackText(target, this.publicUrl, action, language)
              : undefined;
          const card = renderFeedbackCard(target, this.publicUrl, action, language);
          if (target.provider === "slack") {
            const { api } = await this.#slack(target, signal);
            const r = await this.#slackCall(target, () =>
              api.chat.postMessage({
                channel: target.channelId,
                thread_ts: target.threadKey ?? target.inputExternalId,
                ...(text ? { text, unfurl_links: false, unfurl_media: false } : card.slack),
              }),
            );
            if (!r.ok || !r.ts || r.channel !== target.channelId)
              throw new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false);
            return r.ts;
          }
          const { api } = await this.#feishu(target, signal);
          const r = await api.im.v1.message.reply({
            path: { message_id: target.inputExternalId },
            data: {
              msg_type: text ? "text" : "interactive",
              content: text ? JSON.stringify({ text }) : card.feishu,
              uuid: target.providerRequestId,
            },
          });
          if (r.code !== 0 || !r.data?.message_id || r.data.chat_id !== target.channelId)
            throw new FeedbackProviderError("IM_FEEDBACK_SEND_UNKNOWN", false);
          return r.data.message_id;
        },
        { maxAttempts: 1, timeoutMs: 8_000 },
      );
    } catch (error) {
      throw postFailure(error);
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

  async update(target: FeedbackTarget, action?: FeedbackAction): Promise<void> {
    const cardMessageId = target.cardMessageId;
    if (!cardMessageId) return;
    const language = await this.#language(target);
    await this.#run(
      `${target.provider}.feedback.update`,
      async (signal) => {
        const text =
          target.messageFormat === "text_v1" ? renderFeedbackText(target, this.publicUrl, action, language) : undefined;
        const card = renderFeedbackCard(target, this.publicUrl, action, language);
        if (target.provider === "slack") {
          const { api } = await this.#slack(target, signal);
          const r = await this.#slackCall(target, () =>
            api.chat.update({
              channel: target.channelId,
              ts: cardMessageId,
              text: text ?? card.slack.text,
              ...(text ? {} : { blocks: card.slack.blocks }),
            }),
          );
          if (!r.ok) throw new FeedbackProviderError("IM_FEEDBACK_UPDATE_FAILED", false);
        } else {
          const { api } = await this.#feishu(target, signal);
          const r = text
            ? await api.im.v1.message.update({
                path: { message_id: cardMessageId },
                data: { msg_type: "text", content: JSON.stringify({ text }) },
              })
            : await api.im.v1.message.patch({
                path: { message_id: cardMessageId },
                data: { content: card.feishu },
              });
          if (r.code !== 0) throw new FeedbackProviderError("IM_FEEDBACK_UPDATE_FAILED", false);
        }
      },
      { maxAttempts: 1, timeoutMs: 8_000 },
    );
  }

  async find(target: FeedbackTarget, cursor?: string): Promise<{ ids: string[]; cursor?: string }> {
    return this.#run(
      `${target.provider}.feedback.find`,
      (signal) =>
        target.provider === "slack"
          ? this.#findSlack(target, signal, cursor)
          : this.#findFeishu(target, signal, cursor),
      { maxAttempts: 1, timeoutMs: 8_000 },
    );
  }
  async #findSlack(target: FeedbackTarget, signal: AbortSignal, cursor?: string) {
    const { api, material } = await this.#slack(target, signal);
    const r = await this.#slackCall(target, () =>
      api.conversations.replies({
        channel: target.channelId,
        ts: target.threadKey ?? target.inputExternalId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!r.ok) throw new FeedbackProviderError("IM_FEEDBACK_READBACK_FAILED", false);
    const ids = (r.messages ?? [])
      .filter(
        (m) =>
          m.user === material.botUserId &&
          (target.messageFormat === "text_v1"
            ? m.text?.includes(new URL(`/im-feedback/${encodeURIComponent(target.id)}`, this.publicUrl).href)
            : m.blocks?.some((b) => b.block_id === `opentag_feedback:${target.id}`)),
      )
      .flatMap((m) => (m.ts ? [m.ts] : []));
    return { ids, ...(r.response_metadata?.next_cursor ? { cursor: r.response_metadata.next_cursor } : {}) };
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
          m.body?.content?.includes(`/im-feedback/${target.id}`),
      )
      .flatMap((m) => (m.message_id ? [m.message_id] : []));
    return { ids, ...(r.data.has_more && r.data.page_token ? { cursor: r.data.page_token } : {}) };
  }
}

function feedbackRateLimit(error: unknown): FeedbackProviderError | undefined {
  if (error instanceof FeedbackProviderError && error.code === "IM_FEEDBACK_RATE_LIMITED") return error;
  if (error instanceof WebAPIRateLimitedError || slackErrorCode(error) === "ratelimited")
    return new FeedbackProviderError("IM_FEEDBACK_RATE_LIMITED", true, false, slackRetryAfter(error));
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
    if (response.code !== 0 || !response.data)
      throw new FeedbackProviderError("IM_FEEDBACK_REACTION_READ_FAILED", false);
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
): Promise<void> {
  signal.throwIfAborted();
  if (wanted && owned.size === 0) {
    const response = await api.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
    if (response.code !== 0) throw new FeedbackProviderError("IM_FEEDBACK_REACTION_WRITE_FAILED", false);
  }
  if (wanted) return;
  for (const id of owned) {
    signal.throwIfAborted();
    const response = await api.delete({ path: { message_id: messageId, reaction_id: id } });
    if (response.code !== 0) throw new FeedbackProviderError("IM_FEEDBACK_REACTION_WRITE_FAILED", false);
  }
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
