import { useRef, useState } from "react";
import { skillPreviews } from "../mock/capability-data.js";
import { Button, Collapsible } from "../ui/design-system.js";

export function SkillsPage() {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  return (
    <section className="grid gap-6" aria-labelledby="skills-page-title" data-ui="skills-page">
      <header className="flex flex-wrap items-start justify-between gap-4" data-ui="skills-header">
        <div>
          <h1 id="skills-page-title">Skills</h1>
          <p>Reusable playbooks that give Agents the context and methods they need to do specialized work.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3" data-ui="skills-header-actions">
          <span className="text-sm text-kumo-subtle" data-ui="skills-demo-note">
            Demo data
          </span>
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
              <span className="text-sm text-kumo-subtle" data-ui="skills-upload-status" role="status">
                {selectedFileName} selected · Demo only, not uploaded
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <section className="grid gap-4" aria-labelledby="skills-catalog-title" data-ui="skills-catalog">
        <div className="flex items-baseline justify-between gap-3" data-ui="skills-catalog-heading">
          <h2 id="skills-catalog-title">All skills</h2>
          <p>{skillPreviews.length} skills</p>
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
                        <h3>{skill.name}</h3>
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
                    <h4>Instructions preview</h4>
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
