import type { ProviderCliEnsureResult, ProviderCliPhaseEvent, ProviderCliProvider } from "@opentag/client";
import {
  type AgentRuntimeProvider,
  type LocalComputerPreparationResult,
  LocalComputerPreparationResultSchema,
  type LocalPreparationCheck,
  type LocalPreparationComponent,
} from "@opentag/shared";
import { channelConfig } from "../channel/config.js";
import { OPEN_TAG_HOME_ENVIRONMENT_VARIABLE } from "../channel/environment.js";
import { redactSecrets } from "../command/policy.js";
import type { DaemonServiceInfo } from "../daemon/service/index.js";
import { quotePosix } from "../daemon/service/shared.js";
import { runProviderCliEnsure } from "../provider-cli/ensure.js";
import { providerCliCanAutoRepair, providerCliRepairCommand } from "../provider-cli/shared.js";
import {
  probeRuntimeComponent,
  type RuntimeProbeOptions,
  runtimeComponentFromProbeFailure,
  unconfirmedRuntimeComponent,
} from "./runtime-probe.js";

/**
 * One-shot local computer preparation for a targeted connect. It renders exactly four required
 * top-level Components — `computer` (with connection/daemon child Checks), the selected Runtime
 * (`runtime:<provider>` or `runtime:unconfirmed`), and the two Provider CLIs — and derives every
 * count from the completed Checks, never from an ensure exit code alone.
 */

export const LOCAL_COMPUTER_PREPARATION_INCOMPLETE = "LOCAL_COMPUTER_PREPARATION_INCOMPLETE";

export const SERVER_CONFIRMATION_GUIDANCE = "Server/Web confirmation still requires fresh daemon observations.";
export const NO_CODE_REUSE_GUIDANCE = "Connection preserved. Do not reuse the one-time connect code.";

const PROVIDER_COMPONENTS: Record<ProviderCliProvider, { id: "im-cli:lark" | "im-cli:slack"; label: string }> = {
  feishu: { id: "im-cli:lark", label: "Lark CLI" },
  slack: { id: "im-cli:slack", label: "Slack CLI" },
};

export interface LocalComputerPreparationOptions {
  readonly runtimeProvider?: AgentRuntimeProvider;
  readonly service?: DaemonServiceInfo;
  readonly serviceError?: string;
  readonly noStart: boolean;
  readonly prepareProviderClis: boolean;
  readonly home: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly onPhase?: (event: ProviderCliPhaseEvent) => void;
  readonly probeRuntime?: (options: RuntimeProbeOptions) => Promise<LocalPreparationComponent>;
}

/** Idempotent daemon commands that reach the exact connected `--home` through the channel variable. */
export function daemonServiceCommand(action: "install" | "status", home: string): string {
  return `${OPEN_TAG_HOME_ENVIRONMENT_VARIABLE}=${quotePosix(home)} "$HOME/.local/bin/${channelConfig.binName}" daemon ${action}`;
}

function observedAt(now: () => Date): string {
  return now().toISOString();
}

/**
 * The daemon child Check: ready only when the service actually reports `active`. Unknown, inactive,
 * missing, failed, or deliberately skipped (`--no-start`) states are all blocking, and the repair is
 * the idempotent `daemon install` (install/update/start) followed by a `daemon status` verify.
 */
export function daemonChildCheck(input: {
  service?: DaemonServiceInfo;
  serviceError?: string;
  noStart: boolean;
  home: string;
  now: () => Date;
}): LocalPreparationCheck {
  const verifyAction = { command: daemonServiceCommand("status", input.home) };
  if (input.noStart) {
    return {
      id: "computer:daemon",
      label: "Daemon service",
      required: true,
      status: "skipped",
      blocking: true,
      message: "Daemon service was not started (--no-start).",
      nextAction: { command: daemonServiceCommand("install", input.home) },
      verifyAction,
    };
  }
  if (input.serviceError) {
    return {
      id: "computer:daemon",
      label: "Daemon service",
      required: true,
      status: "needs_attention",
      blocking: true,
      diagnosticCode: "DAEMON_SERVICE_FAILED",
      message: redactSecrets(input.serviceError).trim().slice(0, 512) || "Daemon service failed.",
      nextAction: { command: daemonServiceCommand("install", input.home) },
      verifyAction,
    };
  }
  const service = input.service;
  if (!service) {
    return {
      id: "computer:daemon",
      label: "Daemon service",
      required: true,
      status: "needs_attention",
      blocking: true,
      diagnosticCode: "DAEMON_SERVICE_UNAVAILABLE",
      message: "Daemon service did not report a state.",
      nextAction: { command: daemonServiceCommand("install", input.home) },
      verifyAction,
    };
  }
  const terminal = {
    id: "computer:daemon" as const,
    label: "Daemon service",
    required: true as const,
    observedAt: observedAt(input.now),
  };
  if (service.state === "active") {
    return { ...terminal, status: "ready" as const, blocking: false };
  }
  if (service.state === "not-installed") {
    return {
      ...terminal,
      status: "install_required" as const,
      blocking: true,
      diagnosticCode: "DAEMON_SERVICE_NOT_INSTALLED",
      message: "Daemon service is not installed.",
      nextAction: { command: daemonServiceCommand("install", input.home) },
      verifyAction,
    };
  }
  return {
    ...terminal,
    status: "needs_attention" as const,
    blocking: true,
    diagnosticCode: service.state === "inactive" ? "DAEMON_SERVICE_INACTIVE" : "DAEMON_SERVICE_UNKNOWN",
    message: service.state === "inactive" ? "Daemon service is inactive." : "Daemon service state is unknown.",
    nextAction: { command: daemonServiceCommand("install", input.home) },
    verifyAction,
  };
}

export function computerComponent(input: {
  service?: DaemonServiceInfo;
  serviceError?: string;
  noStart: boolean;
  home: string;
  now: () => Date;
}): LocalPreparationComponent {
  const daemon = daemonChildCheck(input);
  const daemonReady = daemon.status === "ready";
  return {
    id: "computer",
    label: "Computer",
    required: true,
    status: daemonReady ? "ready" : "needs_attention",
    blocking: !daemonReady,
    checks: [
      {
        id: "computer:connection",
        label: "Computer connection",
        required: true,
        status: "ready",
        blocking: false,
        observedAt: observedAt(input.now),
      },
      daemon,
    ],
  };
}

function safeRemediation(remediation: string | undefined): string | undefined {
  return remediation ? redactSecrets(remediation).slice(0, 512) : undefined;
}

function warningsFromProvider(result: ProviderCliEnsureResult): LocalPreparationComponent["warnings"] {
  if (result.warnings.length === 0) return undefined;
  return result.warnings.map((warning) => ({
    code: warning.code.slice(0, 64),
    ...(warning.remediation ? { message: redactSecrets(warning.remediation).slice(0, 512) } : {}),
    blocking: false,
  }));
}

function providerRepairCommand(provider: ProviderCliProvider): string {
  return providerCliRepairCommand(provider);
}

function providerInspectCommand(provider: ProviderCliProvider): string {
  return `"$HOME/.local/bin/${channelConfig.binName}" provider-cli inspect --provider ${provider === "feishu" ? "lark" : "slack"}`;
}

/**
 * Map one Provider CLI ensure outcome into its Component. Non-ready rows keep the exact provider
 * diagnostic code, block the verdict, and point at the existing idempotent ensure repair — except
 * manual failures, which get a safe instruction plus a read-only provider-cli inspect verify.
 */
export function providerComponentFromEnsureResult(
  provider: ProviderCliProvider,
  result: ProviderCliEnsureResult | undefined,
  now: () => Date,
  skipped = false,
): LocalPreparationComponent {
  const { id, label } = PROVIDER_COMPONENTS[provider];
  if (skipped) {
    return {
      id,
      label,
      required: true,
      status: "skipped",
      blocking: true,
      message: `${label} preparation was skipped (--no-prepare-provider-clis).`,
      nextAction: { command: providerRepairCommand(provider) },
      verifyAction: { command: providerInspectCommand(provider) },
    };
  }
  if (!result) {
    return {
      id,
      label,
      required: true,
      status: "unavailable",
      blocking: true,
      diagnosticCode: "provider_result_missing",
      message: `${label} preparation produced no result.`,
      nextAction: { command: providerRepairCommand(provider) },
      verifyAction: { command: providerInspectCommand(provider) },
    };
  }
  const observed = observedAt(now);
  if (result.ok && result.readiness === "ready" && result.selected) {
    const warnings = warningsFromProvider(result);
    return {
      id,
      label,
      required: true,
      status: "ready",
      blocking: false,
      version: redactSecrets(result.selected.version).slice(0, 64),
      observedAt: observed,
      ...(warnings ? { warnings } : {}),
    };
  }
  const code = result.diagnostic?.code ?? "unavailable";
  const remediation = safeRemediation(result.diagnostic?.remediation);
  const manual = !providerCliCanAutoRepair(code);
  const base = {
    id,
    label,
    required: true,
    observedAt: observed,
    diagnosticCode: code,
    verifyAction: { command: providerInspectCommand(provider) },
  };
  if (code === "operation_in_progress") {
    return {
      ...base,
      status: "checking" as const,
      blocking: true,
      message: `${label} preparation is owned by another OpenTag process.`,
      nextAction: { command: providerRepairCommand(provider) },
    };
  }
  if (code === "not_installed" || code === "install_incomplete" || code === "artifact_drifted") {
    return {
      ...base,
      status: "install_required" as const,
      blocking: true,
      message: remediation ?? `${label} must be installed or repaired.`,
      nextAction: { command: providerRepairCommand(provider) },
    };
  }
  if (manual) {
    return {
      ...base,
      status: "needs_attention" as const,
      blocking: true,
      message: remediation ?? `${label} needs manual attention.`,
      nextAction: { instruction: remediation ?? `Fix the ${label} manually, then run the verify command.` },
    };
  }
  return {
    ...base,
    status: "needs_attention" as const,
    blocking: true,
    message: remediation ?? `${label} preparation needs attention.`,
    nextAction: { command: providerRepairCommand(provider) },
  };
}

/** Fail-closed Provider rows when ensure itself threw or reported no results at all. */
function failedClosedProviderComponent(
  provider: ProviderCliProvider,
  error: unknown,
  now: () => Date,
): LocalPreparationComponent {
  const { id, label } = PROVIDER_COMPONENTS[provider];
  const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 480);
  return {
    id,
    label,
    required: true,
    status: "unavailable",
    blocking: true,
    diagnosticCode: "provider_prepare_failed",
    message: detail.length > 0 ? `${label} preparation failed: ${detail}` : `${label} preparation failed.`,
    nextAction: { command: providerRepairCommand(provider) },
    verifyAction: { command: providerInspectCommand(provider) },
    observedAt: observedAt(now),
  };
}

export async function runLocalComputerPreparation(
  options: LocalComputerPreparationOptions,
): Promise<LocalComputerPreparationResult> {
  const now = options.now ?? (() => new Date());
  const probe = options.probeRuntime ?? probeRuntimeComponent;
  const computer = computerComponent({
    service: options.service,
    serviceError: options.serviceError,
    noStart: options.noStart,
    home: options.home,
    now,
  });
  const runtime = await probeRuntimeSafely(options, probe, now);
  let lark: LocalPreparationComponent;
  let slack: LocalPreparationComponent;
  if (!options.prepareProviderClis) {
    lark = providerComponentFromEnsureResult("feishu", undefined, now, true);
    slack = providerComponentFromEnsureResult("slack", undefined, now, true);
  } else {
    try {
      const ensured = await runProviderCliEnsure({
        provider: "all",
        json: true,
        stdout: () => undefined,
        stderr: () => undefined,
        onPhase: options.onPhase,
        ...(options.env ? { env: options.env } : {}),
      });
      const byProvider = new Map(ensured.results.map((result) => [result.provider, result]));
      lark = providerComponentFromEnsureResult("feishu", byProvider.get("feishu"), now);
      slack = providerComponentFromEnsureResult("slack", byProvider.get("slack"), now);
    } catch (error) {
      // An unexpected ensure failure must not lose the complete picture: both Provider rows fail
      // closed and the connection/runtime verdicts still render.
      lark = failedClosedProviderComponent("feishu", error, now);
      slack = failedClosedProviderComponent("slack", error, now);
    }
  }
  return projectPreparation([computer, runtime, lark, slack]);
}

/** Derive counts from required rows and validate both normal and fail-closed projections. */
export function projectPreparation(components: LocalPreparationComponent[]): LocalComputerPreparationResult {
  const required = components.filter((component) => component.required);
  const ready = required.filter(
    (component) =>
      component.status === "ready" &&
      !component.blocking &&
      !(component.checks ?? []).some((check) => check.blocking || (check.required && check.status !== "ready")),
  ).length;
  return LocalComputerPreparationResultSchema.parse({
    status: ready === required.length ? "ready" : "needs_attention",
    localReady: ready === required.length,
    readyCount: ready,
    requiredCount: required.length,
    components,
  });
}

/** Preserve all four rows after an unexpected post-connection orchestration/projection error. */
export function failedLocalComputerPreparation(
  options: LocalComputerPreparationOptions,
  error: unknown,
): LocalComputerPreparationResult {
  const now = options.now ?? (() => new Date());
  const computer = computerComponent({ ...options, now });
  const runtime = options.runtimeProvider
    ? runtimeComponentFromProbeFailure(options.runtimeProvider, error, observedAt(now))
    : unconfirmedRuntimeComponent();
  return projectPreparation([
    computer,
    runtime,
    failedClosedProviderComponent("feishu", error, now),
    failedClosedProviderComponent("slack", error, now),
  ]);
}

async function probeRuntimeSafely(
  options: LocalComputerPreparationOptions,
  probe: NonNullable<LocalComputerPreparationOptions["probeRuntime"]>,
  now: () => Date,
): Promise<LocalPreparationComponent> {
  if (options.runtimeProvider === undefined) return unconfirmedRuntimeComponent();
  try {
    return await probe({ provider: options.runtimeProvider, environment: options.env, now });
  } catch (error) {
    // Provider preparation still runs after an unexpected Runtime failure.
    return runtimeComponentFromProbeFailure(options.runtimeProvider, error, observedAt(now));
  }
}

/** Diagnostic codes of the blocking rows that keep this result from being ready. */
export function preparationBlockerCodes(result: LocalComputerPreparationResult): string[] {
  const codes: string[] = [];
  for (const component of result.components) {
    if (component.status === "ready") continue;
    if (component.diagnosticCode) codes.push(component.diagnosticCode);
    for (const check of component.checks ?? []) {
      if ((check.blocking || (check.required && check.status !== "ready")) && check.diagnosticCode) {
        codes.push(check.diagnosticCode);
      }
    }
  }
  return codes;
}

/** Guidance lines shared verbatim by the human and JSON projections of one result. */
export function preparationGuidance(result: LocalComputerPreparationResult): string[] {
  if (result.status === "ready") return [SERVER_CONFIRMATION_GUIDANCE];
  const codes = preparationBlockerCodes(result);
  return [
    ...(codes.length ? [`Blocked by: ${codes.join(", ")}`] : []),
    NO_CODE_REUSE_GUIDANCE,
    SERVER_CONFIRMATION_GUIDANCE,
  ];
}
