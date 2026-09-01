import figmaMark from "../assets/integration-figma.svg";
import githubMark from "../assets/integration-github.svg";
import googleDriveMark from "../assets/integration-google-drive.svg";
import linearMark from "../assets/integration-linear.svg";
import notionMark from "../assets/integration-notion.svg";
import sentryMark from "../assets/integration-sentry.svg";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { integrationPreviews } from "../mock/capability-data.js";
import * as m from "../paraglide/messages.js";
import { Badge, LayerCard, Table, Text } from "../ui/design-system.js";

const integrationMarks: Readonly<Record<string, string>> = {
  figma: figmaMark,
  github: githubMark,
  "google-drive": googleDriveMark,
  linear: linearMark,
  notion: notionMark,
  sentry: sentryMark,
};

function IntegrationMark({ abbreviation, id }: { abbreviation: string; id: string }) {
  const mark = integrationMarks[id];

  return (
    <span
      aria-hidden="true"
      className="inline-grid size-8 shrink-0 place-items-center"
      data-integration={id}
      data-ui="integration-mark"
    >
      {mark ? (
        <img alt="" className="size-5 object-contain" height="20" src={mark} width="20" />
      ) : (
        <span className="inline-grid size-8 place-items-center rounded-full bg-kumo-tint text-xs font-medium">
          {abbreviation}
        </span>
      )}
    </span>
  );
}

export function IntegrationsPage() {
  return (
    <section className="grid gap-6" aria-labelledby="integrations-page-title" data-ui="integrations-page">
      <PageHeader
        description={m.integrations_page_description()}
        title={m.integrations_page_title()}
        titleId="integrations-page-title"
      >
        <Text as="span" data-ui="integrations-demo-note" variant="secondary">
          {m.integrations_demo_data()}
        </Text>
      </PageHeader>

      <div className="grid min-w-0 gap-2">
        <div className="@min-[36rem]/content:hidden" id="integrations-scroll-hint">
          <Text as="p" size="sm" variant="secondary">
            {m.integrations_scroll_hint()}
          </Text>
        </div>
        <LayerCard className="p-0" data-ui="integrations-card">
          <section
            aria-describedby="integrations-scroll-hint"
            aria-label={m.integrations_table_region()}
            className="min-w-0 overflow-x-auto rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus the horizontal scroll region.
            tabIndex={0}
          >
            <Table
              aria-label={m.integrations_table_name()}
              className="min-w-[36rem]"
              data-ui="integrations-table"
              layout="fixed"
            >
              <colgroup>
                <col />
                <col className="w-40" />
                <col className="w-28" />
              </colgroup>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{m.integrations_column_name()}</Table.Head>
                  <Table.Head>{m.integrations_column_category()}</Table.Head>
                  <Table.Head>{m.integrations_column_status()}</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {integrationPreviews.map((integration) => (
                  <Table.Row key={integration.id}>
                    <Table.Cell
                      aria-label={m.integrations_cell_label({
                        name: integration.name,
                        description: integration.description,
                      })}
                    >
                      <span className="flex min-w-0 items-start gap-3">
                        <IntegrationMark abbreviation={integration.abbreviation} id={integration.id} />
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
                      <Badge variant="neutral">{m.integrations_demo()}</Badge>
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
