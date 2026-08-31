import figmaIcon from "../assets/integrations/figma.svg";
import githubIcon from "../assets/integrations/github.svg";
import googleDriveIcon from "../assets/integrations/google-drive.svg";
import linearIcon from "../assets/integrations/linear.svg";
import notionIcon from "../assets/integrations/notion.svg";
import sentryIcon from "../assets/integrations/sentry.svg";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { integrationPreviews } from "../mock/capability-data.js";
import { Badge, LayerCard, Table, Text } from "../ui/design-system.js";

const integrationIcons: Readonly<Record<string, string>> = {
  figma: figmaIcon,
  github: githubIcon,
  "google-drive": googleDriveIcon,
  linear: linearIcon,
  notion: notionIcon,
  sentry: sentryIcon,
};

function IntegrationIcon({ id, abbreviation }: { id: string; abbreviation: string }) {
  const icon = integrationIcons[id];

  return (
    <span
      aria-hidden="true"
      className="inline-grid size-8 shrink-0 place-items-center rounded-lg border border-kumo-line bg-white"
      data-integration={id}
      data-ui="integration-icon"
    >
      {icon ? (
        <img alt="" className="size-5 object-contain" height="20" src={icon} width="20" />
      ) : (
        <span className="text-xs font-medium text-kumo-default">{abbreviation}</span>
      )}
    </span>
  );
}

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
                    <Table.Cell aria-label={`${integration.name}. ${integration.description}`} data-label="Name">
                      <span className="flex min-w-0 items-start gap-3">
                        <IntegrationIcon abbreviation={integration.abbreviation} id={integration.id} />
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
                    <Table.Cell data-label="Category">{integration.category}</Table.Cell>
                    <Table.Cell data-label="Status">
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
