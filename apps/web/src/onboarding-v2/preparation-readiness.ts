/**
 * The second step's local-preparation rows, projected from the canonical setup snapshot onto the
 * presentational readiness primitive (`ReadinessList` in `readiness-list.tsx`).
 *
 * The rows are display decisions over one observed instant, never a readiness source of their own:
 * every status comes out of the snapshot's canonical `components` projection, and the detail copy
 * is chosen from canonical facts the same snapshot carries (identities, the runtime Provider the
 * creation step chose, the Messaging state). The module never guesses a Provider, a stage, or a
 * report, and never turns an absence into a fabricated checking state.
 *
 * Semantics preserved from the source contract:
 *
 * - `waiting` is the word for "no fresh report yet". A missing report is waiting, never checking.
 * - `install` renders as "Installation required". Nothing on this page installs anything, and no
 *   foreground progress transport exists, so no row ever claims a CLI is being prepared or
 *   installed.
 * - Only a real `checking` observation renders checking.
 * - `ready` renders as the row's own ready label (`Computer ready`, `<runtime> ready`, `Lark CLI
 *   ready`, `Slack CLI ready`).
 * - While the Computer leg is not ready the Runtime and messaging CLI legs cannot run yet, so
 *   their rows read "Waiting for Computer"; the Computer row itself carries the reason, and the
 *   action surface below the list owns the connect/repair work.
 * - The snapshot carries no expiry evidence of its own: the Server's freshness TTL already drops
 *   an expired observation before projection, so an expired report is indistinguishable from one
 *   that never arrived. Both project to `waiting`, and re-checking is the browser's only honest
 *   move — this module does not synthesize a stale/expired authority the schema did not give it.
 *
 * The canonical projection retains all four component rows for contract checks. The Step 2 page
 * then compacts those facts into one selected-Runtime row and one Messaging support row.
 */

import type {
  AgentRuntimeProvider,
  AgentSetupComponent,
  AgentSetupSnapshot,
  ImCliProvider,
} from "@opentag/shared/browser";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import type { CheckRow, ReadinessRows } from "./readiness-list.js";

/** The runtime Provider this Agent's creation step chose; the row label is never guessed here. */
function runtimeTitle(provider: AgentRuntimeProvider): string {
  switch (provider) {
    case "codex":
      return m.onboarding_v2_runtime_codex_title();
    case "claude-code":
      return m.onboarding_v2_runtime_claude_code_title();
  }
}

function imCliLabel(provider: ImCliProvider): string {
  return `${messagingProviderLabel(provider)} CLI`;
}

/** The Computer display name; a not-bound Computer has no name to display. */
function computerName(snapshot: AgentSetupSnapshot): string | undefined {
  return snapshot.computer.kind === "not-bound" ? undefined : snapshot.computer.displayName;
}

/**
 * The computer leg is usable only when the canonical component says the exact bound Computer is
 * online. Every downstream leg (Runtime, messaging CLIs) waits behind this fence.
 */
function computerLegReady(snapshot: AgentSetupSnapshot): boolean {
  const component = snapshot.components.find(
    (candidate): candidate is Extract<AgentSetupComponent, { kind: "computer" }> => candidate.kind === "computer",
  );
  return component?.status === "online";
}

/** One component from the snapshot; schema-validated snapshots always carry all four. */
function componentOf(
  snapshot: AgentSetupSnapshot,
  kind: "computer",
): Extract<AgentSetupComponent, { kind: "computer" }> | undefined;
function componentOf(
  snapshot: AgentSetupSnapshot,
  kind: "runtime",
): Extract<AgentSetupComponent, { kind: "runtime" }> | undefined;
function componentOf(
  snapshot: AgentSetupSnapshot,
  kind: "im-cli",
  provider: ImCliProvider,
): Extract<AgentSetupComponent, { kind: "im-cli" }> | undefined;
function componentOf(
  snapshot: AgentSetupSnapshot,
  kind: AgentSetupComponent["kind"],
  provider?: ImCliProvider,
): AgentSetupComponent | undefined {
  return snapshot.components.find((component) =>
    component.kind === "im-cli" ? component.kind === kind && component.provider === provider : component.kind === kind,
  );
}

/**
 * A component whose status the snapshot did not carry cannot be shown as anything real: it reads
 * as waiting with no invented detail. A schema-validated snapshot always names all four rows, so
 * this is a defensive floor, not a product state.
 */
function missingRow(label: string, detailLabel: string): CheckRow {
  return {
    label,
    state: "pending",
    status: "waiting",
    statusLabel: m.onboarding_v2_prep_status_waiting(),
    detail: "",
    detailLabel,
  };
}

function computerRow(snapshot: AgentSetupSnapshot): CheckRow {
  const label = m.onboarding_v2_prep_computer_label();
  const detailLabel = m.onboarding_v2_prep_computer_detail_label();
  const component = componentOf(snapshot, "computer");
  if (component === undefined) return missingRow(label, detailLabel);
  const name = computerName(snapshot) ?? "";
  switch (component.status) {
    case "online":
      return {
        label: m.onboarding_v2_prep_computer_ready(),
        state: "passed",
        status: "ready",
        statusLabel: "",
        detail: m.onboarding_v2_prep_computer_connected({ computerName: name }),
        detailLabel,
      };
    case "offline":
      return {
        label,
        state: "blocked",
        status: "needs-attention",
        statusLabel: m.onboarding_v2_prep_needs_attention(),
        detail: m.onboarding_v2_prep_computer_offline({ computerName: name }),
        detailLabel,
      };
    case "requires-rebind":
      return {
        label,
        state: "failed",
        status: "needs-attention",
        statusLabel: m.onboarding_v2_prep_needs_attention(),
        detail: m.onboarding_v2_setup_computer_rebind({
          computerName: name,
          name: snapshot.agent.displayName,
        }),
        detailLabel,
      };
    case "observation-failed":
      return {
        label,
        state: "failed",
        status: "needs-attention",
        statusLabel: m.onboarding_v2_prep_needs_attention(),
        detail: m.onboarding_v2_prep_computer_observation_failed(),
        detailLabel,
      };
    case "not-bound":
      return {
        label,
        state: "pending",
        status: "waiting",
        statusLabel: m.onboarding_v2_prep_status_waiting(),
        detail: m.onboarding_v2_prep_computer_unbound({ name: snapshot.agent.displayName }),
        detailLabel,
      };
  }
}

/**
 * The selected Runtime's leg. `unavailable` has two canonical shapes and the row keeps them
 * apart: before the Computer leg is usable the runtime cannot be checked yet (so the row waits on
 * the Computer), while an observed unavailable report over an online Computer is a real defect
 * that needs attention.
 */
function runtimeRow(snapshot: AgentSetupSnapshot): CheckRow {
  const runtime = runtimeTitle(snapshot.runtime.provider);
  const detailLabel = m.onboarding_v2_prep_runtime_detail_label();
  const component = componentOf(snapshot, "runtime");
  if (component === undefined) return missingRow(runtime, detailLabel);
  if (!computerLegReady(snapshot)) {
    // The exact Computer is the fence for this leg: no Runtime check can run before it is online.
    return {
      label: runtime,
      state: "blocked",
      status: "waiting",
      statusLabel: m.onboarding_v2_prep_status_waiting_for_computer(),
      detail: m.onboarding_v2_prep_runtime_waits_for_computer({ runtime }),
      detailLabel,
    };
  }
  const computer = computerName(snapshot) ?? "";
  switch (component.status) {
    case "ready":
      return {
        label: m.onboarding_v2_prep_runtime_ready({ runtime }),
        state: "passed",
        status: "ready",
        statusLabel: "",
        detail: m.onboarding_v2_prep_runtime_ready_detail({ computerName: computer }),
        detailLabel,
      };
    case "waiting":
      return {
        label: runtime,
        state: "pending",
        status: "waiting",
        statusLabel: m.onboarding_v2_prep_status_waiting(),
        detail: m.onboarding_v2_prep_runtime_missing({ computerName: computer }),
        detailLabel,
      };
    case "checking":
      return {
        label: runtime,
        state: "pending",
        status: "checking",
        statusLabel: m.onboarding_v2_prep_status_checking(),
        detail: m.onboarding_v2_prep_runtime_checking({ computerName: computer }),
        detailLabel,
      };
    case "install":
      return {
        label: runtime,
        state: "failed",
        status: "install-required",
        statusLabel: m.onboarding_v2_prep_install_required(),
        detail: m.onboarding_v2_prep_runtime_install({ runtime, computerName: computer }),
        detailLabel,
      };
    case "sign-in":
      return {
        label: runtime,
        state: "failed",
        status: "needs-attention",
        statusLabel: m.onboarding_v2_prep_needs_attention(),
        detail: m.onboarding_v2_prep_runtime_sign_in({ runtime, computerName: computer }),
        detailLabel,
      };
    case "observation-failed":
      return {
        label: runtime,
        state: "failed",
        status: "needs-attention",
        statusLabel: m.onboarding_v2_prep_needs_attention(),
        detail: m.onboarding_v2_prep_runtime_observation_failed({ runtime }),
        detailLabel,
      };
    case "unavailable":
      // Over an online Computer this is an observed report, not the computer-leg fence above.
      return {
        label: runtime,
        state: "failed",
        status: "needs-attention",
        statusLabel: m.onboarding_v2_prep_needs_attention(),
        detail: m.onboarding_v2_prep_runtime_not_responding({ computerName: computer }),
        detailLabel,
      };
  }
}

/**
 * One required messaging CLI leg, keyed by the exact Provider the snapshot names. Only required
 * Providers ever reach this point: the canonical component projection is built over the
 * Server-supplied required Provider set in canonical order, and the page renders exactly that.
 */
function imCliRow(snapshot: AgentSetupSnapshot, provider: ImCliProvider): CheckRow {
  const providerName = messagingProviderLabel(provider);
  const label = imCliLabel(provider);
  const detailLabel = m.onboarding_v2_prep_cli_detail_label({ cli: providerName });
  const component = componentOf(snapshot, "im-cli", provider);
  if (component === undefined) return missingRow(label, detailLabel);
  if (!computerLegReady(snapshot)) {
    return {
      label,
      state: "blocked",
      status: "waiting",
      statusLabel: m.onboarding_v2_prep_status_waiting_for_computer(),
      detail: m.onboarding_v2_prep_cli_waits_for_computer({ cli: providerName }),
      detailLabel,
    };
  }
  const computer = computerName(snapshot) ?? "";
  switch (component.status) {
    case "ready":
      return {
        label: m.onboarding_v2_prep_cli_ready({ cli: providerName }),
        state: "passed",
        status: "ready",
        statusLabel: "",
        detail: m.onboarding_v2_prep_cli_verified({ computerName: computer }),
        detailLabel,
      };
    case "waiting":
      return {
        label,
        state: "pending",
        status: "waiting",
        statusLabel: m.onboarding_v2_prep_status_waiting(),
        detail: m.onboarding_v2_prep_cli_missing({ cli: providerName, computerName: computer }),
        detailLabel,
      };
    case "checking":
      return {
        label,
        state: "pending",
        status: "checking",
        statusLabel: m.onboarding_v2_prep_status_checking(),
        detail: m.onboarding_v2_prep_cli_checking({ cli: providerName, computerName: computer }),
        detailLabel,
      };
    case "install":
      return {
        label,
        state: "failed",
        status: "install-required",
        statusLabel: m.onboarding_v2_prep_install_required(),
        detail: m.onboarding_v2_prep_cli_install({ computerName: computer }),
        detailLabel,
      };
    case "unavailable":
      return {
        label,
        state: "failed",
        status: "needs-attention",
        statusLabel: m.onboarding_v2_prep_needs_attention(),
        detail: m.onboarding_v2_prep_cli_unavailable({ computerName: computer }),
        detailLabel,
      };
  }
}

/** The four fixed readiness rows for one snapshot, in the primitive's fixed computer/runtime/CLI order. */
export function preparationReadinessRows(snapshot: AgentSetupSnapshot): ReadinessRows {
  return {
    computer: computerRow(snapshot),
    runtime: runtimeRow(snapshot),
    feishu: imCliRow(snapshot, "feishu"),
    slack: imCliRow(snapshot, "slack"),
  };
}

export type PreparationSummaryRows = Readonly<{
  runtime: CheckRow;
  messaging: CheckRow;
}>;

/**
 * The compact Step 2 presentation. Provider-specific CLI reports stay authoritative underneath,
 * but the reader has not chosen a messaging app yet, so the surface exposes one combined
 * Messaging support result instead of prematurely naming Lark and Slack.
 */
export function preparationSummaryRows(snapshot: AgentSetupSnapshot): PreparationSummaryRows {
  const readiness = preparationReadinessRows(snapshot);
  const runtime = {
    ...readiness.runtime,
    label: runtimeTitle(snapshot.runtime.provider),
    statusLabel:
      readiness.runtime.status === "ready" ? m.onboarding_v2_prep_status_ready() : readiness.runtime.statusLabel,
  };
  const requiredRows = snapshot.requiredImCliProviders.map((provider) =>
    provider === "feishu" ? readiness.feishu : readiness.slack,
  );
  const name = computerName(snapshot) ?? "";
  const shared = {
    detailLabel: m.onboarding_v2_prep_messaging_detail_label(),
    label: m.onboarding_v2_prep_messaging_label(),
  };
  if (requiredRows.some((row) => row.status === "needs-attention")) {
    return {
      runtime,
      messaging: {
        ...shared,
        detail: m.onboarding_v2_prep_messaging_attention({ computerName: name }),
        state: "failed",
        status: "needs-attention",
        statusLabel: m.onboarding_v2_prep_needs_attention(),
      },
    };
  }
  if (requiredRows.some((row) => row.status === "install-required")) {
    return {
      runtime,
      messaging: {
        ...shared,
        detail: m.onboarding_v2_prep_messaging_install({ computerName: name }),
        state: "failed",
        status: "install-required",
        statusLabel: m.onboarding_v2_prep_install_required(),
      },
    };
  }
  if (requiredRows.some((row) => row.status === "checking")) {
    return {
      runtime,
      messaging: {
        ...shared,
        detail: m.onboarding_v2_prep_messaging_checking({ computerName: name }),
        state: "pending",
        status: "checking",
        statusLabel: m.onboarding_v2_prep_status_checking(),
      },
    };
  }
  if (requiredRows.length === 0 || requiredRows.some((row) => row.status !== "ready")) {
    return {
      runtime,
      messaging: {
        ...shared,
        detail: m.onboarding_v2_prep_messaging_waiting({ computerName: name }),
        state: "pending",
        status: "waiting",
        statusLabel: m.onboarding_v2_prep_status_waiting(),
      },
    };
  }
  return {
    runtime,
    messaging: {
      ...shared,
      detail: m.onboarding_v2_prep_messaging_ready({ computerName: name }),
      state: "passed",
      status: "ready",
      statusLabel: m.onboarding_v2_prep_status_ready(),
    },
  };
}

/**
 * Whether the second step's preparation surface belongs on screen. It stays current through every
 * computer-preparation stage. Once Messaging starts, the preparation rows leave the page: an
 * unselected Provider's later report must never regress a messaging session already underway.
 */
export function showPreparationSection(snapshot: AgentSetupSnapshot): boolean {
  return (
    snapshot.stage === "needs-computer" ||
    snapshot.stage === "needs-runtime" ||
    snapshot.stage === "needs-provider-clis"
  );
}

/**
 * Required CLI preparation continues even when Runtime failure owns the stage cursor. Therefore
 * stage-relative blocking=false does not make a required CLI's ongoing check irrelevant.
 */
export function preparationIsTransitional(snapshot: AgentSetupSnapshot): boolean {
  return snapshot.components.some(
    (component) => component.kind === "im-cli" && (component.status === "waiting" || component.status === "checking"),
  );
}
