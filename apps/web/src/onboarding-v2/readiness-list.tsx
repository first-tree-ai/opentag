/** A compact readiness row whose copy and state are decided by its caller. */

export type CheckState = "pending" | "passed" | "failed" | "blocked";

export type ReadinessStatus = "waiting" | "checking" | "install-required" | "ready" | "needs-attention";

export interface CheckRow {
  readonly state: CheckState;
  readonly status: ReadinessStatus;
  readonly label: string;
  readonly statusLabel: string;
  readonly detail: string;
  readonly detailLabel: string;
}

export function CheckLine({ check, position, component }: { check: CheckRow; position: number; component: string }) {
  return (
    <li className="otv2-readiness__line" data-component={component} data-state={check.state} data-status={check.status}>
      <span aria-hidden="true" className="otv2-readiness__marker">
        {position}
      </span>
      <div className="otv2-readiness__copy">
        <div className="otv2-readiness__title" data-ui="readiness-title">
          <span className="otv2-readiness__name">{check.label}</span>
          <span className="otv2-readiness__status">{check.statusLabel}</span>
        </div>
        <section aria-label={check.detailLabel} className="otv2-readiness__detail" data-ui="readiness-detail">
          {check.detail}
        </section>
      </div>
    </li>
  );
}
