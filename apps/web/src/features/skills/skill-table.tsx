import { type SkillSummary, skillArchivePath } from "@opentag/shared/browser";
import type { MouseEvent } from "react";
import { formatDateTime, formatRelativeTime } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { Button, buttonClassName, Icon, LayerCard, Table, Text } from "../../ui/design-system.js";
import { formatBytes, skillUpdatedByLabel } from "./skill-format.js";

export type SkillRowAction = (skill: SkillSummary, trigger: HTMLElement) => void;

/**
 * The library as a table above 40rem of content width and as stacked cards below it, the same
 * seam the Task list uses. The wide region scrolls on its own so the page never does.
 */
export function SkillTable({
  onDelete,
  onView,
  skills,
}: {
  onDelete: SkillRowAction;
  onView: SkillRowAction;
  skills: readonly SkillSummary[];
}) {
  return (
    <LayerCard className="p-0" data-ui="skills-card">
      <section
        aria-label={m.skills_table_region()}
        className="min-w-0 overflow-hidden rounded-lg @min-[40rem]/content:overflow-x-auto @min-[40rem]/content:focus:outline-none @min-[40rem]/content:focus-visible:ring-2 @min-[40rem]/content:focus-visible:ring-kumo-brand @min-[40rem]/content:focus-visible:ring-inset"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The same region remains keyboard-scrollable in wider content areas.
        tabIndex={0}
      >
        <Table
          aria-label={m.skills_table_region()}
          className="block min-w-0 @min-[40rem]/content:table @min-[40rem]/content:min-w-[60rem]"
          data-ui="skill-table"
          layout="fixed"
        >
          <colgroup className="hidden @min-[40rem]/content:table-column-group">
            <col />
            <col className="w-32" />
            <col className="w-40" />
            <col className="w-24" />
            <col className="w-84" />
          </colgroup>
          <Table.Header className="sr-only @min-[40rem]/content:not-sr-only @min-[40rem]/content:table-header-group">
            <Table.Row>
              <Table.Head>{m.skills_column_name()}</Table.Head>
              <Table.Head>{m.skills_column_files()}</Table.Head>
              <Table.Head>{m.skills_column_updated()}</Table.Head>
              <Table.Head>{m.skills_column_agents()}</Table.Head>
              <Table.Head>{m.skills_column_actions()}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body className="block @min-[40rem]/content:table-row-group">
            {skills.map((skill) => (
              <SkillRow key={skill.name} skill={skill} onDelete={onDelete} onView={onView} />
            ))}
          </Table.Body>
        </Table>
      </section>
    </LayerCard>
  );
}

function SkillRow({
  onDelete,
  onView,
  skill,
}: {
  onDelete: SkillRowAction;
  onView: SkillRowAction;
  skill: SkillSummary;
}) {
  const withTrigger = (action: SkillRowAction) => (event: MouseEvent<HTMLButtonElement>) =>
    action(skill, event.currentTarget);
  return (
    <Table.Row
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-b border-kumo-line last:border-b-0 @min-[40rem]/content:table-row @min-[40rem]/content:border-b-0"
      data-ui="skill-row"
    >
      <Table.Cell className="col-span-2 min-w-0 align-top" data-label={m.skills_column_name()}>
        <div className="grid min-w-0 gap-0.5">
          <span className="break-all font-medium text-kumo-default" data-ui="skill-name">
            {skill.name}
          </span>
          <Text as="p" size="sm" variant="secondary">
            <span className="line-clamp-3 break-words @min-[40rem]/content:line-clamp-2">{skill.description}</span>
          </Text>
        </div>
      </Table.Cell>
      <Table.Cell className="col-start-1 min-w-0 self-center" data-label={m.skills_column_files()}>
        <span className="text-sm text-kumo-subtle @min-[40rem]/content:whitespace-nowrap">
          {m.skills_file_count({ count: skill.fileCount })} · {formatBytes(skill.totalBytes)}
        </span>
      </Table.Cell>
      <Table.Cell className="col-start-2 justify-self-end self-center" data-label={m.skills_column_updated()}>
        <span className="grid justify-items-end gap-0.5 text-sm text-kumo-subtle @min-[40rem]/content:justify-items-start">
          <time className="whitespace-nowrap" dateTime={skill.updatedAt} title={formatDateTime(skill.updatedAt)}>
            {formatRelativeTime(skill.updatedAt)}
          </time>
          <span className="whitespace-nowrap text-xs">{skillUpdatedByLabel(skill.updatedBy.kind)}</span>
        </span>
      </Table.Cell>
      <Table.Cell className="col-start-1 self-center" data-label={m.skills_column_agents()}>
        <span className="whitespace-nowrap text-sm text-kumo-subtle" data-ui="skill-agent-count">
          {m.skills_agent_count({ count: skill.agentCount })}
        </span>
      </Table.Cell>
      <Table.Cell className="col-span-2" data-label={m.skills_column_actions()}>
        {/* biome-ignore lint/a11y/useSemanticElements: These are row actions, not form controls; a fieldset would announce a form. */}
        <div
          aria-label={m.skills_actions_for({ name: skill.name })}
          className="flex flex-wrap gap-1 @min-[40rem]/content:justify-end"
          role="group"
        >
          <Button size="compact" type="button" variant="ghost" onClick={withTrigger(onView)}>
            <Icon name="file-text" />
            {m.skills_view_skill_md()}
          </Button>
          <a
            className={buttonClassName({ size: "compact", variant: "ghost" })}
            download={`${skill.name}.zip`}
            href={skillArchivePath(skill.name)}
          >
            <Icon name="download" />
            {m.skills_download()}
          </a>
          <Button
            className="text-kumo-danger"
            size="compact"
            type="button"
            variant="ghost"
            onClick={withTrigger(onDelete)}
          >
            <Icon name="trash" />
            {m.common_delete()}
          </Button>
        </div>
      </Table.Cell>
    </Table.Row>
  );
}
