import type { AgentRuntimeProvider } from "@opentag/shared/browser";
import { RuntimeSignIn } from "./runtime-sign-in.js";

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
  /** A runtime that only needs signing in on this computer offers its terminal steps. */
  readonly signIn?: { readonly provider: AgentRuntimeProvider; readonly computerName: string };
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
          {check.signIn ? (
            <RuntimeSignIn computerName={check.signIn.computerName} provider={check.signIn.provider} />
          ) : null}
        </section>
      </div>
    </li>
  );
}
