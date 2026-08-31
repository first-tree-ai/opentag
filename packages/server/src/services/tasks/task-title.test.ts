import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { TASK_AUTO_TITLE_MAX_GRAPHEMES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { normalizeFeishuMessage } from "../im-bindings/feishu/adapter.js";
import { deriveTaskTitle } from "./task-title.js";

describe("deriveTaskTitle", () => {
  const input = {
    fallbackTitle: "Channel task",
    provider: "feishu" as const,
    addressedExternalId: "ou_bot",
    blocks: null,
  };

  it("removes only the structured routing mention while retaining useful mentions", () => {
    expect(
      deriveTaskTitle({
        ...input,
        fallbackText: "@_user_1 ask @_user_2 to review `apps/web/src/app.tsx`",
        blocks: [
          { type: "mention", externalId: "ou_bot", label: "@Agent" },
          { type: "text", text: " ask " },
          { type: "mention", externalId: "ou_alice", label: "@Alice" },
          { type: "text", text: " to review `apps/web/src/app.tsx`" },
        ],
      }),
    ).toBe("ask @Alice to review apps/web/src/app.tsx");
  });

  it("removes URL query and fragment details", () => {
    expect(
      deriveTaskTitle({
        ...input,
        fallbackText: "Review https://example.com/pull/42?utm_source=chat#discussion please",
      }),
    ).toBe("Review https://example.com/pull/42 please");
  });

  it("returns the Session fallback when the message has no title content", () => {
    expect(
      deriveTaskTitle({
        ...input,
        fallbackTitle: "Thread task",
        fallbackText: "@_user_1 ```ts\nconst hidden = true;\n```",
        blocks: [
          { type: "mention", externalId: "ou_bot", label: "@Agent" },
          { type: "text", text: " ```ts\nconst hidden = true;\n```" },
        ],
      }),
    ).toBe("Thread task");
  });

  it("truncates by grapheme without splitting joined emoji", () => {
    const family = "👨‍👩‍👧‍👦";
    const title = deriveTaskTitle({
      ...input,
      fallbackText: family.repeat(TASK_AUTO_TITLE_MAX_GRAPHEMES + 1),
    });
    expect(title).toBe(family.repeat(TASK_AUTO_TITLE_MAX_GRAPHEMES));
  });

  it("preserves plain user mentions and email addresses", () => {
    expect(
      deriveTaskTitle({
        ...input,
        fallbackText: "Ask @alice or owner@example.com about the failure",
      }),
    ).toBe("Ask @alice or owner@example.com about the failure");
  });

  it("keeps malformed URLs unchanged and projects structured links and attachments", () => {
    expect(
      deriveTaskTitle({
        ...input,
        fallbackText: "Review https://[invalid-url",
      }),
    ).toBe("Review https://[invalid-url");
    expect(
      deriveTaskTitle({
        ...input,
        fallbackText: "ignored",
        blocks: [
          { type: "mention", externalId: "ou_alice", label: "@Alice" },
          { type: "link", url: "https://example.com/docs", label: "the docs" },
          { type: "image", resourceOrdinal: 1, label: "screenshot" },
          { type: "file", resourceOrdinal: 2, label: "log.txt" },
        ],
      }),
    ).toBe("@Alicethe docsscreenshotlog.txt");
  });

  it("removes the exact addressed Slack identity from historical text-only content", () => {
    expect(
      deriveTaskTitle({
        ...input,
        provider: "slack",
        addressedExternalId: "U_BOT",
        fallbackText: "<@U_BOT> ask <@U_ALICE> to review",
      }),
    ).toBe("ask <@U_ALICE> to review");
  });

  it("resolves mentions in a follow-up message that no longer addresses the Agent", () => {
    const [event] = normalizeFeishuMessage({
      appId: "cli_1",
      teamId: "workspace_1",
      message: {
        messageId: "om_followup",
        chatId: "oc_1",
        chatType: "group",
        senderId: "ou_human",
        content: "@_user_2 帮忙看下这个回归",
        rawContentType: "text",
        resources: [],
        mentions: [{ key: "@_user_2", openId: "ou_alice", name: "Alice", isBot: false }],
        mentionAll: false,
        mentionedBot: false,
        createTime: 1_724_025_600_000,
      } as unknown as NormalizedMessage,
    });
    if (!event) throw new Error("Feishu follow-up was not normalized");
    expect(
      deriveTaskTitle({
        ...input,
        fallbackText: event.message.content.fallbackText,
        blocks: event.message.content.blocks,
      }),
    ).toBe("@Alice 帮忙看下这个回归");
  });
});
