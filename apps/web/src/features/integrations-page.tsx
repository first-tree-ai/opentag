import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { integrationPreviews } from "../mock/capability-data.js";
import { Badge, Table, Text } from "../ui/design-system.js";

export function IntegrationsPage() {
  return (
    <section className="grid gap-6" aria-labelledby="integrations-page-title" data-ui="integrations-page">
      <PageHeader
        description="Services OpenTag could work with to find context and complete work."
        title="Integrations"
        titleId="integrations-page-title"
      >
        <Text as="span" data-ui="integrations-demo-note" variant="secondary">
          Demo data
        </Text>
      </PageHeader>

      <section
        aria-label="Integrations table"
        className="min-w-0 overflow-x-auto rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus the horizontal scroll region.
        tabIndex={0}
      >
        <Table className="min-w-[36rem]" aria-label="Demo Integrations" data-ui="integrations-table">
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
    </section>
  );
}
