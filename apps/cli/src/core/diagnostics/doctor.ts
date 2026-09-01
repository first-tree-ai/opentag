import { resolve } from "node:path";
import {
  type AgentRuntimeCliInstallation,
  checkServerHealth,
  inspectLocalComputerConfiguration,
  type LocalComputerConfigurationInspection,
  type ProviderCliInspection,
  ProviderCliManager,
  probeAgentRuntimeCliInstallations,
  resolveAccountHome,
  ServerHealthConfigurationError,
  ServerHealthHttpError,
  ServerHealthNetworkError,
  ServerHealthResponseError,
  ServerHealthTimeoutError,
} from "@opentag/client";
import type { ServerHealth } from "@opentag/shared";
import { CHANNEL, CLI_VERSION } from "../../build-info.js";
import { channelConfig } from "../channel/config.js";
import { wasChannelDefaultHomeApplied } from "../channel/home-source.js";
import { createDaemonServiceManager } from "../daemon/service/index.js";
import { canonicalizeServiceHome } from "../daemon/service/shared.js";
import type { DaemonServiceInfo } from "../daemon/service/types.js";

export type DoctorCheckStatus = "pass" | "fail" | "unknown" | "info" | "skipped";
export type DoctorCheckScope =
  | "target"
  | "local-configuration"
  | "daemon-service"
  | "server"
  | "agent-runtime"
  | "provider-cli";

export interface DoctorCheck {
  code: string;
  scope: DoctorCheckScope;
  status: DoctorCheckStatus;
  blocking: boolean;
  label: string;
  detail: string;
  observedFrom?: string;
  path?: string;
  remediation?: string;
}

export interface DoctorTarget {
  home: string;
  homeSource: "environment" | "channel-default";
  cliVersion: string;
  channel: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
}

export interface DoctorReport {
  target: DoctorTarget;
  checks: DoctorCheck[];
  notEvaluated: readonly string[];
  exitCode: 0 | 1;
}

export interface DoctorResult extends DoctorReport {
  message: string;
}

export type HealthChecker = (serverUrl: string) => Promise<ServerHealth>;
export type LocalConfigurationInspector = (home: string) => Promise<LocalComputerConfigurationInspection>;
export type DaemonServiceInspector = (home: string) => Promise<DaemonServiceInfo>;
export type RuntimeDetector = (options: {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}) => Promise<AgentRuntimeCliInstallation[]>;
export type ProviderCliInspector = (options: {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
}) => Promise<ProviderCliInspection[]>;

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  cliVersion?: string;
  channel?: string;
  healthChecker?: HealthChecker;
  inspectLocalConfiguration?: LocalConfigurationInspector;
  inspectDaemonService?: DaemonServiceInspector;
  providerCliInspector?: ProviderCliInspector;
  runtimeDetector?: RuntimeDetector;
}

export const DOCTOR_NOT_EVALUATED = [
  "Agent Runtime authentication",
  "Agent Runtime version or protocol compatibility",
  "Agent Runtime visibility from the installed daemon environment",
  "machine-token authentication or WebSocket registration",
  "Integration CLI credential validity and active-binding readiness",
  "end-to-end Turn or handoff delivery",
] as const;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const environment = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const selectedTarget = resolveDoctorTarget({
    environment,
    platform,
    arch: options.arch ?? process.arch,
    nodeVersion: options.nodeVersion ?? process.version,
    cliVersion: options.cliVersion ?? CLI_VERSION,
    channel: options.channel ?? CHANNEL,
    channelDefaultHomeApplied: environment === process.env && wasChannelDefaultHomeApplied(),
  });
  const target = {
    ...selectedTarget,
    home: await canonicalizeServiceHome(selectedTarget.home).catch(() => selectedTarget.home),
  };
  const localInspector = options.inspectLocalConfiguration ?? inspectLocalComputerConfiguration;
  const daemonInspector =
    options.inspectDaemonService ??
    (async (home: string) => (await createDaemonServiceManager({ env: environment, home, platform })).status());
  const runtimeDetector =
    options.runtimeDetector ??
    ((request) =>
      probeAgentRuntimeCliInstallations({
        environment: request.environment,
        platform: request.platform,
      }));
  const providerCliInspector =
    options.providerCliInspector ??
    (async (request) => {
      const manager = new ProviderCliManager({
        accountHome: resolveAccountHome(),
        env: request.environment,
        platform: request.platform,
        arch: request.arch,
      });
      return Promise.all([manager.inspect("feishu"), manager.inspect("slack")]);
    });
  const healthChecker = options.healthChecker ?? checkServerHealth;

  const localPromise = settle(localInspector(target.home));
  const daemonPromise = settle(daemonInspector(target.home));
  const runtimePromise = settle(runtimeDetector({ environment, platform }));
  const providerCliPromise = settle(
    providerCliInspector({ environment, platform, arch: options.arch ?? process.arch }),
  );
  const healthPromise = localPromise.then(async (localResult) => {
    if (localResult.status === "rejected") return { status: "skipped" as const };
    const serverUrl = localResult.value.binding.serverUrl;
    if (!serverUrl || localResult.value.binding.status !== "valid") return { status: "skipped" as const };
    return settle(healthChecker(serverUrl));
  });

  const [localResult, daemonResult, healthResult, runtimeResult, providerCliResult] = await Promise.all([
    localPromise,
    daemonPromise,
    healthPromise,
    runtimePromise,
    providerCliPromise,
  ]);
  const checks: DoctorCheck[] = [
    targetCheck(target),
    ...localChecks(localResult),
    daemonCheck(daemonResult, target.home),
    serverCheck(healthResult, localResult),
    ...runtimeChecks(runtimeResult),
    ...providerCliChecks(providerCliResult),
  ];
  const exitCode: 0 | 1 = checks.some(
    (check) => check.blocking && (check.status === "fail" || check.status === "unknown"),
  )
    ? 1
    : 0;
  const report: DoctorReport = { target, checks, notEvaluated: DOCTOR_NOT_EVALUATED, exitCode };
  return { ...report, message: renderDoctorReport(report) };
}

export function resolveDoctorTarget(options: {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  cliVersion: string;
  channel: string;
  channelDefaultHomeApplied?: boolean;
}): DoctorTarget {
  const selected = options.environment.OPENTAG_HOME?.trim();
  const homeSource = selected && !options.channelDefaultHomeApplied ? "environment" : "channel-default";
  return {
    home: resolve(selected || channelConfig.defaultHome),
    homeSource,
    cliVersion: options.cliVersion,
    channel: options.channel,
    platform: options.platform,
    arch: options.arch,
    nodeVersion: options.nodeVersion,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const blockingFailures = report.checks.filter(
    (check) => check.blocking && (check.status === "fail" || check.status === "unknown"),
  ).length;
  const summary =
    blockingFailures === 0
      ? "Baseline checks passed for this OpenTag Home."
      : `${blockingFailures} blocking baseline check(s) failed for this OpenTag Home.`;
  const lines = [
    "OpenTag Doctor",
    "",
    "Target",
    `  - OpenTag Home: ${report.target.home} (${report.target.homeSource === "environment" ? "environment" : "channel default"})`,
    `  - CLI: ${report.target.cliVersion}, ${report.target.channel}, ${report.target.platform} ${report.target.arch}, Node.js ${report.target.nodeVersion}`,
  ];
  for (const [heading, scope] of [
    ["Local configuration", "local-configuration"],
    ["Daemon service", "daemon-service"],
    ["Server", "server"],
    ["Agent Runtime CLIs", "agent-runtime"],
    ["IM Provider CLIs", "provider-cli"],
  ] as const) {
    lines.push("", heading);
    for (const check of report.checks.filter((candidate) => candidate.scope === scope)) {
      lines.push(`  ${statusMarker(check.status)} ${check.label}: ${check.detail}`);
      if (check.remediation) lines.push(`    Next: ${check.remediation}`);
    }
  }
  lines.push("", "Summary", `  ${summary}`, "", "Not evaluated");
  for (const item of report.notEvaluated) lines.push(`  - ${item}`);
  return lines.join("\n");
}

function targetCheck(target: DoctorTarget): DoctorCheck {
  return {
    code: "target.home",
    scope: "target",
    status: "info",
    blocking: false,
    label: "OpenTag Home",
    detail: target.home,
    path: target.home,
    observedFrom: target.homeSource,
  };
}

function localChecks(result: PromiseSettledResult<LocalComputerConfigurationInspection>): DoctorCheck[] {
  if (result.status === "rejected") {
    const detail = safeErrorDetail(result.reason, "Local Computer configuration could not be inspected");
    return [
      localCheck("local.identity", "Computer identity", "unknown", detail),
      localCheck("local.credentials", "Computer credentials", "unknown", detail),
      localCheck("local.binding", "Local Computer binding", "unknown", "Local binding could not be verified"),
    ];
  }
  const { identity, credentials, binding } = result.value;
  return [
    localCheck(
      "local.identity",
      "Computer identity",
      localStatus(identity.status),
      identity.status === "valid" ? "valid for one Computer and one Server" : (identity.detail ?? "invalid"),
    ),
    localCheck(
      "local.credentials",
      "Computer credentials",
      localStatus(credentials.status),
      credentials.status === "valid" ? "1 valid Computer credential" : (credentials.detail ?? "invalid"),
    ),
    localCheck(
      "local.binding",
      "Local Computer configuration",
      localStatus(binding.status),
      binding.status === "valid"
        ? `${binding.credentialCount} credential(s), one Computer, one Server`
        : (binding.detail ?? "invalid"),
    ),
  ];
}

function localCheck(code: string, label: string, status: "pass" | "fail" | "unknown", detail: string): DoctorCheck {
  return {
    code,
    scope: "local-configuration",
    status,
    blocking: true,
    label,
    detail,
    ...(status === "fail"
      ? {
          remediation: `Review this OpenTag Home and run '${channelConfig.binName} computer connect' with a valid connect code`,
        }
      : {}),
  };
}

function localStatus(status: LocalComputerConfigurationInspection["identity"]["status"]): "pass" | "fail" {
  return status === "valid" ? "pass" : "fail";
}

function daemonCheck(result: PromiseSettledResult<DaemonServiceInfo>, home: string): DoctorCheck {
  if (result.status === "rejected") {
    return {
      code: "daemon.service",
      scope: "daemon-service",
      status: "unknown",
      blocking: true,
      label: "Daemon service",
      detail: safeErrorDetail(result.reason, "Daemon service status could not be determined"),
    };
  }
  const info = result.value;
  const sameHome = info.configuredHome !== undefined && resolve(info.configuredHome) === home;
  const passed =
    info.platform !== "unsupported" &&
    info.state === "active" &&
    sameHome &&
    info.drifted === false &&
    info.runtimeOwner?.consistency === "consistent";
  const detail = passed
    ? `active for this OpenTag Home; logs: ${info.logHint}`
    : `${daemonFailureDetail(info, sameHome)}; logs: ${info.logHint}`;
  return {
    code: "daemon.service",
    scope: "daemon-service",
    status: passed ? "pass" : info.state === "unknown" ? "unknown" : "fail",
    blocking: true,
    label: "Daemon service",
    detail,
    ...(passed
      ? {}
      : { remediation: `Inspect with '${channelConfig.binName} daemon status' before changing the service` }),
  };
}

function daemonFailureDetail(info: DaemonServiceInfo, sameHome: boolean): string {
  if (info.platform === "unsupported") return "unsupported on this platform";
  if (info.state !== "active") return info.detail ? `${info.state} (${truncate(info.detail)})` : info.state;
  if (!sameHome) return "active for a different or unverifiable OpenTag Home";
  if (info.drifted !== false) return "service definition is drifted or unverifiable";
  if (info.runtimeOwner?.consistency !== "consistent") {
    return `runtime owner is ${info.runtimeOwner?.consistency ?? "unverified"}`;
  }
  return "status could not be verified";
}

function serverCheck(
  result: { status: "skipped" } | PromiseSettledResult<ServerHealth>,
  localResult: PromiseSettledResult<LocalComputerConfigurationInspection>,
): DoctorCheck {
  const serverUrl = localResult.status === "fulfilled" ? localResult.value.binding.serverUrl : undefined;
  if (result.status === "skipped" || !serverUrl) {
    return {
      code: "server.health",
      scope: "server",
      status: "skipped",
      blocking: true,
      label: "Server health endpoint",
      detail: "not checked because there is no connected Server",
    };
  }
  if (result.status === "fulfilled") {
    return {
      code: "server.health",
      scope: "server",
      status: "pass",
      blocking: true,
      label: "Server health endpoint",
      detail: `reachable at ${serverUrl}`,
    };
  }
  return {
    code: "server.health",
    scope: "server",
    status: "fail",
    blocking: true,
    label: "Server health endpoint",
    detail: formatHealthFailure(result.reason, serverUrl),
    remediation: "Check network access and the connected Server health endpoint",
  };
}

function runtimeChecks(result: PromiseSettledResult<AgentRuntimeCliInstallation[]>): DoctorCheck[] {
  if (result.status === "rejected") {
    return [
      {
        code: "runtime.any-installed",
        scope: "agent-runtime",
        status: "unknown",
        blocking: true,
        label: "Agent Runtime CLI",
        detail: safeErrorDetail(result.reason, "Runtime installation could not be determined"),
        observedFrom: "current CLI process environment",
      },
      runtimeProviderUnknown("codex", "Codex CLI"),
      runtimeProviderUnknown("claude-code", "Claude Code CLI"),
    ];
  }
  const byProvider = new Map(result.value.map((entry) => [entry.provider, entry]));
  const codex = byProvider.get("codex") ?? unknownRuntime("codex", "Codex CLI");
  const claude = byProvider.get("claude-code") ?? unknownRuntime("claude-code", "Claude Code CLI");
  const installed = [codex, claude].filter((entry) => entry.status === "installed");
  const hasUnknown = [codex, claude].some((entry) => entry.status === "unknown");
  return [
    {
      code: "runtime.any-installed",
      scope: "agent-runtime",
      status: installed.length > 0 ? "pass" : hasUnknown ? "unknown" : "fail",
      blocking: true,
      label: "Agent Runtime CLI",
      detail:
        installed.length > 0
          ? "at least one supported Runtime is installed"
          : hasUnknown
            ? "no supported Runtime was found and at least one result is unknown"
            : "no supported Runtime is installed",
      observedFrom: "current CLI process environment",
      ...(installed.length > 0 ? {} : { remediation: "Install Codex CLI or Claude Code CLI" }),
    },
    runtimeProviderCheck(codex),
    runtimeProviderCheck(claude),
  ];
}

function providerCliChecks(result: PromiseSettledResult<ProviderCliInspection[]>): DoctorCheck[] {
  if (result.status === "rejected") {
    const detail = safeErrorDetail(result.reason, "Provider CLI state could not be inspected");
    return [providerCliUnknown("feishu", "Lark CLI", detail), providerCliUnknown("slack", "Slack CLI", detail)];
  }
  const byProvider = new Map(result.value.map((inspection) => [inspection.provider, inspection]));
  return [
    providerCliCheck(byProvider.get("feishu"), "feishu", "Lark CLI"),
    providerCliCheck(byProvider.get("slack"), "slack", "Slack CLI"),
  ];
}

function providerCliCheck(
  inspection: ProviderCliInspection | undefined,
  provider: "feishu" | "slack",
  label: string,
): DoctorCheck {
  if (!inspection) return providerCliUnknown(provider, label, "Inspector did not return a result");
  const common = {
    code: `provider-cli.${provider}.installation`,
    scope: "provider-cli" as const,
    blocking: false,
    label,
    observedFrom: "operating-system account Provider CLI state",
  };
  if (inspection.readiness === "ready" && inspection.selection) {
    return {
      ...common,
      status: "pass",
      detail: `${inspection.selection.kind} ${inspection.selection.version} selected at ${inspection.selection.path}`,
      path: inspection.selection.path,
    };
  }
  if (inspection.readiness === "install") {
    return {
      ...common,
      status: "info",
      detail: "not prepared for this operating-system account",
      remediation:
        "No action is required until this provider is bound; the daemon prepares required CLIs automatically",
    };
  }
  return {
    ...common,
    status: "fail",
    detail: inspection.diagnostic?.code ?? "local Provider CLI selection is unavailable",
    ...(inspection.diagnostic?.remediation ? { remediation: inspection.diagnostic.remediation } : {}),
  };
}

function providerCliUnknown(provider: "feishu" | "slack", label: string, detail: string): DoctorCheck {
  return {
    code: `provider-cli.${provider}.installation`,
    scope: "provider-cli",
    status: "unknown",
    blocking: false,
    label,
    detail: truncate(detail),
    observedFrom: "operating-system account Provider CLI state",
  };
}

function runtimeProviderCheck(entry: AgentRuntimeCliInstallation): DoctorCheck {
  if (entry.status === "installed") {
    return {
      code: `runtime.${entry.provider}.installation`,
      scope: "agent-runtime",
      status: "pass",
      blocking: false,
      label: entry.displayName,
      detail: `installed at ${entry.path} (${entry.source})`,
      path: entry.path,
      observedFrom: "current CLI process environment",
    };
  }
  if (entry.status === "unknown") return runtimeProviderUnknown(entry.provider, entry.displayName, entry.detail);
  return {
    code: `runtime.${entry.provider}.installation`,
    scope: "agent-runtime",
    status: "info",
    blocking: false,
    label: entry.displayName,
    detail: "not installed",
    observedFrom: "current CLI process environment",
  };
}

function runtimeProviderUnknown(provider: "codex" | "claude-code", label: string, detail?: string): DoctorCheck {
  return {
    code: `runtime.${provider}.installation`,
    scope: "agent-runtime",
    status: "unknown",
    blocking: false,
    label,
    detail: truncate(detail ?? "installation could not be determined"),
    observedFrom: "current CLI process environment",
  };
}

function unknownRuntime(provider: "codex" | "claude-code", displayName: string): AgentRuntimeCliInstallation {
  return { provider, displayName, status: "unknown", detail: "Detector did not return a result" };
}

function formatHealthFailure(error: unknown, serverUrl: string): string {
  if (error instanceof ServerHealthConfigurationError) return `invalid connected Server URL ${serverUrl}`;
  if (error instanceof ServerHealthTimeoutError) return `timed out while reaching ${serverUrl}`;
  if (error instanceof ServerHealthNetworkError) return `could not reach ${serverUrl}`;
  if (error instanceof ServerHealthHttpError) return `${serverUrl} returned HTTP ${error.status}`;
  if (error instanceof ServerHealthResponseError) return `${serverUrl} returned an invalid health response`;
  return `health status could not be determined for ${serverUrl}`;
}

function statusMarker(status: DoctorCheckStatus): string {
  if (status === "pass") return "✓";
  if (status === "fail") return "✗";
  if (status === "unknown") return "?";
  return "-";
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function safeErrorDetail(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.length === 0) return fallback;
  return truncate(error.message);
}

function truncate(value: string): string {
  const redacted = value.replace(/otmc_[^\s]+/giu, "[redacted]");
  return [...redacted]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, 300);
}
