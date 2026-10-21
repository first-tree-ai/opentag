import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { overwriteGetLocale } from "../../../paraglide/runtime.js";
import { normalizeSoulValue, serializeSoul, soulDocumentValue, soulEditorExtensions } from "./soul-markdown.js";
import { soulTemplates } from "./soul-templates.js";

const editors: Editor[] = [];
function editor(source: string) {
  const instance = new Editor({ extensions: soulEditorExtensions(), content: source, contentType: "markdown" });
  editors.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of editors.splice(0)) instance.destroy();
  overwriteGetLocale(() => "en");
});

describe("Soul Markdown compatibility", () => {
  it.each([
    ...soulTemplates().map((template) => template.body),
    '---\nmode: careful\n---\n\nUse <rule when="a > b">read_file</rule> & {{user_name}}.',
    "<!-- keep this\n  exact indentation\n-->\n\n![diagram][source]\n\n[source]: https://example.com/image.png",
    "````md\n```text\n  keep this\n```\n````\n\n| Tool | Rule |\n| --- | --- |\n| read_file | a < b & c > d |",
  ])("normalizes existing template and prompt documents without changing their parsed content: %#", (source) => {
    const normalized = normalizeSoulValue(source);
    expect(normalizeSoulValue(normalized)).toBe(normalized);
    expect(soulDocumentValue(editor(normalized).getJSON())).toEqual(soulDocumentValue(editor(source).getJSON()));
  });

  it("ignores only empty boundary paragraphs and line-ending differences", () => {
    const source = "## Principles\n\nKeep this rule.\n\n```text\n  keep indentation\n\n```";
    const expected = normalizeSoulValue(source);
    expect(normalizeSoulValue(`\n\n \t\n${source}\n\n \t\n`)).toBe(expected);
    expect(normalizeSoulValue(source.replaceAll("\n", "\r\n"))).toBe(expected);
    expect(normalizeSoulValue(source.replaceAll("\n", "\r"))).toBe(expected);
    expect(normalizeSoulValue("\n \t\n\n")).toBe("");
    expect(expected).toContain("  keep indentation\n\n```");
  });

  it.each([
    ["First.\n\nSecond.", "First.\n\n\n\nSecond."],
    ["First.\nSecond.", "First.\n\nSecond."],
    ["Keep this rule.", "**Keep this rule.**"],
    ["Keep this rule.", "## Keep this rule."],
    ["```text\n  first\n    second\n```", "```text\n  first\n  second\n```"],
    ["```text\nfirst\nsecond\n```", "```text\nfirst\n\nsecond\n```"],
    ["<rules>\n  keep this\n</rules>", "<rules>\n    keep this\n</rules>"],
  ])("retains meaningful internal layout and formatting changes: %s", (saved, draft) => {
    const value = normalizeSoulValue(draft);
    expect(value).not.toBe(normalizeSoulValue(saved));
    expect(normalizeSoulValue(value)).toBe(value);
    expect(soulDocumentValue(editor(value).getJSON())).toEqual(soulDocumentValue(editor(draft).getJSON()));
  });

  it("drops empty boundary paragraphs without changing internal paragraphs or marked whitespace", () => {
    const source = editor("First.\n\nSecond.");
    const document = source.getJSON();
    const paragraph = { type: "paragraph" };
    const first = document.content?.[0];
    const second = document.content?.[1];
    if (!first || !second) throw new Error("Expected two paragraphs");
    expect(
      soulDocumentValue({ ...document, content: [paragraph, first, paragraph, second, paragraph] }).content,
    ).toEqual([first, paragraph, second]);
    const marked = { type: "paragraph", content: [{ type: "text", text: " ", marks: [{ type: "bold" }] }] };
    expect(soulDocumentValue({ ...document, content: [marked, first, marked] }).content).toEqual([
      marked,
      first,
      marked,
    ]);
  });

  it.each([
    "If score > 0.8 then stop.",
    "Map a -> b and x => y.",
    "Use a < b.",
    "a & b",
    "Q&A and R&D",
    "Call read_file and chat_send.",
    "Use {{user_name}} and env.API_KEY.",
    "调用 read_file，并保留 用户_名称。",
  ])("preserves literal prompt prose after loaded and typed edits: %s", (source) => {
    const loaded = editor(source);
    loaded.commands.insertContentAt(loaded.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added." }],
    });
    expect(serializeSoul(loaded)).toBe(`${source}\n\nAdded.`);
    const typed = editor("");
    typed.commands.insertContent({ type: "text", text: source });
    let saved = serializeSoul(typed);
    expect(saved).toBe(source);
    for (let index = 0; index < 3; index++) {
      const reloaded = editor(saved);
      expect(reloaded.view.dom.textContent).toBe(source);
      saved = serializeSoul(reloaded);
      expect(saved).toBe(source);
    }
  });

  it.each([
    "1\\. Not a list item.",
    "2\\) Not a list item.",
    "\\# Not a heading",
    "\\- not a bullet",
    "\\+ not a bullet",
    "\\> not a quote",
  ])("retains literal line starts through editing and reload: %s", (source) => {
    const original = editor(source);
    original.commands.insertContentAt(original.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added." }],
    });
    const saved = serializeSoul(original);
    expect(saved).toBe(`${source}\n\nAdded.`);
    expect(editor(saved).getJSON()).toEqual(original.getJSON());
    expect(editor(saved).view.dom.querySelector("ol, ul, h1, blockquote")).toBeNull();
  });

  it("keeps identifiers and comparison symbols inside formatting and table cells", () => {
    const source =
      "**Call read_file & chat_send when a > b.**\n\n| Tool | Rule |\n| --- | --- |\n| read_file | a < b & c > d |";
    const original = editor(source);
    original.commands.insertContentAt(original.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added." }],
    });
    const saved = serializeSoul(original);
    expect(saved).toContain("**Call read_file & chat_send when a > b.**");
    expect(saved).toContain("read_file | a < b & c > d");
    expect(editor(saved).getJSON()).toEqual(original.getJSON());
  });

  it.each(["\\---", "\\- - -", "Keep this line.\n\\==="])("retains literal rule and setext markers: %s", (source) => {
    const original = editor(source);
    const saved = serializeSoul(original);
    expect(saved).toBe(source);
    expect(editor(saved).getJSON()).toEqual(original.getJSON());
  });

  it.each([
    ["---", "\\---"],
    ["- not a bullet", "\\- not a bullet"],
    ["1. step one", "1\\. step one"],
    [">", "\\>"],
    ["<", "<"],
    ["&", "&"],
  ])("preserves typed literal block-like text: %s", (text, source) => {
    const original = editor("");
    original.commands.insertContent({ type: "text", text });
    expect(serializeSoul(original)).toBe(source);
    expect(editor(source).getJSON()).toEqual(original.getJSON());
    expect(editor(source).view.dom.textContent).toBe(text);
  });

  it("preserves code containing shorter fences and instructions after it", () => {
    const original = editor("````md\n```text\nexample\n```\n````\n\n## Next\n\nKeep this rule.");
    original.commands.insertContentAt(original.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added." }],
    });
    const saved = serializeSoul(original);
    expect(saved).toContain("````md");
    expect(editor(saved).getJSON()).toEqual(original.getJSON());
  });

  it.each(["<!-- note\n# keep this literal\n-->", "<![CDATA[\n- keep this literal\n]]>"])(
    "does not apply paragraph escaping inside multiline prompt source: %s",
    (source) => {
      const original = editor("");
      original.commands.insertContent({
        type: "paragraph",
        content: [
          { type: "text", text: "Use " },
          { type: "soulSourceInline", content: [{ type: "text", text: source }] },
          { type: "text", text: " inline." },
        ],
      });
      original.commands.insertContentAt(original.state.doc.content.size, {
        type: "paragraph",
        content: [{ type: "text", text: "Added." }],
      });
      expect(serializeSoul(original)).toContain(`Use ${source} inline.`);
    },
  );

  it("does not apply paragraph escaping inside a pasted inline code span", () => {
    const original = editor("");
    original.commands.insertContent({
      type: "paragraph",
      content: [{ type: "text", text: "line\n- keep this literal", marks: [{ type: "code" }] }],
    });
    expect(serializeSoul(original)).toBe("`line\n- keep this literal`");
  });

  it("keeps horizontal rules inside a blockquote as formatted content", () => {
    const original = editor("> ---\n>\n> ## Principles\n>\n> - Verify\n>\n> ---\n\nAfter.");
    expect(original.view.dom.querySelectorAll("blockquote hr")).toHaveLength(2);
    expect(original.view.dom.querySelector("blockquote h2")?.textContent).toBe("Principles");
    expect(original.view.dom.querySelectorAll("blockquote li")).toHaveLength(1);
  });

  it("preserves namespaced XML blocks and their indentation", () => {
    const source = "<ns:rules>\n  - Preserve these exact spaces.\n</ns:rules>";
    const original = editor(source);
    original.commands.insertContentAt(original.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added." }],
    });
    expect(serializeSoul(original)).toContain(source);
    expect(original.view.dom.querySelector("li")).toBeNull();
  });

  it.each(['<rule when="a > b">x</rule>', "<rule when='a > b'>x</rule>"])(
    "preserves quoted delimiters in %s",
    (markup) => {
      const loaded = editor(`Use ${markup}.`);
      loaded.commands.insertContentAt(loaded.state.doc.content.size, {
        type: "paragraph",
        content: [{ type: "text", text: "Added." }],
      });
      expect(serializeSoul(loaded)).toContain(`Use ${markup}.`);
      const typed = editor("");
      typed.commands.insertContent({ type: "text", text: `Use ${markup}.` });
      expect(serializeSoul(typed)).toBe(`Use ${markup}.`);
    },
  );

  it("retains shortcut references while keeping ordinary links formatted", () => {
    const loaded = editor(
      "Read [policy] and [the guide](https://example.com/guide).\n\n[policy]: https://example.com/policy",
    );
    loaded.commands.insertContentAt(loaded.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added." }],
    });
    const saved = serializeSoul(loaded);
    expect(saved).toContain("Read [policy] and [the guide](https://example.com/guide).");
    expect(saved).toContain("[policy]: https://example.com/policy");
    expect(loaded.view.dom.querySelector('a[href="https://example.com/guide"]')).toBeTruthy();
  });

  it.each(["  <!-- keep this rule -->", "  [source]: https://example.com/policy", "   <![CDATA[Keep this rule]]>"])(
    "preserves valid source indentation in %s through an unrelated edit",
    (source) => {
      const original = editor(`See [policy][source].\n\n${source}`);
      original.commands.insertContentAt(original.state.doc.content.size, {
        type: "paragraph",
        content: [{ type: "text", text: "Added." }],
      });
      expect(serializeSoul(original)).toContain(source);
    },
  );

  it.each([
    "<![CDATA[Keep this rule]]>",
    '<?xml version="1.0"?>',
    "<!DOCTYPE instructions>",
    "<!-- keep this note -->",
  ])("preserves inline XML source %s through unrelated typing", (source) => {
    const original = editor(`Use ${source} inline.`);
    original.commands.insertContentAt(original.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "Added." }],
    });
    expect(serializeSoul(original)).toContain(`Use ${source} inline.`);
    expect(original.view.dom.textContent).toContain(source);
  });

  it.each(["![diagram][source]", "![source][]", "![source]", "![nested [diagram]][source]"])(
    "preserves reference image syntax %s without fetching media",
    (source) => {
      const original = editor(`${source}\n\n[source]: https://example.com/private.png`);
      original.commands.insertContentAt(original.state.doc.content.size, {
        type: "paragraph",
        content: [{ type: "text", text: "Added." }],
      });
      expect(serializeSoul(original)).toContain(source);
      expect(serializeSoul(original)).toContain("[source]: https://example.com/private.png");
      expect(original.view.dom.querySelector("img")).toBeNull();
    },
  );

  it.each(["<![CDATA[Keep this rule]]>", "<!DOCTYPE instructions>", '<?xml version="1.0"?>'])(
    "preserves unhandled XML source %s through an unrelated edit",
    (source) => {
      const original = editor(`${source}\n\nExisting rule.`);
      original.commands.insertContentAt(original.state.doc.content.size, {
        type: "paragraph",
        content: [{ type: "text", text: "An added rule." }],
      });
      expect(original.getMarkdown()).toContain(source);
      expect(original.view.dom.textContent).toContain(source);
      expect(original.view.dom.querySelector("script, img")).toBeNull();
    },
  );

  it("keeps ordinary horizontal-rule sections editable as headings and lists", () => {
    const original = editor(
      "Intro.\n\n---\n\n## Working principles\n\n- Verify facts.\n- Cite evidence.\n\n---\n\nBe concise.",
    );
    expect(original.view.dom.querySelectorAll("hr")).toHaveLength(2);
    expect(original.view.dom.querySelector("h2")?.textContent).toBe("Working principles");
    expect(original.view.dom.querySelectorAll("li")).toHaveLength(2);
    expect(editor(original.getMarkdown()).getJSON()).toEqual(original.getJSON());
  });

  it("retains document-preamble frontmatter as literal source", () => {
    const source = "---\nname: Research\n---";
    const original = editor(`${source}\n\n## Role\n\nBe precise.`);
    expect(original.view.dom.querySelector("pre[data-soul-source]")?.textContent).toBe(source);
    expect(original.getMarkdown()).toContain(source);
  });

  it("preserves keyboard-created tags, formatting, code, and existing entity literals", () => {
    const original = editor("Keep &lt;literal&gt; and &amp; unchanged.\n\n`&lt;code&gt;`");
    original.commands.insertContentAt(original.state.doc.content.size, {
      type: "paragraph",
      content: [
        { type: "text", text: "Wrap replies in " },
        { type: "text", text: "<answer>...</answer>", marks: [{ type: "bold" }] },
        { type: "text", text: ". Keep *literal stars*." },
      ],
    });
    const saved = serializeSoul(original);
    expect(saved).toContain("**<answer>...</answer>**");
    expect(saved).toContain("Keep &lt;literal&gt; and &amp; unchanged.");
    expect(saved).toContain("`&lt;code&gt;`");
    expect(saved).toContain("\\*literal stars\\*");
    expect(original.view.dom.querySelector("answer")).toBeNull();
  });

  it.each(["en", "zh"] as const)("round trips the complete %s catalog without changing its meaning", (locale) => {
    overwriteGetLocale(() => locale);
    for (const template of soulTemplates()) {
      const original = editor(template.body);
      expect(editor(original.getMarkdown()).getJSON()).toEqual(original.getJSON());
      expect(editor(serializeSoul(original)).getJSON()).toEqual(original.getJSON());
      expect(original.getHTML()).toContain("<h2>");
    }
  });

  it("retains existing Markdown formats through serialization", () => {
    const source = [
      "## Principles",
      "",
      "A **bold** and *careful* [partner](https://example.com).",
      "",
      "- First",
      "  - Nested",
      "",
      "3. Third",
      "4. Fourth",
      "",
      "- [x] Verify",
      "- [ ] Report",
      "",
      "> Check evidence.",
      "",
      "```ts",
      "const reply = '<answer>';",
      "```",
      "",
      "| Topic | Rule |",
      "| --- | --- |",
      "| Accuracy | Check |",
      "",
      "Keep `literal_code` and \\*literal stars\\*.",
    ].join("\n");
    const original = editor(source);
    expect(editor(original.getMarkdown()).getJSON()).toEqual(original.getJSON());
  });

  it("preserves prompt markup, comments, image references and definitions as inert editable text", () => {
    const source = [
      "<!-- keep this note -->",
      "",
      "<rules>",
      "Be careful & precise.",
      "</rules>",
      "",
      "Use <answer> tags and [evidence][source].",
      "",
      "![diagram](https://example.com/private.png)",
      "",
      "[source]: https://example.com",
      "",
      "## Reply",
      "",
      "Be concise.",
    ].join("\n");
    const original = editor(source);
    original.commands.insertContentAt(original.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "An added rule." }],
    });
    const saved = original.getMarkdown();
    for (const literal of [
      "<!-- keep this note -->",
      "<rules>",
      "</rules>",
      "<answer>",
      "[evidence][source]",
      "![diagram](https://example.com/private.png)",
      "[source]: https://example.com",
    ])
      expect(saved).toContain(literal);
    expect(original.view.dom.querySelector("rules, answer, img")).toBeNull();
    expect(editor(saved).getJSON()).toEqual(original.getJSON());
  });
});
