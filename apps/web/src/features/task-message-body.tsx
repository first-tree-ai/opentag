import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import * as m from "../paraglide/messages.js";
import { Text } from "../ui/design-system.js";

type TaskMessageBodyProps = {
  /** `chat_markdown` is Markdown written for an IM, where a single newline is a visible line break. */
  format: "markdown" | "chat_markdown" | "plain_text";
  text: string;
};

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

const blockContainers = new Set(["root", "blockquote", "listItem"]);

/**
 * Chat Markdown as an IM displays it: each newline inside a text node is a hard break, and HTML a
 * person typed stays literal text rather than being dropped.
 */
function chatLineBreaks(node: MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "html") {
      const text = { type: "text", value: child.value ?? "" };
      // A block of HTML sits where paragraphs do, so its literal text needs a paragraph of its own.
      child = blockContainers.has(node.type) ? { type: "paragraph", children: [text] } : text;
    }
    if (child.type !== "text" || !child.value?.includes("\n")) {
      chatLineBreaks(child);
      return [child];
    }
    return child.value
      .split("\n")
      .flatMap((value, index): MarkdownNode[] =>
        index === 0 ? [{ type: "text", value }] : [{ type: "break" }, { type: "text", value }],
      );
  });
}

const remarkChatLineBreaks = () => chatLineBreaks;

export function TaskMessageBody({ format, text }: TaskMessageBodyProps) {
  const typography = "text-sm font-normal leading-normal";
  if (format === "plain_text") {
    return (
      <p className={`wrap-anywhere whitespace-pre-wrap ${typography}`} data-content-format="plain_text">
        {text || "No text content"}
      </p>
    );
  }

  return (
    <div
      className={`grid min-w-0 gap-3 wrap-anywhere text-pretty ${typography} [&>*:first-child]:mt-0 [&>*:last-child]:mb-0`}
      data-content-format="markdown"
    >
      <ReactMarkdown
        remarkPlugins={format === "chat_markdown" ? [remarkGfm, remarkChatLineBreaks] : [remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          a: ({ children, href }) =>
            href ? (
              <a className="break-all underline underline-offset-2" href={href} rel="noreferrer" target="_blank">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-kumo-line pl-4 text-kumo-subtle">{children}</blockquote>
          ),
          code: ({ children, className }) => (
            <code className={`${className ?? ""} rounded-sm bg-kumo-recessed px-1 py-0.5 font-mono text-[0.875em]`}>
              {children}
            </code>
          ),
          h1: ({ children }) => (
            <Text as="h3" variant="heading">
              {children}
            </Text>
          ),
          h2: ({ children }) => (
            <Text as="h3" variant="heading">
              {children}
            </Text>
          ),
          h3: ({ children }) => (
            <Text as="h4" variant="heading">
              {children}
            </Text>
          ),
          h4: ({ children }) => (
            <Text as="h4" variant="heading">
              {children}
            </Text>
          ),
          h5: ({ children }) => (
            <Text as="h4" variant="heading">
              {children}
            </Text>
          ),
          h6: ({ children }) => (
            <Text as="h4" variant="heading">
              {children}
            </Text>
          ),
          hr: () => <hr className="border-0 border-t border-kumo-line" />,
          img: ({ alt }) => (alt ? <span className="text-sm text-kumo-subtle">[Image: {alt}]</span> : null),
          ol: ({ children }) => <ol className="ml-5 list-decimal space-y-1">{children}</ol>,
          p: ({ children }) => <p>{children}</p>,
          pre: ({ children }) => (
            // biome-ignore lint/a11y/useSemanticElements: The named scroll region must retain native preformatted code semantics.
            <pre
              className="max-w-full overflow-x-auto rounded-md bg-kumo-recessed p-3 text-sm leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-inset [&>code]:bg-transparent [&>code]:p-0"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll long code blocks.
              tabIndex={0}
              role="region"
              aria-label={m.tasks_code_block()}
            >
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <section
              className="max-w-full overflow-x-auto rounded-md ring ring-kumo-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-inset"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide message tables.
              tabIndex={0}
              aria-label={m.tasks_message_table()}
            >
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">{children}</table>
            </section>
          ),
          td: ({ children }) => <td className="border-t border-kumo-line p-2 align-top">{children}</td>,
          th: ({ children }) => <th className="bg-kumo-recessed p-2 font-semibold">{children}</th>,
          ul: ({ children }) => <ul className="ml-5 list-disc space-y-1">{children}</ul>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
