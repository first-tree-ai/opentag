import type { TaskTurn } from "@opentag/shared/browser";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskOutgoingReplies } from "./task-outgoing-replies.js";

type Snapshot = NonNullable<NonNullable<TaskTurn["report"]>["outgoingReplies"]>;
type Content = Snapshot["replies"][number]["content"];
function snapshot(contents: Content[]): Snapshot {
  return {
    status: "complete",
    replies: contents.map((content, index) => ({
      provider: "feishu",
      teamBrand: "lark",
      messageId: `om_${index}`,
      chatId: "oc_chat",
      content,
    })),
  };
}

describe("actual outgoing reply content", () => {
  it("preserves reply order, literal text and inspectable native post/card payloads", () => {
    const post = { title: "Native title", content: [[{ tag: "a", text: "Read", href: "javascript:bad()" }], []] };
    const card = '{"header":{"title":{"content":"Actual card"}},"url":"javascript:bad()"}';
    const { container } = render(
      <TaskOutgoingReplies
        snapshot={snapshot([
          { msgType: "text", text: "First\n\n<b>literal HTML</b>" },
          { msgType: "post", text: "Native title\nRead\n", post },
          { msgType: "interactive", raw: card },
        ])}
      />,
    );
    const replies = container.querySelectorAll('[data-ui="task-sent-reply"]');
    expect(replies).toHaveLength(3);
    expect(replies[0]?.textContent).toContain("First\n\n<b>literal HTML</b>");
    expect(replies[0]?.querySelector("b")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    const controls = screen.getAllByRole("button", { name: "Message details" });
    expect(controls).toHaveLength(2);
    for (const control of controls) {
      expect(control.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(control);
      expect(control.getAttribute("aria-expanded")).toBe("true");
    }
    expect(replies[1]?.querySelector("pre")?.textContent).toBe(JSON.stringify(post, null, 2));
    expect(replies[2]?.querySelector("pre")?.textContent).toBe(card);
  });

  it.each(["image", "file", "audio", "video", "media", "sticker"] as const)(
    "keeps usable %s metadata without inventing an attachment URL",
    (msgType) => {
      const { container } = render(
        <TaskOutgoingReplies
          snapshot={snapshot([{ msgType, filename: "actual-attachment.bin", fileKey: "file_native_id" }])}
        />,
      );
      expect(screen.getByText(/actual-attachment.bin/)).toBeTruthy();
      expect(container.querySelectorAll("a,img,audio,video")).toHaveLength(0);
    },
  );

  it("labels a truncated body even when the surviving text is readable", () => {
    render(
      <TaskOutgoingReplies
        snapshot={{
          ...snapshot([{ msgType: "text", text: "Surviving text", unavailable: "content_truncated" }]),
          status: "incomplete",
        }}
      />,
    );
    expect(screen.getByText("Surviving text")).toBeTruthy();
    expect(screen.getByText("This reply was truncated.")).toBeTruthy();
    expect(screen.getByText(/Reply history is incomplete/)).toBeTruthy();
  });
});
