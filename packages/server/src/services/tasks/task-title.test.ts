import { TASK_AUTO_TITLE_MAX_GRAPHEMES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { deriveTaskTitle } from "./task-title.js";

describe("deriveTaskTitle", () => {
  it("removes routing noise while retaining useful inline identifiers", () => {
    expect(
      deriveTaskTitle(
        "  @opentag-gandy\nReview `apps/web/src/app.tsx`  ```ts\nconst secret = true;\n``` now  ",
        "Channel task",
      ),
    ).toBe("Review apps/web/src/app.tsx now");
  });

  it("removes URL query and fragment details", () => {
    expect(
      deriveTaskTitle("Review https://example.com/pull/42?utm_source=chat#discussion please", "Channel task"),
    ).toBe("Review https://example.com/pull/42 please");
  });

  it("returns the Session fallback when the message has no title content", () => {
    expect(deriveTaskTitle(" @opentag-gandy ```ts\nconst hidden = true;\n``` ", "Thread task")).toBe("Thread task");
  });

  it("truncates by grapheme without splitting joined emoji", () => {
    const family = "👨‍👩‍👧‍👦";
    const title = deriveTaskTitle(family.repeat(TASK_AUTO_TITLE_MAX_GRAPHEMES + 1), "Channel task");
    expect(title).toBe(family.repeat(TASK_AUTO_TITLE_MAX_GRAPHEMES));
  });

  it("does not mistake an email address for a mention", () => {
    expect(deriveTaskTitle("Email owner@example.com about the failure", "Channel task")).toBe(
      "Email owner@example.com about the failure",
    );
  });
});
