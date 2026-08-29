import {
  AGENT_USAGE_WINDOW_DAYS,
  AGENT_USAGE_WINDOW_OPTIONS,
  type AgentUsageDetail,
  type AgentUsageWindowDays,
} from "@opentag/shared/browser";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { browserApi } from "../api.js";
import "./agent-usage.css";

type UsageState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly value: AgentUsageDetail };

/** The Agent home answers "how much has this Agent used recently", so it offers the shortest windows. */
const AGENT_HOME_USAGE_WINDOW_OPTIONS = [1, 7, AGENT_USAGE_WINDOW_DAYS] as const;

export function usageWindowLabel(days: AgentUsageWindowDays): string {
  return days === 1 ? "Last 24 hours" : `Last ${days} days`;
}

export function AgentUsageOverview({
  agentId,
  detailsLinkState,
}: {
  agentId: string;
  /** Route state that keeps the Agent header rendered while the usage details page loads. */
  detailsLinkState?: unknown;
}) {
  const [windowDays, setWindowDays] = useState<AgentUsageWindowDays>(AGENT_USAGE_WINDOW_DAYS);
  const state = useAgentUsage(agentId, windowDays);
  return (
    <section className="agent-home-section agent-usage-overview" aria-labelledby="agent-usage-overview-heading">
      <header className="agent-home-section-heading">
        <h2 id="agent-usage-overview-heading">Usage</h2>
        <div className="agent-usage-overview-actions">
          <UsageWindowSelect options={AGENT_HOME_USAGE_WINDOW_OPTIONS} value={windowDays} onChange={setWindowDays} />
          <Link state={detailsLinkState} to={`/agents/${agentId}/usage`}>
            View details
          </Link>
        </div>
      </header>
      <UsageSummaryState state={state} compact />
    </section>
  );
}

export function AgentUsageTab({ agentId }: { agentId: string }) {
  const [windowDays, setWindowDays] = useState<AgentUsageWindowDays>(AGENT_USAGE_WINDOW_DAYS);
  const state = useAgentUsage(agentId, windowDays);
  return (
    <div className="agent-usage-tab">
      <div className="agent-usage-toolbar">
        <UsageWindowSelect options={AGENT_USAGE_WINDOW_OPTIONS} value={windowDays} onChange={setWindowDays} />
      </div>
      <UsageSummaryState state={state} />
    </div>
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
    <label className="agent-usage-period">
      <span>Usage period</span>
      <select
        aria-label="Usage period"
        className="ds-control ds-control--compact"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value) as AgentUsageWindowDays)}
      >
        {options.map((days) => (
          <option key={days} value={days}>
            {usageWindowLabel(days)}
          </option>
        ))}
      </select>
    </label>
  );
}

function useAgentUsage(agentId: string, windowDays: AgentUsageWindowDays): UsageState {
  const [state, setState] = useState<UsageState>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    void browserApi.agentUsage(agentId, windowDays).then(
      (value) => active && setState({ kind: "ready", value }),
      () => active && setState({ kind: "error" }),
    );
    return () => {
      active = false;
    };
  }, [agentId, windowDays]);
  return state;
}

function UsageSummaryState({ state, compact = false }: { state: UsageState; compact?: boolean }) {
  if (state.kind === "loading") {
    return (
      <div aria-label="Loading Agent usage" className="agent-usage-loading" role="status">
        <span />
        <span />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="agent-usage-unavailable" role="status">
        Usage is temporarily unavailable.
      </p>
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
    <dl className="agent-usage-metrics" aria-label={`Agent usage · ${usageWindowLabel(usage.windowDays)}`}>
      <Metric label="Tokens" value={formatUsageNumber(usage.tokens)} primary />
      <Metric label="Tasks" value={formatUsageNumber(usage.tasks)} />
    </dl>
  );
}

function UsageCoverage({ usage, includesCharts = false }: { usage: AgentUsageDetail; includesCharts?: boolean }) {
  if (usage.tasks === usage.measuredTasks) return null;
  const affectedContent = includesCharts ? "Token totals and charts" : "Token totals";
  return (
    <p className="agent-usage-coverage" role="status">
      <strong>{usage.measuredTasks === 0 ? "Token data unavailable." : "Partial data."}</strong>{" "}
      {usage.measuredTasks === 0
        ? `None of the ${usage.tasks.toLocaleString()} tasks reported token usage. ${affectedContent} may be empty.`
        : `Token data is available for ${usage.measuredTasks.toLocaleString()} of ${usage.tasks.toLocaleString()} tasks. ${affectedContent} are partial.`}
    </p>
  );
}

function Metric({ label, primary = false, value }: { label: string; primary?: boolean; value: string }) {
  return (
    <div className={primary ? "is-primary" : undefined}>
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
      <div className="agent-usage-analysis">
        <section aria-labelledby="agent-usage-trend-heading">
          <header className="agent-usage-subheading">
            <h3 id="agent-usage-trend-heading">Token usage over time</h3>
          </header>
          <TokenTrendChart usage={usage} />
        </section>
        <section aria-labelledby="agent-usage-breakdown-heading">
          <header className="agent-usage-subheading">
            <h3 id="agent-usage-breakdown-heading">Token breakdown</h3>
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
    return <p className="agent-usage-empty">No Token usage was recorded in this period.</p>;
  }
  const width = 760;
  const height = 232;
  const plotTop = 12;
  const plotBottom = 204;
  const startedAt = new Date(usage.startedAt).getTime();
  const endedAt = new Date(usage.endedAt).getTime();
  const duration = Math.max(endedAt - startedAt, 1);
  const maximum = Math.max(...usage.daily.map((point) => point.tokens), 1);
  const points = usage.daily.map((point) => {
    const timestamp = new Date(`${point.date}T12:00:00.000Z`).getTime();
    const x = Math.max(0, Math.min(width, ((timestamp - startedAt) / duration) * width));
    const y = plotBottom - (point.tokens / maximum) * (plotBottom - plotTop);
    return { ...point, x, y };
  });
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const first = points[0];
  const last = points.at(-1);
  const area =
    first && last
      ? `M${first.x.toFixed(1)} ${plotBottom} L${points
          .map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
          .join(" L")} L${last.x.toFixed(1)} ${plotBottom} Z`
      : "";
  const ticks = [1, 0.75, 0.5, 0.25, 0];
  return (
    <div className="agent-usage-chart">
      <svg
        aria-label={`${formatUsageNumber(usage.tokens)} Tokens used · ${usageWindowLabel(usage.windowDays)}`}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {ticks.map((tick) => {
          const y = plotBottom - tick * (plotBottom - plotTop);
          return <line className="agent-usage-chart-grid" key={tick} x1="0" x2={width} y1={y} y2={y} />;
        })}
        <path className="agent-usage-chart-area" d={area} />
        <path className="agent-usage-chart-line" d={line} />
        {points.map((point) => (
          <circle className="agent-usage-chart-point" cx={point.x} cy={point.y} key={point.date} r="3.5">
            <title>{`${formatUsageDate(point.date)}: ${formatUsageNumber(point.tokens)} Tokens`}</title>
          </circle>
        ))}
      </svg>
      <div className="agent-usage-chart-axis" aria-hidden="true">
        <span>{formatUsageDate(usage.startedAt)}</span>
        <span>{formatUsageDate(new Date((startedAt + endedAt) / 2).toISOString())}</span>
        <span>{formatUsageDate(usage.endedAt)}</span>
      </div>
      <ol className="visually-hidden">
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
    <div className="agent-token-breakdown">
      <div aria-hidden="true" className="agent-token-breakdown-bar">
        <span className="is-input" style={{ width: `${inputShare}%` }} />
        <span className="is-output" style={{ width: `${outputShare}%` }} />
      </div>
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
        <span className={`agent-token-dot is-${tone}`} aria-hidden="true" />
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
