import { describe, expect, it } from "vitest";
import { feishuMessageContent } from "../services/im-bindings/feishu/message-content.js";
import { normalizeSlackEnvelope } from "../services/im-bindings/slack/adapter.js";
import { slackMessageContent } from "../services/im-bindings/slack/message-content.js";

describe("native IM format normalization", () => {
  it.each([
    [{ bold: true }, "**cedar**"],
    [{ italic: true }, "*cedar*"],
    [{ strike: true }, "~~cedar~~"],
    [{ code: true }, "`cedar`"],
    [{ bold: true, italic: true, strike: true }, "~~***cedar***~~"],
    [{ bold: "true", italic: false }, "cedar"],
    [{ underline: true, lineThrough: true }, "cedar"],
  ])("preserves Slack inline styles %j", (style, expected) => {
    expect(
      slackMessageContent({
        blocks: [
          {
            type: "rich_text",
            elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "cedar", style }] }],
          },
        ],
      }).text,
    ).toBe(expected);
  });

  it("keeps backticks in Slack inline code and styles on links and mentions", () => {
    const parsed = slackMessageContent({
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "a`b", style: { code: true } },
                { type: "link", text: "docs", url: "https://example.com", style: { bold: true } },
                { type: "user", user_id: "U123", style: { italic: true } },
              ],
            },
          ],
        },
      ],
    });
    expect(parsed.text).toBe("``a`b``**[docs](https://example.com)***<@U123>*");
    expect(parsed.mentionIds).toEqual(["U123"]);
  });

  it.each([
    ["`cedar`", "`` `cedar` ``"],
    [" cedar ", "`  cedar  `"],
    ["  ", "`  `"],
  ])("preserves code delimiters and spaces in %j", (text, expected) => {
    expect(
      slackMessageContent({
        blocks: [
          {
            type: "rich_text",
            elements: [{ type: "rich_text_section", elements: [{ type: "text", text, style: { code: true } }] }],
          },
        ],
      }).text,
    ).toBe(expected);
  });

  it.each([
    [["bold"], "**cedar**"],
    [["italic"], "*cedar*"],
    [["lineThrough"], "~~cedar~~"],
    [["underline"], "<u>cedar</u>"],
    [["bold", "underline"], "<u>**cedar**</u>"],
    [["unknown"], "cedar"],
    [["code", "strike"], "cedar"],
  ])("preserves Feishu structured styles %j", (style, expected) => {
    expect(
      feishuMessageContent("post", JSON.stringify({ content: [[{ tag: "text", text: "cedar", style }]] })).text,
    ).toBe(expected);
  });

  it("preserves Feishu link and mention styles with their native identity", () => {
    const parsed = feishuMessageContent(
      "post",
      JSON.stringify({
        content: [
          [
            { tag: "at", user_id: "ou_1", style: ["lineThrough"] },
            { tag: "a", text: "docs", href: "https://example.com", style: ["bold"] },
          ],
        ],
      }),
      [{ key: "@_user_1", id: { open_id: "ou_1" }, name: "User" }],
    );
    expect(parsed.text).toBe("~~@_user_1~~**[docs](https://example.com)**");
  });

  it("prefers original Feishu content_v2 Markdown over its downgraded text copy", () => {
    const markdown = "| Name | Count |\n| --- | --- |\n| cedar | 2 |";
    const parsed = feishuMessageContent(
      "post",
      JSON.stringify({
        content: [
          [
            { tag: "text", text: "downgraded table" },
            { tag: "img", image_key: "img_1" },
          ],
        ],
        content_v2: [[{ tag: "md", text: markdown }]],
      }),
    );
    expect(parsed.text).toBe(`${markdown}\n[Attachment 1]`);
    expect(parsed.resources).toEqual([{ type: "image", fileKey: "img_1" }]);
  });

  it("keeps attachment markers once when both Feishu representations contain resources", () => {
    const parsed = feishuMessageContent(
      "post",
      JSON.stringify({
        content: [[{ tag: "img", image_key: "img_1" }]],
        content_v2: [
          [
            { tag: "md", text: "**cedar**" },
            { tag: "img", image_key: "img_1" },
          ],
        ],
      }),
    );
    expect(parsed.text).toBe("**cedar**[Attachment 1]");
    expect(parsed.resources).toEqual([{ type: "image", fileKey: "img_1" }]);
  });

  it.each(["message", "app_mention"])("keeps top-level Slack bot mentions when blocks supply the body: %s", (type) => {
    const [event] = normalizeSlackEnvelope({
      eventId: "Ev-block-mention",
      appId: "A1",
      teamId: "T1",
      botUserId: "U123BOT",
      botId: "B1",
      event: {
        type,
        channel: "C1",
        ts: "1.0",
        text: "<@U123BOT> inspect the image",
        blocks: [{ type: "image", image_url: "https://example.com/qa.png", alt_text: "image" }],
      },
    });
    expect(event?.mentions[0]?.externalId).toBe("U123BOT");
    expect(event?.message.content.fallbackText).toContain("Attachment 1");
    expect(event?.message.content.fallbackText).not.toContain("inspect the image");
  });

  it("retains Slack app_mention routing even without a rendered mention token", () => {
    const [event] = normalizeSlackEnvelope({
      eventId: "Ev-app-mention",
      appId: "A1",
      teamId: "T1",
      botUserId: "U123BOT",
      botId: "B1",
      event: { type: "app_mention", channel: "C1", ts: "1.0", text: "inspect this", blocks: [{ type: "divider" }] },
    });
    expect(event?.mentions).toEqual([{ externalId: "U123BOT", displayName: null }]);
  });

  it.each([
    "https://files.slack.com/files-pri/T0123456-F0123456/xyz.png",
    "https://first-tree.slack.com/files/U0123456/F0123456/xyz.png",
  ])("preserves URL-only Slack image references with stable file identity: %s", (url) => {
    const parsed = slackMessageContent({
      blocks: [{ type: "image", slack_file: { url }, alt_text: "kitten" }],
    });
    expect(parsed.resources).toEqual([
      { providerResourceKey: "F0123456", kind: "image", filename: null, mediaType: null, sizeBytes: null },
    ]);
    expect(parsed.text).not.toContain("reference unavailable");
    expect(parsed.text).not.toContain(url);
    expect(
      slackMessageContent({
        blocks: [
          { type: "image", slack_file: { url } },
          { type: "image", slack_file: { id: "F0123456" } },
        ],
        files: [{ id: "F0123456", name: "kitten.png", mimetype: "image/png" }],
      }).resources,
    ).toEqual([
      {
        providerResourceKey: "F0123456",
        kind: "image",
        filename: "kitten.png",
        mediaType: "image/png",
        sizeBytes: null,
      },
    ]);
  });

  it.each([
    "https://files.slack.com.evil.example/files-pri/T0123456-F0123456/xyz.png",
    "https://evil.example/files/U0123456/F0123456/xyz.png",
    "https://user:password@files.slack.com/files-pri/T0123456-F0123456/xyz.png",
    "https://files.slack.com/unknown/xyz.png",
  ])("does not reinterpret unsupported URL references as Slack file IDs: %s", (url) => {
    const parsed = slackMessageContent({ blocks: [{ type: "image", slack_file: { url }, alt_text: "image" }] });
    expect(parsed.resources).toEqual([]);
    expect(parsed.text).toContain("reference unavailable");
  });

  it.each([false, true])("keeps a documented Slack rich-text file_id, with metadata: %s", (withMetadata) => {
    const parsed = slackMessageContent({
      blocks: [
        {
          type: "rich_text",
          elements: [{ type: "rich_text_section", elements: [{ type: "file", file_id: "F123ABC456" }] }],
        },
      ],
      ...(withMetadata ? { files: [{ id: "F123ABC456", name: "report.pdf", mimetype: "application/pdf" }] } : {}),
    });
    expect(parsed.text).toContain("Attachment 1");
    expect(parsed.resources).toEqual([
      {
        providerResourceKey: "F123ABC456",
        kind: "file",
        filename: withMetadata ? "report.pdf" : null,
        mediaType: withMetadata ? "application/pdf" : null,
        sizeBytes: null,
      },
    ]);
  });

  it.each(["structure", "mrkdwn", "fallback"])(
    "routes a Slack bot mention beyond the text and mention budgets in %s",
    (shape) => {
      const prefix = `${Array.from({ length: 256 }, (_, i) => `<@U${i}>`).join(" ")}${"x".repeat(25 * 1024)}`;
      const [event] = normalizeSlackEnvelope({
        eventId: "Ev-long-mention",
        appId: "A1",
        teamId: "T1",
        botUserId: "U123BOT",
        botId: "B1",
        event: {
          type: "message",
          channel: "C1",
          ts: "1.0",
          ...(shape === "fallback"
            ? { text: `${prefix}<@U123BOT>` }
            : {
                blocks: [
                  {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements:
                          shape === "structure"
                            ? [
                                { type: "text", text: prefix },
                                { type: "user", user_id: "U123BOT" },
                              ]
                            : [{ type: "mrkdwn", text: `${prefix}<@U123BOT>` }],
                      },
                    ],
                  },
                ],
              }),
        },
      });
      expect(event?.message.content.truncated).toBe(true);
      expect(Buffer.byteLength(event?.message.content.fallbackText ?? "")).toBeLessThanOrEqual(24 * 1024);
      expect(event?.mentions).toHaveLength(256);
      expect(event?.mentions[0]).toEqual({ externalId: "U123BOT", displayName: null });
    },
  );

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
        content_v2: [
          [{ tag: "md", text: "@_user_1 [docs](https://example.com/docs)\n```py\nprint(1)\n```\n![photo](img_1)" }],
        ],
      }),
      [{ key: "@_user_1", id: { open_id: "ou_1" }, name: "User" }],
    );
    for (const value of ["@_user_1", "https://example.com/docs", "```py", "![photo](img_1)"])
      expect(parsed.text).toContain(value);
    expect(parsed.text.match(/print\(1\)/g)).toHaveLength(1);
    expect(parsed.resources).toEqual([{ type: "image", fileKey: "img_1" }]);
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
