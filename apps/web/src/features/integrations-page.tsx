import "../mock-pages.css";

export function IntegrationsPage() {
  return (
    <section className="capability-page" aria-labelledby="integrations-page-title">
      <header className="capability-page-header">
        <div>
          <h1 id="integrations-page-title">Integrations</h1>
          <p>Review Workspace-level service connections when OpenTag exposes an authoritative API.</p>
        </div>
      </header>

      <section className="settings-unavailable">
        <span className="settings-state-label">Coming later</span>
        <h2>Workspace Integrations are not available yet</h2>
        <p>The current server does not expose a Workspace Integration contract.</p>
        <ul>
          <li>No connection state or Agent assignment is inferred or generated here.</li>
          <li>Provider Bot connections remain managed from each Agent&apos;s Messaging page.</li>
        </ul>
      </section>
    </section>
  );
}
