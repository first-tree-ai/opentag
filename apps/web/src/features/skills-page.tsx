import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { skillPreviews } from "../mock/capability-data.js";
import * as m from "../paraglide/messages.js";
import { Badge, Button, Collapsible, Icon, LayerCard, Text, Tooltip } from "../ui/design-system.js";

export function SkillsPage() {
  return (
    <section className="grid gap-6" aria-labelledby="skills-page-title" data-ui="skills-page">
      <PageHeader description={m.skills_page_description()} title={m.skills_page_title()} titleId="skills-page-title">
        <div
          className="flex w-full flex-wrap items-center justify-between gap-2 @min-[36rem]/workspace:w-auto @min-[36rem]/workspace:justify-start"
          data-ui="skills-header-actions"
        >
          <Badge data-ui="skills-demo-note" variant="neutral">
            {m.skills_demo_data()}
          </Badge>
          <Tooltip
            content={m.skills_upload_unavailable()}
            render={
              <Button
                aria-disabled="true"
                aria-label={`${m.skills_upload()}: ${m.skills_upload_unavailable()}`}
                size="compact"
                type="button"
                variant="secondary"
              />
            }
          >
            {m.skills_upload()}
          </Tooltip>
        </div>
      </PageHeader>

      <section className="grid gap-4" aria-labelledby="skills-catalog-title" data-ui="skills-catalog">
        <div className="flex items-baseline justify-between gap-3" data-ui="skills-catalog-heading">
          <Text as="h2" id="skills-catalog-title" variant="heading">
            {m.skills_all_skills()}
          </Text>
          <Text as="p" variant="secondary">
            {m.skills_count({ count: skillPreviews.length })}
          </Text>
        </div>

        <LayerCard className="overflow-hidden p-0" data-ui="skills-list-card">
          <ul className="divide-y divide-kumo-line" aria-label={m.skills_available()} data-ui="skills-list">
            {skillPreviews.map((skill) => (
              <li key={skill.name}>
                <article data-ui="skill-row">
                  <Collapsible.Root>
                    <div
                      className="grid gap-3 p-4 @min-[48rem]/workspace:grid-cols-[minmax(0,1fr)_auto_auto] @min-[48rem]/workspace:items-center"
                      data-ui="skill-row-summary"
                    >
                      <div className="min-w-0" data-ui="skill-row-copy">
                        <div className="flex flex-wrap items-center gap-2" data-ui="skill-row-title">
                          <Text as="h3" variant="heading">
                            {skill.name}
                          </Text>
                          <Text as="span" size="sm" variant="secondary">
                            {skill.source === "OpenTag" ? m.skills_built_by_opentag() : m.skills_shared()}
                          </Text>
                        </div>
                        <Text as="p" variant="secondary">
                          {skill.description}.
                        </Text>
                      </div>
                      <div className="whitespace-nowrap">
                        <Text as="p" size="sm" variant="secondary">
                          {m.skills_used_by()} {m.skills_agent_count({ count: skill.agentCount })}
                        </Text>
                      </div>
                      <Collapsible.Trigger render={<Button size="compact" type="button" variant="ghost" />}>
                        {m.skills_preview()}
                        <Icon
                          className="size-3.5 transition-transform [[data-panel-open]_&]:rotate-180"
                          name="chevron-down"
                        />
                      </Collapsible.Trigger>
                    </div>
                    <Collapsible.Panel className="border-t border-kumo-line p-4" data-ui="skill-preview-panel">
                      <div className="grid max-w-prose gap-2">
                        <Text as="h4" variant="heading">
                          {m.skills_instructions_preview()}
                        </Text>
                        <Text as="p" variant="secondary">
                          {skill.instructions}
                        </Text>
                      </div>
                    </Collapsible.Panel>
                  </Collapsible.Root>
                </article>
              </li>
            ))}
          </ul>
        </LayerCard>
      </section>
    </section>
  );
}
