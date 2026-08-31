import type { ImCliProvider } from "@opentag/shared";

/**
 * A managed Provider CLI is either Feishu/Lark (`lark-cli`) or Slack (`slack`).
 * The provider identifier reuses the canonical IM provider vocabulary.
 */
export type ProviderCliProvider = ImCliProvider;

export type ProviderCliTrust = "catalog-verified" | "compatible-unverified";

/** Local Provider CLI state machine from the management design; `checking` is an in-flight observation. */
export type ProviderCliLocalState = "checking" | "absent" | "ready" | "unavailable";

/**
 * Stable local diagnostic codes. These stay local to the machine; only the coarse
 * readiness mapping may ever leave the device.
 */
export type ProviderCliDiagnosticCode =
  | "not_installed"
  | "global_bin_unavailable"
  | "launcher_invalid"
  | "global_command_shadowed"
  | "external_path_invalid"
  | "external_not_detected"
  | "external_candidate_changed"
  | "external_candidate_unverified"
  | "artifact_drifted"
  | "integrity_failed"
  | "version_incompatible"
  | "probe_failed"
  | "install_incomplete"
  | "credential_unavailable"
  | "unsupported_platform"
  | "operation_in_progress"
  | "selection_invalid";

/** Warning codes that never downgrade readiness on their own. */
export type ProviderCliWarningCode =
  | "global_command_shadowed"
  | "global_path_not_configured"
  | "external_candidate_unverified";

export interface ProviderCliDiagnostic {
  readonly code: ProviderCliDiagnosticCode;
  readonly remediation?: string;
}

export interface ProviderCliWarning {
  readonly code: ProviderCliWarningCode;
  readonly remediation?: string;
}

export interface ProviderCliSelectionSummary {
  readonly kind: "managed" | "external";
  readonly path: string;
  readonly version: string;
  readonly trust: ProviderCliTrust;
  readonly generation: number;
}

/** Read-only inspection result for one provider. */
export interface ProviderCliInspection {
  readonly provider: ProviderCliProvider;
  readonly state: Exclude<ProviderCliLocalState, "checking">;
  readonly readiness: "ready" | "install" | "unavailable";
  readonly selection?: ProviderCliSelectionSummary;
  readonly fingerprint?: string;
  readonly launcher: {
    readonly path: string;
    readonly status: "valid" | "missing" | "invalid" | "mismatch";
  };
  readonly globalCommand: {
    readonly active: boolean;
    readonly path?: string;
    readonly resolvedPath?: string;
  };
  readonly warnings: readonly ProviderCliWarning[];
  readonly diagnostic?: ProviderCliDiagnostic;
}

export type ProviderCliEnsureAction = "noop" | "selected-existing" | "installed-managed" | "failed";

export type ProviderCliPhase = "detect" | "select" | "managed-install" | "verify";

export interface ProviderCliPhaseRecord {
  readonly phase: ProviderCliPhase;
  readonly status: "started" | "completed" | "failed";
  /** Bounded single-line human detail; never carries credentials or raw child-process output. */
  readonly detail?: string;
}

export interface ProviderCliCandidateReport {
  readonly path: string;
  readonly version?: string;
  readonly trust?: ProviderCliTrust;
  readonly disposition: "selected" | "ignored";
  readonly reason: string;
}

/** Stable ensure result shape; the `--json` document serializes this verbatim per provider. */
export interface ProviderCliEnsureResult {
  readonly ok: boolean;
  readonly provider: ProviderCliProvider;
  readonly action: ProviderCliEnsureAction;
  readonly phases: readonly ProviderCliPhaseRecord[];
  readonly selected?: {
    readonly path: string;
    readonly version: string;
    readonly source: string;
    readonly trust: ProviderCliTrust;
  };
  readonly candidates: readonly ProviderCliCandidateReport[];
  readonly readiness: "ready" | "unavailable";
  readonly globalCommand: {
    readonly active: boolean;
    readonly path?: string;
    readonly resolvedPath?: string;
  };
  readonly warnings: readonly ProviderCliWarning[];
  readonly diagnostic?: ProviderCliDiagnostic;
  readonly dryRun?: boolean;
}

/** Map the local state machine onto the coarse readiness vocabulary used by the Server wire. */
export function mapProviderCliLocalStateToReadiness(
  state: ProviderCliLocalState,
): "checking" | "install" | "ready" | "unavailable" {
  switch (state) {
    case "ready":
      return "ready";
    case "absent":
      return "install";
    case "checking":
      return "checking";
    case "unavailable":
      return "unavailable";
  }
}
