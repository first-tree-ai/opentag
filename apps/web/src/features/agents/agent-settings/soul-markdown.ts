import { type Editor, type JSONContent, Mark, Node } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import { TableKit } from "@tiptap/extension-table";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Lexer, Marked, type marked } from "marked";

function literalText(node: JSONContent): string {
  return node.text ?? node.content?.map(literalText).join("") ?? "";
}

const promptMarkup =
  /(?:<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<![A-Za-z](?:"[^"]*"|'[^']*'|[^'">])*>|<\/?[A-Za-z][\w:.-]*(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>)/u;
const literalPromptParts = new RegExp(`(${promptMarkup.source}|[<>&]|[\\p{L}\\p{N}]+(?:_+[\\p{L}\\p{N}]+)+)`, "u");

function escapeLiteralBlockMarkers(text: string): string {
  const sourceRanges = Array.from(text.matchAll(new RegExp(promptMarkup.source, "gu")), (match): [number, number] => [
    match.index,
    match.index + match[0].length,
  ]);
  new Marked().walkTokens(new Lexer().inlineTokens(text), (token) => {
    if (token.type !== "codespan" && token.type !== "image") return;
    for (let start = text.indexOf(token.raw); start !== -1; start = text.indexOf(token.raw, start + token.raw.length))
      sourceRanges.push([start, start + token.raw.length]);
  });
  return text.replace(
    /^( {0,3})(#{1,6}(?=[ \t]|$)|>|[-+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)|-(?:[ \t]*-){2,}(?=[ \t]*$)|=+(?=[ \t]*$))/gm,
    (match: string, indent: string, marker: string, offset: number) => {
      const position = offset + indent.length;
      if (sourceRanges.some(([start, end]) => position >= start && position < end)) return match;
      if (marker.startsWith("=") && offset === 0) return match;
      const escaped = /^\d/.test(marker) ? marker.replace(/([.)])$/, "\\$1") : `\\${marker}`;
      return indent + escaped;
    },
  );
}

const SoulParagraph = Paragraph.extend({
  renderMarkdown(node, helpers, context) {
    const text = this.parent?.(node, helpers, context) ?? helpers.renderChildren(node.content ?? []);
    // Plain paragraph text must not become a heading, list, quote, or rule on the next load.
    return escapeLiteralBlockMarkers(text);
  },
});

// Prompt markup is data, never executable HTML. Preserve it through unrelated edits.
const SourceBlock = Node.create({
  name: "soulSourceBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML: () => [{ tag: "pre[data-soul-source]" }],
  renderHTML: () => ["pre", { "data-soul-source": "block" }, 0],
  markdownTokenizer: {
    name: "soulSourceBlock",
    level: "block",
    start: (source) => source.search(/^ {0,3}(?:<!|<\?|<\/?[A-Za-z]|\[[^\]]+\]:)/m),
    tokenize: (source) => {
      const raw = source.match(
        /^ {0,3}(?:<!--[\s\S]*?-->[^\S\n]*(?:\n|$)|\[[^\]]+\]:[^\n]*(?:\n[ \t]+[^\n]*)*(?:\n|$)|<([A-Za-z][\w:.-]*)\b[^>]*>[\s\S]*?<\/\1>[^\S\n]*(?:\n|$)|<\/?[A-Za-z][\w:.-]*(?=[\s/>])[^\n]*(?:\n|$))/u,
      )?.[0];
      if (raw) return { type: "soulSourceBlock", raw };
      // Marked recognizes additional XML/HTML forms, including CDATA and processing instructions.
      const fallback = source.trimStart().startsWith("<") ? new Lexer().blockTokens(source)[0] : undefined;
      return fallback?.type === "html" ? { type: "soulSourceBlock", raw: fallback.raw } : undefined;
    },
  },
  parseMarkdown: (token) => ({
    type: "soulSourceBlock",
    content: token.raw ? [{ type: "text", text: token.raw.replace(/\n$/, "") }] : [],
  }),
  renderMarkdown: literalText,
});

const SoulCodeBlock = CodeBlock.extend({
  renderMarkdown: (node) => {
    const text = literalText(node);
    const length = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)) + 1;
    const fence = "`".repeat(length);
    return `${fence}${node.attrs?.language ?? ""}\n${text}\n${fence}`;
  },
});

class SoulLexer<ParserOutput = string, RendererOutput = string> extends Lexer<ParserOutput, RendererOutput> {
  override lex(source: string) {
    const preamble = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0];
    const tokens = super.lex(preamble ? source.slice(preamble.length) : source);
    if (preamble) tokens.unshift({ type: "soulSourceBlock", raw: preamble });
    return tokens;
  }
}

function soulMarked() {
  const instance = new Marked();
  instance.Lexer = SoulLexer;
  return instance;
}

const SourceInline = Node.create({
  name: "soulSourceInline",
  inline: true,
  group: "inline",
  content: "text*",
  marks: "",
  code: true,
  parseHTML: () => [{ tag: "span[data-soul-source=inline]" }],
  renderHTML: () => ["span", { "data-soul-source": "inline" }, 0],
  markdownTokenizer: {
    name: "soulSourceInline",
    level: "inline",
    start: (source) => source.search(/<!|<\?|<\/?[A-Za-z]|\[|&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[\da-fA-F]+);/u),
    tokenize: (source) => {
      const markup = promptMarkup.exec(source);
      if (markup?.index === 0) return { type: "soulSourceInline", raw: markup[0] };
      const reference = source.startsWith("[")
        ? (Lexer.rules.inline.gfm.reflink.exec(source)?.[0] ?? Lexer.rules.inline.gfm.nolink.exec(source)?.[0])
        : undefined;
      if (reference && source[reference.length] !== "(") return { type: "soulSourceInline", raw: reference };
      const raw = source.match(/^&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[\da-fA-F]+);/u)?.[0];
      return raw ? { type: "soulSourceInline", raw } : undefined;
    },
  },
  parseMarkdown: (token) => ({ type: "soulSourceInline", content: [{ type: "text", text: token.raw ?? "" }] }),
  renderMarkdown: literalText,
});

// Image references remain editable text; loading an instruction must not fetch remote media.
const SourceImage = SourceInline.extend({
  name: "soulSourceImage",
  markdownTokenizer: {
    name: "soulSourceImage",
    level: "inline",
    start: (source) => source.indexOf("!["),
    tokenize: (source) => {
      if (!source.startsWith("![")) return undefined;
      const token = new Lexer().inlineTokens(source)[0];
      if (token?.type === "image") return { type: "soulSourceImage", raw: token.raw };
      // An isolated lexer has no reference definitions; use Marked's own reference syntax rules.
      const raw = Lexer.rules.inline.gfm.reflink.exec(source)?.[0] ?? Lexer.rules.inline.gfm.nolink.exec(source)?.[0];
      return raw ? { type: "soulSourceImage", raw } : undefined;
    },
  },
  parseHTML: () => [{ tag: "span[data-soul-source=image]" }],
  renderHTML: () => ["span", { "data-soul-source": "image" }, 0],
  parseMarkdown: (token) => ({ type: "soulSourceImage", content: [{ type: "text", text: token.raw ?? "" }] }),
});

// Suppress HTML/entity and identifier escaping in prompt text while retaining its formatting marks.
const LiteralPrompt = Mark.create({
  name: "soulLiteralPrompt",
  code: true,
  renderHTML: () => ["span", 0],
  renderMarkdown: (node, helpers) => helpers.renderChildren(node.content ?? []),
});

export function serializeSoul(editor: Editor): string {
  const markdown = editor.markdown;
  if (!markdown) throw new Error("Soul editing requires Markdown support.");
  return markdown.serialize(literalPromptText(soulDocumentValue(editor.getJSON())));
}

/** Ignore only empty root paragraphs; whitespace inside a block remains part of the document. */
export function soulDocumentValue(document: JSONContent): JSONContent {
  const content = document.content ?? [];
  let start = 0;
  let end = content.length;
  while (start < end && emptyBoundaryParagraph(content[start])) start++;
  while (end > start && emptyBoundaryParagraph(content[end - 1])) end--;
  return { ...document, content: content.slice(start, end) };
}

function emptyBoundaryParagraph(node: JSONContent | undefined): boolean {
  return (
    node?.type === "paragraph" &&
    (node.content ?? []).every(
      (child) => child.type === "text" && !child.marks?.length && /^[ \t\r\n]*$/.test(child.text ?? ""),
    )
  );
}

let valueMarkdown: MarkdownManager | undefined;

/** The same canonical value drives comparison, the saved payload, and unsaved-navigation protection. */
export function normalizeSoulValue(source: string): string {
  valueMarkdown ??= new MarkdownManager({
    extensions: soulEditorExtensions(),
    marked: soulMarked() as unknown as typeof marked,
  });
  const document = valueMarkdown.parse(source.replace(/\r\n?/g, "\n"));
  return valueMarkdown.serialize(literalPromptText(soulDocumentValue(document)));
}

function literalPromptText(node: JSONContent): JSONContent {
  if (node.type === "codeBlock" || node.type?.startsWith("soulSource")) return node;
  if (!node.content) return node;
  return {
    ...node,
    content: node.content.flatMap((child) => {
      if (child.type !== "text" || child.marks?.some((mark) => mark.type === "code")) return [literalPromptText(child)];
      return (child.text ?? "")
        .split(literalPromptParts)
        .map((text, index) => ({
          ...child,
          text,
          marks: index % 2 === 1 ? [...(child.marks ?? []), { type: "soulLiteralPrompt" }] : child.marks,
        }))
        .filter((part) => part.text.length > 0);
    }),
  };
}

export function soulEditorExtensions() {
  return [
    StarterKit.configure({
      codeBlock: false,
      paragraph: false,
      underline: false,
      trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: false },
    }),
    SoulCodeBlock,
    SoulParagraph,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    SourceBlock,
    SourceInline,
    SourceImage,
    LiteralPrompt,
    // Each editor owns its lexer; custom tokenizers must not accumulate on Marked's global singleton.
    Markdown.configure({ marked: soulMarked() as unknown as typeof marked }),
  ];
}
