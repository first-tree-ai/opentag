import { ImContentV1Schema } from "@opentag/shared";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { imBindings, imMessages } from "../db/schema/index.js";
import {
  ImOutboundCapture,
  OUTBOUND_CAPTURED_CONTENT_MAX_BYTES,
  type OutboundCaptureEvent,
  parseCapturedOutbound,
} from "../services/im/im-outbound-capture.js";

const OBSERVED_AT = new Date("2026-09-22T02:00:00.000Z");

function event(overrides: Partial<OutboundCaptureEvent> = {}): OutboundCaptureEvent {
  return {
    provider: "slack",
    operationId: "chat.postMessage",
    bindingId: "binding-1",
    pathParams: {},
    query: "",
    requestBody: { channel: "C0123ABCD", text: "request text" },
    responsePayload: {
      ok: true,
      channel: "C0123ABCD",
      ts: "1790042400.000100",
      message: {
        type: "message",
        subtype: "bot_message",
        bot_id: "B0123BOT",
        text: "Confirmed reply body",
        ts: "1790042400.000100",
      },
    },
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function feishuEvent(overrides: Partial<OutboundCaptureEvent> = {}): OutboundCaptureEvent {
  return {
    provider: "feishu",
    operationId: "feishu.im.messages.create",
    bindingId: "binding-1",
    pathParams: {},
    query: "receive_id_type=chat_id",
    requestBody: { receive_id: "oc_confirmed_chat", msg_type: "text", content: '{"text":"request text"}' },
    responsePayload: {
      code: 0,
      msg: "success",
      data: {
        message_id: "om_confirmed",
        chat_id: "oc_confirmed_chat",
        msg_type: "text",
        create_time: "1790042400000",
        sender: { id: "ou_bot", id_type: "open_id", sender_type: "app" },
        body: { content: '{"text":"Confirmed reply body"}' },
      },
    },
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function captured(value: OutboundCaptureEvent) {
  const result = parseCapturedOutbound(value);
  if (result.status !== "captured") throw new Error(`Expected a captured message, got ${result.status}`);
  // Every captured record must remain storable as canonical IM content.
  ImContentV1Schema.parse(result.message.content);
  return result.message;
}

/**
 * A Drizzle database over a scripted postgres-js client: query building stays real, and the test
 * controls exactly what each compiled statement returns.
 */
function fakeDatabase(unsafe: (sql: string, params: unknown[]) => unknown) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (sql: string, params: unknown[]) => {
      statements.push({ sql, params });
      return unsafe(sql, params);
    },
  };
  const database = drizzle(client as never, { schema: { imBindings, imMessages } }) as unknown as DatabaseClient;
  return { database, statements };
}

describe("parseCapturedOutbound operation filter", () => {
  it("observes exactly the three registered send/reply operations", () => {
    expect(captured(event()).externalMessageId).toBe("1790042400.000100");
    expect(captured(feishuEvent()).externalMessageId).toBe("om_confirmed");
    expect(
      captured(feishuEvent({ operationId: "feishu.im.messages.reply", pathParams: { message_id: "om_parent" } }))
        .replyTargetExternalId,
    ).toBe("om_parent");
  });

  it.each([
    ["slack", "chat.update"],
    ["slack", "reactions.add"],
    ["feishu", "feishu.im.messages.update"],
    ["feishu", "feishu.im.reactions.create"],
    ["github", "chat.postMessage"],
  ] as const)("ignores %s %s even when it succeeds", (provider, operationId) => {
    const result = parseCapturedOutbound(event({ provider, operationId }));
    expect(result).toEqual({ status: "skipped", reason: "operation_not_observed" });
  });
});

describe("parseCapturedOutbound Slack chat.postMessage", () => {
  it("captures the confirmed identity, body, and provider time from the response", () => {
    const message = captured(event());
    expect(message).toMatchObject({
      channelId: "C0123ABCD",
      externalMessageId: "1790042400.000100",
      threadKey: null,
      replyToExternalId: null,
      responseAuthorExternalId: "B0123BOT",
      timeSource: "provider",
      providerContext: { provider: "slack" },
    });
    // Slack ts fractions are microseconds; Date keeps millisecond precision.
    expect(message.occurredAt.toISOString()).toBe("2026-09-22T02:00:00.000Z");
    expect(message.content.fallbackText).toBe("Confirmed reply body");
    expect(message.content.outbound).toEqual({
      messageType: "bot_message",
      contentAvailable: true,
      timeSource: "provider",
    });
  });

  it("prefers the response thread and falls back to the verified request thread", () => {
    const fromResponse = captured(
      event({
        requestBody: { channel: "C0123ABCD", thread_ts: "1758500000.000001" },
        responsePayload: {
          ok: true,
          channel: "C0123ABCD",
          ts: "1790042400.000100",
          message: { type: "message", text: "In thread", thread_ts: "1758500000.000009" },
        },
      }),
    );
    expect(fromResponse.threadKey).toBe("1758500000.000009");
    expect(fromResponse.providerContext).toEqual({ provider: "slack", threadTs: "1758500000.000009" });

    const fromRequest = captured(event({ requestBody: { channel: "C0123ABCD", thread_ts: "1758500000.000001" } }));
    expect(fromRequest.threadKey).toBe("1758500000.000001");
  });

  it("reads the verified thread from a decoded Slack form body", () => {
    const message = captured(event({ requestBody: { channel: "C0123ABCD", text: "form", thread_ts: "1.5" } }));
    expect(message.threadKey).toBe("1.5");
  });

  it("keeps the confirmed send when the response carries no usable body", () => {
    const message = captured(
      event({
        responsePayload: { ok: true, channel: "C0123ABCD", ts: "1790042400.000100", message: { type: "message" } },
      }),
    );
    expect(message.externalMessageId).toBe("1790042400.000100");
    expect(message.content.outbound?.contentAvailable).toBe(false);
    expect(message.content.fallbackText).toBe("");
  });

  it("never uses the request text as the confirmed body", () => {
    const message = captured(event({ requestBody: { channel: "C0123ABCD", text: "only in the request" } }));
    expect(message.content.fallbackText).not.toBe("only in the request");
  });

  it("refuses a response whose confirmed channel contradicts the verified target id", () => {
    expect(
      parseCapturedOutbound(event({ responsePayload: { ok: true, channel: "C999OTHER", ts: "1790042400.000100" } })),
    ).toEqual({ status: "skipped", reason: "channel_mismatch" });
  });

  it("accepts a channel alias in the request because the response confirms the real id", () => {
    const message = captured(event({ requestBody: { channel: "#general" } }));
    expect(message.channelId).toBe("C0123ABCD");
  });

  it("skips a success-shaped response that lacks the confirmed message or target identity", () => {
    expect(parseCapturedOutbound(event({ responsePayload: { ok: true, channel: "C0123ABCD" } }))).toEqual({
      status: "skipped",
      reason: "message_identity_missing",
    });
    expect(
      parseCapturedOutbound(
        event({ requestBody: {}, responsePayload: { ok: true, ts: "1790042400.000100", message: {} } }),
      ),
    ).toEqual({ status: "skipped", reason: "channel_missing" });
  });

  it("labels an unparseable provider timestamp honestly as observed", () => {
    const message = captured(event({ responsePayload: { ok: true, channel: "C0123ABCD", ts: "not-a-time" } }));
    expect(message.timeSource).toBe("observed");
    expect(message.occurredAt).toEqual(OBSERVED_AT);
    expect(message.content.outbound?.timeSource).toBe("observed");
  });

  it("refuses a response whose top-level and nested message timestamps disagree", () => {
    expect(
      parseCapturedOutbound(
        event({
          responsePayload: {
            ok: true,
            channel: "C0123ABCD",
            ts: "1790042400.000100",
            message: { ts: "1790042401.000200", text: "fixture" },
          },
        }),
      ),
    ).toEqual({ status: "skipped", reason: "message_identity_conflict" });
  });

  it("accepts a user-id recipient when the response confirms the resulting DM channel", () => {
    const message = captured(
      event({
        requestBody: { channel: "U0123USER", text: "request text" },
        responsePayload: { ok: true, channel: "D0123DM", ts: "1790042400.000100", message: { text: "fixture" } },
      }),
    );
    expect(message.channelId).toBe("D0123DM");
  });

  it("never lets a request alias or user id stand in for an unconfirmed channel", () => {
    for (const channel of ["#general", "U0123USER"]) {
      expect(
        parseCapturedOutbound(
          event({
            requestBody: { channel },
            responsePayload: { ok: true, ts: "1790042400.000100", message: { text: "fixture" } },
          }),
        ),
      ).toEqual({ status: "skipped", reason: "channel_missing" });
    }
  });

  it("projects bounded legacy attachment descriptions alongside the message text", () => {
    const message = captured(
      event({
        responsePayload: {
          ok: true,
          channel: "C0123ABCD",
          ts: "1790042400.000100",
          message: {
            type: "message",
            text: "Deploy finished",
            attachments: [
              { pretext: "Build", title: "runbook", text: "see steps", fallback: "Deploy finished" },
              { image_url: "https://files.slack.com/secret-image" },
            ],
          },
        },
      }),
    );
    expect(message.content.fallbackText).toBe("Deploy finished\nBuild\nrunbook\nsee steps");
    expect(JSON.stringify(message.content)).not.toContain("secret-image");
  });

  it("projects Block Kit rich text when the response has no plain text", () => {
    const message = captured(
      event({
        responsePayload: {
          ok: true,
          channel: "C0123ABCD",
          ts: "1790042400.000100",
          message: {
            type: "message",
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: "Section body" } },
              {
                type: "rich_text",
                elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Rich body" }] }],
              },
            ],
          },
        },
      }),
    );
    expect(message.content.fallbackText).toBe("Section body\nRich body");
  });

  it("is defensive about business failures even though the caller only forwards successes", () => {
    expect(parseCapturedOutbound(event({ responsePayload: { ok: false, error: "channel_not_found" } }))).toEqual({
      status: "skipped",
      reason: "platform_not_successful",
    });
  });
});

describe("parseCapturedOutbound Feishu create/reply", () => {
  it("captures the confirmed text body, chat, sender, and provider time", () => {
    const message = captured(feishuEvent());
    expect(message).toMatchObject({
      channelId: "oc_confirmed_chat",
      externalMessageId: "om_confirmed",
      responseAuthorExternalId: "ou_bot",
      timeSource: "provider",
      providerContext: { provider: "feishu" },
    });
    expect(message.occurredAt.toISOString()).toBe("2026-09-22T02:00:00.000Z");
    expect(message.content.fallbackText).toBe("Confirmed reply body");
    expect(message.content.outbound).toEqual({ messageType: "text", contentAvailable: true, timeSource: "provider" });
  });

  it("confirms the chat from the response when the receive id is not a chat id", () => {
    const message = captured(
      feishuEvent({ query: "receive_id_type=open_id", requestBody: { receive_id: "ou_someone" } }),
    );
    expect(message.channelId).toBe("oc_confirmed_chat");
    expect(
      parseCapturedOutbound(
        feishuEvent({
          query: "receive_id_type=open_id",
          requestBody: { receive_id: "ou_someone" },
          responsePayload: { code: 0, data: { message_id: "om_x", msg_type: "text" } },
        }),
      ),
    ).toEqual({ status: "skipped", reason: "channel_missing" });
  });

  it("refuses a confirmed chat that contradicts the verified chat_id target", () => {
    expect(
      parseCapturedOutbound(
        feishuEvent({
          responsePayload: { code: 0, data: { message_id: "om_x", chat_id: "oc_other", msg_type: "text" } },
        }),
      ),
    ).toEqual({ status: "skipped", reason: "channel_mismatch" });
  });

  it("resolves reply thread, root, and parent from the platform response", () => {
    const message = captured(
      feishuEvent({
        operationId: "feishu.im.messages.reply",
        pathParams: { message_id: "om_parent" },
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_child",
            chat_id: "oc_confirmed_chat",
            root_id: "om_root",
            parent_id: "om_parent",
            thread_id: "omt_topic",
            msg_type: "text",
            create_time: "1790042400000",
            body: { content: '{"text":"In the topic"}' },
          },
        },
      }),
    );
    expect(message.threadKey).toBe("omt_topic");
    expect(message.replyToExternalId).toBe("om_parent");
    expect(message.providerContext).toEqual({
      provider: "feishu",
      threadId: "omt_topic",
      rootId: "om_root",
      parentId: "om_parent",
    });
  });

  it("falls back to the verified reply target as the parent when the response omits it", () => {
    const message = captured(
      feishuEvent({
        operationId: "feishu.im.messages.reply",
        pathParams: { message_id: "om_parent" },
        responsePayload: {
          code: 0,
          data: { message_id: "om_child", chat_id: "oc_confirmed_chat", msg_type: "text" },
        },
      }),
    );
    expect(message.threadKey).toBeNull();
    expect(message.replyToExternalId).toBe("om_parent");
    expect(message.providerContext).toEqual({ provider: "feishu", parentId: "om_parent" });
  });

  it("extracts bounded plain text from a post body", () => {
    const message = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_post",
            chat_id: "oc_confirmed_chat",
            msg_type: "post",
            create_time: "1790042400000",
            body: {
              content: JSON.stringify({
                title: "Deploy report",
                content: [
                  [
                    { tag: "text", text: "Finished " },
                    { tag: "a", text: "runbook", href: "https://example.com" },
                  ],
                  [{ tag: "at", user_id: "ou_mia", user_name: "Mia" }],
                ],
              }),
            },
          },
        },
      }),
    );
    expect(message.content.fallbackText).toBe("Deploy report\nFinished runbook\n@Mia");
    expect(message.content.outbound?.contentAvailable).toBe(true);
    expect(message.content.outbound?.messageType).toBe("post");
  });

  it("keeps image sends as a bounded resource descriptor without any signed URL", () => {
    const message = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_img",
            chat_id: "oc_confirmed_chat",
            msg_type: "image",
            create_time: "1790042400000",
            body: { content: '{"image_key":"img_v3_confirmed"}' },
          },
        },
      }),
    );
    expect(message.content.outbound?.contentAvailable).toBe(true);
    expect(message.content.resources).toEqual([
      {
        providerResourceKey: "img_v3_confirmed",
        kind: "image",
        filename: null,
        mediaType: null,
        sizeBytes: null,
        ordinal: 0,
      },
    ]);
    expect(JSON.stringify(message.content)).not.toContain("http");
  });

  it("marks card and other unsupported types as sent with unavailable content", () => {
    const message = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_card",
            chat_id: "oc_confirmed_chat",
            msg_type: "interactive",
            create_time: "1790042400000",
            body: { content: '{"elements":[]}' },
          },
        },
      }),
    );
    expect(message.content.outbound?.contentAvailable).toBe(false);
    expect(message.content.outbound?.messageType).toBe("interactive");
    expect(message.content.blocks).toEqual([{ type: "unsupported", providerType: "interactive" }]);
  });

  it("marks a missing body as unavailable without dropping the confirmed identity", () => {
    const message = captured(
      feishuEvent({ responsePayload: { code: 0, data: { message_id: "om_empty", chat_id: "oc_confirmed_chat" } } }),
    );
    expect(message.externalMessageId).toBe("om_empty");
    expect(message.content.outbound?.contentAvailable).toBe(false);
    expect(message.timeSource).toBe("observed");
  });

  it("refuses an ordinary reply whose response parent contradicts the requested target", () => {
    expect(
      parseCapturedOutbound(
        feishuEvent({
          operationId: "feishu.im.messages.reply",
          pathParams: { message_id: "om_requested" },
          responsePayload: {
            code: 0,
            data: {
              message_id: "om_new",
              chat_id: "oc_confirmed_chat",
              parent_id: "om_different",
              msg_type: "text",
              body: { content: '{"text":"fixture"}' },
            },
          },
        }),
      ),
    ).toEqual({ status: "skipped", reason: "reply_target_conflict" });
  });

  it("keeps a thread reply whose response parent is the thread root", () => {
    const message = captured(
      feishuEvent({
        operationId: "feishu.im.messages.reply",
        pathParams: { message_id: "om_target" },
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_new",
            chat_id: "oc_confirmed_chat",
            root_id: "om_root",
            parent_id: "om_root",
            thread_id: "omt_topic",
            msg_type: "text",
            body: { content: '{"text":"fixture"}' },
          },
        },
      }),
    );
    expect(message.threadKey).toBe("omt_topic");
    expect(message.replyToExternalId).toBe("om_root");
  });

  it("extracts text from a locale-wrapped post body", () => {
    const message = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_post_locale",
            chat_id: "oc_confirmed_chat",
            msg_type: "post",
            body: {
              content: JSON.stringify({
                zh_cn: { title: "部署报告", content: [[{ tag: "text", text: "完成" }]] },
              }),
            },
          },
        },
      }),
    );
    expect(message.content.fallbackText).toBe("部署报告\n完成");
    expect(message.content.outbound?.contentAvailable).toBe(true);
  });

  it("falls back to the post markdown body when the tagged form has no text", () => {
    const message = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_post_v2",
            chat_id: "oc_confirmed_chat",
            msg_type: "post",
            body: { content: JSON.stringify({ en_us: { title: "Post title", content_v2: "Markdown body" } }) },
          },
        },
      }),
    );
    expect(message.content.fallbackText).toBe("Post title\nMarkdown body");
  });

  it("excludes a signed-URL resource key without losing the confirmed message", () => {
    const message = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_new",
            chat_id: "oc_confirmed_chat",
            msg_type: "file",
            body: { content: JSON.stringify({ file_key: "https://files.example.test/download?token=fixture-secret" }) },
          },
        },
      }),
    );
    expect(message.externalMessageId).toBe("om_new");
    expect(message.content.resources).toBeUndefined();
    expect(message.content.outbound?.contentAvailable).toBe(false);
    expect(JSON.stringify(message.content)).not.toContain("fixture-secret");
  });

  it("maps each media type through its own documented key", () => {
    const imageWithFileKey = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_img",
            chat_id: "oc_confirmed_chat",
            msg_type: "image",
            body: { content: JSON.stringify({ file_key: "file_v3_fixture" }) },
          },
        },
      }),
    );
    expect(imageWithFileKey.content.resources).toBeUndefined();

    const fileWithImageKey = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_file",
            chat_id: "oc_confirmed_chat",
            msg_type: "file",
            body: { content: JSON.stringify({ image_key: "img_v3_fixture" }) },
          },
        },
      }),
    );
    expect(fileWithImageKey.content.resources).toBeUndefined();
  });

  it("does not treat a prototype property name as a media type", () => {
    const message = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_proto",
            chat_id: "oc_confirmed_chat",
            msg_type: "constructor",
            body: { content: JSON.stringify({ image_key: "img_v3_fixture" }) },
          },
        },
      }),
    );
    expect(message.content.resources).toBeUndefined();
    expect(message.content.blocks).toEqual([{ type: "unsupported", providerType: "constructor" }]);
  });
});

describe("parseCapturedOutbound bounded content", () => {
  it("truncates a confirmed body at 8 KiB without splitting a code point", () => {
    const text = `${"ab".repeat(4095)}字🙂`;
    const message = captured(
      event({
        responsePayload: {
          ok: true,
          channel: "C0123ABCD",
          ts: "1790042400.000100",
          message: { type: "message", text },
        },
      }),
    );
    expect(message.content.truncated).toBe(true);
    expect(new TextEncoder().encode(message.content.fallbackText).byteLength).toBeLessThanOrEqual(8 * 1024);
    expect(message.content.fallbackText.endsWith("字")).toBe(false);
    expect(message.content.fallbackText.endsWith("🙂")).toBe(false);
  });

  it("keeps an exactly-8-KiB body untruncated", () => {
    const text = "a".repeat(8 * 1024);
    const message = captured(
      event({
        responsePayload: { ok: true, channel: "C0123ABCD", ts: "1790042400.000100", message: { text } },
      }),
    );
    expect(message.content.truncated).toBe(false);
    expect(message.content.fallbackText).toBe(text);
  });

  it("keeps the captured record within 32 KiB of content JSON", () => {
    const text = "a".repeat(8 * 1024);
    const message = captured(
      feishuEvent({
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_big",
            chat_id: "oc_confirmed_chat",
            msg_type: "text",
            body: { content: JSON.stringify({ text }) },
          },
        },
      }),
    );
    expect(new TextEncoder().encode(JSON.stringify(message.content)).byteLength).toBeLessThanOrEqual(32 * 1024);
  });

  it("keeps the serialized content within 32 KiB even for 8,192 NUL characters", () => {
    const message = captured(
      event({
        responsePayload: {
          ok: true,
          channel: "C0123ABCD",
          ts: "1790042400.000100",
          message: { text: "\u0000".repeat(8192) },
        },
      }),
    );
    expect(message.externalMessageId).toBe("1790042400.000100");
    expect(Buffer.byteLength(JSON.stringify(message.content))).toBeLessThanOrEqual(OUTBOUND_CAPTURED_CONTENT_MAX_BYTES);
    expect(message.content.fallbackText).not.toContain("\u0000");
    expect(message.content.truncated).toBe(true);
  });

  it("truncates text whose JSON escaping would exceed the cap", () => {
    const message = captured(
      event({
        responsePayload: {
          ok: true,
          channel: "C0123ABCD",
          ts: "1790042400.000100",
          message: { text: "\u0001".repeat(8192) },
        },
      }),
    );
    expect(message.externalMessageId).toBe("1790042400.000100");
    expect(Buffer.byteLength(JSON.stringify(message.content))).toBeLessThanOrEqual(OUTBOUND_CAPTURED_CONTENT_MAX_BYTES);
    expect(message.content.fallbackText.length).toBeLessThan(8192);
    expect(message.content.truncated).toBe(true);
  });

  it("normalizes NUL and lone surrogates but keeps the rest of the display text", () => {
    const message = captured(
      event({
        responsePayload: {
          ok: true,
          channel: "C0123ABCD",
          ts: "1790042400.000100",
          message: { text: `Fixture ${String.fromCharCode(0)} ${String.fromCharCode(0xd800)} body` },
        },
      }),
    );
    expect(message.content.fallbackText).toBe("Fixture \uFFFD \uFFFD body");
    expect(message.content.truncated).toBe(true);
    expect(JSON.stringify(message.content)).not.toContain("\\u0000");
  });
});

describe("ImOutboundCapture bounded persistence", () => {
  it("cancels a statement that outlives the capture deadline", async () => {
    const state = { cancelled: 0 };
    const neverSettles = new Promise<unknown[]>(() => undefined);
    const { database } = fakeDatabase(() => {
      const pending = neverSettles as Promise<unknown[]> & { cancel(): unknown };
      pending.cancel = () => {
        state.cancelled += 1;
      };
      return pending;
    });
    const logs: unknown[] = [];
    const capture = new ImOutboundCapture(database, {
      deadlineMs: 20,
      logger: { error: (fields) => logs.push(fields), warn: (fields) => logs.push(fields) },
    });

    await capture.capture(event());

    expect(state.cancelled).toBe(1);
    expect(logs).toEqual([{ code: "IM_OUTBOUND_CAPTURE_TIMEOUT", provider: "slack", operationId: "chat.postMessage" }]);
  });

  it("logs only controlled identifiers when a statement throws", async () => {
    const { database } = fakeDatabase(() => {
      throw new Error("Failed query parameters include synthetic-private-body");
    });
    const logs: unknown[] = [];
    const capture = new ImOutboundCapture(database, {
      logger: { error: (fields) => logs.push(fields), warn: (fields) => logs.push(fields) },
    });

    await capture.capture(event());

    expect(logs).toEqual([{ code: "IM_OUTBOUND_CAPTURE_FAILED", provider: "slack", operationId: "chat.postMessage" }]);
    expect(JSON.stringify(logs)).not.toContain("synthetic-private-body");
  });

  it("constrains the stored reply parent lookup to the captured channel", async () => {
    const parent = {
      external_message_id: "om_root",
      thread_key: null,
      provider_context: { provider: "feishu", chatType: "p2p" },
    };
    let calls = 0;
    const { database, statements } = fakeDatabase(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve([{ external_bot_id: "ou_bot" }]);
      if (calls === 2) return Promise.resolve([parent]);
      return Promise.resolve([]);
    });
    const capture = new ImOutboundCapture(database);

    await capture.capture(
      feishuEvent({
        operationId: "feishu.im.messages.reply",
        pathParams: { message_id: "om_root" },
        responsePayload: {
          code: 0,
          data: {
            message_id: "om_child",
            chat_id: "oc_confirmed_chat",
            msg_type: "text",
            body: { content: '{"text":"fixture"}' },
          },
        },
      }),
    );

    const parentLookup = statements[1];
    expect(parentLookup?.sql).toContain('"channel_id"');
    expect(parentLookup?.params).toContain("oc_confirmed_chat");
    expect(statements).toHaveLength(3);
  });
});
