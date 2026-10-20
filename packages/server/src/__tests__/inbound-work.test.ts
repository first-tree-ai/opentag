import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { InboundWorkSchema, inboundWorkRetryDelay, slackWorkEvent } from "../services/im/inbound-work.js";
import { normalizeSlackEnvelope } from "../services/im-bindings/slack/adapter.js";

const identity = { eventId: "Ev_input", appId: "A_INPUT", teamId: "T_INPUT", botUserId: "U_BOT", botId: "B_BOT" };
const work = (event: unknown) => ({
  version: 1,
  provider: "slack",
  bindingId: null,
  ...identity,
  identityClosed: true,
  revokesBot: false,
  event,
});

it.each(["slack-inbound-file-share-png.json", "slack-inbound-file-share-text.json"])(
  "preserves normalization of %s through the persisted input projection",
  (name) => {
    const source = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as {
      event: unknown;
    };
    expect(normalizeSlackEnvelope({ ...identity, event: slackWorkEvent(source.event) })).toEqual(
      normalizeSlackEnvelope({ ...identity, event: source.event }),
    );
  },
);

it.each(["created", "edited", "deleted"])(
  "preserves %s message content, routing, and revision through recovery",
  (operation) => {
    const canonical = {
      ts: "1.001",
      thread_ts: "1.000",
      user: "U_HUMAN",
      text: "<@U_BOT> hello",
      files: [
        { id: "F_IMAGE", name: "image.png", mimetype: "image/png", size: 100, private_download_token: "excluded" },
      ],
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "styled", style: { bold: true, italic: true, token: "excluded" } },
                { type: "link", url: "https://example.test", text: "docs" },
                { type: "user", user_id: "U_BOT" },
              ],
            },
          ],
        },
      ],
      attachments: [
        { title: "Attachment", fields: [{ title: "One", value: "Two" }], image_url: "https://example.test/image.png" },
      ],
    };
    const event = {
      type: "message",
      channel: "C_INPUT",
      channel_type: "channel",
      event_ts: "2.000",
      ...canonical,
      ...(operation === "edited" ? { subtype: "message_changed", message: canonical } : {}),
      ...(operation === "deleted"
        ? { subtype: "message_deleted", deleted_ts: "1.001", previous_message: canonical }
        : {}),
      token: "excluded",
      signing_secret: "excluded",
    };
    const projected = InboundWorkSchema.parse(work(event));
    expect(JSON.stringify(projected)).not.toContain("excluded");
    expect(normalizeSlackEnvelope({ ...identity, event: projected.event })).toEqual(
      normalizeSlackEnvelope({ ...identity, event }),
    );
  },
);

it("rejects oversized durable input and invalid versions before persistence", () => {
  expect(() => InboundWorkSchema.parse(work({ type: "message", text: "x".repeat(2 * 1024 * 1024) }))).toThrow(
    "Inbound work exceeds 2 MiB",
  );
  expect(() => InboundWorkSchema.parse({ ...work({ type: "message" }), version: 2 })).toThrow();
});

it("caps retry backoff without changing the attempt identity", () => {
  expect([1, 2, 3, 4, 5, 50].map(inboundWorkRetryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});
