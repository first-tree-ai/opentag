import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import * as m from "../paraglide/messages.js";
import { Text } from "../ui/design-system.js";

/** The part of an mdast node this plugin reads; the web app does not depend on mdast's types. */
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/**
 * A sent chat message shows what its recipient saw. Its single line breaks are its own — Markdown
 * would join those lines — so each newline in prose becomes a hard break; code keeps its text
 * untouched. HTML in the message was never rendered for the recipient, so it stays literal text.
 */
function remarkChatMessage() {
  return (tree: MarkdownNode) => keepChatText(tree);
}

/** Parents whose HTML children are blocks; anywhere else an HTML node is inline. */
const BLOCK_CONTAINERS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

function literalHtml(node: MarkdownNode, parent: MarkdownNode): MarkdownNode {
  if (node.type !== "html") return node;
  const text = { type: "text", value: node.value ?? "" };
  return BLOCK_CONTAINERS.has(parent.type) ? { type: "paragraph", children: [text] } : text;
}

function keepChatText(node: MarkdownNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MarkdownNode[] => {
    const text = literalHtml(child, node);
    if (text.type !== "text" || !text.value?.includes("\n")) {
      keepChatText(text);
      return [text];
    }
    return text.value
      .split(/\r?\n/u)
      .flatMap((line, index) => [
        ...(index > 0 ? [{ type: "break" }] : []),
        ...(line ? [{ type: "text", value: line }] : []),
      ]);
  });
}

type TaskMessageBodyProps = {
  format: "markdown" | "plain_text";
  text: string;
};

export function TaskMessageBody({ format, text }: TaskMessageBodyProps) {
  const typography = "text-sm font-normal leading-normal";
  // An empty body says so in either format rather than rendering nothing.
  if (format === "plain_text" || !text) {
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
        remarkPlugins={[remarkGfm, remarkChatMessage]}
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
