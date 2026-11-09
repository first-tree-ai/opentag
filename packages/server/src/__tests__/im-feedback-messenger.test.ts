import { randomUUID } from "node:crypto";
import { WebAPIRateLimitedError } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalCallPolicy, ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { FeedbackCooldownStorageError, ImFeedbackMessenger } from "../services/im/im-feedback-messenger.js";
import type { FeedbackAction, FeedbackTarget } from "../services/im/im-feedback-store.js";
import { renderFeedbackText } from "../services/im/im-feedback-text.js";
import type { ImBindingService } from "../services/im-bindings/im-binding-service.js";
import { deferred } from "./support/deferred.js";

const mocks = vi.hoisted(() => ({
  slack: {
    reactions: { add: vi.fn(), remove: vi.fn() },
    chat: { postMessage: vi.fn(), update: vi.fn() },
    conversations: { replies: vi.fn(), history: vi.fn() },
  },
  feishu: {
    im: {
      v1: {
        messageReaction: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
        message: { create: vi.fn(), reply: vi.fn(), patch: vi.fn(), update: vi.fn(), list: vi.fn() },
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
    messageContext: vi.fn(async () => ({ language: "en" as "en" | "zh", direct: false })),
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
  mocks.slack.reactions.add.mockResolvedValue({ ok: true });
  mocks.slack.reactions.remove.mockResolvedValue({ ok: true });
  mocks.feishu.im.v1.messageReaction.list.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  mocks.feishu.im.v1.messageReaction.create.mockResolvedValue({ code: 0 });
  mocks.feishu.im.v1.messageReaction.delete.mockResolvedValue({ code: 0 });
});
afterEach(() => vi.useRealTimers());
describe("native feedback transport", () => {
  it("sends the offline notice as an orange card outside the failure message identity", async () => {
    const { messenger, cooldown } = harness();
    cooldown.messageContext.mockResolvedValueOnce({ language: "zh", direct: false });
    const t = target("feishu");
    mocks.feishu.im.v1.message.reply.mockResolvedValue({ code: 0, data: { message_id: "n", chat_id: t.channelId } });
    await messenger.postOfflineNotice(t);
    const data = mocks.feishu.im.v1.message.reply.mock.calls[0]?.[0].data;
    expect(data).not.toHaveProperty("uuid");
    expect(data.msg_type).toBe("interactive");
    const card = JSON.parse(data.content);
    expect(card.header).toEqual({ title: { tag: "plain_text", content: "Agent 所在电脑离线" }, template: "orange" });
    expect(card.config).toMatchObject({ update_multi: true });
    expect(card.elements).toEqual([
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `恢复后会自动处理，[恢复连接](https://app.example.test/im-feedback/${t.id}?open=restore)`,
        },
      },
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
        color: "#F2952F",
        fallback: "The Agent's computer is offline: Messages will be handled after it reconnects",
        blocks: [
          {
            type: "header",
            block_id: `opentag_feedback:${t.id}`,
            text: { type: "plain_text", text: "The Agent's computer is offline", emoji: true },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Messages will be handled after it reconnects. <https://app.example.test/im-feedback/${t.id}?open=restore|Restore connection>`,
            },
          },
        ],
      },
    ]);
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
    expect(card.header).toEqual({ title: { tag: "plain_text", content: "模型认证失败" }, template: "red" });
    expect(card.elements[0].text.content).toBe(
      `需要更新模型设置，[去设置](https://app.example.test/im-feedback/${t.id}?open=settings)`,
    );
    expect(data.content).not.toContain("provider_authentication_failed");
  });
  it("gives a Feishu card without a link a zero-width identity link for readback", async () => {
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
  it("finds a Slack card in the channel history by its attachment block identity", async () => {
    const t: FeedbackTarget = { ...target(), messageFormat: "interactive_v1", threadKey: null };
    const identity = { block_id: `opentag_feedback:${t.id}` };
    mocks.slack.conversations.history.mockResolvedValue({
      ok: true,
      messages: [
        { user: "human", ts: "foreign", attachments: [{ blocks: [identity] }] },
        { user: "bot", ts: "other", attachments: [{ blocks: [{ block_id: "opentag_feedback:other" }] }] },
        { user: "bot", ts: "match", attachments: [{ blocks: [identity] }] },
      ],
    });
    expect(await harness().messenger.find(t)).toEqual({ ids: ["match"] });
    expect(mocks.slack.conversations.history).toHaveBeenCalledWith({
      channel: t.channelId,
      oldest: String(Math.floor((t.sendStartedAt ?? t.createdAt).getTime() / 1000) - 60),
      limit: 100,
    });
    expect(mocks.slack.conversations.replies).not.toHaveBeenCalled();
  });
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
