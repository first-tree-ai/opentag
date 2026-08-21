import { useState } from "react";
import { type ResourceFilter, resourcePreviews, resourceTypes } from "../mock/capability-data.js";
import "../mock-pages.css";

const filters: readonly ResourceFilter[] = ["All", ...resourceTypes];

export function ResourcesPage() {
  const [activeFilter, setActiveFilter] = useState<ResourceFilter>("All");
  const visibleResources =
    activeFilter === "All" ? resourcePreviews : resourcePreviews.filter((resource) => resource.type === activeFilter);

  return (
    <section className="capability-page" aria-labelledby="resources-page-title">
      <header className="capability-page-header">
        <div>
          <span className="capability-preview-label">Demo data preview</span>
          <h1 id="resources-page-title">Resources</h1>
          <p>Reusable context and capabilities available across this Workspace.</p>
        </div>
        <div className="capability-future-action">
          <button type="button" disabled>
            Add resource (Coming soon)
          </button>
        </div>
      </header>

      <fieldset className="capability-filter-bar">
        <legend className="capability-filter-label">Filter resources</legend>
        {filters.map((filter) => (
          <button
            className={activeFilter === filter ? "is-active" : undefined}
            type="button"
            aria-pressed={activeFilter === filter}
            onClick={() => setActiveFilter(filter)}
            key={filter}
          >
            {filter}
          </button>
        ))}
      </fieldset>

      <table className="capability-table" aria-label={`${activeFilter} resources`}>
        <thead>
          <tr className="capability-table-header capability-resource-grid">
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Agents</th>
          </tr>
        </thead>
        <tbody>
          {visibleResources.map((resource) => (
            <tr className="capability-table-row capability-resource-grid" key={resource.name}>
              <td className="capability-primary-cell">
                <strong>{resource.name}</strong>
                <small>{resource.description}</small>
              </td>
              <td data-label="Type">
                <span className="capability-type-badge">{resource.type}</span>
              </td>
              <td data-label="Agents">
                {resource.agentCount} {resource.agentCount === 1 ? "Agent" : "Agents"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
