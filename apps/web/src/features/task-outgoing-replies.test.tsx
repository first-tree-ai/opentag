import type { TaskTurn } from "@opentag/shared/browser";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskOutgoingReply } from "./task-outgoing-replies.js";

type Reply = NonNullable<NonNullable<TaskTurn["report"]>["outgoingReplies"]>["replies"][number];
type Content = Reply["content"];
function renderReplies(contents: Content[]) {
  const replies: Reply[] = contents.map((content, index) => ({
    provider: "feishu",
    teamBrand: "lark",
    messageId: `om_${index}`,
    chatId: "oc_chat",
    content,
  }));
  return render(replies.map((reply) => <TaskOutgoingReply key={reply.messageId} reply={reply} />));
}

describe("actual outgoing reply content", () => {
  it("preserves reply order, literal text and inspectable native post/card payloads", () => {
    const post = { title: "Native title", content: [[{ tag: "a", text: "Read", href: "javascript:bad()" }], []] };
    const card = '{"header":{"title":{"content":"Actual card"}},"url":"javascript:bad()"}';
    const { container } = renderReplies([
      { msgType: "text", text: "First\n\n<b>literal HTML</b>" },
      { msgType: "post", text: "Native title\nRead\n", post },
      { msgType: "interactive", raw: card },
    ]);
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
      const { container } = renderReplies([{ msgType, filename: "actual-attachment.bin", fileKey: "file_native_id" }]);
      expect(screen.getByText(/actual-attachment.bin/)).toBeTruthy();
      expect(container.querySelectorAll("a,img,audio,video")).toHaveLength(0);
    },
  );

  it("labels a truncated body even when the surviving text is readable", () => {
    renderReplies([{ msgType: "text", text: "Surviving text", unavailable: "content_truncated" }]);
    expect(screen.getByText("Surviving text")).toBeTruthy();
    expect(screen.getByText("This reply was truncated.")).toBeTruthy();
  });

  it("says a reply's content is unavailable when the read failed and nothing survived", () => {
    renderReplies([{ msgType: "text", unavailable: "content_read_failed" }]);

    expect(screen.getByText("Content unavailable")).toBeTruthy();
  });

  it("shows whatever survived a failed read rather than only reporting the failure", () => {
    renderReplies([{ msgType: "text", text: "Partial text", unavailable: "content_read_failed" }]);

    expect(screen.getByText("Partial text")).toBeTruthy();
    expect(screen.queryByText("Content unavailable")).toBeNull();
  });

  it("prefers the native post payload and falls back to the raw one", () => {
    const post = { title: "Native title" };
    const { unmount } = renderReplies([{ msgType: "post", post }]);
    fireEvent.click(screen.getByRole("button", { name: "Message details" }));
    expect(document.querySelector('[data-content-format="raw"]')?.textContent).toBe(JSON.stringify(post, null, 2));
    unmount();

    renderReplies([{ msgType: "post", raw: '{"raw":true}' }]);
    fireEvent.click(screen.getByRole("button", { name: "Message details" }));
    expect(document.querySelector('[data-content-format="raw"]')?.textContent).toBe('{"raw":true}');
  });

  it("shows a post's own text above its native payload", () => {
    renderReplies([{ msgType: "post", text: "Post text", raw: "{}" }]);

    expect(screen.getByText("Post text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Message details" })).toBeTruthy();
  });

  it("falls back to the post payload for a card that carries only one of the two", () => {
    const post = { header: { title: "Card title" } };
    renderReplies([{ msgType: "interactive", post }]);

    fireEvent.click(screen.getByRole("button", { name: "Message details" }));
    expect(document.querySelector('[data-content-format="raw"]')?.textContent).toBe(JSON.stringify(post, null, 2));
  });

  it("labels a card's own body as a card rather than as the raw message type", () => {
    renderReplies([{ msgType: "interactive", raw: "{}" }]);

    // "Card" appears both in the meta line and beside the payload; both are the product word.
    expect(screen.getAllByText("Card").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("interactive")).toBeNull();
  });

  it("falls back through text, then raw, then unavailable", () => {
    const { unmount } = renderReplies([{ msgType: "share_chat", text: "Shared text" }]);
    expect(screen.getByText("Shared text")).toBeTruthy();
    unmount();

    const second = renderReplies([{ msgType: "share_chat", raw: '{"k":1}' }]);
    fireEvent.click(screen.getByRole("button", { name: "Message details" }));
    expect(document.querySelector('[data-content-format="raw"]')?.textContent).toBe('{"k":1}');
    second.unmount();

    renderReplies([{ msgType: "share_chat" }]);
    expect(screen.getByText("Content unavailable")).toBeTruthy();
  });

  it("says a native payload is unavailable when there is nothing behind it", () => {
    renderReplies([{ msgType: "interactive" }]);

    expect(screen.getByText("Content unavailable")).toBeTruthy();
  });

  it("does not invent an attachment line for a media reply with no locator at all", () => {
    renderReplies([{ msgType: "image" }]);

    // The type label alone is not a description of anything, so the reader gets the unavailable line.
    expect(screen.getByText("Content unavailable")).toBeTruthy();
  });

  it("lists every locator a media reply carries, so nothing is silently dropped", () => {
    renderReplies([{ msgType: "image", filename: "a.png", fileKey: "file_1", imageKey: "img_1" }]);

    expect(screen.getByText("Image · a.png · file_1 · img_1")).toBeTruthy();
  });

  it("names each reply kind in product language, and an unrecognized one generically", () => {
    renderReplies([
      { msgType: "share_chat" },
      { msgType: "share_user" },
      { msgType: "sticker" },
      { msgType: "audio" },
      { msgType: "video" },
      { msgType: "file", fileKey: "file_1" },
      { msgType: "media", fileKey: "file_1" },
      // A kind the client does not know about yet still has to render something.
      { msgType: "future_kind" as Content["msgType"], raw: "{}" },
    ]);

    for (const label of ["Shared chat", "Shared contact", "Sticker", "Audio", "Video", "File", "Media", "Message"]) {
      expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
    }
  });

  it("reads a numeric reply time as an epoch and an ISO one as a date", () => {
    const withTimes: Reply[] = [
      {
        provider: "feishu",
        teamBrand: "lark",
        messageId: "om_epoch",
        chatId: "oc_chat",
        createTime: "1757980800000",
        content: { msgType: "text", text: "epoch" },
      },
      {
        provider: "feishu",
        teamBrand: "lark",
        messageId: "om_iso",
        chatId: "oc_chat",
        createTime: "2026-09-16T00:00:00.000Z",
        content: { msgType: "text", text: "iso" },
      },
      {
        provider: "feishu",
        teamBrand: "lark",
        messageId: "om_bad",
        chatId: "oc_chat",
        createTime: "not a date",
        content: { msgType: "text", text: "bad" },
      },
    ];
    render(withTimes.map((reply) => <TaskOutgoingReply key={reply.messageId} reply={reply} />));

    // Both real times are formatted; an unparseable one is dropped rather than shown as Invalid Date.
    const meta = [...document.querySelectorAll('[data-ui="task-sent-reply"] small')].map((node) => node.textContent);
    expect(meta[0]).toContain("·");
    expect(meta[1]).toContain("·");
    expect(meta[2]).toBe("Text");
    expect(meta[2]).not.toContain("Invalid");
  });

  it("always shows the reply kind, even when there is no time to show beside it", () => {
    renderReplies([{ msgType: "interactive", raw: "{}" }]);

    // The meta line is kind-only here: the time is absent, and the kind is never dropped with it.
    expect(document.querySelector('[data-ui="task-sent-reply"] small')?.textContent).toBe("Card");
  });
});
