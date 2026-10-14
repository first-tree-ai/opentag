import { describe, expect, it, vi } from "vitest";
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
  it.each([true, false])("honors the provider page-size limit while paginating failed=%s", async (failed) => {
    const api = feishu();
    vi.mocked(api.list).mockImplementation(async (input) => {
      const pageSize = input?.params?.page_size ?? 20;
      if (pageSize > 50) throw new Error("Feishu rejects reaction pages larger than 50");
      const lastPage = input?.params?.page_token === "next";
      return {
        code: 0,
        data: { items: lastPage && !failed ? [own] : [], has_more: !lastPage, page_token: lastPage ? "" : "next" },
      };
    });
    await expect(setFeishuFailureReaction(api, "A1", "om_1", failed)).resolves.toBeUndefined();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.create).toHaveBeenCalledTimes(failed ? 1 : 0);
    expect(api.delete).toHaveBeenCalledTimes(failed ? 0 : 1);
  });
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
      params: { reaction_type: "CrossMark", page_size: expect.any(Number), page_token: "next" },
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
