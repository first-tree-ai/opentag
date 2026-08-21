import { integrationPreviews } from "../mock/capability-data.js";
import "../mock-pages.css";

export function IntegrationsPage() {
  const connected = integrationPreviews.filter((integration) => integration.status === "Connected");
  const available = integrationPreviews.filter((integration) => integration.status === "Available");

  return (
    <section className="capability-page" aria-labelledby="integrations-page-title">
      <header className="capability-page-header">
        <div>
          <span className="capability-preview-label">Demo data preview</span>
          <h1 id="integrations-page-title">Integrations</h1>
          <p>Services that help Agents work with the tools used in this Workspace.</p>
        </div>
      </header>

      <div className="capability-section-stack">
        <IntegrationSection
          title="Connected"
          description="Sample connections currently available to Agents."
          items={connected}
        />
        <IntegrationSection
          title="Available"
          description="Additional services planned for this Workspace."
          items={available}
        />
      </div>
    </section>
  );
}

function IntegrationSection({
  title,
  description,
  items,
}: {
  title: "Connected" | "Available";
  description: string;
  items: typeof integrationPreviews;
}) {
  const headingId = `integrations-${title.toLowerCase()}`;

  return (
    <section className="capability-list-section" aria-labelledby={headingId}>
      <div className="capability-section-heading">
        <div>
          <h2 id={headingId}>{title}</h2>
          <p>{description}</p>
        </div>
        <span>{items.length}</span>
      </div>
      <ul className="capability-integration-list">
        {items.map((integration) => (
          <li key={integration.name}>
            <div className="capability-integration-identity">
              <span className="capability-integration-mark" aria-hidden="true">
                {integration.mark}
              </span>
              <span>
                <strong>{integration.name}</strong>
                <small>{integration.category}</small>
              </span>
            </div>
            <span className={`capability-status ${integration.status === "Connected" ? "is-connected" : ""}`}>
              {integration.status}
            </span>
            <span className="capability-agent-count">
              {integration.agentCount} {integration.agentCount === 1 ? "Agent" : "Agents"}
            </span>
            {integration.status === "Available" ? (
              <button type="button" className="secondary compact-button" disabled title="Coming soon">
                Connect (Coming soon)
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
