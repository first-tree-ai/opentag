import { randomUUID } from "node:crypto";
import { TurnFailureReasonSchema } from "@opentag/shared";
import { WebAPIRateLimitedError } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalCallPolicy, ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { feedbackCard, feishuCardContent, slackCardMessage, waitingCard } from "../services/im/im-feedback-card.js";
import {
  CONVERSATION_READBACK,
  FeedbackCooldownStorageError,
  ImFeedbackMessenger,
  SENDER_READBACK,
} from "../services/im/im-feedback-messenger.js";
import type {
  FeedbackAction,
  FeedbackMessageContext,
  FeedbackRuntime,
  FeedbackTarget,
} from "../services/im/im-feedback-store.js";
import { renderFeedbackText } from "../services/im/im-feedback-text.js";
import type { ImBindingService } from "../services/im-bindings/im-binding-service.js";
import { deferred } from "./support/deferred.js";

const mocks = vi.hoisted(() => ({
  slack: {
    reactions: { add: vi.fn(), remove: vi.fn() },
    chat: { postMessage: vi.fn(), update: vi.fn() },
    conversations: { replies: vi.fn(), history: vi.fn(), open: vi.fn(), info: vi.fn() },
  },
  feishu: {
    im: {
      v1: {
        messageReaction: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
        message: { create: vi.fn(), reply: vi.fn(), patch: vi.fn(), update: vi.fn(), list: vi.fn() },
        chat: { get: vi.fn() },
      },
    },
  },
  slackOptions: vi.fn(),
  feishuOptions: vi.fn(),
}));
vi.mock("@slack/web-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@slack/web-api")>()),
  WebClient: class {
    constructor(token: string, options: unknown) {
      mocks.slackOptions(token, options);
      Object.assign(this, mocks.slack);
    }
  },
}));
vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@larksuiteoapi/node-sdk")>()),
  Client: class {
    constructor(options: unknown) {
      mocks.feishuOptions(options);
      Object.assign(this, mocks.feishu);
    }
  },
}));
function target(provider: "slack" | "feishu" = "slack"): FeedbackTarget {
  const now = new Date();
  const deliveryId = randomUUID();
  return {
    id: randomUUID(),
    accountId: randomUUID(),
    agentId: randomUUID(),
    bindingId: randomUUID(),
    bindingGeneration: 2,
    provider,
    installationId: "11111111-1111-4111-8111-111111111111",
    messageId: randomUUID(),
    sessionId: randomUUID(),
    deliveryId,
    turnId: "turn",
    placementGeneration: 1,
    channelId: "channel",
    inputExternalId: "input",
    threadKey: "thread",
    senderExternalId: "human",
    cardOwnerDeliveryId: deliveryId,
    sandboxId: null,
    environmentGeneration: null,
    resourceUid: null,
    state: "failed",
    errorCode: "provider_failed",
    effects: "may_have_occurred",
    reportHash: "a".repeat(64),
    desiredReaction: "warning",
    appliedReaction: "working",
    revision: 3,
    appliedRevision: 2,
    cardRevision: 0,
    messageFormat: "text_v1",
    cardState: "pending",
    cardMessageId: null,
    providerRequestId: randomUUID(),
    sendStartedAt: now,
    reconciliationCursor: null,
    claimId: randomUUID(),
    claimExpiresAt: new Date(now.getTime() + 90_000),
    nextAttemptAt: now,
    attemptCount: 0,
    lastErrorCode: null,
    actionsExpireAt: new Date(now.getTime() + 86_400_000),
    settledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
function harness(policy = new ExternalCallPolicy({ allowedHosts: [] })) {
  const slack = vi.fn(async () => ({
    generation: 2,
    botAccessToken: "unit-token",
    botUserId: "bot",
    installationId: "11111111-1111-4111-8111-111111111111",
  }));
  const feishu = vi.fn(async () => ({
    generation: 2,
    appId: "app",
    appSecret: "unit-secret",
    botOpenId: "bot",
    teamBrand: "feishu",
  }));
  const bindings = {
    getSlackConnectionMaterial: slack,
    getFeishuConnectionMaterial: feishu,
  } as unknown as ImBindingService;
  const cooldown = {
    slackCooldownRemaining: vi.fn(async () => 0 as number | undefined),
    deferSlackInstallation: vi.fn(async () => true),
    messageContext: vi.fn(async (): Promise<FeedbackMessageContext> => ({ language: "en", direct: false })),
  };
  return {
    messenger: new ImFeedbackMessenger(bindings, policy, "https://app.example.test", cooldown),
    policy,
    slack,
    feishu,
    cooldown,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of [
    mocks.slack.reactions.add,
    mocks.slack.reactions.remove,
    mocks.slack.chat.postMessage,
    mocks.slack.chat.update,
    mocks.slack.conversations.replies,
    mocks.slack.conversations.history,
    mocks.slack.conversations.open,
    mocks.slack.conversations.info,
    mocks.feishu.im.v1.chat.get,
    mocks.feishu.im.v1.messageReaction.list,
    mocks.feishu.im.v1.messageReaction.create,
    mocks.feishu.im.v1.messageReaction.delete,
    mocks.feishu.im.v1.message.create,
    mocks.feishu.im.v1.message.reply,
    mocks.feishu.im.v1.message.patch,
    mocks.feishu.im.v1.message.update,
    mocks.feishu.im.v1.message.list,
  ])
    mock.mockReset();
  // Unless a test opens it, the sender's Slack direct message is refused, so a card stays in the conversation.
  mocks.slack.conversations.open.mockRejectedValue({ data: { error: "cannot_dm_bot" } });
  mocks.slack.reactions.add.mockResolvedValue({ ok: true });
  mocks.slack.reactions.remove.mockResolvedValue({ ok: true });
  mocks.feishu.im.v1.messageReaction.list.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  mocks.feishu.im.v1.messageReaction.create.mockResolvedValue({ code: 0 });
  mocks.feishu.im.v1.messageReaction.delete.mockResolvedValue({ code: 0 });
});
afterEach(() => vi.useRealTimers());
describe("native feedback transport", () => {
  it("sends the offline notice as a red card outside the failure message identity", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValueOnce({ language: "zh", direct: false });
    const t = target("feishu");
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "n", chat_id: t.channelId } });
    await messenger.postOfflineNotice(t);
    const data = mocks.feishu.im.v1.message.reply.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("uuid");
    expect(data.msg_type).toBe("interactive");
    const card = JSON.parse(data.content);
    expect(card.header).toEqual({ title: { tag: "plain_text", content: "Agent 所在电脑离线" }, template: "red" });
    expect(card.config).toMatchObject({ update_multi: true });
    expect(card.elements).toEqual([
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "电脑恢复后会自动处理",
        },
      },
      { tag: "note", elements: [{ tag: "lark_md", content: `Session：${t.sessionId}` }] },
    ]);
  });
  it("sends the Slack offline notice as an attachment card in the input's thread", async () => {
    const { messenger } = harness();
    const t = target("slack");
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: t.channelId, ts: "n" });
    await messenger.postOfflineNotice(t);
    const sent = mocks.slack.chat.postMessage.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ channel: t.channelId, thread_ts: t.threadKey });
    expect(sent).not.toHaveProperty("text");
    expect(sent.attachments).toEqual([
      {
        color: "#E01E5A",
        fallback: "The Agent's computer is offline: Messages will be handled after the computer reconnects",
        blocks: [
          {
            type: "header",
            block_id: `opentag_notice:${t.id}`,
            text: { type: "plain_text", text: "The Agent's computer is offline", emoji: true },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Messages will be handled after the computer reconnects.",
            },
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `Session: ${t.sessionId}` }],
          },
        ],
      },
    ]);
  });
  it("sends the parked-dispatch notice as a red card placed like the offline notice", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValueOnce({ language: "zh", direct: true });
    const t: FeedbackTarget = { ...target("feishu"), threadKey: null };
    mocks.feishu.im.v1.message.create.mockResolvedValue({ code: 0, data: { message_id: "n", chat_id: t.channelId } });
    await messenger.postOfflineNotice(t, "parked");
    const data = mocks.feishu.im.v1.message.create.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("uuid");
    const card = JSON.parse(data.content);
    expect(card.header).toEqual({ title: { tag: "plain_text", content: "排队中" }, template: "red" });
    expect(card.elements[0].text.content).toBe("前一条完成后处理");
    expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
    const slack = target("slack");
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: slack.channelId, ts: "n" });
    await messenger.postOfflineNotice(slack, "parked");
    const sent = mocks.slack.chat.postMessage.mock.calls[0]?.[0];
    expect(sent.attachments[0]).toMatchObject({
      color: "#E01E5A",
      fallback: "Queued: Handled after the earlier message finishes",
    });
    expect(sent.attachments[0].blocks[1].text.text).toBe("Handled after the earlier message finishes.");
  });
  it("does not submit a send whose language cannot be read, and keeps it retryable", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockRejectedValueOnce(new Error("storage"));
    await expect(messenger.post(target("feishu"))).rejects.toMatchObject({
      code: "IM_FEEDBACK_LANGUAGE_UNAVAILABLE",
      knownNotApplied: true,
    });
    expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
  });
  it("sends a red Feishu card in the language of the input without an error code", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValueOnce({ language: "zh", direct: false });
    const t: FeedbackTarget = { ...target("feishu"), errorCode: "provider_authentication_failed" };
    mocks.feishu.im.v1.message.reply.mockResolvedValue({
      code: 0,
      data: { message_id: "card-message", chat_id: t.channelId },
    });
    expect(await messenger.post(t)).toBe("card-message");
    const data = mocks.feishu.im.v1.message.reply.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ msg_type: "interactive", uuid: t.providerRequestId });
    const card = JSON.parse(data.content);
    expect(card.header).toEqual({ title: { tag: "plain_text", content: "模型未登录或登录已失效" }, template: "red" });
    expect(card.elements[0].text.content).toBe(
      `请在 Agent 所在电脑登录模型账号[\u200b](https://app.example.test/im-feedback/${t.id})`,
    );
    expect(data.content).not.toContain("provider_authentication_failed");
  });
  it("names the lost IM connection by provider, and the missing model sign-in", () => {
    const card = (provider: "slack" | "feishu", errorCode: string) =>
      feedbackCard({ ...target(provider), errorCode }, undefined, "zh");
    expect(card("feishu", "im_connection_unavailable")).toMatchObject({
      title: "飞书连接已失效",
      body: "请在 OpenTag 重新连接",
    });
    expect(card("slack", "im_connection_unavailable")).toMatchObject({
      title: "Slack 连接已失效",
      body: "请在 OpenTag 重新连接",
    });
    // A Computer with no signed-in model account gets the sign-in card.
    expect(card("slack", "model_login_missing")).toMatchObject({
      title: "模型未登录或登录已失效",
      body: "请在 Agent 所在电脑登录模型账号",
    });
    expect(card("feishu", "tool_setup_failed")).toMatchObject({
      title: "Agent 运行出错",
      body: "飞书命令行没能准备好，请重试",
    });
    expect(card("slack", "tool_setup_failed")).toMatchObject({
      title: "Agent 运行出错",
      body: "Slack 命令行没能准备好，请重试",
    });
    // A Computer too old to name the cause, or a missing Cloud grant.
    expect(card("feishu", "credential_unavailable")).toMatchObject({ title: "Agent 运行出错", body: "请重试" });
  });
  it("names the Agent's tool and model on the cards that say what to fix", () => {
    const card = (errorCode: string, runtime: FeedbackRuntime, language: "zh" | "en" = "zh") => {
      const c = feedbackCard({ ...target("feishu"), errorCode }, undefined, language, runtime);
      return `${c.title} / ${c.body}`;
    };
    const claude: FeedbackRuntime = { tool: "claude-code", model: "claude-sonnet-5-5" };
    expect(card("provider_authentication_failed", claude)).toBe(
      "Claude Code 未登录或登录已失效 / 请在 Agent 所在电脑登录 Claude Code",
    );
    expect(card("provider_access_denied", claude)).toBe("没有 claude-sonnet-5-5 的使用权限 / 请在 OpenTag 更换模型");
    // A Computer with no signed-in model account gets the same sign-in card, naming its tool.
    expect(card("model_login_missing", { tool: "codex", model: null })).toBe(
      "Codex 未登录或登录已失效 / 请在 Agent 所在电脑登录 Codex",
    );
    expect(card("provider_process_exited", { tool: "codex", model: null })).toBe(
      "Agent 运行出错 / Codex 意外退出，请重试",
    );
    expect(card("provider_start_failed", { tool: "pi", model: null })).toBe(
      "Agent 运行出错 / Pi 没能启动，请检查 Agent 所在电脑上的 Pi 是否已安装",
    );
    expect(card("provider_protocol_error", { tool: "cloud", model: null })).toBe(
      "Agent 运行出错 / 云端模型返回了无法识别的结果，请重试",
    );
    expect(card("provider_process_exited", claude, "en")).toBe(
      "The Agent ran into an error / Claude Code exited unexpectedly. Try again",
    );
    // Without a model, or for sign-in and start-up on the Cloud Computer, the generic card stays.
    expect(card("provider_access_denied", { tool: "codex", model: null })).toBe(
      "没有该模型的使用权限 / 请在 OpenTag 更换模型",
    );
    expect(card("provider_authentication_failed", { tool: "cloud", model: "gpt-5" })).toBe(
      "模型未登录或登录已失效 / 请在 Agent 所在电脑登录模型账号",
    );
    expect(card("provider_start_failed", { tool: "cloud", model: null })).toBe("Agent 运行出错 / 请重试");
  });
  it("gives a Feishu failure card a zero-width identity link for readback", async () => {
    const { messenger } = harness();
    const t: FeedbackTarget = { ...target("feishu"), errorCode: "provider_unavailable" };
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "m", chat_id: t.channelId } });
    await messenger.post(t);
    const card = JSON.parse(mocks.feishu.im.v1.message.reply.mock.calls[0]?.[0].data.content);
    expect(card.elements[0].text.content).toBe(
      `Try again later.[\u200b](https://app.example.test/im-feedback/${t.id})`,
    );
  });
  it.each([
    ["direct message", true, null],
    ["group", false, null],
    ["thread", false, "thread"],
    ["direct-message thread", true, "thread"],
  ] as const)("places a card in a %s where the conversation expects it", async (_, direct, threadKey) => {
    for (const provider of ["slack", "feishu"] as const) {
      const { messenger, cooldown } = harness();
      cooldown.messageContext.mockResolvedValue({ language: "en", direct });
      const t: FeedbackTarget = { ...target(provider), threadKey };
      mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: t.channelId, ts: "m" });
      mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "m", chat_id: t.channelId } });
      mocks.feishu.im.v1.message.create.mockResolvedValue({ code: 0, data: { message_id: "m", chat_id: t.channelId } });
      await messenger.post(t);
      if (provider === "slack") {
        const sent = mocks.slack.chat.postMessage.mock.calls.at(-1)?.[0];
        if (threadKey) expect(sent.thread_ts).toBe(threadKey);
        else expect(sent).not.toHaveProperty("thread_ts");
      } else if (direct && !threadKey) {
        expect(mocks.feishu.im.v1.message.create).toHaveBeenLastCalledWith({
          params: { receive_id_type: "chat_id" },
          data: expect.objectContaining({ receive_id: t.channelId, uuid: t.providerRequestId }),
        });
        expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
      } else {
        expect(mocks.feishu.im.v1.message.reply).toHaveBeenLastCalledWith(
          expect.objectContaining({ path: { message_id: t.inputExternalId } }),
        );
        expect(mocks.feishu.im.v1.message.create).not.toHaveBeenCalled();
      }
      mocks.feishu.im.v1.message.reply.mockReset();
      mocks.feishu.im.v1.message.create.mockReset();
    }
  });
  it.each(["slack", "feishu"] as const)(
    "keeps %s cards retryable after capacity rejection or a queue deadline",
    async (provider) => {
      vi.useFakeTimers();
      for (const mode of ["overflow", "deadline"] as const) {
        const policy = new ExternalCallPolicy({ maxConcurrency: 1, maxQueueDepth: mode === "overflow" ? 0 : 1 });
        const busy = deferred();
        const entered = deferred();
        const occupying = policy.run(
          "busy",
          async () => {
            entered.resolve();
            await busy.promise;
          },
          { timeoutMs: 60_000 },
        );
        await entered.promise;
        try {
          const h = harness(policy);
          const result = h.messenger.post(target(provider)).then(
            () => undefined,
            (error: unknown) => error,
          );
          await vi.advanceTimersByTimeAsync(mode === "overflow" ? 0 : 8_000);
          expect(await result).toMatchObject({
            code: mode === "overflow" ? "IM_PROVIDER_OVERLOADED" : "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
            knownNotApplied: true,
          });
          expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
          expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
        } finally {
          busy.resolve();
          await occupying;
        }
      }
    },
  );
  it.each(["slack", "feishu"] as const)(
    "edits and finds a plain-text %s message from before cards as text",
    async (provider) => {
      const t: FeedbackTarget = { ...target(provider), messageFormat: "text_v1" };
      const { messenger } = harness();
      const details = `https://app.example.test/im-feedback/${t.id}`;
      mocks.slack.chat.update.mockResolvedValue({ ok: true });
      mocks.feishu.im.v1.message.update.mockResolvedValue({ code: 0 });
      await messenger.update({ ...t, cardMessageId: "text-message" });
      if (provider === "slack") {
        expect(mocks.slack.chat.update).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining(details) }),
        );
        expect(mocks.slack.chat.update.mock.calls[0]?.[0]).not.toHaveProperty("attachments");
        mocks.slack.conversations.replies.mockResolvedValue({
          ok: true,
          messages: [
            { user: "human", ts: "other", text: details },
            { user: "bot", ts: "text-message", text: details },
          ],
        });
      } else {
        expect(mocks.feishu.im.v1.message.update).toHaveBeenCalledWith(
          expect.objectContaining({
            path: { message_id: "text-message" },
            data: expect.objectContaining({ msg_type: "text" }),
          }),
        );
        expect(mocks.feishu.im.v1.message.patch).not.toHaveBeenCalled();
        mocks.feishu.im.v1.message.list.mockResolvedValue({
          code: 0,
          data: {
            items: [
              {
                sender: { sender_type: "app", id: "app" },
                message_id: "text-message",
                body: { content: JSON.stringify({ text: details }) },
              },
            ],
          },
        });
      }
      expect(await messenger.find(t)).toEqual({ ids: ["text-message"] });
    },
  );
  it("reconciles designated Slack reactions idempotently with SDK retries disabled", async () => {
    const { messenger } = harness();
    const t = target();
    mocks.slack.reactions.remove.mockRejectedValueOnce({ data: { error: "no_reaction" } });
    mocks.slack.reactions.add.mockRejectedValueOnce({ data: { error: "already_reacted" } });
    await messenger.reaction(t, "warning");
    expect(mocks.slack.reactions.remove).toHaveBeenCalledWith({ channel: "channel", timestamp: "input", name: "eyes" });
    expect(mocks.slack.reactions.add).toHaveBeenCalledWith({ channel: "channel", timestamp: "input", name: "warning" });
    expect(mocks.slackOptions.mock.calls[0]?.[1]).toMatchObject({
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
  });
  it("removes only this Feishu application's working reaction and uses a supported failure emoji", async () => {
    const api = mocks.feishu.im.v1.messageReaction;
    api.list.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "mine",
            operator: { operator_type: "app", operator_id: "app" },
            reaction_type: { emoji_type: "OnIt" },
          },
          {
            reaction_id: "human",
            operator: { operator_type: "user", operator_id: "app" },
            reaction_type: { emoji_type: "OnIt" },
          },
          {
            reaction_id: "other",
            operator: { operator_type: "app", operator_id: "other" },
            reaction_type: { emoji_type: "OnIt" },
          },
        ],
        has_more: false,
      },
    });
    await harness().messenger.reaction(target("feishu"), "warning");
    expect(api.delete).toHaveBeenCalledExactlyOnceWith({ path: { message_id: "input", reaction_id: "mine" } });
    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      path: { message_id: "input" },
      data: { reaction_type: { emoji_type: "CrossMark" } },
    });
  });
  it("refuses incomplete or looping Feishu reaction pagination", async () => {
    mocks.feishu.im.v1.messageReaction.list.mockResolvedValue({
      code: 0,
      data: { items: [], has_more: true, page_token: "" },
    });
    await expect(harness().messenger.reaction(target("feishu"), "none")).rejects.toThrow("PAGINATION_INVALID");
    expect(mocks.feishu.im.v1.messageReaction.delete).not.toHaveBeenCalled();
  });
  it.each(["slack", "feishu"] as const)("posts one %s card in the original conversation", async (provider) => {
    const t = target(provider);
    const { messenger } = harness();
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: t.channelId, ts: "card" });
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "card", chat_id: t.channelId } });
    expect(await messenger.post(t)).toBe("card");
    if (provider === "slack")
      expect(mocks.slack.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: t.channelId, thread_ts: t.threadKey }),
      );
    else
      expect(mocks.feishu.im.v1.message.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { message_id: t.inputExternalId },
          data: expect.objectContaining({ uuid: t.providerRequestId, msg_type: "interactive" }),
        }),
      );
  });
  it.each(["slack", "feishu"] as const)("keeps malformed or lost %s send responses unknown", async (provider) => {
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, ts: "card", channel: "wrong" });
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: {} });
    const { messenger } = harness();
    await expect(messenger.post(target(provider))).rejects.toMatchObject({ knownNotApplied: false });
  });
  it("honors a definite Slack rejection and Retry-After without retrying inside the SDK", async () => {
    mocks.slack.chat.postMessage.mockRejectedValue(new WebAPIRateLimitedError(42));
    const { messenger } = harness();
    await expect(messenger.post(target())).rejects.toMatchObject({ knownNotApplied: true, retryAfterMs: 42_000 });
    expect(mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
    mocks.slack.chat.postMessage.mockRejectedValue({ data: { error: "internal_error" } });
    await expect(messenger.post(target())).rejects.toMatchObject({ knownNotApplied: false });
  });
  it.each(["reaction", "update", "find"] as const)("propagates SDK Retry-After for %s", async (operation) => {
    const t = { ...target(), cardMessageId: "existing" };
    const h = harness();
    const mocksByOperation = {
      reaction: mocks.slack.reactions.remove,
      update: mocks.slack.chat.update,
      find: mocks.slack.conversations.replies,
    };
    mocksByOperation[operation].mockRejectedValue(new WebAPIRateLimitedError(37));
    const calls = {
      reaction: () => h.messenger.reaction(t, "warning"),
      update: () => h.messenger.update(t),
      find: () => h.messenger.find(t),
    };
    await expect(calls[operation]()).rejects.toMatchObject({ knownNotApplied: true, retryAfterMs: 37_000 });
  });
  it("treats an open local circuit as definitely not submitted", async () => {
    const h = harness();
    vi.spyOn(h.policy, "run").mockRejectedValue(
      new ExternalCallPolicyError("IM_PROVIDER_CIRCUIT_OPEN", "open", { phase: "circuit" }),
    );
    await expect(h.messenger.post(target())).rejects.toMatchObject({ knownNotApplied: true, retryAfterMs: 30_000 });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("retains an in-flight deadline as unknown rather than retrying a possibly applied post", async () => {
    vi.useFakeTimers();
    const h = harness();
    const sent = deferred<{ ok: boolean; channel: string; ts: string }>();
    mocks.slack.chat.postMessage.mockImplementation(() => sent.promise);
    const result = h.messenger.post(target()).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await result).toMatchObject({ code: "IM_FEEDBACK_SEND_UNKNOWN", knownNotApplied: false });
    } finally {
      sent.resolve({ ok: true, channel: "channel", ts: "late" });
      await vi.runAllTimersAsync();
    }
  });
  it("fences revoked credentials before any provider write", async () => {
    const h = harness();
    h.slack.mockResolvedValue({
      generation: 3,
      botAccessToken: "new",
      botUserId: "bot",
      installationId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(h.messenger.post(target())).rejects.toMatchObject({
      code: "IM_FEEDBACK_BINDING_STALE",
      knownNotApplied: true,
    });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("refuses a different Slack installation even if its generation number coincides", async () => {
    const h = harness();
    h.slack.mockResolvedValue({
      generation: 2,
      botAccessToken: "other",
      botUserId: "other",
      installationId: randomUUID(),
    });
    await expect(h.messenger.post(target())).rejects.toMatchObject({
      code: "IM_FEEDBACK_BINDING_STALE",
      knownNotApplied: true,
    });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("matches a legacy Slack card by the exact bot and hidden feedback identity during bounded readback", async () => {
    const t: FeedbackTarget = { ...target(), messageFormat: "interactive_v1" };
    mocks.slack.conversations.replies.mockResolvedValue({
      ok: true,
      messages: [
        { user: "human", ts: "foreign", blocks: [{ block_id: `opentag_feedback:${t.id}` }] },
        { user: "bot", ts: "wrong", blocks: [{ block_id: "opentag_feedback:other" }] },
        { user: "bot", ts: "match", blocks: [{ block_id: `opentag_feedback:${t.id}` }] },
      ],
      response_metadata: { next_cursor: "next" },
    });
    expect(await harness().messenger.find(t, "previous")).toEqual({ ids: ["match"], cursor: "next" });
    expect(mocks.slack.conversations.replies).toHaveBeenCalledWith({
      channel: t.channelId,
      ts: t.threadKey,
      limit: 100,
      cursor: "previous",
    });
  });
  it("matches only its Feishu app sender and stable feedback link", async () => {
    const t = target("feishu");
    const content = `/im-feedback/${t.id}`;
    mocks.feishu.im.v1.message.list.mockResolvedValue({
      code: 0,
      data: {
        items: [
          { message_id: "foreign", sender: { sender_type: "user", id: "app" }, body: { content } },
          { message_id: "match", sender: { sender_type: "app", id: "app" }, body: { content } },
        ],
        has_more: true,
        page_token: "next",
      },
    });
    expect(await harness().messenger.find(t)).toEqual({ ids: ["match"], cursor: "next" });
    expect(mocks.feishu.im.v1.message.list).toHaveBeenCalledWith({
      params: { container_id_type: "thread", container_id: t.threadKey, page_size: 50, sort_type: "ByCreateTimeAsc" },
    });
  });
  it.each(["slack", "feishu"] as const)(
    "updates the bound %s message rather than creating another one",
    async (provider) => {
      const t = { ...target(provider), cardMessageId: "existing" };
      mocks.slack.chat.update.mockResolvedValue({ ok: true });
      mocks.feishu.im.v1.message.update.mockResolvedValue({ code: 0 });
      await harness().messenger.update(t);
      expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
      expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
      if (provider === "slack")
        expect(mocks.slack.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: "existing" }));
      else
        expect(mocks.feishu.im.v1.message.update).toHaveBeenCalledWith(
          expect.objectContaining({ path: { message_id: "existing" } }),
        );
    },
  );
  it.each(["slack", "feishu"] as const)(
    "updates a %s card in place, including one from before plain text",
    async (provider) => {
      const h = await harness();
      const t: FeedbackTarget = {
        ...target(provider),
        messageFormat: "interactive_v1",
        cardMessageId: "existing",
        state: "completed",
      };
      mocks.slack.chat.update.mockResolvedValue({ ok: true });
      mocks.feishu.im.v1.message.patch.mockResolvedValue({ code: 0 });
      await h.messenger.update(t);
      expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
      expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
      expect(mocks.feishu.im.v1.message.update).not.toHaveBeenCalled();
      if (provider === "slack") {
        const sent = mocks.slack.chat.update.mock.calls[0]?.[0];
        expect(sent).toMatchObject({ ts: "existing", text: "", blocks: [] });
        expect(sent.attachments[0]).toMatchObject({ color: "#2EB67D", fallback: "Done" });
      } else {
        const patch = mocks.feishu.im.v1.message.patch.mock.calls[0]?.[0];
        expect(patch.path).toEqual({ message_id: "existing" });
        expect(JSON.parse(patch.data.content).header).toEqual({
          title: { tag: "plain_text", content: "Done" },
          template: "green",
        });
      }
    },
  );
  it("finds a Slack card in the input's replies (pre-text location), then in the channel history", async () => {
    const t: FeedbackTarget = { ...target(), messageFormat: "interactive_v1", threadKey: null };
    const identity = { block_id: `opentag_feedback:${t.id}` };
    const notice = { block_id: `opentag_notice:${t.id}` };
    mocks.slack.conversations.replies.mockResolvedValueOnce({
      ok: true,
      messages: [{ user: "bot", ts: "legacy", blocks: [identity] }],
      response_metadata: { next_cursor: "r2" },
    });
    const { messenger } = harness();
    expect(await messenger.find(t)).toEqual({ ids: ["legacy"], cursor: "replies:r2" });
    expect(mocks.slack.conversations.replies).toHaveBeenLastCalledWith({
      channel: t.channelId,
      ts: t.inputExternalId,
      limit: 100,
    });
    mocks.slack.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [] });
    expect(await messenger.find(t, "replies:r2")).toEqual({ ids: [], cursor: "history:" });
    expect(mocks.slack.conversations.replies).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "r2" }));
    mocks.slack.conversations.history.mockResolvedValueOnce({
      ok: true,
      messages: [
        { user: "human", ts: "foreign", attachments: [{ blocks: [identity] }] },
        { user: "bot", ts: "other", attachments: [{ blocks: [{ block_id: "opentag_feedback:other" }] }] },
        { user: "bot", ts: "notice", attachments: [{ blocks: [notice] }] },
        { user: "bot", ts: "match", attachments: [{ blocks: [identity] }] },
      ],
      response_metadata: { next_cursor: "h2" },
    });
    expect(await messenger.find(t, "history:")).toEqual({ ids: ["match"], cursor: "history:h2" });
    expect(mocks.slack.conversations.history).toHaveBeenLastCalledWith({
      channel: t.channelId,
      oldest: String(Math.floor((t.sendStartedAt ?? t.createdAt).getTime() / 1000) - 60),
      limit: 100,
    });
    mocks.slack.conversations.history.mockResolvedValueOnce({ ok: true, messages: [] });
    expect(await messenger.find(t, "history:h2")).toEqual({ ids: [] });
    expect(mocks.slack.conversations.history).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "h2" }));
  });
  it.each(["offline", "parked"] as const)(
    "never reads back an earlier %s notice as the failure message",
    async (reason) => {
      for (const provider of ["slack", "feishu"] as const) {
        const { messenger } = harness();
        const t: FeedbackTarget = { ...target(provider), messageFormat: "interactive_v1" };
        mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: t.channelId, ts: "notice" });
        mocks.feishu.im.v1.message.reply.mockResolvedValue({
          code: 0,
          data: { message_id: "notice", chat_id: t.channelId },
        });
        await messenger.postOfflineNotice(t, reason);
        const sentNotice =
          provider === "slack"
            ? mocks.slack.chat.postMessage.mock.calls.at(-1)?.[0]
            : JSON.parse(mocks.feishu.im.v1.message.reply.mock.calls.at(-1)?.[0].data.content);
        // What the provider returns on read: Slack keeps the blocks, Feishu degrades the card to text and links.
        expect(JSON.stringify(sentNotice)).not.toContain("/im-feedback/");
        if (provider === "slack")
          mocks.slack.conversations.replies.mockResolvedValueOnce({
            ok: true,
            messages: [
              { user: "bot", ts: "notice", attachments: sentNotice.attachments },
              { user: "bot", ts: "failure", attachments: [{ blocks: [{ block_id: `opentag_feedback:${t.id}` }] }] },
            ],
          });
        else
          mocks.feishu.im.v1.message.list.mockResolvedValueOnce({
            code: 0,
            data: {
              items: [
                {
                  message_id: "notice",
                  sender: { sender_type: "app", id: "app" },
                  body: {
                    content: JSON.stringify({
                      elements: [[{ tag: "text", text: sentNotice.elements[0].text.content }]],
                    }),
                  },
                },
                {
                  message_id: "failure",
                  sender: { sender_type: "app", id: "app" },
                  body: {
                    content: JSON.stringify({
                      elements: [[{ tag: "a", href: `https://app.example.test/im-feedback/${t.id}` }]],
                    }),
                  },
                },
              ],
            },
          });
        expect((await messenger.find(t)).ids).toEqual(["failure"]);
      }
    },
  );
});

it("does not count Slack 429 responses toward the shared outage circuit", async () => {
  const { messenger } = harness();
  for (let i = 0; i < 4; i++) {
    mocks.slack.chat.postMessage.mockRejectedValueOnce(new WebAPIRateLimitedError(2));
    await expect(messenger.post(target())).rejects.toMatchObject({
      code: "IM_FEEDBACK_RATE_LIMITED",
      retryAfterMs: 2000,
    });
  }
  mocks.slack.chat.postMessage.mockResolvedValueOnce({ ok: true, ts: "other-installation-card", channel: "channel" });
  expect(await messenger.post(target())).toBe("other-installation-card");
  expect(mocks.slack.chat.postMessage).toHaveBeenCalledTimes(5);
});

describe("shared Slack cooldown transport", () => {
  it.each(["post", "update", "find", "reaction"] as const)(
    "defers %s before provider I/O without opening the outage circuit",
    async (operation) => {
      const h = harness();
      const t = { ...target(), cardMessageId: "existing" };
      h.cooldown.slackCooldownRemaining.mockResolvedValue(45_000);
      for (let i = 0; i < 4; i++)
        await expect(
          operation === "reaction" ? h.messenger.reaction(t, "warning") : h.messenger[operation](t),
        ).rejects.toMatchObject({ knownNotApplied: true, retryAfterMs: 45_000 });
      expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
      expect(mocks.slack.chat.update).not.toHaveBeenCalled();
      expect(mocks.slack.conversations.replies).not.toHaveBeenCalled();
      expect(mocks.slack.reactions.add).not.toHaveBeenCalled();
      expect(mocks.slack.reactions.remove).not.toHaveBeenCalled();
      expect(h.cooldown.deferSlackInstallation).not.toHaveBeenCalled();
      h.cooldown.slackCooldownRemaining.mockResolvedValue(0);
      mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: t.channelId, ts: "ready" });
      expect(await h.messenger.post(t)).toBe("ready");
    },
  );
  it("checks the deadline separately before each reaction method", async () => {
    const h = harness();
    h.cooldown.slackCooldownRemaining.mockResolvedValueOnce(0).mockResolvedValueOnce(30_000);
    await expect(h.messenger.reaction(target(), "warning")).rejects.toMatchObject({ retryAfterMs: 30_000 });
    expect(mocks.slack.reactions.remove).toHaveBeenCalledOnce();
    expect(mocks.slack.reactions.add).not.toHaveBeenCalled();
  });
  it("persists a native SDK 429 before returning it to the worker", async () => {
    const h = harness();
    const t = target();
    mocks.slack.chat.postMessage.mockRejectedValueOnce(new WebAPIRateLimitedError(42));
    await expect(h.messenger.post(t)).rejects.toMatchObject({ retryAfterMs: 42_000 });
    expect(h.cooldown.deferSlackInstallation).toHaveBeenCalledExactlyOnceWith(t, 42_000);
  });
  it("classifies a failed cooldown write after a confirmed rejection as definitely not sent", async () => {
    const h = harness();
    h.cooldown.deferSlackInstallation.mockRejectedValueOnce(new Error("database unavailable"));
    mocks.slack.chat.postMessage.mockRejectedValueOnce(new WebAPIRateLimitedError(7));
    await expect(h.messenger.post(target())).rejects.toBeInstanceOf(FeedbackCooldownStorageError);
    expect(mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
  });
  it("does not call Slack on storage failure, or count that failure toward the provider circuit", async () => {
    const h = harness();
    h.cooldown.slackCooldownRemaining.mockRejectedValue(new Error("database unavailable"));
    for (let i = 0; i < 4; i++)
      await expect(h.messenger.post(target())).rejects.toMatchObject({
        code: "IM_FEEDBACK_COOLDOWN_UNAVAILABLE",
        knownNotApplied: true,
      });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    h.cooldown.slackCooldownRemaining.mockResolvedValue(0);
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: "channel", ts: "ready" });
    expect(await h.messenger.post(target())).toBe("ready");
  });
  it("blocks a rotated installation and ignores its late rate-limit result", async () => {
    const h = harness();
    h.cooldown.deferSlackInstallation.mockResolvedValueOnce(false);
    mocks.slack.chat.postMessage.mockRejectedValueOnce(new WebAPIRateLimitedError(7));
    await expect(h.messenger.post(target())).rejects.toMatchObject({
      code: "IM_FEEDBACK_BINDING_STALE",
      knownNotApplied: true,
    });
    h.cooldown.slackCooldownRemaining.mockResolvedValueOnce(undefined);
    await expect(h.messenger.post(target())).rejects.toMatchObject({ code: "IM_FEEDBACK_BINDING_STALE" });
    expect(mocks.slack.chat.postMessage).toHaveBeenCalledOnce();
  });
  it("does not consult the Slack cooldown for Feishu", async () => {
    const h = harness();
    h.cooldown.slackCooldownRemaining.mockRejectedValue(new Error("not a Slack installation"));
    const t = target("feishu");
    mocks.feishu.im.v1.message.reply.mockResolvedValue({
      code: 0,
      data: { message_id: "feishu-card", chat_id: t.channelId },
    });
    expect(await h.messenger.post(t)).toBe("feishu-card");
    expect(h.cooldown.slackCooldownRemaining).not.toHaveBeenCalled();
    expect(h.cooldown.deferSlackInstallation).not.toHaveBeenCalled();
  });
});

describe("postConversationText", () => {
  const scope = {
    bindingGeneration: 2,
    bindingId: randomUUID(),
    channelId: "channel",
    installationId: "11111111-1111-4111-8111-111111111111",
    threadKey: null,
  };

  it("posts unparsed Slack text to the channel, or to the Session's thread", async () => {
    const h = harness();
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, ts: "1.2", channel: "channel" });
    await expect(h.messenger.postConversationText({ ...scope, provider: "slack" }, "failed", "req")).resolves.toBe(
      "1.2",
    );
    expect(mocks.slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "channel",
      text: "failed",
      parse: "none",
      unfurl_links: false,
      unfurl_media: false,
    });
    await h.messenger.postConversationText({ ...scope, provider: "slack", threadKey: "9.9" }, "failed", "req");
    expect(mocks.slack.chat.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ thread_ts: "9.9" }));
    expect(h.cooldown.slackCooldownRemaining).toHaveBeenCalled();
  });

  it("creates a Feishu chat message, or replies in the thread, under the request id", async () => {
    const h = harness();
    const ok = { code: 0, data: { message_id: "om_1", chat_id: "channel" } };
    mocks.feishu.im.v1.message.create.mockResolvedValue(ok);
    mocks.feishu.im.v1.message.reply.mockResolvedValue(ok);
    const text = JSON.stringify({ text: "failed" });

    await h.messenger.postConversationText({ ...scope, provider: "feishu", installationId: null }, "failed", "req");
    expect(mocks.feishu.im.v1.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: { msg_type: "text", content: text, uuid: "req", receive_id: "channel" },
    });

    await h.messenger.postConversationText(
      { ...scope, provider: "feishu", installationId: null, threadKey: "omt", replyToExternalId: "om_anchor" },
      "failed",
      "req",
    );
    expect(mocks.feishu.im.v1.message.reply).toHaveBeenCalledWith({
      path: { message_id: "om_anchor" },
      data: { msg_type: "text", content: text, uuid: "req", reply_in_thread: true },
    });
  });

  it("rewrites a plain message it sent, on Slack and Feishu", async () => {
    const h = harness();
    mocks.slack.chat.update.mockResolvedValue({ ok: true });
    await h.messenger.updateConversationText({ ...scope, provider: "slack" }, "1.2", "later");
    expect(mocks.slack.chat.update).toHaveBeenLastCalledWith({ channel: "channel", ts: "1.2", text: "later" });
    mocks.feishu.im.v1.message.update.mockResolvedValue({ code: 0 });
    await h.messenger.updateConversationText({ ...scope, provider: "feishu", installationId: null }, "om_1", "later");
    expect(mocks.feishu.im.v1.message.update).toHaveBeenLastCalledWith({
      path: { message_id: "om_1" },
      data: { msg_type: "text", content: JSON.stringify({ text: "later" }) },
    });
    mocks.slack.chat.update.mockResolvedValue({ ok: false });
    await expect(
      h.messenger.updateConversationText({ ...scope, provider: "slack" }, "1.2", "later"),
    ).rejects.toMatchObject({ code: "IM_FEEDBACK_UPDATE_FAILED" });
    mocks.feishu.im.v1.message.update.mockResolvedValue({ code: 500 });
    await expect(
      h.messenger.updateConversationText({ ...scope, provider: "feishu", installationId: null }, "om_1", "later"),
    ).rejects.toMatchObject({ code: "IM_FEEDBACK_UPDATE_FAILED" });
  });

  it("classifies a send that returned no message as unknown", async () => {
    const h = harness();
    mocks.feishu.im.v1.message.create.mockResolvedValue({ code: 500 });
    await expect(
      h.messenger.postConversationText({ ...scope, provider: "feishu", installationId: null }, "failed", "req"),
    ).rejects.toMatchObject({ code: "IM_FEEDBACK_SEND_UNKNOWN", knownNotApplied: false });
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: false });
    await expect(
      h.messenger.postConversationText({ ...scope, provider: "slack" }, "failed", "req"),
    ).rejects.toMatchObject({ code: "IM_FEEDBACK_SEND_UNKNOWN" });
  });
});

it("keeps link and mention syntax in an actor's display name inert, leaving only the details link", () => {
  const actorDisplayName =
    'x [click](http://evil.example) <http://evil.example|View details> <at user_id="all">y</at> <!channel>';
  const action = {
    kind: "save_release",
    state: "succeeded",
    resultCode: "saved_released",
    actorDisplayName,
    updatedAt: new Date("2026-11-09T00:00:00.000Z"),
  } as FeedbackAction;
  const feishu = renderFeedbackText({ ...target("feishu"), state: "workspace_blocked" }, "https://app.test", action);
  const slack = renderFeedbackText({ ...target("slack"), state: "workspace_blocked" }, "https://app.test", action);
  expect(feishu.match(/\]\(/gu)).toHaveLength(1);
  expect(feishu).toContain("［click］(http://evil.example)");
  expect(feishu).not.toContain("<at");
  expect(slack.match(/</gu)).toHaveLength(1);
  expect(slack).not.toContain("<!channel>");
  expect(slack).toContain("Saved and environment released");
});

it("renders no visible link or button on any card other than its Session ID line", () => {
  const cards = [
    ...[...TurnFailureReasonSchema.options, "input_expired", "input_rejected", null].flatMap((code) =>
      [false, true].map((batchRetryBlocked) =>
        feedbackCard({ ...target(), errorCode: code, batchRetryBlocked }, undefined, "zh"),
      ),
    ),
    feedbackCard({ ...target(), state: "workspace_blocked", errorCode: "workspace_failed" }, undefined, "en"),
    waitingCard("zh", "s"),
    waitingCard("en", "s", "parked"),
  ];
  for (const card of cards) {
    const slack = JSON.stringify(slackCardMessage({ ...card, sessionUrl: "https://app.example.test/t" }, "f", "zh"));
    expect(slack.replaceAll(`<https://app.example.test/t|${card.sessionId}>`, "")).not.toMatch(
      /<https?:|"actions"|"button"/u,
    );
    const feishu = feishuCardContent(card, "https://app.example.test/im-feedback/f", "zh");
    expect(feishu.replaceAll("[​](https://app.example.test/im-feedback/f)", "")).not.toMatch(/\]\(|"button"|"action"/u);
  }
});

it("ends every card, including an edited status card, with the full Session ID", () => {
  const sessionId = "f76fc68f-43a0-4b0d-8493-480680c1888b";
  const failure = feedbackCard({ ...target(), sessionId, errorCode: "provider_quota_exceeded" }, undefined, "zh");
  const done = feedbackCard({ ...target(), sessionId, state: "completed" }, undefined, "en");
  const notice = waitingCard("en", sessionId, "parked");
  const feishu = JSON.parse(feishuCardContent(failure, "https://app.example.test/im-feedback/f", "zh"));
  expect(feishu.elements.at(-1)).toEqual({
    tag: "note",
    elements: [{ tag: "lark_md", content: `Session：${sessionId}` }],
  });
  for (const card of [done, notice]) {
    const slack = slackCardMessage(card, "f", "en");
    expect(slack.attachments[0]?.blocks.at(-1)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Session: ${sessionId}` }],
    });
    // The notification preview stays the title and body only.
    expect(slack.attachments[0]?.fallback).not.toContain(sessionId);
  }
});

it("links the card's Session ID to its Task page only when the context says the page can be opened", async () => {
  const { messenger, cooldown } = harness();
  const t: FeedbackTarget = { ...target("feishu"), errorCode: "provider_rate_limited" };
  cooldown.messageContext.mockResolvedValue({ language: "zh", direct: false, taskAgentId: "agent-1" });
  mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "r", chat_id: t.channelId } });
  await messenger.post(t);
  const linked = JSON.parse(mocks.feishu.im.v1.message.reply.mock.calls[0]?.[0].data.content);
  expect(linked.elements.at(-1).elements[0].content).toBe(
    `Session：[${t.sessionId}](https://app.example.test/agents/agent-1/tasks/${t.sessionId})`,
  );
  cooldown.messageContext.mockResolvedValue({ language: "zh", direct: false });
  await messenger.post({ ...t, id: randomUUID() });
  const plain = JSON.parse(mocks.feishu.im.v1.message.reply.mock.calls[1]?.[0].data.content);
  expect(plain.elements.at(-1).elements[0].content).toBe(`Session：${t.sessionId}`);
});

describe("cards sent to the sender's direct message", () => {
  const quota = (provider: "slack" | "feishu"): FeedbackTarget => ({
    ...target(provider),
    messageFormat: "interactive_v1",
    errorCode: "provider_quota_exceeded",
    senderExternalId: provider === "feishu" ? "ou_sender" : "U_SENDER",
  });
  it("sends a Feishu group's quota card and waiting notices to the sender's open_id", async () => {
    const { messenger } = harness();
    const t = quota("feishu");
    mocks.feishu.im.v1.message.create.mockResolvedValue({ code: 0, data: { message_id: "dm", chat_id: "oc_dm" } });
    expect(await messenger.post(t)).toBe("dm");
    await messenger.postOfflineNotice(t, "parked");
    const [card, notice] = mocks.feishu.im.v1.message.create.mock.calls.map((c) => c[0]);
    expect(card).toMatchObject({
      params: { receive_id_type: "open_id" },
      data: { receive_id: "ou_sender", uuid: t.providerRequestId },
    });
    expect(JSON.parse(card.data.content).header.title.content).toBe("Model quota used up");
    expect(notice.data).not.toHaveProperty("uuid");
    expect(JSON.parse(notice.data.content).header.title.content).toBe("Queued");
    expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
  });
  it("keeps other failures, and every card of a direct message, where they were", async () => {
    const { messenger, cooldown } = harness();
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "r", chat_id: "channel" } });
    mocks.feishu.im.v1.message.create.mockResolvedValue({ code: 0, data: { message_id: "c", chat_id: "channel" } });
    await messenger.post({ ...quota("feishu"), errorCode: "provider_rate_limited" });
    await messenger.post({ ...quota("feishu"), state: "workspace_blocked" });
    cooldown.messageContext.mockResolvedValueOnce({ language: "en", direct: true });
    await messenger.post({ ...quota("feishu"), threadKey: null });
    expect(mocks.feishu.im.v1.message.reply).toHaveBeenCalledTimes(2);
    expect(mocks.feishu.im.v1.message.create.mock.calls[0]?.[0].params).toEqual({ receive_id_type: "chat_id" });
  });
  it("falls back to the conversation when Feishu refuses the message or the sender is a bot", async () => {
    const { messenger } = harness();
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "r", chat_id: "channel" } });
    mocks.feishu.im.v1.message.create.mockResolvedValueOnce({ code: 230013, msg: "not in scope" });
    mocks.feishu.im.v1.message.create.mockRejectedValueOnce(
      Object.assign(new Error("400"), { response: { status: 400, data: { code: 99992361 } } }),
    );
    for (const t of [quota("feishu"), quota("feishu"), { ...quota("feishu"), senderExternalId: "cli_bot" }])
      expect(await messenger.post(t)).toBe("r");
    expect(mocks.feishu.im.v1.message.create).toHaveBeenCalledTimes(2);
    expect(mocks.feishu.im.v1.message.reply).toHaveBeenCalledTimes(3);
  });
  it("never falls back after an unknown direct-message outcome, and reads back there", async () => {
    const { messenger } = harness();
    const t = quota("feishu");
    mocks.feishu.im.v1.message.create.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(messenger.post(t)).rejects.toMatchObject({
      code: "IM_FEEDBACK_SEND_UNKNOWN",
      knownNotApplied: false,
      readbackCursor: SENDER_READBACK,
    });
    expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
    mocks.feishu.im.v1.message.create.mockResolvedValueOnce({ code: 0, data: { message_id: "dm", chat_id: "oc" } });
    expect(await messenger.find(t, SENDER_READBACK)).toEqual({ ids: ["dm"] });
    expect(mocks.feishu.im.v1.message.create.mock.calls[1]?.[0].data.uuid).toBe(t.providerRequestId);
    // Past Feishu's deduplication window a repeat could post twice, so nothing is sent.
    const old = { ...t, sendStartedAt: new Date(Date.now() - 55 * 60_000) };
    expect(await messenger.find(old, SENDER_READBACK)).toEqual({ ids: [] });
    expect(mocks.feishu.im.v1.message.create).toHaveBeenCalledTimes(2);
  });
  it("opens the Slack direct message, keeps its channel in the card ID, and edits the card there", async () => {
    const { messenger } = harness();
    const t: FeedbackTarget = { ...quota("slack"), errorCode: "input_expired" };
    mocks.slack.conversations.open.mockResolvedValue({ ok: true, channel: { id: "D1" } });
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: "D1", ts: "1.5" });
    mocks.slack.chat.update.mockResolvedValue({ ok: true });
    expect(await messenger.post(t)).toBe("D1/1.5");
    expect(mocks.slack.conversations.open).toHaveBeenCalledWith({ users: "U_SENDER" });
    const sent = mocks.slack.chat.postMessage.mock.calls[0]?.[0];
    expect(sent.channel).toBe("D1");
    expect(sent).not.toHaveProperty("thread_ts");
    expect(sent.attachments[0].blocks[0].text.text).toBe("Message expired");
    await messenger.update({ ...t, cardMessageId: "D1/1.5", state: "completed" });
    expect(mocks.slack.chat.update.mock.calls[0]?.[0]).toMatchObject({ channel: "D1", ts: "1.5" });
    await messenger.update({ ...t, cardMessageId: "9.9" });
    expect(mocks.slack.chat.update.mock.calls[1]?.[0]).toMatchObject({ channel: t.channelId, ts: "9.9" });
  });
  it("falls back to the Slack conversation when the direct message is refused, but not on a rate limit", async () => {
    const { messenger } = harness();
    const t: FeedbackTarget = { ...quota("slack"), errorCode: "input_rejected" };
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: t.channelId, ts: "2.5" });
    expect(await messenger.post(t)).toBe("2.5");
    expect(mocks.slack.chat.postMessage.mock.calls[0]?.[0]).toMatchObject({ channel: t.channelId });
    mocks.slack.chat.postMessage.mockClear();
    mocks.slack.conversations.open.mockRejectedValueOnce(new WebAPIRateLimitedError(3));
    await expect(messenger.post(t)).rejects.toMatchObject({ code: "IM_FEEDBACK_RATE_LIMITED", knownNotApplied: true });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("reads a Slack card back from the sender's direct message by its identity", async () => {
    const { messenger } = harness();
    const t = quota("slack");
    mocks.slack.conversations.open.mockResolvedValue({ ok: true, channel: { id: "D1" } });
    const card = (id: string, user = "bot") => ({
      user,
      ts: id,
      attachments: [{ blocks: [{ block_id: `opentag_feedback:${t.id}` }] }],
    });
    mocks.slack.conversations.history.mockResolvedValue({
      ok: true,
      messages: [card("1.1"), card("1.2", "someone"), { user: "bot", ts: "1.3" }],
      response_metadata: { next_cursor: "p2" },
    });
    expect(await messenger.find(t, SENDER_READBACK)).toEqual({ ids: ["D1/1.1"], cursor: `${SENDER_READBACK}p2` });
    await messenger.find(t, `${SENDER_READBACK}p2`);
    expect(mocks.slack.conversations.history.mock.calls[1]?.[0]).toMatchObject({ channel: "D1", cursor: "p2" });
  });
});

describe("readback of a card meant for the sender", () => {
  const quota = (provider: "slack" | "feishu"): FeedbackTarget => ({
    ...target(provider),
    messageFormat: "interactive_v1",
    errorCode: "provider_quota_exceeded",
    senderExternalId: provider === "feishu" ? "ou_sender" : "U_SENDER",
  });
  it("keeps the leg that started when the outer deadline ends the send", async () => {
    vi.useFakeTimers();
    const h = harness();
    const late = deferred<{ ok: boolean; channel: string; ts: string }>();
    mocks.slack.conversations.open.mockResolvedValue({ ok: true, channel: { id: "D1" } });
    mocks.slack.chat.postMessage.mockImplementation(() => late.promise);
    const dm = h.messenger.post(quota("slack")).catch((error: unknown) => error);
    const lateFeishu = deferred<unknown>();
    mocks.feishu.im.v1.message.create.mockResolvedValueOnce({ code: 230013 });
    mocks.feishu.im.v1.message.reply.mockImplementation(() => lateFeishu.promise);
    const fallback = h.messenger.post(quota("feishu")).catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await dm).toMatchObject({ knownNotApplied: false, readbackCursor: SENDER_READBACK });
      expect(await fallback).toMatchObject({ knownNotApplied: false, readbackCursor: CONVERSATION_READBACK });
    } finally {
      late.resolve({ ok: true, channel: "D1", ts: "late" });
      lateFeishu.resolve({ code: 0, data: { message_id: "late", chat_id: "channel" } });
      await vi.runAllTimersAsync();
    }
  });
  it("treats a failed Slack conversations.open as nothing sent", async () => {
    const { messenger } = harness();
    mocks.slack.conversations.open.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(messenger.post(quota("slack"))).rejects.toMatchObject({
      code: "IM_FEEDBACK_SENDER_OPEN_FAILED",
      knownNotApplied: true,
    });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("reads the conversation, then the sender's direct message, when no leg was recorded", async () => {
    const { messenger, cooldown } = harness();
    mocks.slack.conversations.replies.mockResolvedValue({ ok: true, messages: [] });
    mocks.slack.conversations.open.mockResolvedValue({ ok: true, channel: { id: "D1" } });
    mocks.slack.conversations.history.mockResolvedValue({ ok: true, messages: [] });
    const first = await messenger.find(quota("slack"));
    expect(mocks.slack.conversations.replies).toHaveBeenCalledOnce();
    expect(mocks.slack.conversations.open).not.toHaveBeenCalled();
    expect(first).toEqual({ ids: [], cursor: "either-sender:" });
    await messenger.find(quota("slack"), first.cursor);
    expect(mocks.slack.conversations.history.mock.calls[0]?.[0]).toMatchObject({ channel: "D1" });
    // Feishu re-creates in the direct message only after the read-only conversation search found nothing.
    mocks.feishu.im.v1.message.list.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
    expect(await messenger.find(quota("feishu"))).toEqual({ ids: [], cursor: "either-sender:" });
    expect(mocks.feishu.im.v1.message.create).not.toHaveBeenCalled();
    // A direct conversation, a card that never goes to the sender, and a legacy text message read the conversation.
    mocks.slack.conversations.replies.mockClear();
    cooldown.messageContext.mockResolvedValueOnce({ language: "en", direct: true });
    expect(await messenger.find(quota("slack"))).toEqual({ ids: [] });
    expect(await messenger.find({ ...quota("slack"), errorCode: "provider_rate_limited" })).toEqual({ ids: [] });
    expect(await messenger.find({ ...quota("slack"), messageFormat: "text_v1" })).toEqual({ ids: [] });
    expect(mocks.slack.conversations.replies).toHaveBeenCalledTimes(3);
  });
  it("finds a card that fell back to the group though its leg was never recorded", async () => {
    const { messenger, material } = { ...harness(), material: "bot" };
    const t = quota("slack");
    mocks.slack.conversations.replies.mockResolvedValue({
      ok: true,
      messages: [{ user: material, ts: "9.9", attachments: [{ blocks: [{ block_id: `opentag_feedback:${t.id}` }] }] }],
    });
    expect(await messenger.find(t)).toEqual({ ids: ["9.9"] });
    expect(mocks.slack.conversations.open).not.toHaveBeenCalled();
  });
  it("reports a deadline while the direct message opens as nothing sent", async () => {
    vi.useFakeTimers();
    const { messenger } = harness();
    mocks.slack.conversations.open.mockImplementation(() => new Promise(() => undefined));
    const result = messenger.post(quota("slack")).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await result).toMatchObject({ code: "IM_FEEDBACK_SEND_NOT_STARTED", knownNotApplied: true });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("reads the conversation when the sender's direct message cannot be opened", async () => {
    const { messenger } = harness();
    mocks.slack.conversations.replies.mockResolvedValue({
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "p2" },
    });
    const result = await messenger.find(quota("slack"), SENDER_READBACK);
    expect(mocks.slack.conversations.replies).toHaveBeenCalledOnce();
    expect(result.cursor?.startsWith(CONVERSATION_READBACK)).toBe(true);
  });
});

describe("the origin line on a card sent to the sender", () => {
  const quota = (provider: "slack" | "feishu"): FeedbackTarget => ({
    ...target(provider),
    messageFormat: "interactive_v1",
    errorCode: "provider_quota_exceeded",
    senderExternalId: provider === "feishu" ? "ou_sender" : "U_SENDER",
  });
  it("names the Feishu group and the start of the message in plain text above the body", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValue({ language: "zh", direct: false, excerpt: "帮我*整理*一下周报…" });
    mocks.feishu.im.v1.chat.get.mockResolvedValue({ code: 0, data: { name: "产品 [群]" } });
    mocks.feishu.im.v1.message.create.mockResolvedValue({ code: 0, data: { message_id: "dm", chat_id: "oc_dm" } });
    await messenger.post(quota("feishu"));
    const card = JSON.parse(mocks.feishu.im.v1.message.create.mock.calls[0]?.[0].data.content);
    expect(card.elements[0]).toEqual({
      tag: "div",
      text: { tag: "plain_text", content: "你在「产品 [群]」发的：帮我*整理*一下周报…" },
    });
    expect(card.elements[1]).toMatchObject({ tag: "div", text: { tag: "lark_md" } });
  });
  it("names the Slack channel, and still sends the card when the name can't be read", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValue({ language: "en", direct: false, excerpt: "<!here> ship it" });
    mocks.slack.conversations.open.mockResolvedValue({ ok: true, channel: { id: "D1" } });
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: "D1", ts: "1.1" });
    mocks.slack.conversations.info.mockResolvedValueOnce({ ok: true, channel: { name: "launch" } });
    await messenger.post(quota("slack"));
    mocks.slack.conversations.info.mockRejectedValueOnce({ data: { error: "missing_scope" } });
    await messenger.post(quota("slack"));
    const [named, unnamed] = mocks.slack.chat.postMessage.mock.calls.map((c) => c[0].attachments[0].blocks[1]);
    expect(named).toEqual({
      type: "section",
      text: { type: "plain_text", text: 'Your message in "launch": <!here> ship it', emoji: false },
    });
    expect(unnamed.text.text).toBe("Your message in the group: <!here> ship it");
  });
  it("sends without the group name when its lookup hangs, within the send deadline", async () => {
    vi.useFakeTimers();
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValue({ language: "zh", direct: false, excerpt: "你好" });
    mocks.feishu.im.v1.chat.get.mockImplementation(() => new Promise(() => undefined));
    mocks.feishu.im.v1.message.create.mockResolvedValue({ code: 0, data: { message_id: "dm", chat_id: "oc_dm" } });
    mocks.slack.conversations.info.mockImplementation(() => new Promise(() => undefined));
    mocks.slack.conversations.open.mockResolvedValue({ ok: true, channel: { id: "D1" } });
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: "D1", ts: "1.1" });
    const feishu = messenger.post(quota("feishu"));
    const slack = messenger.post(quota("slack"));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await feishu).toBe("dm");
    expect(await slack).toBe("D1/1.1");
    const card = JSON.parse(mocks.feishu.im.v1.message.create.mock.calls[0]?.[0].data.content);
    expect(card.elements[0].text.content).toBe("你在群里发的：你好");
    expect(mocks.slack.chat.postMessage.mock.calls[0]?.[0].attachments[0].blocks[1].text.text).toBe(
      "你在群里发的：你好",
    );
  });
  it("reports a deadline before any provider write as nothing sent", async () => {
    vi.useFakeTimers();
    const { messenger } = harness();
    mocks.slack.conversations.open.mockImplementation(() => new Promise(() => undefined));
    const result = messenger.postOfflineNotice(quota("slack")).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await result).toMatchObject({ code: "IM_FEEDBACK_SEND_NOT_STARTED", knownNotApplied: true });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("stops on a cooldown that could not be stored during the group-name lookup", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValue({ language: "zh", direct: false, excerpt: "你好" });
    cooldown.deferSlackInstallation.mockRejectedValueOnce(new Error("db down"));
    mocks.slack.conversations.info.mockRejectedValueOnce(new WebAPIRateLimitedError(7));
    await expect(messenger.postOfflineNotice(quota("slack"))).rejects.toBeInstanceOf(FeedbackCooldownStorageError);
    expect(mocks.slack.conversations.open).not.toHaveBeenCalled();
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("waits for a slow cooldown write after a rate-limited lookup, past the lookup's limit", async () => {
    vi.useFakeTimers();
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValue({ language: "zh", direct: false, excerpt: "你好" });
    const write = deferred<boolean>();
    cooldown.deferSlackInstallation.mockImplementationOnce(() => write.promise);
    mocks.slack.conversations.info.mockRejectedValueOnce(new WebAPIRateLimitedError(7));
    const result = messenger.postOfflineNotice(quota("slack")).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_001);
    write.reject(new Error("db down"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBeInstanceOf(FeedbackCooldownStorageError);
    expect(mocks.slack.conversations.open).not.toHaveBeenCalled();
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
  });
  it("adds no origin line to a card that stays in the conversation", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValue({ language: "zh", direct: false, excerpt: "hi" });
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "r", chat_id: "channel" } });
    await messenger.post({ ...quota("feishu"), errorCode: "provider_rate_limited" });
    const card = JSON.parse(mocks.feishu.im.v1.message.reply.mock.calls[0]?.[0].data.content);
    expect(card.elements.map((element: { tag: string }) => element.tag)).toEqual(["div", "note"]);
    expect(mocks.feishu.im.v1.chat.get).not.toHaveBeenCalled();
  });
});
