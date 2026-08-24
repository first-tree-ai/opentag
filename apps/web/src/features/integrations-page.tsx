import { integrationPreviews } from "../mock/capability-data.js";
import "../mock-pages.css";

export function IntegrationsPage() {
  return (
    <section className="capability-page" aria-labelledby="integrations-page-title">
      <header className="capability-page-header integration-page-header">
        <div>
          <h1 id="integrations-page-title">Integrations</h1>
          <p>Services OpenTag could work with to find context and complete work.</p>
        </div>
        <span className="capability-demo-note">Demo data</span>
      </header>

      <table className="capability-table" aria-label="Demo Integrations">
        <thead>
          <tr className="capability-table-header capability-integration-grid">
            <th scope="col">Name</th>
            <th scope="col">Category</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {integrationPreviews.map((integration) => (
            <tr className="capability-table-row capability-integration-grid" key={integration.id}>
              <td className="capability-primary-cell capability-integration-cell">
                <span className={`capability-integration-mark is-${integration.id}`} aria-hidden="true">
                  {integration.abbreviation}
                </span>
                <span>
                  <strong>{integration.name}</strong>
                  <small>{integration.description}</small>
                </span>
              </td>
              <td data-label="Category">{integration.category}</td>
              <td data-label="Status">
                <span className="capability-demo-status">Demo</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
