import { useRef, useState } from "react";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { skillPreviews } from "../mock/capability-data.js";
import { Button, Collapsible, Text } from "../ui/design-system.js";

export function SkillsPage() {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  return (
    <section className="grid gap-6" aria-labelledby="skills-page-title" data-ui="skills-page">
      <PageHeader
        description="Reusable playbooks that give Agents the context and methods they need to do specialized work."
        title="Skills"
        titleId="skills-page-title"
      >
        <div className="flex flex-wrap items-center gap-3" data-ui="skills-header-actions">
          <Text as="span" data-ui="skills-demo-note" variant="secondary">
            Demo data
          </Text>
          <div className="grid gap-2" data-ui="skills-upload-entry">
            <Button size="compact" variant="secondary" type="button" onClick={() => uploadInputRef.current?.click()}>
              Upload skill
            </Button>
            <input
              ref={uploadInputRef}
              hidden
              accept=".md,.zip"
              aria-label="Skill file"
              type="file"
              onChange={(event) => setSelectedFileName(event.currentTarget.files?.[0]?.name ?? null)}
            />
            {selectedFileName ? (
              <Text as="span" data-ui="skills-upload-status" role="status" variant="secondary">
                {selectedFileName} selected · Demo only, not uploaded
              </Text>
            ) : null}
          </div>
        </div>
      </PageHeader>

      <section className="grid gap-4" aria-labelledby="skills-catalog-title" data-ui="skills-catalog">
        <div className="flex items-baseline justify-between gap-3" data-ui="skills-catalog-heading">
          <Text as="h2" id="skills-catalog-title" variant="heading">
            All skills
          </Text>
          <Text as="p" variant="secondary">
            {skillPreviews.length} skills
          </Text>
        </div>

        <ul className="grid gap-3" aria-label="Available skills" data-ui="skills-list">
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
                          <span className="text-sm text-kumo-subtle">Built by OpenTag</span>
                        ) : null}
                      </div>
                      <p>{skill.description}.</p>
                    </div>
                    <dl className="text-sm text-kumo-subtle" data-ui="skill-row-meta">
                      <div>
                        <dt>Used by</dt>
                        <dd>
                          {skill.agentCount} {skill.agentCount === 1 ? "Agent" : "Agents"}
                        </dd>
                      </div>
                    </dl>
                    <span className="text-sm text-kumo-link">Preview</span>
                  </Collapsible.Trigger>
                  <Collapsible.Panel className="grid gap-2 border-t border-kumo-line p-4" data-ui="skill-preview-panel">
                    <Text as="h4" variant="heading">
                      Instructions preview
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
