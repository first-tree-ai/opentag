import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Text } from "../ui/design-system.js";

type TaskMessageBodyProps = {
  format: "markdown" | "plain_text";
  text: string;
};

export function TaskMessageBody({ format, text }: TaskMessageBodyProps) {
  if (format === "plain_text") {
    return (
      <p className="break-words whitespace-pre-wrap" data-content-format="plain_text">
        {text || "No text content"}
      </p>
    );
  }

  return (
    <div
      className="grid min-w-0 gap-3 break-words text-pretty [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      data-content-format="markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
          p: ({ children }) => <p className="leading-6">{children}</p>,
          pre: ({ children }) => (
            <pre className="max-w-full overflow-x-auto rounded-md bg-kumo-recessed p-3 text-sm leading-5 [&>code]:bg-transparent [&>code]:p-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto rounded-md ring ring-kumo-line">
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">{children}</table>
            </div>
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
