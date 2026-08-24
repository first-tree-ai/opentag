import { useRef, useState } from "react";
import { skillPreviews } from "../mock/capability-data.js";
import "../mock-pages.css";

export function SkillsPage() {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  return (
    <section className="capability-page skills-page" aria-labelledby="skills-page-title">
      <header className="skills-hero">
        <div>
          <h1 id="skills-page-title">Skills</h1>
          <p>Reusable playbooks that give Agents the context and methods they need to do specialized work.</p>
        </div>
        <div className="skills-header-actions">
          <span className="skills-demo-note">Demo data</span>
          <div className="skills-upload-entry">
            <button
              className="ds-button ds-button--secondary ds-button--compact"
              type="button"
              onClick={() => uploadInputRef.current?.click()}
            >
              Upload skill
            </button>
            <input
              ref={uploadInputRef}
              hidden
              accept=".md,.zip"
              aria-label="Skill file"
              type="file"
              onChange={(event) => setSelectedFileName(event.currentTarget.files?.[0]?.name ?? null)}
            />
            {selectedFileName ? (
              <span className="skills-upload-status" role="status">
                {selectedFileName} selected · Demo only, not uploaded
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <section className="skills-catalog" aria-labelledby="skills-catalog-title">
        <div className="skills-catalog-heading">
          <h2 id="skills-catalog-title">All skills</h2>
          <p>{skillPreviews.length} skills</p>
        </div>

        <ul className="skills-list" aria-label="Available skills">
          {skillPreviews.map((skill) => (
            <li key={skill.name}>
              <article className="skill-row">
                <details>
                  <summary className="skill-row-summary">
                    <div className="skill-row-copy">
                      <div className="skill-row-title">
                        <h3>{skill.name}</h3>
                        <span className="skill-row-status">{skill.status}</span>
                        {skill.source === "OpenTag" ? (
                          <span className="skill-row-provider">Built by OpenTag</span>
                        ) : null}
                      </div>
                      <p>{skill.description}.</p>
                    </div>
                    <dl className="skill-row-meta">
                      <div>
                        <dt>Used by</dt>
                        <dd>
                          {skill.agentCount} {skill.agentCount === 1 ? "Agent" : "Agents"}
                        </dd>
                      </div>
                    </dl>
                    <span className="skill-row-preview-label">Preview</span>
                  </summary>
                  <div className="skill-preview-panel">
                    <h4>Instructions preview</h4>
                    <p>{skill.instructions}</p>
                  </div>
                </details>
              </article>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
