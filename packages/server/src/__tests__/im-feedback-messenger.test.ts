import { randomUUID } from "node:crypto";
import { WebAPIRateLimitedError } from "@slack/web-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalCallPolicy, ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { ImFeedbackMessenger } from "../services/im/im-feedback-messenger.js";
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
        message: { reply: vi.fn(), patch: vi.fn(), list: vi.fn() },
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
  return { messenger: new ImFeedbackMessenger(bindings, policy, "https://app.example.test"), policy, slack, feishu };
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
      params: { container_id_type: "thread", container_id: t.threadKey, page_size: 100, sort_type: "ByCreateTimeAsc" },
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
