import { skillPreviews } from "../mock/capability-data.js";
import "../mock-pages.css";

export function SkillsPage() {
  return (
    <section className="capability-page" aria-labelledby="skills-page-title">
      <header className="capability-page-header">
        <div>
          <span className="capability-preview-label">Demo data</span>
          <h1 id="skills-page-title">Skills</h1>
          <p>Reusable instructions and capability requirements that Agents use to complete Tasks.</p>
        </div>
      </header>

      <table className="capability-table" aria-label="Demo Skills">
        <thead>
          <tr className="capability-table-header capability-skill-grid">
            <th scope="col">Name</th>
            <th scope="col">Source</th>
            <th scope="col">Used by</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {skillPreviews.map((skill) => (
            <tr className="capability-table-row capability-skill-grid" key={skill.name}>
              <td className="capability-primary-cell">
                <strong>{skill.name}</strong>
                <small>{skill.description}</small>
              </td>
              <td data-label="Source">{skill.source}</td>
              <td data-label="Used by">
                {skill.agentCount} {skill.agentCount === 1 ? "Agent" : "Agents"}
              </td>
              <td data-label="Status">
                <span className="capability-demo-status">{skill.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
