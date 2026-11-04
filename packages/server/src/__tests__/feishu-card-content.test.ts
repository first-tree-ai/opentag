import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import { createReliableFeishuDispatcher, normalizeFeishuMessage } from "../services/im-bindings/feishu/adapter.js";
import { feishuMessageContent } from "../services/im-bindings/feishu/message-content.js";

const columns = {
  tag: "column_set",
  columns: [
    {
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [{ tag: "div", text: { tag: "plain_text", content: "W2-LEFT-739" } }],
    },
    {
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        { tag: "div", text: { tag: "plain_text", content: "W2-RIGHT-852" } },
        { tag: "img", img_key: "img_column", alt: { tag: "plain_text", content: "Column image" } },
      ],
    },
  ],
};

describe("Feishu column card delivery", () => {
  it.each([
    ["v1", { elements: [columns] }],
    ["v2", { schema: "2.0", body: { elements: [columns] } }],
  ])("preserves visible text and native image resources through raw %s admission", async (_version, card) => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    await dispatcher.invoke(
      {
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", event_id: "ev_column", tenant_key: "tenant_column" },
        event: {
          sender: { sender_id: { open_id: "ou_human" }, sender_type: "user" },
          message: {
            message_id: "om_column",
            chat_id: "oc_column",
            chat_type: "p2p",
            create_time: "1793750400000",
            message_type: "interactive",
            content: JSON.stringify(card),
          },
        },
      },
      { needCheck: false },
    );
    expect(received).toHaveLength(1);
    const message = received[0];
    if (!message) throw new Error("Column card was not admitted");
    const [event] = normalizeFeishuMessage({ appId: "cli_column", teamId: "tenant_column", message });
    expect(event?.message.content.fallbackText).toBe("W2-LEFT-739\nW2-RIGHT-852\n[Attachment 1]");
    expect(event?.message.resources).toEqual([
      { providerResourceKey: "img_column", kind: "image", filename: null, mediaType: null, sizeBytes: null },
    ]);
    expect(event?.message.content.truncated).toBe(false);
  });

  it("keeps the existing resource limit when images are inside columns", () => {
    const parsed = feishuMessageContent(
      "interactive",
      JSON.stringify({
        elements: [
          {
            tag: "column_set",
            columns: [
              {
                tag: "column",
                elements: Array.from({ length: 17 }, (_, i) => ({ tag: "img", img_key: `img_${i}` })),
              },
            ],
          },
        ],
      }),
    );
    expect(parsed.resources).toHaveLength(16);
    expect(parsed.truncated).toBe(true);
    expect(parsed.text).toContain("Additional attachment; read the source message");
  });
});
