import { randomUUID } from "node:crypto";
import { WebAPIRateLimitedError } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalCallPolicy, ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { FeedbackCooldownStorageError, ImFeedbackMessenger } from "../services/im/im-feedback-messenger.js";
import type { FeedbackTarget } from "../services/im/im-feedback-store.js";
import type { ImBindingService } from "../services/im-bindings/im-binding-service.js";

const mocks = vi.hoisted(() => ({
  slack: {
    reactions: { add: vi.fn(), remove: vi.fn() },
    chat: { postMessage: vi.fn(), update: vi.fn(), postEphemeral: vi.fn() },
    conversations: { replies: vi.fn() },
  },
  feishu: {
    im: {
      v1: {
        messageReaction: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
        message: { reply: vi.fn(), patch: vi.fn(), update: vi.fn(), list: vi.fn() },
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
    messageFormat: "interactive_v1",
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
function harness() {
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
  const policy = new ExternalCallPolicy({ allowedHosts: [] });
  const cooldown = {
    slackCooldownRemaining: vi.fn(async () => 0 as number | undefined),
    deferSlackInstallation: vi.fn(async () => true),
    messageLanguage: vi.fn(async () => "en" as "en" | "zh"),
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
    mocks.slack.chat.postEphemeral,
    mocks.slack.conversations.replies,
    mocks.feishu.im.v1.messageReaction.list,
    mocks.feishu.im.v1.messageReaction.create,
    mocks.feishu.im.v1.messageReaction.delete,
    mocks.feishu.im.v1.message.reply,
    mocks.feishu.im.v1.message.patch,
    mocks.feishu.im.v1.message.update,
    mocks.feishu.im.v1.message.list,
  ])
    mock.mockReset();
  mocks.slack.reactions.add.mockResolvedValue({ ok: true });
  mocks.slack.reactions.remove.mockResolvedValue({ ok: true });
  mocks.feishu.im.v1.messageReaction.list.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  mocks.feishu.im.v1.messageReaction.create.mockResolvedValue({ code: 0 });
  mocks.feishu.im.v1.messageReaction.delete.mockResolvedValue({ code: 0 });
});
describe("native feedback transport", () => {
  it("sends the offline notice outside the failure message identity", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageLanguage.mockResolvedValueOnce("zh");
    const t = target("feishu");
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "n", chat_id: t.channelId } });
    await messenger.postOfflineNotice(t);
    const data = mocks.feishu.im.v1.message.reply.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("uuid");
    expect(data.msg_type).toBe("post");
    expect(JSON.parse(data.content)).toEqual({
      zh_cn: {
        content: [
          [{ tag: "text", text: "运行这个 Agent 的电脑离线了，暂时处理不了这条消息。" }],
          [
            { tag: "text", text: "请确认电脑已开机、已联网，再到 Agent 页面恢复连接。" },
            { tag: "text", text: " " },
            { tag: "a", text: "恢复连接", href: `https://app.example.test/agents/${t.agentId}` },
          ],
          [{ tag: "text", text: "如果这不是你管理的 Agent，请联系它的管理员。" }],
          [{ tag: "text", text: "消息已保留，恢复后会自动处理；7 天内没恢复会过期。" }],
        ],
      },
    });
  });
  it("sends the Slack offline notice in the thread with a Slack link", async () => {
    const { messenger } = harness();
    const t = target("slack");
    mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: t.channelId, ts: "n" });
    await messenger.postOfflineNotice(t);
    const sent = mocks.slack.chat.postMessage.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ channel: t.channelId, thread_ts: t.threadKey ?? t.inputExternalId });
    expect(sent.text).toContain(`<https://app.example.test/agents/${t.agentId}|Restore connection>`);
    expect(sent.text).toContain("It expires after 7 days.");
  });
  it("does not submit a send whose language cannot be read, and keeps it retryable", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageLanguage.mockRejectedValueOnce(new Error("storage"));
    await expect(messenger.post(target("feishu"))).rejects.toMatchObject({
      code: "IM_FEEDBACK_LANGUAGE_UNAVAILABLE",
      knownNotApplied: true,
    });
    expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
  });
  it("sends Feishu text in the language of the input without an error code", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageLanguage.mockResolvedValueOnce("zh");
    const t: FeedbackTarget = {
      ...target("feishu"),
      messageFormat: "text_v1",
      state: "failed",
      errorCode: "provider_quota_exceeded",
      effects: "may_have_occurred",
    };
    mocks.feishu.im.v1.message.reply.mockResolvedValue({
      code: 0,
      data: { message_id: "text-message", chat_id: t.channelId },
    });
    await messenger.post(t);
    const sent = JSON.parse(mocks.feishu.im.v1.message.reply.mock.calls[0]?.[0].data.content).text as string;
    expect(sent).toBe(
      `模型额度用完了，任务没有完成。\n可能已经执行了部分操作，重发前请先检查结果。\n请 Agent 所有者处理后再发一次。 [查看详情](https://app.example.test/im-feedback/${t.id})`,
    );
  });
  it.each(["slack", "feishu"] as const)(
    "sends, edits and finds %s text without an interactive card",
    async (provider) => {
      const t: FeedbackTarget = { ...target(provider), messageFormat: "text_v1" };
      const { messenger } = harness();
      const details = `https://app.example.test/im-feedback/${t.id}`;
      mocks.slack.chat.postMessage.mockResolvedValue({ ok: true, channel: t.channelId, ts: "text-message" });
      mocks.slack.chat.update.mockResolvedValue({ ok: true });
      mocks.feishu.im.v1.message.reply.mockResolvedValue({
        code: 0,
        data: { message_id: "text-message", chat_id: t.channelId },
      });
      mocks.feishu.im.v1.message.update.mockResolvedValue({ code: 0 });
      expect(await messenger.post(t)).toBe("text-message");
      await messenger.update({ ...t, cardMessageId: "text-message" });
      if (provider === "slack") {
        expect(mocks.slack.chat.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining(details) }),
        );
        expect(mocks.slack.chat.postMessage.mock.calls[0]?.[0]).not.toHaveProperty("blocks");
        expect(mocks.slack.chat.update.mock.calls[0]?.[0]).not.toHaveProperty("blocks");
        mocks.slack.conversations.replies.mockResolvedValue({
          ok: true,
          messages: [
            { user: "human", ts: "other", text: details },
            { user: "bot", ts: "text-message", text: details },
          ],
        });
      } else {
        expect(mocks.feishu.im.v1.message.reply).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ msg_type: "text" }) }),
        );
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
  it("privately answers an ineligible Slack click without replacing or posting a public card", async () => {
    await harness().messenger.respondSlack({
      installationId: "11111111-1111-4111-8111-111111111111",
      generation: 2,
      token: "unit-token",
      channelId: "channel",
      userId: "human",
      threadKey: "thread",
      result: "unavailable",
    });
    expect(mocks.slack.chat.postEphemeral).toHaveBeenCalledExactlyOnceWith({
      channel: "channel",
      user: "human",
      thread_ts: "thread",
      text: expect.stringContaining("unavailable"),
    });
    expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
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
  it("matches only the exact Slack bot and hidden feedback identity during bounded readback", async () => {
    const t = target();
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
    "updates the bound %s message rather than creating another card",
    async (provider) => {
      const t = { ...target(provider), cardMessageId: "existing" };
      mocks.slack.chat.update.mockResolvedValue({ ok: true });
      mocks.feishu.im.v1.message.patch.mockResolvedValue({ code: 0 });
      await harness().messenger.update(t);
      expect(mocks.slack.chat.postMessage).not.toHaveBeenCalled();
      expect(mocks.feishu.im.v1.message.reply).not.toHaveBeenCalled();
      if (provider === "slack")
        expect(mocks.slack.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: "existing" }));
      else
        expect(mocks.feishu.im.v1.message.patch).toHaveBeenCalledWith(
          expect.objectContaining({ path: { message_id: "existing" } }),
        );
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

it("gates private callback acknowledgements at the verified installation generation", async () => {
  const h = harness();
  h.cooldown.slackCooldownRemaining.mockResolvedValue(25_000);
  const input = {
    installationId: "11111111-1111-4111-8111-111111111111",
    generation: 2,
    token: "synthetic-token",
    channelId: "channel",
    userId: "human",
    threadKey: "thread",
    result: "unavailable" as const,
  };
  await expect(h.messenger.respondSlack(input)).rejects.toMatchObject({
    code: "IM_FEEDBACK_RATE_LIMITED",
    retryAfterMs: 25_000,
  });
  expect(mocks.slack.chat.postEphemeral).not.toHaveBeenCalled();
  h.cooldown.slackCooldownRemaining.mockResolvedValue(0);
  mocks.slack.chat.postEphemeral.mockRejectedValueOnce(new WebAPIRateLimitedError(7));
  await expect(h.messenger.respondSlack(input)).rejects.toMatchObject({ retryAfterMs: 7_000 });
  expect(h.cooldown.deferSlackInstallation).toHaveBeenCalledExactlyOnceWith(
    { provider: "slack", installationId: input.installationId, bindingGeneration: 2 },
    7_000,
  );
});
