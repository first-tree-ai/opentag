import { AGENT_USAGE_WINDOW_OPTIONS, type CloudUsageSummary, type CloudUsageWindowDays } from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { browserApi } from "../../api.js";
import { formatCompactNumber, formatNumber } from "../../i18n/format.js";
import * as m from "../../paraglide/messages.js";
import { liveResourceQueryOptions } from "../../query/live.js";
import { Banner, Empty, LayerCard, Text } from "../../ui/design-system.js";
import { Metric, TokenTrendChart, UsageWindowSelect } from "../agent-usage.js";
import { Page } from "../layout/page.js";

export function CloudUsagePage() {
  const [windowDays, setWindowDays] = useState<CloudUsageWindowDays>(30);
  const query = useQuery({
    queryKey: ["cloud-usage", windowDays],
    queryFn: () => browserApi.cloudUsage(windowDays),
    ...liveResourceQueryOptions,
  });
  return (
    <div className="@container/usage-tab">
      <Page
        title={m.usage_cloud_title()}
        description={m.usage_cloud_description()}
        action={<UsageWindowSelect options={AGENT_USAGE_WINDOW_OPTIONS} value={windowDays} onChange={setWindowDays} />}
      >
        {query.isPending ? <p role="status">{m.usage_cloud_loading()}</p> : null}
        {query.isError ? (
          <Banner
            role="alert"
            variant="error"
            title={m.usage_error_title()}
            description={m.usage_error_fallback()}
            action={<Banner.Action onClick={() => void query.refetch()}>{m.usage_retry()}</Banner.Action>}
          />
        ) : null}
        {!query.isError && query.data ? <CloudUsageContent usage={query.data} /> : null}
      </Page>
    </div>
  );
}

function CloudUsageContent({ usage }: { usage: CloudUsageSummary }) {
  if (!usage.enabled) return <p className="text-sm text-kumo-subtle">{m.usage_cloud_disabled()}</p>;
  return (
    <>
      <LayerCard className="p-0" data-ui="usage-summary">
        <dl className="grid grid-cols-2 divide-x divide-kumo-line" aria-label={m.usage_cloud_title()}>
          <Metric label={m.usage_metric_total_tokens()} value={formatCompactNumber(usage.tokens)} />
          <Metric label={m.usage_cloud_requests()} value={formatCompactNumber(usage.requests)} />
        </dl>
      </LayerCard>
      {usage.measuredRequests < usage.requests ? (
        <Banner
          role="status"
          variant="alert"
          size="sm"
          title={m.usage_coverage_partial_title()}
          description={m.usage_cloud_partial({
            measured: formatNumber(usage.measuredRequests),
            requests: formatNumber(usage.requests),
          })}
        />
      ) : null}
      {usage.tokens > 0 ? (
        <div className="grid gap-4" data-ui="usage-analysis">
          <LayerCard
            render={<section aria-labelledby="cloud-usage-trend-heading" />}
            className="grid min-w-0 content-start gap-4 p-4"
          >
            <Text as="h2" id="cloud-usage-trend-heading" variant="heading">
              {m.usage_trend_title()}
            </Text>
            <TokenTrendChart usage={usage} />
          </LayerCard>
        </div>
      ) : (
        <LayerCard className="p-4">
          <Empty
            className="min-h-72 rounded-none border-0 bg-transparent"
            title={m.usage_no_tokens_title()}
            description={m.usage_no_tokens_description()}
          />
        </LayerCard>
      )}
    </>
  );
}
