import {
  AGENT_USAGE_WINDOW_DAYS,
  AGENT_USAGE_WINDOW_OPTIONS,
  type AgentUsageDetail,
  type AgentUsageWindowDays,
} from "@opentag/shared/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, lazy, Suspense, useCallback, useState } from "react";
import { browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { formatCompactNumber, formatDay, formatNumber, formatPercent } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { liveResourceQueryOptions } from "../query/live.js";
import { terminalResourceObservedAt } from "../query/session-cache.js";
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
import { useAgentListQuery } from "./agents/agent-queries.js";
import {
  isConfirmedQuerySuccess,
  isTerminalResourceError,
  ResourceRefreshNotice,
  usePersistedSettledError,
} from "./resource/resource-state.js";

const LazyTimeseriesChart = lazy(async () => {
  const { echarts } = await import("./agent-usage-echarts.js");
  return {
    default: (props: Omit<ComponentProps<typeof TimeseriesChart>, "echarts">) => (
      <TimeseriesChart {...props} echarts={echarts} />
    ),
  };
});

type UsageTotals = {
  readonly windowDays: AgentUsageWindowDays;
  readonly tasks: number;
  readonly tokens: number;
};

type UsageState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: Error }
  | {
      readonly kind: "ready";
      readonly value: UsageTotals;
      readonly detail?: AgentUsageDetail;
      readonly refreshError?: Error;
    };

/** The Agent home answers "how much has this Agent used recently", so it offers the shortest windows. */
const AGENT_HOME_USAGE_WINDOW_OPTIONS = [1, 7, AGENT_USAGE_WINDOW_DAYS] as const;

export function usageWindowLabel(days: AgentUsageWindowDays): string {
  return days === 1 ? m.usage_window_24_hours() : m.usage_window_days({ days });
}

export function usageXAxisTickCount(days: AgentUsageWindowDays): number {
  if (days === 1) return 4;
  return 3;
}

export function usageXAxisTickLabel(value: number, endedAt: string, windowDays: AgentUsageWindowDays): string {
  const timestamp = new Date(value).toISOString();
  const distanceFromEnd = Date.parse(endedAt) - value;
  const endLabelBuffer = windowDays === 1 ? 4 * 60 * 60 * 1_000 : 2 * 24 * 60 * 60 * 1_000;
  return distanceFromEnd >= 0 && distanceFromEnd < endLabelBuffer ? "" : formatDay(timestamp);
}

export function AgentUsageOverview({ accountId, agentId }: { accountId?: string; agentId: string }) {
  const [windowDays, setWindowDays] = useState<AgentUsageWindowDays>(AGENT_USAGE_WINDOW_DAYS);
  const { retry, state } = useAgentUsage(agentId, windowDays, { accountId, compact: true });
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
  { accountId, compact = false }: { accountId?: string; compact?: boolean } = {},
): { readonly retry: () => void; readonly state: UsageState } {
  const queryClient = useQueryClient();
  const usageKey = queryKeys.agents.usage(agentId, windowDays);
  const canUseListSummary = Boolean(compact && windowDays === AGENT_USAGE_WINDOW_DAYS && accountId);
  const listQuery = useAgentListQuery(accountId ?? "", canUseListSummary);
  const listed = listQuery.data?.agents.find((agent) => agent.id === agentId);
  const listSummary =
    canUseListSummary && listed && isConfirmedQuerySuccess(listQuery)
      ? ({
          windowDays: AGENT_USAGE_WINDOW_DAYS,
          tasks: listed.usage.tasks,
          tokens: listed.usage.tokens,
        } satisfies UsageTotals)
      : undefined;
  const waitingForList = canUseListSummary && !listQuery.isFetched;
  const cachedUsage = queryClient.getQueryState<AgentUsageDetail>(usageKey);
  const usageSuccessAt = cachedUsage?.data !== undefined ? cachedUsage.dataUpdatedAt : 0;
  const usageRefusalAt = terminalResourceObservedAt(queryClient, usageKey);
  const listStamp = listQuery.isSuccess ? listQuery.dataUpdatedAt : 0;
  const usageAuthoritative = usageSuccessAt > listStamp || usageRefusalAt > listStamp;
  // Keyed by Agent and window. The home 30-day totals reuse the list summary when that read is the
  // newest authorized source; a newer full read or refusal wins. A summary is never written into the
  // detail cache.
  const query = useQuery({
    queryKey: usageKey,
    queryFn: () => browserApi.agentUsage(agentId, windowDays),
    enabled: !waitingForList && (!listSummary || usageAuthoritative),
    ...liveResourceQueryOptions,
  });
  const persistedError = usePersistedSettledError(usageKey, {
    error: query.error ? usageError(query.error) : null,
    isError: query.isError,
    isSuccess: query.isSuccess,
  });
  const retry = useCallback(() => {
    if (usageAuthoritative || !listSummary) void query.refetch();
    else void listQuery.refetch();
  }, [listQuery, listSummary, query, usageAuthoritative]);
  return {
    retry,
    state: presentUsageState({
      detail: query.data,
      detailUpdatedAt: query.dataUpdatedAt,
      listError: listQuery.isError ? usageError(listQuery.error) : undefined,
      listSummary,
      listUpdatedAt: listQuery.dataUpdatedAt,
      persistedAt: usageRefusalAt,
      persistedError,
      queryError: query.isError ? usageError(query.error) : undefined,
    }),
  };
}

function usageRefreshError(error: Error | null | undefined): Error | undefined {
  return error && !isTerminalResourceError(error) ? error : undefined;
}

function readyUsage(value: UsageTotals, detail?: AgentUsageDetail, refreshError?: Error): UsageState {
  return { kind: "ready", value, detail, refreshError };
}

function fallbackUsageState(detail: AgentUsageDetail | undefined, error: Error | null | undefined): UsageState {
  if (error && (!detail || isTerminalResourceError(error))) return { kind: "error", error };
  if (detail) return readyUsage(detail, detail, usageRefreshError(error));
  return error ? { kind: "error", error } : { kind: "loading" };
}

function presentUsageState({
  detail,
  detailUpdatedAt,
  listError,
  listSummary,
  listUpdatedAt,
  persistedAt,
  persistedError,
  queryError,
}: {
  detail?: AgentUsageDetail;
  detailUpdatedAt: number;
  listError?: Error;
  listSummary?: UsageTotals;
  listUpdatedAt: number;
  persistedAt: number;
  persistedError: Error | null;
  queryError?: Error;
}): UsageState {
  const refusalAt = persistedError && isTerminalResourceError(persistedError) ? persistedAt : 0;
  const usageSuccessAt = detail ? detailUpdatedAt : 0;
  const listAt = listSummary ? listUpdatedAt : 0;
  if (refusalAt > listAt && refusalAt > usageSuccessAt) {
    return { kind: "error", error: persistedError ?? queryError ?? new Error(m.usage_error_fallback()) };
  }
  if (detail && usageSuccessAt >= listAt && usageSuccessAt >= refusalAt) {
    return readyUsage(detail, detail, usageRefreshError(persistedError ?? queryError));
  }
  if (listSummary && listAt >= refusalAt) {
    return readyUsage(listSummary, undefined, usageRefreshError(listError));
  }
  return fallbackUsageState(detail, persistedError ?? queryError);
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
  return (
    <>
      {state.refreshError ? <ResourceRefreshNotice error={state.refreshError} onRetry={onRetry} /> : null}
      {compact ? (
        <UsageMetrics usage={state.value} compact />
      ) : state.detail ? (
        <AgentUsageDetailContent usage={state.detail} />
      ) : (
        <UsageMetrics usage={state.value} />
      )}
    </>
  );
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

function UsageMetrics({ compact = false, usage }: { compact?: boolean; usage: UsageTotals }) {
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
      className="text-kumo-default"
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
  const hasTokenActivity = usage.tokens > 0 || usage.cachedInputTokens > 0;
  return (
    <>
      <LayerCard className="p-0" data-ui="usage-summary">
        <UsageMetrics usage={usage} />
      </LayerCard>
      <UsageCoverage usage={usage} />
      {hasTokenActivity ? (
        <div
          className="grid gap-4 @min-[42rem]/usage-tab:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]"
          data-ui="usage-analysis"
        >
          <LayerCard
            render={<section aria-labelledby="agent-usage-trend-heading" />}
            className="grid min-w-0 content-start gap-4 p-4"
          >
            <header className="flex min-h-7 items-center">
              <Text as="h2" id="agent-usage-trend-heading" variant="heading">
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
              <Text as="h2" id="agent-usage-breakdown-heading" variant="heading">
                {m.usage_breakdown_title()}
              </Text>
            </header>
            <TokenBreakdown usage={usage} />
          </LayerCard>
        </div>
      ) : (
        <LayerCard
          render={<section aria-label={m.usage_no_tokens_title()} />}
          className="p-4"
          data-ui="usage-empty-card"
        >
          <UsageEmpty />
        </LayerCard>
      )}
    </>
  );
}

function UsageEmpty() {
  return (
    <div data-ui="usage-empty">
      <Empty
        className="min-h-72 gap-2 rounded-none border-0 bg-transparent px-6 py-8 [&_h2]:text-base"
        description={m.usage_no_tokens_description()}
        size="sm"
        title={m.usage_no_tokens_title()}
      />
    </div>
  );
}

function TokenTrendChart({ usage }: { usage: AgentUsageDetail }) {
  const nonEmpty = usage.daily.some((point) => point.tokens > 0);
  if (!nonEmpty) {
    return <UsageEmpty />;
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
      xAxisTickCount={usageXAxisTickCount(usage.windowDays)}
      xAxisTickFormat={(value) => usageXAxisTickLabel(value, usage.endedAt, usage.windowDays)}
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
      <div className="min-w-0 overflow-x-auto rounded-lg">
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
