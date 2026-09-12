import { describe, expect, it } from "vitest";
import { postToPlainText } from "../runtime/provider-cli/outgoing-reply-post.js";

function paragraph(...elements: unknown[]): unknown[] {
  return elements;
}

describe("postToPlainText", () => {
  it("returns an empty string for non-object input", () => {
    expect(postToPlainText(undefined)).toBe("");
    expect(postToPlainText(null)).toBe("");
    expect(postToPlainText("text")).toBe("");
    expect(postToPlainText([{ tag: "text", text: "x" }])).toBe("");
  });

  describe("locale unwrapping", () => {
    it("uses a direct body when it carries content, content_v2, or a title", () => {
      expect(postToPlainText({ title: "Only title" })).toBe("Only title");
      expect(postToPlainText({ content: [paragraph({ tag: "text", text: "direct" })] })).toBe("direct");
      expect(postToPlainText({ content_v2: [paragraph({ tag: "text", text: "v2" })] })).toBe("v2");
    });

    it("prefers zh_cn, then en_us, then ja_jp", () => {
      const en = { content: [paragraph({ tag: "text", text: "english" })] };
      const zh = { content: [paragraph({ tag: "text", text: "中文" })] };
      const ja = { content: [paragraph({ tag: "text", text: "日本語" })] };
      expect(postToPlainText({ ja_jp: ja, en_us: en, zh_cn: zh })).toBe("中文");
      expect(postToPlainText({ ja_jp: ja, en_us: en })).toBe("english");
      expect(postToPlainText({ ja_jp: ja })).toBe("日本語");
    });

    it("falls back to any locale whose body has a content array", () => {
      expect(postToPlainText({ fr_fr: { content: [paragraph({ tag: "text", text: "bonjour" })] } })).toBe("bonjour");
      expect(postToPlainText({ de_de: { content_v2: [paragraph({ tag: "text", text: "hallo" })] } })).toBe("hallo");
    });

    it("renders nothing when no locale body can be found", () => {
      expect(postToPlainText({ fr_fr: { title: "no content array" } })).toBe("");
      expect(postToPlainText({ zh_cn: "not a record", other: 3 })).toBe("");
    });
  });

  describe("content blocks", () => {
    it("prefers a non-empty content_v2 over content and ignores an empty content_v2", () => {
      expect(
        postToPlainText({
          content: [paragraph({ tag: "text", text: "v1" })],
          content_v2: [paragraph({ tag: "text", text: "v2" })],
        }),
      ).toBe("v2");
      expect(postToPlainText({ content: [paragraph({ tag: "text", text: "v1" })], content_v2: [] })).toBe("v1");
    });

    it("skips an empty title and renders non-array paragraphs as blank lines", () => {
      expect(postToPlainText({ title: "", content: [paragraph({ tag: "text", text: "a" }), "oops", null] })).toBe(
        "a\n\n",
      );
      expect(postToPlainText({ content: "not-an-array" })).toBe("");
    });
  });

  describe("inline elements", () => {
    it("renders text and markdown verbatim and ignores malformed elements", () => {
      expect(
        postToPlainText({
          content: [paragraph({ tag: "text", text: "plain " }, { tag: "md", text: "**bold**" }, 42, { tag: 5 })],
        }),
      ).toBe("plain **bold**");
    });

    it("renders links with and without text or href", () => {
      expect(postToPlainText({ content: [paragraph({ tag: "a", text: "site", href: "https://x.test" })] })).toBe(
        "[site](https://x.test)",
      );
      expect(postToPlainText({ content: [paragraph({ tag: "a", href: "https://x.test" })] })).toBe("https://x.test");
      expect(postToPlainText({ content: [paragraph({ tag: "a", text: "bare" })] })).toBe("bare");
      expect(postToPlainText({ content: [paragraph({ tag: "a", href: 3 })] })).toBe("");
    });

    it("renders mentions for everyone, open IDs, names and bare IDs", () => {
      expect(postToPlainText({ content: [paragraph({ tag: "at", user_id: "@_all" })] })).toBe(
        '<at user_id="all"></at>',
      );
      expect(postToPlainText({ content: [paragraph({ tag: "at", user_id: "all", user_name: "x" })] })).toBe(
        '<at user_id="all"></at>',
      );
      expect(postToPlainText({ content: [paragraph({ tag: "at", user_id: "ou_123", user_name: "Ann" })] })).toBe(
        '<at user_id="ou_123">Ann</at>',
      );
      expect(postToPlainText({ content: [paragraph({ tag: "at", user_id: "u_123", user_name: "Ann" })] })).toBe("@Ann");
      expect(postToPlainText({ content: [paragraph({ tag: "at", user_id: "u_123" })] })).toBe("@u_123");
      expect(postToPlainText({ content: [paragraph({ tag: "at" })] })).toBe("@mention");
    });

    it("renders emotions, images and media embeds", () => {
      expect(postToPlainText({ content: [paragraph({ tag: "emotion", emoji_type: "SMILE" })] })).toBe(":SMILE:");
      expect(postToPlainText({ content: [paragraph({ tag: "emotion" })] })).toBe("");
      expect(postToPlainText({ content: [paragraph({ tag: "img", image_key: "img_1" })] })).toBe("![Image](img_1)");
      expect(postToPlainText({ content: [paragraph({ tag: "img", image_key: "" })] })).toBe("[Image]");
      expect(postToPlainText({ content: [paragraph({ tag: "media", file_key: "file_1" })] })).toBe("[Media: file_1]");
      expect(postToPlainText({ content: [paragraph({ tag: "media" })] })).toBe("[Media]");
    });

    it("renders code blocks with and without a language, horizontal rules, and unknown tags as text", () => {
      expect(postToPlainText({ content: [paragraph({ tag: "code_block", text: "x = 1", language: "python" })] })).toBe(
        "\n```python\nx = 1\n```\n",
      );
      expect(postToPlainText({ content: [paragraph({ tag: "code_block", text: "x = 1" })] })).toBe(
        "\n```\nx = 1\n```\n",
      );
      expect(postToPlainText({ content: [paragraph({ tag: "hr" })] })).toBe("\n---\n");
      expect(postToPlainText({ content: [paragraph({ tag: "custom", text: "fallback" })] })).toBe("fallback");
      expect(postToPlainText({ content: [paragraph({ text: "no tag" })] })).toBe("no tag");
    });
  });

  describe("attachments", () => {
    it("appends file and folder attachments after the body", () => {
      expect(
        postToPlainText({
          title: "Files",
          files: [
            { file_key: "f_1", file_name: "a.txt" },
            { file_key: "f_2", is_folder: true },
            { file_key: "", file_name: "skipped" },
            "not-a-record",
            { file_name: "no key" },
          ],
        }),
      ).toBe('Files\n<file key="f_1" name="a.txt"/>\n<folder key="f_2"/>');
    });

    it("returns only the attachments when the body renders to nothing", () => {
      expect(postToPlainText({ files: [{ file_key: "f_1" }] })).toBe('<file key="f_1"/>');
      expect(postToPlainText({ zh_cn: {}, files: [{ file_key: "f_1" }] })).toBe('<file key="f_1"/>');
    });

    it("ignores an empty or non-array files field", () => {
      expect(postToPlainText({ title: "T", files: [] })).toBe("T");
      expect(postToPlainText({ title: "T", files: "nope" })).toBe("T");
    });
  });
});
