import { integrationPreviews } from "../mock/capability-data.js";
import { Badge, Table } from "../ui/design-system.js";

export function IntegrationsPage() {
  return (
    <section className="grid gap-6" aria-labelledby="integrations-page-title" data-ui="integrations-page">
      <header className="flex flex-wrap items-start justify-between gap-4" data-ui="integrations-header">
        <div>
          <h1 id="integrations-page-title">Integrations</h1>
          <p>Services OpenTag could work with to find context and complete work.</p>
        </div>
        <span className="text-sm text-kumo-subtle" data-ui="integrations-demo-note">
          Demo data
        </span>
      </header>

      <Table className="w-full" aria-label="Demo Integrations" data-ui="integrations-table">
        <thead>
          <tr className="border-b border-kumo-line text-left text-sm text-kumo-subtle">
            <th scope="col">Name</th>
            <th scope="col">Category</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {integrationPreviews.map((integration) => (
            <tr className="border-b border-kumo-line" key={integration.id}>
              <td className="p-3">
                <span
                  className="mr-2 inline-grid size-7 place-items-center rounded-full bg-kumo-tint text-xs font-medium"
                  aria-hidden="true"
                >
                  {integration.abbreviation}
                </span>
                <span>
                  <strong>{integration.name}</strong>
                  <small>{integration.description}</small>
                </span>
              </td>
              <td data-label="Category">{integration.category}</td>
              <td data-label="Status">
                <Badge variant="neutral">Demo</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}
