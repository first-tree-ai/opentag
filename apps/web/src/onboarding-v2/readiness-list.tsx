/**
 * The readiness rows: four fixed lines that show exactly the state and copy they are handed.
 *
 * Every string arrives already translated and every state already decided, so this primitive never
 * derives a readiness from the values it receives and never invents product or provider copy of
 * its own. It is display only: keep the four rows, their reserved slot heights, and their DOM
 * identity steady while the copy beneath them resolves. Styling lives in the scoped
 * `.otv2-readiness*` rules in `onboarding-v2.css`.
 */

export type CheckState = "pending" | "passed" | "failed" | "blocked";

export type ReadinessStatus = "waiting" | "checking" | "install-required" | "ready" | "needs-attention" | "stale";

export interface CheckRow {
  /** The row's own outcome. Styling and tests read it; nothing here derives it from the copy. */
  readonly state: CheckState;
  /** The caller's readiness reading. Published and displayed exactly as given. */
  readonly status: ReadinessStatus;
  readonly label: string;
  readonly statusLabel: string;
  readonly detail: string;
  /** Accessible label for the diagnostic region, which stays mounted even when empty. */
  readonly detailLabel: string;
}

export type ReadinessRows = Readonly<{
  computer: CheckRow;
  runtime: CheckRow;
  feishu: CheckRow;
  slack: CheckRow;
}>;

const READINESS_ORDER: ReadonlyArray<{ key: keyof ReadinessRows; component: string }> = [
  { key: "computer", component: "computer" },
  { key: "runtime", component: "runtime" },
  { key: "feishu", component: "im-cli:feishu" },
  { key: "slack", component: "im-cli:slack" },
];

/**
 * One readiness row. `position` becomes a decorative 1..4 marker, `component` a stable identity
 * the list also uses as the row key, so a row never moves or remounts as its copy changes.
 *
 * The title and detail slots are fixed-height scroll regions: both are always mounted and
 * keyboard-focusable, and the detail slot carries its own accessible label.
 */
export function CheckLine({ check, position, component }: { check: CheckRow; position: number; component: string }) {
  return (
    <li className="otv2-readiness__line" data-component={component} data-state={check.state} data-status={check.status}>
      <span aria-hidden="true" className="otv2-readiness__marker">
        {position}
      </span>
      <div className="otv2-readiness__copy">
        <div
          className="otv2-readiness__title"
          data-ui="readiness-title"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The title slot is a fixed-height scroll region; keyboard users must be able to focus and scroll it.
          tabIndex={0}
        >
          <span className="otv2-readiness__name">{check.label}</span>
          <span className="otv2-readiness__status">{check.statusLabel}</span>
        </div>
        <section
          aria-label={check.detailLabel}
          className="otv2-readiness__detail"
          data-ui="readiness-detail"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The detail slot is a fixed-height scroll region; keyboard users must be able to focus and scroll it.
          tabIndex={0}
        >
          {check.detail}
        </section>
      </div>
    </li>
  );
}

/**
 * The four readiness rows — computer, runtime, feishu, slack — in that fixed order inside one
 * labelled list. The rows are read from the caller's named `rows`, so four lines always render
 * even when some copy is blank.
 */
export function ReadinessList({ rows, label }: { rows: ReadinessRows; label: string }) {
  return (
    <ol aria-label={label} className="otv2-readiness" data-ui="readiness-list">
      {READINESS_ORDER.map(({ key, component }, index) => (
        <CheckLine check={rows[key]} component={component} key={component} position={index + 1} />
      ))}
    </ol>
  );
}
