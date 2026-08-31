import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { integrationPreviews } from "../mock/capability-data.js";
import { Badge, LayerCard, Table, Text } from "../ui/design-system.js";

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

      <div className="grid min-w-0 gap-2">
        <div className="@min-[36rem]/workspace:hidden" id="integrations-scroll-hint">
          <Text as="p" size="sm" variant="secondary">
            Scroll horizontally to see category and status.
          </Text>
        </div>
        <LayerCard className="p-0" data-ui="integrations-card">
          <section
            aria-describedby="integrations-scroll-hint"
            aria-label="Integrations table"
            className="min-w-0 overflow-x-auto rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus the horizontal scroll region.
            tabIndex={0}
          >
            <Table aria-label="Demo Integrations" className="min-w-[36rem]" data-ui="integrations-table" layout="fixed">
              <colgroup>
                <col />
                <col className="w-40" />
                <col className="w-28" />
              </colgroup>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Name</Table.Head>
                  <Table.Head>Category</Table.Head>
                  <Table.Head>Status</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {integrationPreviews.map((integration) => (
                  <Table.Row key={integration.id}>
                    <Table.Cell aria-label={`${integration.name}. ${integration.description}`}>
                      <span className="flex min-w-0 items-start gap-3">
                        <span
                          className="inline-grid size-8 shrink-0 place-items-center rounded-full bg-kumo-tint text-xs font-medium"
                          aria-hidden="true"
                        >
                          {integration.abbreviation}
                        </span>
                        <span className="grid min-w-0 gap-0.5">
                          <Text as="strong" variant="heading">
                            {integration.name}
                          </Text>
                          <Text as="span" variant="secondary">
                            {integration.description}
                          </Text>
                        </span>
                      </span>
                    </Table.Cell>
                    <Table.Cell>{integration.category}</Table.Cell>
                    <Table.Cell>
                      <Badge variant="neutral">Demo</Badge>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </section>
        </LayerCard>
      </div>
    </section>
  );
}
