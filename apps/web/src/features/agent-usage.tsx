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
import { formatCompactNumber, formatDay, formatNumber } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import {
  Button,
  ChartPalette,
  Icon,
  KumoSelectControl,
  Loader,
  Meter,
  Text,
  TimeseriesChart,
} from "../ui/design-system.js";
import type { AgentDetailView } from "./agents/agent-model.js";
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
  return days === 1 ? "Last 24 hours" : `Last ${days} days`;
}

export function AgentUsageOverview({
  agent,
  agentId,
}: {
  /** Carried into history state so the usage page opens with the Agent already on screen. */
  agent?: AgentDetailView;
  agentId: string;
}) {
  const [windowDays, setWindowDays] = useState<AgentUsageWindowDays>(AGENT_USAGE_WINDOW_DAYS);
  const { retry, state } = useAgentUsage(agentId, windowDays);
  return (
    <section
      className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      aria-labelledby="agent-usage-overview-heading"
      data-ui="usage-overview"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Text as="h2" id="agent-usage-overview-heading" variant="heading">
          Usage
        </Text>
        <UsageWindowSelect options={AGENT_HOME_USAGE_WINDOW_OPTIONS} value={windowDays} onChange={setWindowDays} />
      </div>
      <UsageSummaryState state={state} compact onRetry={retry} />
      <Link
        className="inline-flex items-center justify-self-end gap-1 text-sm text-kumo-link"
        params={{ agentId }}
        state={{ agent }}
        to="/agents/$agentId/usage"
      >
        View details
        <Icon className="size-3.5" name="chevron-right" />
      </Link>
    </section>
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
    <div>
      <span className="sr-only" id="usage-period-label">
        Usage period
      </span>
      <KumoSelectControl
        aria-label="Usage period"
        aria-labelledby="usage-period-label"
        className="w-fit"
        size="sm"
        value={String(value)}
        onChange={(event) => onChange(Number(event.currentTarget.value) as AgentUsageWindowDays)}
      >
        {options.map((days) => (
          <option key={days} value={days}>
            {usageWindowLabel(days)}
          </option>
        ))}
      </KumoSelectControl>
    </div>
  );
}

export function AgentUsageTab({ agentId }: { agentId: string }) {
  const [windowDays, setWindowDays] = useState<AgentUsageWindowDays>(AGENT_USAGE_WINDOW_DAYS);
  const { retry, state } = useAgentUsage(agentId, windowDays);
  return (
    <div className="grid gap-6" data-ui="usage-tab">
      <div className="flex items-end justify-end" data-ui="usage-toolbar">
        <UsageWindowSelect options={AGENT_USAGE_WINDOW_OPTIONS} value={windowDays} onChange={setWindowDays} />
      </div>
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
  return new Error("Usage is temporarily unavailable. Try again.");
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
    return (
      <div aria-label="Loading Agent usage" className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
        <span aria-hidden="true">
          <Loader size="sm" />
        </span>
        <span>Loading Agent usage…</span>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="grid justify-items-start gap-2" data-ui="usage-unavailable" role="alert">
        <p className="text-sm text-kumo-danger">{state.error.message}</p>
        <Button aria-label="Retry Agent usage" size="compact" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return compact ? <UsageMetrics usage={state.value} /> : <AgentUsageDetailContent usage={state.value} />;
}

function UsageMetrics({ usage }: { usage: AgentUsageDetail }) {
  return (
    <dl
      className="grid gap-3 @min-[36rem]/workspace:grid-cols-2"
      aria-label={`Agent usage · ${usageWindowLabel(usage.windowDays)}`}
      data-ui="usage-metrics"
    >
      <Metric label="Tasks" value={formatCompactNumber(usage.tasks)} />
      <Metric label="Tokens" value={formatCompactNumber(usage.tokens)} primary />
    </dl>
  );
}

function UsageCoverage({ usage, includesCharts = false }: { usage: AgentUsageDetail; includesCharts?: boolean }) {
  if (usage.tasks === usage.measuredTasks) return null;
  const affectedContent = includesCharts ? "Token totals and charts" : "Token totals";
  return (
    <p className="text-sm text-kumo-subtle" data-ui="usage-coverage" role="status">
      <strong>{usage.measuredTasks === 0 ? "Token data unavailable." : "Partial data."}</strong>{" "}
      {usage.measuredTasks === 0
        ? m.format_tasks_token_data_none({ tasks: formatNumber(usage.tasks), affectedContent })
        : m.format_tasks_token_data_available({
            measuredTasks: formatNumber(usage.measuredTasks),
            tasks: formatNumber(usage.tasks),
            affectedContent,
          })}
    </p>
  );
}

function Metric({ label, primary = false, value }: { label: string; primary?: boolean; value: string }) {
  return (
    <div className={`grid gap-1 ${primary ? "rounded-md bg-kumo-tint p-3" : "rounded-md bg-kumo-recessed p-3"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AgentUsageDetailContent({ usage }: { usage: AgentUsageDetail }) {
  return (
    <>
      <UsageMetrics usage={usage} />
      <UsageCoverage usage={usage} includesCharts />
      <div className="grid gap-6 @min-[48rem]/workspace:grid-cols-2" data-ui="usage-analysis">
        <section aria-labelledby="agent-usage-trend-heading">
          <header>
            <Text as="h3" id="agent-usage-trend-heading" variant="heading">
              Token usage over time
            </Text>
          </header>
          <TokenTrendChart usage={usage} />
        </section>
        <section aria-labelledby="agent-usage-breakdown-heading">
          <header>
            <Text as="h3" id="agent-usage-breakdown-heading" variant="heading">
              Token breakdown
            </Text>
          </header>
          <TokenBreakdown usage={usage} />
        </section>
      </div>
    </>
  );
}

function TokenTrendChart({ usage }: { usage: AgentUsageDetail }) {
  const nonEmpty = usage.daily.some((point) => point.tokens > 0);
  if (!nonEmpty) {
    return (
      <p className="text-sm text-kumo-subtle" data-ui="usage-empty">
        No Token usage was recorded in this period.
      </p>
    );
  }
  const chart = (
    <LazyTimeseriesChart
      ariaDescription={`${formatCompactNumber(usage.tokens)} Tokens used · ${usageWindowLabel(usage.windowDays)}`}
      data={[
        {
          color: ChartPalette.categorical(0),
          data: usage.daily.map((point) => [Date.parse(`${point.date}T12:00:00.000Z`), point.tokens]),
          name: "Tokens",
        },
      ]}
      height={240}
      tooltipValueFormat={(value) => `${formatCompactNumber(value)} Tokens`}
      xAxisTickFormat={(value) => formatDay(new Date(value).toISOString())}
      yAxisTickFormat={(value) => formatCompactNumber(value)}
    />
  );
  return (
    <div className="grid gap-2" data-ui="usage-chart">
      {import.meta.env.MODE === "test" ? (
        <div
          aria-label={`${formatCompactNumber(usage.tokens)} Tokens used · ${usageWindowLabel(usage.windowDays)}`}
          className="h-60 rounded bg-kumo-recessed"
          role="img"
        />
      ) : (
        <Suspense
          fallback={
            <div
              aria-label="Loading usage chart"
              className="flex h-60 items-center justify-center rounded bg-kumo-tint text-kumo-subtle"
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
  const inputShare = (usage.inputTokens / total) * 100;
  const outputShare = (usage.outputTokens / total) * 100;
  return (
    <div className="grid gap-4">
      <Meter
        customValue={formatCompactNumber(usage.inputTokens)}
        indicatorClassName="bg-kumo-info"
        label="Input Tokens"
        value={inputShare}
      />
      <Meter
        customValue={formatCompactNumber(usage.outputTokens)}
        indicatorClassName="bg-kumo-brand"
        label="Output Tokens"
        value={outputShare}
      />
      <dl>
        <BreakdownRow label="Input" tone="input" value={usage.inputTokens} />
        <BreakdownRow label="Output" tone="output" value={usage.outputTokens} />
        <BreakdownRow label="Cached input" tone="cached" value={usage.cachedInputTokens} />
      </dl>
      <p>Cached input is shown separately and is not added again to Total.</p>
    </div>
  );
}

function BreakdownRow({ label, tone, value }: { label: string; tone: "cached" | "input" | "output"; value: number }) {
  return (
    <div>
      <dt>
        <span
          className={`size-2 rounded-full ${tone === "input" ? "bg-kumo-info" : tone === "output" ? "bg-kumo-brand" : "bg-kumo-subtle"}`}
          aria-hidden="true"
        />
        {label}
      </dt>
      <dd>{formatCompactNumber(value)}</dd>
    </div>
  );
}
