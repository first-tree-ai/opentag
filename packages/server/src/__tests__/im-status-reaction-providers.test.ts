import { describe, expect, it, vi } from "vitest";
import { syncFeishuStatusReaction } from "../services/im-bindings/feishu/status-reactions.js";
import { syncSlackStatusReaction } from "../services/im-bindings/slack/status-reactions.js";

const target = { channelId: "channel", messageExternalId: "message" };

describe("Slack status reactions", () => {
  it.each([
    ["working", "eyes"],
    ["completed", "white_check_mark"],
    ["failed", "warning"],
  ] as const)("sets %s and removes only obsolete bot statuses", async (status, name) => {
    const api = { add: vi.fn().mockResolvedValue({ ok: true }), remove: vi.fn().mockResolvedValue({ ok: true }) };
    await syncSlackStatusReaction(api, { ...target, status });
    expect(api.add).toHaveBeenCalledWith({ channel: "channel", timestamp: "message", name });
    expect(api.remove).toHaveBeenCalledTimes(2);
    expect(api.remove.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ name }));
    expect(api.add.mock.invocationCallOrder[0]).toBeLessThan(api.remove.mock.invocationCallOrder[0] ?? 0);
  });

  it("treats already-present and already-removed reactions as success", async () => {
    const api = {
      add: vi.fn().mockRejectedValue({ data: { error: "already_reacted" } }),
      remove: vi.fn().mockRejectedValue({ data: { error: "no_reaction" } }),
    };
    await expect(syncSlackStatusReaction(api, { ...target, status: "completed" })).resolves.toBeUndefined();
    api.add.mockRejectedValueOnce({ data: { error: "missing_scope" } });
    await expect(syncSlackStatusReaction(api, { ...target, status: "completed" })).rejects.toEqual({
      data: { error: "missing_scope" },
    });
  });

  it("clears statuses on cancellation and preserves other reactions", async () => {
    const api = { add: vi.fn(), remove: vi.fn().mockResolvedValue({ ok: true }) };
    await syncSlackStatusReaction(api, { ...target, status: "cancelled" });
    expect(api.add).not.toHaveBeenCalled();
    expect(api.remove.mock.calls.map(([input]) => input.name)).toEqual(["eyes", "white_check_mark", "warning"]);
  });
});

function reaction(id: string, emoji: string, operatorId = "app", operatorType: "app" | "user" = "app") {
  return {
    reaction_id: id,
    reaction_type: { emoji_type: emoji },
    operator: { operator_id: operatorId, operator_type: operatorType },
  };
}
function feishuApi(items: ReturnType<typeof reaction>[] = []) {
  return {
    list: vi.fn().mockResolvedValue({ code: 0, data: { items, has_more: false, page_token: "" } }),
    create: vi.fn().mockResolvedValue({ code: 0 }),
    delete: vi.fn().mockResolvedValue({ code: 0 }),
  };
}

describe("Feishu status reactions", () => {
  it("paginates and preserves contextual and other people's reactions", async () => {
    const api = feishuApi();
    api.list.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          reaction("old", "OnIt"),
          reaction("context", "PARTY"),
          reaction("other-app", "OnIt", "another-app"),
          reaction("human", "OnIt", "user", "user"),
        ],
        has_more: true,
        page_token: "next",
      },
    });
    await syncFeishuStatusReaction(api, "app", { ...target, status: "completed" });
    expect(api.list).toHaveBeenLastCalledWith({
      path: { message_id: "message" },
      params: { page_size: 50, page_token: "next" },
    });
    expect(api.create).toHaveBeenCalledWith({
      path: { message_id: "message" },
      data: { reaction_type: { emoji_type: "DONE" } },
    });
    expect(api.delete).toHaveBeenCalledExactlyOnceWith({ path: { message_id: "message", reaction_id: "old" } });
  });

  it.each([
    ["working", "OnIt"],
    ["completed", "DONE"],
    ["failed", "ERROR"],
  ] as const)("deduplicates existing %s reactions", async (status, emoji) => {
    const api = feishuApi([reaction("existing", emoji)]);
    await syncFeishuStatusReaction(api, "app", { ...target, status });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it("clears reserved statuses on cancellation", async () => {
    const api = feishuApi([reaction("working", "OnIt"), reaction("context", "PARTY")]);
    await syncFeishuStatusReaction(api, "app", { ...target, status: "cancelled" });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.delete).toHaveBeenCalledExactlyOnceWith({ path: { message_id: "message", reaction_id: "working" } });
  });

  it("rejects provider errors and incomplete pagination without mutating reactions", async () => {
    const api = feishuApi();
    api.list.mockResolvedValueOnce({ code: 999, data: undefined });
    await expect(syncFeishuStatusReaction(api, "app", { ...target, status: "working" })).rejects.toThrow(
      "FEISHU_STATUS_REACTION_FAILED",
    );
    api.list.mockResolvedValue({ code: 0, data: { items: [], has_more: true, page_token: "same" } });
    await expect(syncFeishuStatusReaction(api, "app", { ...target, status: "working" })).rejects.toThrow(
      "FEISHU_STATUS_REACTION_LIST_INCOMPLETE",
    );
    expect(api.create).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});
