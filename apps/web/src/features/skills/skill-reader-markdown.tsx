import type { SkillFileEntry } from "@opentag/shared/browser";
import { Children, isValidElement, type ReactNode, useId, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import * as m from "../../paraglide/messages.js";
import { Button } from "../../ui/design-system.js";
import { resolveSkillFileLink, skillHeadingSlug, splitSkillFrontmatter } from "./skill-reader-model.js";

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : typeof child === "string" || typeof child === "number"
          ? String(child)
          : "",
    )
    .join("");
}

/** Package Markdown is untrusted: no HTML, remote images, embeds or executable code. */
export function SkillReaderMarkdown({
  content,
  path,
  files,
  onSelect,
}: {
  content: string;
  path: string;
  files: SkillFileEntry[];
  onSelect: (path: string) => void;
}) {
  const id = useId();
  const [showFrontmatter, setShowFrontmatter] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { frontmatter, body } = splitSkillFrontmatter(content);
  function heading(level: 1 | 2 | 3 | 4 | 5 | 6, children: ReactNode, offset: number | undefined) {
    const slug = skillHeadingSlug(plainText(children));
    const Tag = `h${level}` as const;
    return (
      <Tag id={`${id}-${offset ?? slug}`} data-skill-heading={slug} tabIndex={-1}>
        {children}
      </Tag>
    );
  }
  const scrollToHeading = (href: string) => {
    let fragment: string;
    try {
      fragment = decodeURIComponent(href.slice(1));
    } catch {
      return;
    }
    const headings = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-skill-heading]") ?? []);
    const duplicate = /^(.*)-(\d+)$/.exec(fragment);
    const target =
      headings.find((element) => element.dataset.skillHeading === fragment) ??
      (duplicate
        ? headings.filter((element) => element.dataset.skillHeading === duplicate[1])[Number(duplicate[2])]
        : undefined);
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  };
  return (
    <div className="skill-reader-markdown" ref={root}>
      {frontmatter ? (
        <div className="skill-reader-frontmatter">
          <Button
            size="compact"
            variant="ghost"
            aria-expanded={showFrontmatter}
            onClick={() => setShowFrontmatter(!showFrontmatter)}
          >
            {m.skills_details_frontmatter()}
          </Button>
          {showFrontmatter ? (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Frontmatter can need keyboard horizontal scrolling.
            <section className="skill-reader-code" aria-label={m.skills_details_frontmatter()} tabIndex={0}>
              <pre>
                <code>{frontmatter}</code>
              </pre>
            </section>
          ) : null}
        </div>
      ) : null}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={defaultUrlTransform}
        components={{
          h1: ({ children, node }) => heading(1, children, node?.position?.start.offset),
          h2: ({ children, node }) => heading(2, children, node?.position?.start.offset),
          h3: ({ children, node }) => heading(3, children, node?.position?.start.offset),
          h4: ({ children, node }) => heading(4, children, node?.position?.start.offset),
          h5: ({ children, node }) => heading(5, children, node?.position?.start.offset),
          h6: ({ children, node }) => heading(6, children, node?.position?.start.offset),
          a: ({ children, href }) => {
            if (!href) return <span>{children}</span>;
            const file = resolveSkillFileLink(href, path, files);
            if (file)
              return (
                <Button
                  className="skill-reader-package-link"
                  size="compact"
                  variant="inline"
                  onClick={() => onSelect(file)}
                >
                  {children}
                </Button>
              );
            if (href.startsWith("#"))
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    scrollToHeading(href);
                  }}
                >
                  {children}
                </a>
              );
            if (/^(https?:|mailto:)/i.test(href))
              return (
                <a href={href} rel="noopener noreferrer" target="_blank">
                  {children}
                </a>
              );
            return <span>{children}</span>;
          },
          img: ({ alt, src }) => {
            const file = src ? resolveSkillFileLink(src, path, files) : undefined;
            const label = m.skills_details_image({ name: alt || src || m.skills_details_image_unavailable() });
            return file ? (
              <Button className="skill-reader-package-link" variant="inline" onClick={() => onSelect(file)}>
                {label}
              </Button>
            ) : (
              <span className="text-kumo-subtle">{label}</span>
            );
          },
          pre: ({ children }) => (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Code blocks need keyboard horizontal scrolling.
            <section className="skill-reader-code" aria-label={m.skills_details_source()} tabIndex={0}>
              <pre>{children}</pre>
            </section>
          ),
          table: ({ children }) => (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Tables need keyboard horizontal scrolling.
            <section className="skill-reader-table" aria-label={m.skills_details_reading()} tabIndex={0}>
              <table>{children}</table>
            </section>
          ),
          input: ({ checked }) => <span>{checked ? "☑" : "☐"}</span>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
