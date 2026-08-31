import { useRef, useState } from "react";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { skillPreviews } from "../mock/capability-data.js";
import * as m from "../paraglide/messages.js";
import { Button, Collapsible, Text } from "../ui/design-system.js";

export function SkillsPage() {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  return (
    <section className="grid gap-6" aria-labelledby="skills-page-title" data-ui="skills-page">
      <PageHeader description={m.skills_page_description()} title={m.skills_page_title()} titleId="skills-page-title">
        <div className="flex flex-wrap items-center gap-3" data-ui="skills-header-actions">
          <Text as="span" data-ui="skills-demo-note" variant="secondary">
            {m.skills_demo_data()}
          </Text>
          <div className="grid gap-2" data-ui="skills-upload-entry">
            <Button size="compact" variant="secondary" type="button" onClick={() => uploadInputRef.current?.click()}>
              {m.skills_upload()}
            </Button>
            <input
              ref={uploadInputRef}
              hidden
              accept=".md,.zip"
              aria-label={m.skills_upload_file()}
              type="file"
              onChange={(event) => setSelectedFileName(event.currentTarget.files?.[0]?.name ?? null)}
            />
            {selectedFileName ? (
              <Text as="span" data-ui="skills-upload-status" role="status" variant="secondary">
                {m.skills_upload_status({ fileName: selectedFileName })}
              </Text>
            ) : null}
          </div>
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

        <ul className="grid gap-3" aria-label={m.skills_available()} data-ui="skills-list">
          {skillPreviews.map((skill) => (
            <li key={skill.name}>
              <article className="rounded-lg bg-kumo-base ring ring-kumo-line" data-ui="skill-row">
                <Collapsible.Root>
                  <Collapsible.Trigger
                    className="flex w-full cursor-pointer flex-wrap items-center gap-4 p-4 text-left"
                    data-ui="skill-row-summary"
                  >
                    <div className="min-w-0 flex-1" data-ui="skill-row-copy">
                      <div className="flex flex-wrap items-center gap-2" data-ui="skill-row-title">
                        <Text as="h3" variant="heading">
                          {skill.name}
                        </Text>
                        <span className="text-sm text-kumo-subtle">{skill.status}</span>
                        {skill.source === "OpenTag" ? (
                          <span className="text-sm text-kumo-subtle">{m.skills_built_by_opentag()}</span>
                        ) : null}
                      </div>
                      <p>{skill.description}.</p>
                    </div>
                    <dl className="text-sm text-kumo-subtle" data-ui="skill-row-meta">
                      <div>
                        <dt>{m.skills_used_by()}</dt>
                        <dd>{m.skills_agent_count({ count: skill.agentCount })}</dd>
                      </div>
                    </dl>
                    <span className="text-sm text-kumo-link">{m.skills_preview()}</span>
                  </Collapsible.Trigger>
                  <Collapsible.Panel className="grid gap-2 border-t border-kumo-line p-4" data-ui="skill-preview-panel">
                    <Text as="h4" variant="heading">
                      {m.skills_instructions_preview()}
                    </Text>
                    <p>{skill.instructions}</p>
                  </Collapsible.Panel>
                </Collapsible.Root>
              </article>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
