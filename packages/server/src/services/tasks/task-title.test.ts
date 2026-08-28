import { TASK_AUTO_TITLE_MAX_GRAPHEMES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
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
});
