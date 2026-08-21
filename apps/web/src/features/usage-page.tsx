import { useState } from "react";
import { type UsageRange, usageRanges, usageSnapshots } from "../mock/capability-data.js";
import "../mock-pages.css";

export function UsagePage() {
  const [range, setRange] = useState<UsageRange>("30 days");
  const snapshot = usageSnapshots[range];
  const trendPoints = makeTrendPoints(snapshot.trend);

  return (
    <section className="capability-page" aria-labelledby="usage-page-title">
      <header className="capability-page-header capability-usage-header">
        <div>
          <span className="capability-preview-label">Demo data preview</span>
          <h1 id="usage-page-title">Usage</h1>
          <p>A simple view of sample Agent activity across this Workspace.</p>
        </div>
        <label className="capability-range-field">
          <span>Time range</span>
          <select value={range} onChange={(event) => setRange(event.currentTarget.value as UsageRange)}>
            {usageRanges.map((option) => (
              <option value={option} key={option}>
                Last {option}
              </option>
            ))}
          </select>
        </label>
      </header>

      <dl className="capability-metric-grid" aria-label="Usage metrics" aria-live="polite">
        <Metric label="Tasks" value={snapshot.metrics.tasks} />
        <Metric label="Turns" value={snapshot.metrics.turns} />
        <Metric label="Active Agents" value={snapshot.metrics.activeAgents} />
        <Metric label="Providers" value={snapshot.metrics.providers} />
      </dl>

      <div className="capability-usage-grid">
        <section className="capability-chart-panel" aria-labelledby="activity-trend-title">
          <div className="capability-section-heading">
            <div>
              <h2 id="activity-trend-title">Activity trend</h2>
              <p>Turns completed during the selected demo period.</p>
            </div>
            <span>{range}</span>
          </div>
          <svg
            className="capability-trend-chart"
            viewBox="0 0 640 220"
            role="img"
            aria-label={`Demo activity trend for the last ${range}`}
            preserveAspectRatio="none"
          >
            <line x1="0" y1="40" x2="640" y2="40" />
            <line x1="0" y1="110" x2="640" y2="110" />
            <line x1="0" y1="180" x2="640" y2="180" />
            <polyline points={trendPoints} />
          </svg>
        </section>

        <section className="capability-provider-panel" aria-labelledby="provider-usage-title">
          <div className="capability-section-heading">
            <div>
              <h2 id="provider-usage-title">Provider usage</h2>
              <p>Share of demo Turns.</p>
            </div>
          </div>
          <ul className="capability-provider-list">
            {snapshot.providers.map((provider) => (
              <li key={provider.name}>
                <div>
                  <strong>{provider.name}</strong>
                  <span>{provider.turns.toLocaleString()} Turns</span>
                </div>
                <small>{provider.share}%</small>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value.toLocaleString()}</dd>
    </div>
  );
}

function makeTrendPoints(values: readonly number[]): string {
  const maximum = Math.max(...values, 1);
  const divisor = Math.max(values.length - 1, 1);

  return values
    .map((value, index) => {
      const x = (index / divisor) * 640;
      const y = 190 - (value / maximum) * 150;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
