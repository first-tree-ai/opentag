import { describe, expect, it } from "vitest";
import { renderImContentText, truncateImText } from "../im-content-text.js";
import { ImContentV1Schema } from "../im-message.js";
import { runtimeByteString } from "../runtime-config.js";

describe("IM text projection", () => {
  it("preserves structured content once with code, links, quotes and attachment positions", () => {
    const content = ImContentV1Schema.parse({
      version: 1,
      fallbackText: "duplicate fallback",
      blocks: [
        { type: "text", text: "Read " },
        { type: "mention", externalId: "U1", label: "@User" },
        { type: "link", label: "docs", url: "https://example.com/docs" },
        { type: "code", language: "ts", text: "const a = 1" },
        { type: "quote", text: "first\nsecond" },
        { type: "image", resourceOrdinal: 0, label: "diagram" },
      ],
      resources: [
        { providerResourceKey: "F123", kind: "image", filename: "diagram.png", mediaType: "image/png", sizeBytes: 42 },
      ],
    });
    const text = renderImContentText({ content, provider: "slack", maxBytes: 16384 });
    for (const expected of [
      "@User",
      "https://example.com/docs",
      "```ts",
      "> first\n> second",
      "Attachment 1",
      '"file_id":"F123"',
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain("duplicate fallback");
  });

  it("makes attachment-only and unsupported messages meaningful without fetching anything", () => {
    const resource = {
      providerResourceKey: "file_1",
      kind: "video" as const,
      filename: null,
      mediaType: null,
      sizeBytes: null,
      availability: "unavailable" as const,
    };
    const text = renderImContentText({
      content: { fallbackText: "", resources: [resource] },
      provider: "feishu",
      maxBytes: 16384,
    });
    expect(text).toContain('"file_key":"file_1"');
    expect(text).toContain('"availability":"unavailable"');
    expect(
      renderImContentText({
        content: { fallbackText: "", blocks: [{ type: "unsupported", providerType: "sticker" }] },
        provider: "feishu",
        maxBytes: 16384,
      }),
    ).toContain("sticker");
    expect(renderImContentText({ content: { fallbackText: "  " }, provider: "slack", maxBytes: 16384 })).toBe("");
  });

  it("keeps stable identifiers and makes input truncation visible for multibyte content", () => {
    const text = renderImContentText({
      content: {
        fallbackText: "中文😀".repeat(10000),
        resources: [
          {
            providerResourceKey: "F_STABLE",
            kind: "file",
            filename: "合同😀".repeat(100),
            mediaType: null,
            sizeBytes: null,
          },
        ],
      },
      provider: "slack",
      maxBytes: 16384,
    });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
    expect(text).toContain("F_STABLE");
    expect(text).toContain("Content omitted");
    expect(text).not.toContain("\uFFFD");
    for (let bytes = 0; bytes < 16; bytes++) {
      const value = truncateImText("中😀文", bytes);
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(bytes);
      expect(value).not.toContain("\uFFFD");
    }
  });

  it("marks excessive resource metadata, deleted messages, and public URLs honestly", () => {
    const resources = Array.from({ length: 17 }, (_, i) => ({
      providerResourceKey: `https://example.com/${i}`,
      kind: "image" as const,
      filename: "名".repeat(512),
      mediaType: null,
      sizeBytes: null,
    }));
    const text = renderImContentText({ content: { fallbackText: "", resources }, provider: "slack", maxBytes: 1024 });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
    expect(text).toContain('"url":"https://example.com/0"');
    expect(text).toContain("Content omitted");
    expect(
      renderImContentText({
        content: { fallbackText: "old", resources },
        provider: "slack",
        maxBytes: 1024,
        deleted: true,
      }),
    ).toBe("[deleted]");
  });

  it("distinguishes a minimum byte violation from a maximum byte violation", () => {
    const schema = runtimeByteString(4, "too long", 1);
    expect(schema.safeParse("").error?.issues[0]?.message).toContain("at least 1");
    expect(schema.safeParse("中文").error?.issues[0]?.message).toBe("too long");
  });
});
