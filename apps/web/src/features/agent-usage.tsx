import {
  AGENT_USAGE_WINDOW_DAYS,
  AGENT_USAGE_WINDOW_OPTIONS,
  type AgentUsageDetail,
  type AgentUsageWindowDays,
} from "@opentag/shared/browser";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, lazy, Suspense, useCallback, useState } from "react";
import { browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { formatCompactNumber, formatDay, formatNumber, formatPercent } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import {
  Banner,
  ChartPalette,
  Empty,
  Icon,
  LayerCard,
  Loader,
  Select,
  SkeletonLine,
  Table,
  Text,
  TimeseriesChart,
} from "../ui/design-system.js";
import { isTerminalResourceError } from "./resource/resource-state.js";

const LazyTimeseriesChart = lazy(async () => {
  const { echarts } = await import("./agent-usage-echarts.js");
  return {
    default: (props: Omit<ComponentProps<typeof TimeseriesChart>, "echarts">) => (
      <TimeseriesChart {...props} echarts={echarts} />
    ),
  };
});

type UsageState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "ready"; readonly value: AgentUsageDetail };

/** The Agent home answers "how much has this Agent used recently", so it offers the shortest windows. */
const AGENT_HOME_USAGE_WINDOW_OPTIONS = [1, 7, AGENT_USAGE_WINDOW_DAYS] as const;

export function usageWindowLabel(days: AgentUsageWindowDays): string {
  return days === 1 ? m.usage_window_24_hours() : m.usage_window_days({ days });
}

export function AgentUsageOverview({ agentId }: { agentId: string }) {
  const [windowDays, setWindowDays] = useState<AgentUsageWindowDays>(AGENT_USAGE_WINDOW_DAYS);
  const { retry, state } = useAgentUsage(agentId, windowDays);
  return (
    <LayerCard
      render={<section />}
      className="grid gap-4 p-4"
      aria-labelledby="agent-usage-overview-heading"
      data-ui="usage-overview"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Text as="h2" id="agent-usage-overview-heading" variant="heading">
          {m.usage_title()}
        </Text>
        <UsageWindowSelect options={AGENT_HOME_USAGE_WINDOW_OPTIONS} value={windowDays} onChange={setWindowDays} />
      </div>
      <UsageSummaryState state={state} compact onRetry={retry} />
      <Link
        className="inline-flex items-center justify-self-end gap-1 text-sm text-kumo-link"
        params={{ agentId }}
        to="/agents/$agentId/usage"
      >
        {m.usage_view_usage()}
        <Icon className="size-3.5" name="chevron-right" />
      </Link>
    </LayerCard>
  );
}

function UsageWindowSelect({
  onChange,
  options,
  value,
}: {
  onChange: (windowDays: AgentUsageWindowDays) => void;
  options: readonly AgentUsageWindowDays[];
  value: AgentUsageWindowDays;
}) {
  return (
    <div className="ml-auto w-40 shrink-0" data-ui="usage-window-select">
      <Select
        aria-label={m.usage_period_label()}
        className="w-full"
        renderValue={(days) => usageWindowLabel(days)}
        size="sm"
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue !== null) onChange(nextValue);
        }}
      >
        {options.map((days) => (
          <Select.Option key={days} value={days}>
            {usageWindowLabel(days)}
          </Select.Option>
        ))}
      </Select>
    </div>
  );
}

export function AgentUsageTab({ agentId }: { agentId: string }) {
  const [windowDays, setWindowDays] = useState<AgentUsageWindowDays>(AGENT_USAGE_WINDOW_DAYS);
  const { retry, state } = useAgentUsage(agentId, windowDays);
  return (
    <div className="@container/usage-tab grid gap-6" data-ui="usage-tab">
      <PageHeader description={m.usage_description()} title={m.usage_title()} titleId="agent-usage-page-heading">
        <UsageWindowSelect options={AGENT_USAGE_WINDOW_OPTIONS} value={windowDays} onChange={setWindowDays} />
      </PageHeader>
      <UsageSummaryState state={state} onRetry={retry} />
    </div>
  );
}

function useAgentUsage(
  agentId: string,
  windowDays: AgentUsageWindowDays,
): { readonly retry: () => void; readonly state: UsageState } {
  // Keyed by Agent and window, so the overview on an Agent's page and the tab on its usage page ask
  // for the same 30 days once between them rather than each on its own.
  const query = useQuery({
    queryKey: queryKeys.agents.usage(agentId, windowDays),
    queryFn: () => browserApi.agentUsage(agentId, windowDays),
  });
  const retry = useCallback(() => void query.refetch(), [query]);
  const error = query.isError ? usageError(query.error) : undefined;
  const state: UsageState =
    error && (!query.data || isTerminalResourceError(error))
      ? { kind: "error", error }
      : query.data
        ? { kind: "ready", value: query.data }
        : error
          ? { kind: "error", error }
          : { kind: "loading" };
  return { retry, state };
}

function usageError(cause: unknown): Error {
  if (cause instanceof Error && cause.message.trim()) return cause;
  if (typeof cause === "string" && cause.trim()) return new Error(cause);
  return new Error(m.usage_error_fallback());
}

function UsageSummaryState({
  state,
  compact = false,
  onRetry,
}: {
  state: UsageState;
  compact?: boolean;
  onRetry: () => void;
}) {
  if (state.kind === "loading") {
    return compact ? (
      <div aria-label={m.usage_loading()} className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
        <span aria-hidden="true">
          <Loader size="sm" />
        </span>
        <span>{m.usage_loading()}…</span>
      </div>
    ) : (
      <UsageLoading />
    );
  }
  if (state.kind === "error") {
    return (
      <Banner
        action={<Banner.Action onClick={onRetry}>{m.usage_retry()}</Banner.Action>}
        data-ui="usage-unavailable"
        description={state.error.message}
        role="alert"
        title={m.usage_error_title()}
        variant="error"
      />
    );
  }
  return compact ? <UsageMetrics usage={state.value} compact /> : <AgentUsageDetailContent usage={state.value} />;
}

function UsageLoading() {
  return (
    <div aria-label={m.usage_loading()} className="grid gap-4" data-ui="usage-loading" role="status">
      <LayerCard className="grid grid-cols-2 divide-x divide-kumo-line p-0">
        <UsageMetricSkeleton />
        <UsageMetricSkeleton />
      </LayerCard>
      <div className="grid gap-4 @min-[42rem]/usage-tab:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        <LayerCard className="grid gap-4 p-4">
          <SkeletonLine blockHeight="1.25rem" maxWidth={40} minWidth={28} />
          <SkeletonLine blockHeight="18rem" maxWidth={100} minWidth={100} />
        </LayerCard>
        <LayerCard className="grid content-start gap-4 p-4">
          <SkeletonLine blockHeight="1.25rem" maxWidth={55} minWidth={38} />
          <SkeletonLine blockHeight="2.5rem" maxWidth={100} minWidth={82} />
          <SkeletonLine blockHeight="2.5rem" maxWidth={100} minWidth={82} />
          <SkeletonLine blockHeight="2.5rem" maxWidth={100} minWidth={82} />
        </LayerCard>
      </div>
    </div>
  );
}

function UsageMetricSkeleton() {
  return (
    <div className="grid gap-3 p-5" aria-hidden="true">
      <SkeletonLine blockHeight="0.875rem" maxWidth={38} minWidth={24} />
      <SkeletonLine blockHeight="1.75rem" maxWidth={58} minWidth={36} />
    </div>
  );
}

function UsageMetrics({ compact = false, usage }: { compact?: boolean; usage: AgentUsageDetail }) {
  return (
    <dl
      className="grid grid-cols-2 divide-x divide-kumo-line"
      aria-label={m.usage_metrics_label({ window: usageWindowLabel(usage.windowDays) })}
      data-ui="usage-metrics"
    >
      <Metric compact={compact} label={m.usage_metric_total_tokens()} value={formatCompactNumber(usage.tokens)} />
      <Metric compact={compact} label={m.usage_metric_tasks()} value={formatCompactNumber(usage.tasks)} />
    </dl>
  );
}

function UsageCoverage({ usage }: { usage: AgentUsageDetail }) {
  if (usage.tasks === usage.measuredTasks) return null;
  const noCoverage = usage.measuredTasks === 0;
  return (
    <Banner
      data-ui="usage-coverage"
      description={
        noCoverage
          ? m.usage_coverage_none_description({ tasks: formatNumber(usage.tasks) })
          : m.usage_coverage_partial_description({
              measuredTasks: formatNumber(usage.measuredTasks),
              tasks: formatNumber(usage.tasks),
            })
      }
      role="status"
      size="sm"
      title={noCoverage ? m.usage_coverage_none_title() : m.usage_coverage_partial_title()}
      variant="alert"
    />
  );
}

function Metric({ compact = false, label, value }: { compact?: boolean; label: string; value: string }) {
  return (
    <div className={compact ? "grid min-w-0 gap-1 px-4 first:pl-0 last:pr-0" : "grid gap-1 p-5"}>
      <Text as="dt" size="sm" variant="secondary">
        {label}
      </Text>
      <Text as="dd" DANGEROUS_className="tabular-nums" size="lg" variant="heading">
        {value}
      </Text>
    </div>
  );
}

function AgentUsageDetailContent({ usage }: { usage: AgentUsageDetail }) {
  return (
    <>
      <LayerCard className="p-0" data-ui="usage-summary">
        <UsageMetrics usage={usage} />
      </LayerCard>
      <UsageCoverage usage={usage} />
      <div
        className="grid gap-4 @min-[42rem]/usage-tab:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]"
        data-ui="usage-analysis"
      >
        <LayerCard
          render={<section aria-labelledby="agent-usage-trend-heading" />}
          className="grid min-w-0 content-start gap-4 p-4"
        >
          <header className="flex min-h-7 items-center">
            <Text as="h3" id="agent-usage-trend-heading" variant="heading">
              {m.usage_trend_title()}
            </Text>
          </header>
          <TokenTrendChart usage={usage} />
        </LayerCard>
        <LayerCard
          render={<section aria-labelledby="agent-usage-breakdown-heading" />}
          className="grid min-w-0 content-start gap-4 p-4"
        >
          <header className="flex min-h-7 items-center">
            <Text as="h3" id="agent-usage-breakdown-heading" variant="heading">
              {m.usage_breakdown_title()}
            </Text>
          </header>
          <TokenBreakdown usage={usage} />
        </LayerCard>
      </div>
    </>
  );
}

function TokenTrendChart({ usage }: { usage: AgentUsageDetail }) {
  const nonEmpty = usage.daily.some((point) => point.tokens > 0);
  if (!nonEmpty) {
    return (
      <Empty
        className="min-h-72"
        data-ui="usage-empty"
        description={m.usage_no_tokens_description()}
        size="sm"
        title={m.usage_no_tokens_title()}
      />
    );
  }
  const chart = (
    <LazyTimeseriesChart
      ariaDescription={m.usage_chart_description({
        tokens: formatCompactNumber(usage.tokens),
        window: usageWindowLabel(usage.windowDays),
      })}
      data={[
        {
          color: ChartPalette.categorical(0),
          data: usage.daily.map((point) => [Date.parse(`${point.date}T12:00:00.000Z`), point.tokens]),
          name: m.usage_breakdown_tokens(),
        },
      ]}
      height={288}
      tooltipValueFormat={(value) => m.usage_chart_tooltip({ tokens: formatCompactNumber(value) })}
      xAxisTickFormat={(value) => formatDay(new Date(value).toISOString())}
      yAxisTickFormat={(value) => formatCompactNumber(value)}
    />
  );
  return (
    <div className="grid gap-2" data-ui="usage-chart">
      {import.meta.env.MODE === "test" ? (
        <div
          aria-label={m.usage_chart_description({
            tokens: formatCompactNumber(usage.tokens),
            window: usageWindowLabel(usage.windowDays),
          })}
          className="h-72 rounded bg-kumo-recessed"
          role="img"
        />
      ) : (
        <Suspense
          fallback={
            <div
              aria-label={m.usage_loading()}
              className="flex h-72 items-center justify-center rounded bg-kumo-tint text-kumo-subtle"
              role="status"
            >
              <span aria-hidden="true">
                <Loader size="lg" />
              </span>
            </div>
          }
        >
          {chart}
        </Suspense>
      )}
      <ol className="sr-only">
        {usage.daily.map((point) => (
          <li key={point.date}>
            {m.format_daily_tokens({ date: formatDay(point.date), tokens: formatNumber(point.tokens) })}
          </li>
        ))}
      </ol>
    </div>
  );
}

function TokenBreakdown({ usage }: { usage: AgentUsageDetail }) {
  const total = Math.max(usage.tokens, 1);
  return (
    <div className="grid gap-3">
      <div className="min-w-0 overflow-x-auto rounded-lg ring ring-kumo-line">
        <Table aria-label={m.usage_breakdown_title()} data-ui="usage-breakdown-table">
          <Table.Header variant="compact">
            <Table.Row>
              <Table.Head>{m.usage_breakdown_type()}</Table.Head>
              <Table.Head className="text-right">{m.usage_breakdown_usage()}</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            <BreakdownRow
              label={m.usage_breakdown_input()}
              share={formatPercent(usage.inputTokens / total)}
              value={usage.inputTokens}
            />
            <BreakdownRow
              label={m.usage_breakdown_output()}
              share={formatPercent(usage.outputTokens / total)}
              value={usage.outputTokens}
            />
            <BreakdownRow
              label={m.usage_breakdown_cached_input()}
              share={m.usage_breakdown_not_in_total()}
              value={usage.cachedInputTokens}
            />
          </Table.Body>
        </Table>
      </div>
      <Text as="p" size="sm" variant="secondary">
        {m.usage_breakdown_note()}
      </Text>
    </div>
  );
}

function BreakdownRow({ label, share, value }: { label: string; share: string; value: number }) {
  return (
    <Table.Row>
      <Table.Cell>
        <Text as="span" size="sm">
          {label}
        </Text>
      </Table.Cell>
      <Table.Cell className="align-middle">
        <span className="grid justify-items-end gap-0.5 text-right">
          <Text as="span" DANGEROUS_className="tabular-nums" size="sm">
            {m.usage_chart_tooltip({ tokens: formatCompactNumber(value) })}
          </Text>
          <Text as="span" DANGEROUS_className="tabular-nums" size="xs" variant="secondary">
            {share}
          </Text>
        </span>
      </Table.Cell>
    </Table.Row>
  );
}
