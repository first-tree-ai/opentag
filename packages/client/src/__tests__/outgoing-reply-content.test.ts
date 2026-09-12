import { RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES, RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { contentFromBody } from "../runtime/provider-cli/outgoing-reply-content.js";

function body(content: unknown): Record<string, unknown> {
  return { content };
}

const oversized = "x".repeat(RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES + 16);

describe("contentFromBody", () => {
  describe("body payload parsing", () => {
    it("records an unparseable string body as raw with content_read_failed", () => {
      const result = contentFromBody("text", body("not json {"));
      expect(result).toEqual({
        content: { msgType: "text", raw: "not json {", unavailable: "content_read_failed" },
        truncated: false,
      });
    });

    it("bounds the raw copy of an unparseable body without flagging truncation", () => {
      const result = contentFromBody("text", body(oversized));
      expect(result.content.unavailable).toBe("content_read_failed");
      expect(Buffer.byteLength(result.content.raw ?? "", "utf8")).toBe(RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES);
      expect(result.truncated).toBe(false);
    });

    it("accepts an already parsed object body", () => {
      expect(contentFromBody("text", body({ text: "parsed" }))).toEqual({
        content: { msgType: "text", text: "parsed" },
        truncated: false,
      });
    });
  });

  describe("text", () => {
    it("extracts the text field from a JSON string body", () => {
      expect(contentFromBody("text", body(JSON.stringify({ text: "hello" })))).toEqual({
        content: { msgType: "text", text: "hello" },
        truncated: false,
      });
    });

    it("marks bodies without a string text field as unreadable", () => {
      for (const payload of [{}, { text: 1 }, [], "plain", null, 3]) {
        expect(contentFromBody("text", body(JSON.stringify(payload)))).toEqual({
          content: { msgType: "text", unavailable: "content_read_failed" },
          truncated: false,
        });
      }
    });

    it("truncates oversized text on a UTF-8 boundary and flags it", () => {
      const result = contentFromBody("text", body(JSON.stringify({ text: `${"a".repeat(8 * 1024 - 1)}你好` })));
      expect(result.truncated).toBe(true);
      expect(result.content.unavailable).toBe("content_truncated");
      expect(result.content.text).toBe("a".repeat(8 * 1024 - 1));
      expect(Buffer.byteLength(result.content.text ?? "", "utf8")).toBeLessThanOrEqual(
        RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES,
      );
    });
  });

  describe("post", () => {
    it("keeps the structured post alongside its plain-text rendering", () => {
      const post = { title: "Title", content: [[{ tag: "text", text: "body" }]] };
      expect(contentFromBody("post", body(JSON.stringify(post)))).toEqual({
        content: { msgType: "post", text: "Title\nbody", post },
        truncated: false,
      });
    });

    it("omits the text key when the post renders to nothing", () => {
      const result = contentFromBody("post", body(JSON.stringify({})));
      expect(result.content).toEqual({ msgType: "post", post: {} });
      expect("text" in result.content).toBe(false);
    });

    it("drops the structured post in favour of a bounded raw copy when it is oversized", () => {
      const post = { title: "T", content: [[{ tag: "text", text: oversized }]] };
      const result = contentFromBody("post", body(JSON.stringify(post)));
      expect(result.truncated).toBe(true);
      expect(result.content.msgType).toBe("post");
      expect(result.content.post).toBeUndefined();
      expect(result.content.unavailable).toBe("content_truncated");
      expect(Buffer.byteLength(result.content.raw ?? "", "utf8")).toBeLessThanOrEqual(
        RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES,
      );
      expect(Buffer.byteLength(result.content.text ?? "", "utf8")).toBeLessThanOrEqual(
        RUNTIME_OUTGOING_REPLY_TEXT_MAX_BYTES,
      );
    });

    it("flags truncation when only the raw copy exceeds the limit", () => {
      // Many short paragraphs keep the rendered text small while the JSON grows past the raw limit.
      const paragraphs = Array.from({ length: 400 }, () => [{ tag: "text", text: "p", extra: "z".repeat(40) }]);
      const result = contentFromBody("post", body(JSON.stringify({ content: paragraphs })));
      expect(result.truncated).toBe(true);
      expect(result.content.post).toBeUndefined();
      expect(result.content.text).toBe(Array.from({ length: 400 }, () => "p").join("\n"));
      expect(result.content.unavailable).toBe("content_truncated");
    });
  });

  describe("image and sticker", () => {
    it("prefers image_key and falls back to file_key", () => {
      expect(contentFromBody("image", body(JSON.stringify({ image_key: "img_1" })))).toEqual({
        content: { msgType: "image", imageKey: "img_1" },
        truncated: false,
      });
      expect(contentFromBody("sticker", body(JSON.stringify({ file_key: "file_1" })))).toEqual({
        content: { msgType: "sticker", imageKey: "file_1" },
        truncated: false,
      });
      expect(contentFromBody("image", body(JSON.stringify({ image_key: "", file_key: "file_2" })))).toEqual({
        content: { msgType: "image", imageKey: "file_2" },
        truncated: false,
      });
    });

    it("marks payloads without a key as unreadable", () => {
      for (const payload of [{}, { image_key: "" }, { image_key: 7 }, [], "s"]) {
        expect(contentFromBody("image", body(JSON.stringify(payload)))).toEqual({
          content: { msgType: "image", unavailable: "content_read_failed" },
          truncated: false,
        });
      }
    });
  });

  describe("file, audio, video and media", () => {
    it("copies the file key, filename and image key when present", () => {
      expect(
        contentFromBody("file", body(JSON.stringify({ file_key: "f_1", file_name: "report.pdf", image_key: "i_1" }))),
      ).toEqual({
        content: { msgType: "file", fileKey: "f_1", filename: "report.pdf", imageKey: "i_1" },
        truncated: false,
      });
    });

    it.each(["audio", "video", "media"] as const)("accepts a %s payload with only a file key", (msgType) => {
      expect(contentFromBody(msgType, body(JSON.stringify({ file_key: "f_2" })))).toEqual({
        content: { msgType, fileKey: "f_2" },
        truncated: false,
      });
    });

    it("accepts a media payload that only carries an image key", () => {
      expect(contentFromBody("media", body(JSON.stringify({ image_key: "cover" })))).toEqual({
        content: { msgType: "media", imageKey: "cover" },
        truncated: false,
      });
    });

    it("marks payloads without any key as unreadable while keeping the filename", () => {
      expect(contentFromBody("file", body(JSON.stringify({ file_name: "only-name" })))).toEqual({
        content: { msgType: "file", filename: "only-name", unavailable: "content_read_failed" },
        truncated: false,
      });
      expect(contentFromBody("file", body(JSON.stringify([])))).toEqual({
        content: { msgType: "file", unavailable: "content_read_failed" },
        truncated: false,
      });
    });
  });

  describe("other message types", () => {
    it("stores the payload as raw JSON", () => {
      const card = { elements: [{ tag: "div" }] };
      expect(contentFromBody("interactive", body(JSON.stringify(card)))).toEqual({
        content: { msgType: "interactive", raw: JSON.stringify(card) },
        truncated: false,
      });
    });

    it("falls back to the whole body when the payload is null", () => {
      const result = contentFromBody("share_chat", { content: null, extra: 1 });
      expect(result).toEqual({
        content: { msgType: "share_chat", raw: JSON.stringify({ content: null, extra: 1 }) },
        truncated: false,
      });
    });

    it("truncates oversized raw payloads and flags them", () => {
      const result = contentFromBody("unknown", body(JSON.stringify({ blob: oversized })));
      expect(result.truncated).toBe(true);
      expect(result.content.unavailable).toBe("content_truncated");
      expect(Buffer.byteLength(result.content.raw ?? "", "utf8")).toBeLessThanOrEqual(
        RUNTIME_OUTGOING_REPLY_RAW_MAX_BYTES,
      );
    });
  });
});
