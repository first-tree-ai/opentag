import {
  AGENT_USAGE_WINDOW_DAYS,
  AGENT_USAGE_WINDOW_OPTIONS,
  type AgentUsageDetail,
  type AgentUsageWindowDays,
} from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { browserApi } from "../api.js";
import { Button, ChartPalette, KumoSelectControl, Loader, Meter, Text, TimeseriesChart } from "../ui/design-system.js";

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

export function AgentUsageOverview({ agentId }: { agentId: string }) {
  const { retry, state } = useAgentUsage(agentId, AGENT_USAGE_WINDOW_DAYS);
  return (
    <section className="grid gap-4" aria-labelledby="agent-usage-overview-heading" data-ui="usage-overview">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Text as="h3" id="agent-usage-overview-heading" variant="heading">
            Recent usage
          </Text>
          <p>Token use from Tasks handled by this Agent during the last 30 days.</p>
        </div>
        <Link params={{ agentId }} to="/agents/$agentId/usage">
          View usage details
        </Link>
      </div>
      <UsageSummaryState state={state} compact onRetry={retry} />
    </section>
  );
}

export function AgentUsageTab({ agentId }: { agentId: string }) {
  const [windowDays, setWindowDays] = useState<AgentUsageWindowDays>(AGENT_USAGE_WINDOW_DAYS);
  const { retry, state } = useAgentUsage(agentId, windowDays);
  return (
    <div className="grid gap-6" data-ui="usage-tab">
      <div className="flex items-end justify-end" data-ui="usage-toolbar">
        <div>
          <span id="usage-period-label">Usage period</span>
          <KumoSelectControl
            aria-label="Usage period"
            aria-labelledby="usage-period-label"
            className="w-fit"
            size="sm"
            value={String(windowDays)}
            onChange={(event) => setWindowDays(Number(event.currentTarget.value) as AgentUsageWindowDays)}
          >
            {AGENT_USAGE_WINDOW_OPTIONS.map((days) => (
              <option key={days} value={days}>
                Last {days} days
              </option>
            ))}
          </KumoSelectControl>
        </div>
      </div>
      <UsageSummaryState state={state} onRetry={retry} />
    </div>
  );
}

function useAgentUsage(
  agentId: string,
  windowDays: AgentUsageWindowDays,
): { readonly retry: () => void; readonly state: UsageState } {
  const [state, setState] = useState<UsageState>({ kind: "loading" });
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setState({ kind: "loading" });
    void browserApi.agentUsage(agentId, windowDays).then(
      (value) => {
        if (mountedRef.current && requestIdRef.current === requestId) setState({ kind: "ready", value });
      },
      (cause: unknown) => {
        if (mountedRef.current && requestIdRef.current === requestId) {
          setState({ kind: "error", error: usageError(cause) });
        }
      },
    );
  }, [agentId, windowDays]);
  const retry = useCallback(() => {
    load();
  }, [load]);
  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);
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
  return compact ? (
    <>
      <UsageMetrics usage={state.value} />
      <UsageCoverage usage={state.value} />
    </>
  ) : (
    <AgentUsageDetailContent usage={state.value} />
  );
}

function UsageMetrics({ usage }: { usage: AgentUsageDetail }) {
  return (
    <dl
      className="grid gap-3 @min-[36rem]/workspace:grid-cols-3"
      aria-label={`Agent usage for the last ${usage.windowDays} days`}
      data-ui="usage-metrics"
    >
      <Metric label="Tokens" value={formatUsageNumber(usage.tokens)} primary />
      <Metric label="Tasks" value={formatUsageNumber(usage.tasks)} />
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
        ? `None of the ${usage.tasks.toLocaleString()} tasks reported token usage. ${affectedContent} may be empty.`
        : `Token data is available for ${usage.measuredTasks.toLocaleString()} of ${usage.tasks.toLocaleString()} tasks. ${affectedContent} are partial.`}
    </p>
  );
}

function Metric({ label, primary = false, value }: { label: string; primary?: boolean; value: string }) {
  return (
    <div className={primary ? "rounded-md bg-kumo-tint p-3" : "rounded-md bg-kumo-recessed p-3"}>
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
      ariaDescription={`${formatUsageNumber(usage.tokens)} Tokens used during the last ${usage.windowDays} days`}
      data={[
        {
          color: ChartPalette.categorical(0),
          data: usage.daily.map((point) => [Date.parse(`${point.date}T12:00:00.000Z`), point.tokens]),
          name: "Tokens",
        },
      ]}
      height={240}
      tooltipValueFormat={(value) => `${formatUsageNumber(value)} Tokens`}
      xAxisTickFormat={(value) => formatUsageDate(new Date(value).toISOString())}
      yAxisTickFormat={(value) => formatUsageNumber(value)}
    />
  );
  return (
    <div className="grid gap-2" data-ui="usage-chart">
      {import.meta.env.MODE === "test" ? (
        <div
          aria-label={`${formatUsageNumber(usage.tokens)} Tokens used during the last ${usage.windowDays} days`}
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
          <li key={point.date}>{`${formatUsageDate(point.date)}: ${point.tokens.toLocaleString()} Tokens`}</li>
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
        customValue={formatUsageNumber(usage.inputTokens)}
        indicatorClassName="bg-kumo-info"
        label="Input Tokens"
        value={inputShare}
      />
      <Meter
        customValue={formatUsageNumber(usage.outputTokens)}
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
      <dd>{formatUsageNumber(value)}</dd>
    </div>
  );
}

function formatUsageNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1_000 ? 1 : 0,
    notation: value >= 1_000 ? "compact" : "standard",
  }).format(value);
}

function formatUsageDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(
    new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value),
  );
}
