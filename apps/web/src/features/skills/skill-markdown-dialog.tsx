import { skillArchivePath } from "@opentag/shared/browser";
import type { RefObject } from "react";
import * as m from "../../paraglide/messages.js";
import { Banner, buttonClassName, Dialog, Icon, Loader, Text } from "../../ui/design-system.js";
import { TaskMessageBody } from "../task-message-body.js";
import { useSkillAgentsQuery, useSkillMarkdownQuery } from "./skill-queries.js";

/**
 * The one file of a skill package the Web shows: its `SKILL.md`, read from the Server as text and
 * rendered as Markdown with raw HTML dropped. The rest of the package is only ever downloaded.
 */
export function SkillMarkdownDialog({
  name,
  onClose,
  returnFocusRef,
}: {
  name: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const markdown = useSkillMarkdownQuery(name);
  const agents = useSkillAgentsQuery(name);
  return (
    <Dialog
      className="w-[min(100vw-1.5rem,48rem)] max-w-3xl"
      eyebrow={m.skills_view_skill_md()}
      returnFocusRef={returnFocusRef}
      title={name}
      onClose={onClose}
    >
      <div className="grid gap-4" data-ui="skill-markdown-dialog">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <Text as="span" size="xs" variant="secondary">
              {m.skills_markdown_assigned_agents()}
            </Text>
            <Text as="p" size="sm" variant="secondary">
              {agents.data
                ? agents.data.agents.length > 0
                  ? agents.data.agents.map((agent) => agent.displayName).join(", ")
                  : m.skills_markdown_no_agents()
                : agents.isError
                  ? m.skills_request_failed()
                  : m.common_loading()}
            </Text>
          </div>
          <a
            className={buttonClassName({ size: "compact", variant: "secondary" })}
            download={`${name}.zip`}
            href={skillArchivePath(name)}
          >
            <Icon name="download" />
            {m.skills_download()}
          </a>
        </div>
        {markdown.isPending ? (
          <p className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
            <Loader aria-label={m.skills_markdown_loading()} size="sm" />
            {m.skills_markdown_loading()}
          </p>
        ) : null}
        {markdown.isError ? (
          <Banner
            action={<Banner.Action onClick={() => void markdown.refetch()}>{m.skills_try_again()}</Banner.Action>}
            description={markdown.error instanceof Error ? markdown.error.message : m.skills_request_failed()}
            role="alert"
            title={m.skills_markdown_unavailable()}
            variant="error"
          />
        ) : null}
        {markdown.data !== undefined ? (
          <div className="rounded-md bg-kumo-recessed p-4" data-ui="skill-markdown">
            <TaskMessageBody format="markdown" text={withoutFrontmatter(markdown.data)} />
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The YAML frontmatter carries the name and description the list already shows; rendered as
 * Markdown its `---` fences would turn the first field into a heading, so only the body is shown.
 */
export function withoutFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}
