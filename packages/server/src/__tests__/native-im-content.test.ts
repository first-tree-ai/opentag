import { describe, expect, it } from "vitest";
import { feishuMessageContent } from "../services/im-bindings/feishu/message-content.js";
import { normalizeSlackEnvelope } from "../services/im-bindings/slack/adapter.js";
import { slackMessageContent } from "../services/im-bindings/slack/message-content.js";

describe("native IM format normalization", () => {
  it("reads Slack rich text and structural mentions without requiring top-level text", () => {
    const [event] = normalizeSlackEnvelope({
      eventId: "Ev1",
      appId: "A1",
      teamId: "T1",
      botUserId: "U123",
      botId: "B1",
      event: {
        type: "message",
        channel: "C1",
        ts: "1.0",
        user: "U2",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "user", user_id: "U123" },
                  { type: "text", text: " read " },
                  { type: "link", text: "docs", url: "https://example.com" },
                ],
              },
              {
                type: "rich_text_list",
                style: "ordered",
                elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "one" }] }],
              },
              { type: "rich_text_quote", elements: [{ type: "text", text: "quoted" }] },
              { type: "rich_text_preformatted", elements: [{ type: "text", text: "a=1" }] },
            ],
          },
        ],
      },
    });
    expect(event?.mentions).toEqual([{ externalId: "U123", displayName: null }]);
    expect(event?.message.content.blocks).toContainEqual({ type: "mention", externalId: "U123", label: "<@U123>" });
    for (const value of ["https://example.com", "1. one", "> quoted", "```\na=1"])
      expect(event?.message.content.fallbackText).toContain(value);
  });

  it("keeps Slack fields, cards, URLs and all media while deduplicating file references", () => {
    const parsed = slackMessageContent({
      text: "duplicate",
      files: [
        { id: "F1", name: "photo.png", mimetype: "image/png" },
        { id: "F2", mimetype: "audio/ogg" },
        { id: "F3", mimetype: "video/mp4" },
      ],
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Title" } },
        {
          type: "section",
          text: { type: "mrkdwn", text: "Body" },
          fields: [{ type: "plain_text", text: "Column: value" }],
          accessory: { type: "button", text: { type: "plain_text", text: "Open" }, url: "https://example.com/open" },
        },
        { type: "image", slack_file: { id: "F1" }, alt_text: "photo" },
        { type: "context", elements: [{ type: "image", image_url: "https://example.com/p.png", alt_text: "public" }] },
        {
          type: "table",
          rows: [
            [
              { type: "plain_text", text: "A" },
              { type: "plain_text", text: "B" },
            ],
          ],
        },
        { type: "new_block" },
      ],
      attachments: [
        {
          title: "Legacy",
          title_link: "https://example.com/legacy",
          text: "description",
          fields: [{ title: "Total", value: "42" }],
        },
      ],
    });
    expect(parsed.resources.map((v) => v.kind)).toEqual(["image", "image", "audio", "video"]);
    expect(parsed.resources.filter((v) => v.providerResourceKey === "F1")).toHaveLength(1);
    for (const value of [
      "Title",
      "Body",
      "Column: value",
      "https://example.com/open",
      "A | B",
      "Unsupported Slack block: new_block",
      "Total: 42",
    ])
      expect(parsed.text).toContain(value);
    expect(parsed.text).not.toContain("duplicate");
  });

  it("marks Slack resource overflow and bounds recursive content", () => {
    const parsed = slackMessageContent({
      files: Array.from({ length: 20 }, (_, i) => ({ id: `F${i}` })),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "中文😀".repeat(10000) } }],
    });
    expect(parsed.resources).toHaveLength(16);
    expect(parsed.truncated).toBe(true);
    expect(Buffer.byteLength(parsed.text)).toBeLessThanOrEqual(24 * 1024);
    expect(parsed.text).not.toContain("\uFFFD");
    let deep: unknown = { type: "plain_text", text: "hidden" };
    for (let i = 0; i < 30; i++) deep = { type: "rich_text", elements: [deep] };
    expect(slackMessageContent({ blocks: [deep] }).truncated).toBe(true);
  });

  it("reads image-only Feishu posts and separates video body from its cover", () => {
    const parsed = feishuMessageContent(
      "post",
      JSON.stringify({
        zh_cn: {
          title: "",
          content: [
            [{ tag: "img", image_key: "img_1" }],
            [{ tag: "media", file_key: "file_video", image_key: "img_cover" }],
          ],
        },
      }),
    );
    expect(parsed.text).toContain("Attachment 1");
    expect(parsed.resources).toEqual([
      { type: "image", fileKey: "img_1" },
      { type: "video", fileKey: "file_video" },
      { type: "image", fileKey: "img_cover" },
    ]);
    expect(feishuMessageContent("media", JSON.stringify({ file_key: "video", image_key: "cover" })).resources).toEqual([
      { type: "video", fileKey: "video" },
      { type: "image", fileKey: "cover" },
    ]);
  });

  it("preserves Feishu links, mention identity, markdown and media without duplicate prose", () => {
    const parsed = feishuMessageContent(
      "post",
      JSON.stringify({
        content: [
          [
            { tag: "at", user_id: "ou_1", user_name: "User" },
            { tag: "a", text: "docs", href: "https://example.com/docs" },
            { tag: "code_block", language: "py", text: "print(1)" },
            { tag: "img", image_key: "img_1" },
          ],
        ],
        content_v2: [[{ tag: "md", text: "duplicate" }]],
      }),
      [{ key: "@_user_1", id: { open_id: "ou_1" }, name: "User" }],
    );
    for (const value of ["@_user_1", "https://example.com/docs", "```py", "Attachment 1"])
      expect(parsed.text).toContain(value);
    expect(parsed.text).not.toContain("duplicate");
    const fallback = feishuMessageContent(
      "post",
      JSON.stringify({
        content: [[{ tag: "img", image_key: "img_1" }]],
        content_v2: [[{ tag: "md", text: "**markdown**" }]],
      }),
    );
    expect(fallback.text).toContain("**markdown**");
    expect(fallback.resources).toHaveLength(1);
  });

  it("keeps visible Feishu cards/share/forward content and honestly labels unknowns", () => {
    const card = feishuMessageContent(
      "interactive",
      JSON.stringify({
        header: { title: { tag: "plain_text", content: "Card" } },
        elements: [
          { tag: "div", text: { tag: "lark_md", content: "**answer 42**" } },
          { tag: "img", img_key: "img_card" },
          { tag: "button", text: { tag: "plain_text", content: "Open" }, url: "https://example.com" },
        ],
      }),
    );
    for (const value of ["Card", "**answer 42**", "Open", "https://example.com"]) expect(card.text).toContain(value);
    expect(card.resources).toContainEqual({ type: "image", fileKey: "img_card" });
    expect(feishuMessageContent("share_chat", '{"chat_id":"oc_1"}').text).toContain("oc_1");
    expect(
      feishuMessageContent("merge_forward", '{"messages":[{"sender":"Alice","create_time":"123","content":"hello"}]}')
        .text,
    ).toContain("hello");
    expect(feishuMessageContent("future", "{}").text).toContain("unsupported:future");
  });
});
