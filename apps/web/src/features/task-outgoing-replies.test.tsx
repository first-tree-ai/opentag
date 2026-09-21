import type { TaskTurn } from "@opentag/shared/browser";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskOutgoingReplies } from "./task-outgoing-replies.js";

type Snapshot = NonNullable<NonNullable<TaskTurn["report"]>["outgoingReplies"]>;
type Content = Snapshot["replies"][number]["content"];
function snapshot(contents: Content[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    status: "complete",
    replies: contents.map((content, index) => ({
      provider: "feishu",
      teamBrand: "lark",
      messageId: `om_${index}`,
      chatId: "oc_chat",
      content,
    })),
    ...extra,
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

  it("says a reply's content is unavailable when the read failed and nothing survived", () => {
    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "text", unavailable: "content_read_failed" }])} />);

    expect(screen.getByText("Content unavailable")).toBeTruthy();
  });

  it("shows whatever survived a failed read rather than only reporting the failure", () => {
    render(
      <TaskOutgoingReplies
        snapshot={snapshot([{ msgType: "text", text: "Partial text", unavailable: "content_read_failed" }])}
      />,
    );

    expect(screen.getByText("Partial text")).toBeTruthy();
    expect(screen.queryByText("Content unavailable")).toBeNull();
  });

  it("prefers the native post payload and falls back to the raw one", () => {
    const post = { title: "Native title" };
    const { unmount } = render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "post", post }])} />);
    fireEvent.click(screen.getByRole("button", { name: "Message details" }));
    expect(document.querySelector('[data-content-format="raw"]')?.textContent).toBe(JSON.stringify(post, null, 2));
    unmount();

    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "post", raw: '{"raw":true}' }])} />);
    fireEvent.click(screen.getByRole("button", { name: "Message details" }));
    expect(document.querySelector('[data-content-format="raw"]')?.textContent).toBe('{"raw":true}');
  });

  it("shows a post's own text above its native payload", () => {
    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "post", text: "Post text", raw: "{}" }])} />);

    expect(screen.getByText("Post text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Message details" })).toBeTruthy();
  });

  it("falls back to the post payload for a card that carries only one of the two", () => {
    const post = { header: { title: "Card title" } };
    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "interactive", post }])} />);

    fireEvent.click(screen.getByRole("button", { name: "Message details" }));
    expect(document.querySelector('[data-content-format="raw"]')?.textContent).toBe(JSON.stringify(post, null, 2));
  });

  it("labels a card's own body as a card rather than as the raw message type", () => {
    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "interactive", raw: "{}" }])} />);

    // "Card" appears both in the meta line and beside the payload; both are the product word.
    expect(screen.getAllByText("Card").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("interactive")).toBeNull();
  });

  it("falls back through text, then raw, then unavailable", () => {
    const { unmount } = render(
      <TaskOutgoingReplies snapshot={snapshot([{ msgType: "share_chat", text: "Shared text" }])} />,
    );
    expect(screen.getByText("Shared text")).toBeTruthy();
    unmount();

    const second = render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "share_chat", raw: '{"k":1}' }])} />);
    fireEvent.click(screen.getByRole("button", { name: "Message details" }));
    expect(document.querySelector('[data-content-format="raw"]')?.textContent).toBe('{"k":1}');
    second.unmount();

    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "share_chat" }])} />);
    expect(screen.getByText("Content unavailable")).toBeTruthy();
  });

  it("says a native payload is unavailable when there is nothing behind it", () => {
    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "interactive" }])} />);

    expect(screen.getByText("Content unavailable")).toBeTruthy();
  });

  it("does not invent an attachment line for a media reply with no locator at all", () => {
    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "image" }])} />);

    // The type label alone is not a description of anything, so the reader gets the unavailable line.
    expect(screen.getByText("Content unavailable")).toBeTruthy();
  });

  it("lists every locator a media reply carries, so nothing is silently dropped", () => {
    render(
      <TaskOutgoingReplies
        snapshot={snapshot([{ msgType: "image", filename: "a.png", fileKey: "file_1", imageKey: "img_1" }])}
      />,
    );

    expect(screen.getByText("Image · a.png · file_1 · img_1")).toBeTruthy();
  });

  it("names each reply kind in product language, and an unrecognized one generically", () => {
    render(
      <TaskOutgoingReplies
        snapshot={snapshot([
          { msgType: "share_chat" },
          { msgType: "share_user" },
          { msgType: "sticker" },
          { msgType: "audio" },
          { msgType: "video" },
          { msgType: "file", fileKey: "file_1" },
          { msgType: "media", fileKey: "file_1" },
          // A kind the client does not know about yet still has to render something.
          { msgType: "future_kind" as Content["msgType"], raw: "{}" },
        ])}
      />,
    );

    for (const label of ["Shared chat", "Shared contact", "Sticker", "Audio", "Video", "File", "Media", "Message"]) {
      expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0);
    }
  });

  it("reads a numeric reply time as an epoch and an ISO one as a date", () => {
    const { unmount } = render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "text", text: "a" }], {})} />);
    unmount();

    // The time lives on the reply, not on its content, so it is set on the snapshot directly.
    const withTimes: Snapshot = {
      status: "complete",
      replies: [
        {
          provider: "feishu",
          teamBrand: "lark",
          messageId: "om_epoch",
          chatId: "oc_chat",
          createTime: "1757980800",
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
      ],
    };
    render(<TaskOutgoingReplies snapshot={withTimes} />);

    // Both real times are formatted; an unparseable one is dropped rather than shown as Invalid Date.
    const meta = [...document.querySelectorAll('[data-ui="task-sent-reply"] small')].map((node) => node.textContent);
    expect(meta[0]).toContain("·");
    expect(meta[1]).toContain("·");
    expect(meta[2]).toBe("Text");
    expect(meta[2]).not.toContain("Invalid");
  });

  it("always shows the reply kind, even when there is no time to show beside it", () => {
    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "interactive", raw: "{}" }])} />);

    // The meta line is kind-only here: the time is absent, and the kind is never dropped with it.
    expect(document.querySelector('[data-ui="task-sent-reply"] small')?.textContent).toBe("Card");
  });

  it("reports an incomplete history when replies were omitted rather than dropped", () => {
    render(<TaskOutgoingReplies snapshot={snapshot([{ msgType: "text", text: "Only one" }], { omittedCount: 3 })} />);

    expect(screen.getByText(/Reply history is incomplete/)).toBeTruthy();
  });

  it("keeps a complete history quiet", () => {
    render(
      <TaskOutgoingReplies snapshot={snapshot([{ msgType: "text", text: "All of them" }], { omittedCount: 0 })} />,
    );

    expect(screen.queryByText(/Reply history is incomplete/)).toBeNull();
  });
});
