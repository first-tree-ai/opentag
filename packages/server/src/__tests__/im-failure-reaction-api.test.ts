import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FailureReactionTarget } from "../services/im/im-failure-reaction-store.js";
import { ImFailureReactionWorker } from "../services/im/im-failure-reaction-worker.js";
import { FailureReactionError } from "../services/im-bindings/failure-reaction-error.js";
import { setFeishuFailureReaction } from "../services/im-bindings/feishu/failure-reaction.js";
import { DefaultSlackApiClient } from "../services/im-bindings/slack/default-api-client.js";

const own = {
  reaction_id: "own",
  operator: { operator_type: "app" as const, operator_id: "A1" },
  reaction_type: { emoji_type: "CrossMark" },
};
function feishu() {
  const api: Parameters<typeof setFeishuFailureReaction>[0] = {
    create: vi.fn(async () => ({ code: 0 })),
    delete: vi.fn(async () => ({ code: 0 })),
    list: vi.fn(async () => ({ code: 0, data: { items: [], has_more: false, page_token: "" } })),
  };
  return api;
}

describe("Feishu bot-owned error reaction", () => {
  it("adds CrossMark and does not duplicate an existing bot reaction", async () => {
    const api = feishu();
    await setFeishuFailureReaction(api, "A1", "om_1", true);
    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      path: { message_id: "om_1" },
      data: { reaction_type: { emoji_type: "CrossMark" } },
    });
    vi.mocked(api.list).mockResolvedValue({ code: 0, data: { items: [own], has_more: false, page_token: "" } });
    await setFeishuFailureReaction(api, "A1", "om_1", true);
    expect(api.create).toHaveBeenCalledOnce();
  });
  it("paginates and removes only this app's error reaction", async () => {
    const api = feishu();
    vi.mocked(api.list)
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { ...own, reaction_id: "human", operator: { operator_type: "user", operator_id: "ou_1" } },
            { ...own, reaction_id: "other-app", operator: { operator_type: "app", operator_id: "A2" } },
            { ...own, reaction_id: "working", reaction_type: { emoji_type: "OnIt" } },
          ],
          has_more: true,
          page_token: "next",
        },
      })
      .mockResolvedValueOnce({ code: 0, data: { items: [own], has_more: false, page_token: "" } });
    await setFeishuFailureReaction(api, "A1", "om_1", false);
    expect(api.list).toHaveBeenLastCalledWith({
      path: { message_id: "om_1" },
      params: { reaction_type: "CrossMark", page_size: 100, page_token: "next" },
    });
    expect(api.delete).toHaveBeenCalledExactlyOnceWith({ path: { message_id: "om_1", reaction_id: "own" } });
    expect(api.create).not.toHaveBeenCalled();
  });
  it("treats an already removed error marker as success", async () => {
    const api = feishu();
    await setFeishuFailureReaction(api, "A1", "om_1", false);
    expect(api.delete).not.toHaveBeenCalled();
  });
  it.each(["list", "create", "delete"] as const)("reports %s failures without upstream text", async (method) => {
    const api = feishu();
    vi.mocked(api.list).mockResolvedValue({
      code: 0,
      data: { items: method === "delete" ? [own] : [], has_more: false, page_token: "" },
    });
    vi.mocked(api[method]).mockResolvedValue({ code: 231001, msg: "private-provider-text" });
    await expect(setFeishuFailureReaction(api, "A1", "om_1", method !== "delete")).rejects.toThrow(
      `FEISHU_FAILURE_REACTION_${method.toUpperCase()}_FAILED`,
    );
  });
  it("rejects a repeated pagination token", async () => {
    const api = feishu();
    vi.mocked(api.list).mockResolvedValue({ code: 0, data: { items: [], has_more: true, page_token: "repeat" } });
    await expect(setFeishuFailureReaction(api, "A1", "om_1", false)).rejects.toThrow(
      "FEISHU_FAILURE_REACTION_PAGINATION_INVALID",
    );
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});

describe("Slack failure reaction API", () => {
  it.each([true, false])("projects failed=%s onto the exact message with a warning reaction", async (failed) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    await new DefaultSlackApiClient(undefined, fetchImpl).setFailureReaction({
      token: "unit-secret",
      channelId: "C1",
      externalMessageId: "2.2",
      failed,
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `https://slack.com/api/reactions.${failed ? "add" : "remove"}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ channel: "C1", timestamp: "2.2", name: "warning" }),
        headers: { authorization: "Bearer unit-secret", "content-type": "application/json" },
      }),
    );
  });
  it.each([
    [true, "already_reacted"],
    [false, "no_reaction"],
  ] as const)("accepts an already applied state (%s, %s)", async (failed, error) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: false, error }));
    await expect(
      new DefaultSlackApiClient(undefined, fetchImpl).setFailureReaction({
        token: "unit-secret",
        channelId: "C1",
        externalMessageId: "2.2",
        failed,
      }),
    ).resolves.toBeUndefined();
  });
  it("preserves Slack Retry-After", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "90" },
      }),
    );
    await expect(
      new DefaultSlackApiClient(undefined, fetchImpl).setFailureReaction({
        token: "unit-secret",
        channelId: "C1",
        externalMessageId: "2.2",
        failed: false,
      }),
    ).rejects.toMatchObject({ retryAfterMs: 90_000 });
  });
  it("does not confirm an API-level failure or expose provider bodies", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: false, error: "private-provider-text" }));
    await expect(
      new DefaultSlackApiClient(undefined, fetchImpl).setFailureReaction({
        token: "unit-secret",
        channelId: "C1",
        externalMessageId: "2.2",
        failed: false,
      }),
    ).rejects.toThrow("SLACK_FAILURE_REACTION_UNAVAILABLE");
  });
});

describe("reaction worker cooldown", () => {
  it("pauses further provider calls until Retry-After and coalesces concurrent passes", async () => {
    let now = Date.now();
    const target: FailureReactionTarget = {
      id: randomUUID(),
      bindingId: randomUUID(),
      channelId: "C1",
      externalMessageId: "2.2",
      credentialGeneration: 1,
      desired: false,
      applied: null,
      revision: 1,
      failures: 0,
      nextAttemptAt: new Date(now),
      claimId: randomUUID(),
      claimExpiresAt: new Date(now + 30_000),
    };
    const store = {
      reconcile: vi.fn(async () => undefined),
      claim: vi.fn<() => Promise<FailureReactionTarget | undefined>>(async () => target),
      ownsClaim: vi.fn(async () => true),
      settle: vi.fn(async () => undefined),
    };
    const setFailureReaction = vi.fn(async () => undefined).mockRejectedValueOnce(new FailureReactionError(90_000));
    const adapter = {
      provider: "slack" as const,
      normalizeInbound: vi.fn(),
      validateBinding: vi.fn(),
      fetchResource: vi.fn(),
      setFailureReaction,
    };
    const worker = new ImFailureReactionWorker({
      store,
      resolveAdapter: async () => adapter,
      logger: { warn: vi.fn() },
      now: () => now,
    });
    await Promise.all([worker.runOnce(), worker.runOnce()]);
    expect(setFailureReaction).toHaveBeenCalledOnce();
    expect(store.settle).toHaveBeenCalledWith(target, 90_000);
    now += 89_000;
    await worker.runOnce();
    expect(setFailureReaction).toHaveBeenCalledOnce();
    now += 1_001;
    store.claim.mockResolvedValueOnce(target).mockResolvedValueOnce(undefined);
    await worker.runOnce();
    expect(setFailureReaction).toHaveBeenCalledTimes(2);
  });
});
