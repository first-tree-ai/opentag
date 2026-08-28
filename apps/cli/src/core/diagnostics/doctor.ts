import {
  checkServerHealth,
  resolveExecutable,
  resolveOpenTagHome,
  ServerHealthConfigurationError,
  ServerHealthHttpError,
  ServerHealthNetworkError,
  ServerHealthResponseError,
} from "@opentag/client";
import {
  AGENT_RUNTIME_PROVIDERS,
  type AgentRuntimeProvider,
  IM_CLI_PROVIDERS,
  type ImCliProvider,
  type ServerHealth,
} from "@opentag/shared";
import { CLI_VERSION } from "../../build-info.js";
import { channelConfig } from "../channel/config.js";
import { loadDaemonEnvironment } from "../daemon/environment.js";
import type { DaemonServiceManager } from "../daemon/service/index.js";
import {
  type AgentRuntimeProbe,
  checkAgentRuntimes,
  checkImClis,
  DOCTOR_PROBE_COMMANDS,
  type DoctorCheck,
  type ImCliProbe,
} from "./checks.js";
import { type DaemonServiceEnvironment, readDaemonServiceEnvironment } from "./service-environment.js";

export type HealthChecker = (serverUrl: string) => Promise<ServerHealth>;

export interface DoctorOptions {
  clientVersion?: string;
  env?: NodeJS.ProcessEnv;
  healthChecker?: HealthChecker;
  home?: string;
  imProbe?: ImCliProbe;
  /** Messaging CLIs that must be ready. Defaults to "any one of them is enough". */
  imProviders?: readonly ImCliProvider[];
  probeDeadlineMs?: number;
  platform?: NodeJS.Platform;
  runtimeProbe?: AgentRuntimeProbe;
  serviceManager?: DaemonServiceManager;
  /** Agent Runtimes that must be ready. Defaults to "any one of them is enough". */
  runtimes?: readonly AgentRuntimeProvider[];
  serverUrl?: string;
  signal?: AbortSignal;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  exitCode: 0 | 1;
  message: string;
}

export function resolveServerUrl(serverUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = serverUrl ?? env.OPENTAG_SERVER_URL ?? channelConfig.defaultServerUrl;
  if (!resolved) throw new ServerHealthConfigurationError(`The ${channelConfig.channel} channel requires a server URL`);
  return resolved;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const baseEnvironment = options.env ?? process.env;
  const home = options.home ?? resolveOpenTagHome(baseEnvironment);
  const environmentChecks: DoctorCheck[] = [];
  let environment = baseEnvironment;
  try {
    environment = (await loadDaemonEnvironment(home, baseEnvironment)).env;
  } catch (error) {
    environmentChecks.push({
      detail: `${describeError(error)}; the daemon reads the same file and fails the same way`,
      fix: { commands: [], summary: `Repair or remove the daemon environment file under ${home}` },
      id: "daemon-environment",
      status: "error",
      title: "Daemon environment",
    });
  }

  // Readiness is published by the installed daemon service, which resolves provider CLIs through the
  // PATH captured when it was installed. Probing with anything else answers a different question.
  const service = await readDaemonServiceEnvironment({
    env: baseEnvironment,
    home,
    ...(options.serviceManager ? { manager: options.serviceManager } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const serviceCheck = daemonServiceCheck(service);
  const shellPath = environment.PATH ?? "";
  const probeEnvironment = service.kind === "installed" ? { ...environment, PATH: service.path } : { ...environment };

  const runtimeProviders = options.runtimes ?? AGENT_RUNTIME_PROVIDERS;
  const imProviders = options.imProviders ?? IM_CLI_PROVIDERS;
  const [serverCheck, runtimeChecks, imChecks] = await Promise.all([
    checkServer(options),
    checkAgentRuntimes({
      clientVersion: options.clientVersion ?? CLI_VERSION,
      environment: probeEnvironment,
      providers: runtimeProviders,
      ...(options.probeDeadlineMs ? { probeDeadlineMs: options.probeDeadlineMs } : {}),
      ...(options.runtimeProbe ? { probe: options.runtimeProbe } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    checkImClis({
      environment: probeEnvironment,
      providers: imProviders,
      ...(options.probeDeadlineMs ? { probeDeadlineMs: options.probeDeadlineMs } : {}),
      ...(options.imProbe ? { probe: options.imProbe } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  ]);
  const probedRuntimeChecks =
    service.kind === "installed" ? await explainPathDivergence(runtimeChecks, shellPath, service.path) : runtimeChecks;
  const probedImChecks =
    service.kind === "installed" ? await explainPathDivergence(imChecks, shellPath, service.path) : imChecks;

  const checks = [serverCheck, serviceCheck, ...environmentChecks, ...probedRuntimeChecks, ...probedImChecks];
  const blocking = [
    ...(serverCheck.status === "ok" ? [] : [serverCheck]),
    ...(serviceCheck.status === "ok" ? [] : [serviceCheck]),
    ...environmentChecks,
    ...blockingGroup(probedRuntimeChecks, Boolean(options.runtimes)),
    ...blockingGroup(probedImChecks, Boolean(options.imProviders)),
  ];
  const ready = {
    imProviders: imProviders.filter((provider) => isReady(probedImChecks, `im:${provider}`)),
    runtimes: runtimeProviders.filter((provider) => isReady(probedRuntimeChecks, `runtime:${provider}`)),
  };
  return {
    checks,
    exitCode: blocking.length > 0 ? 1 : 0,
    message: renderDoctorText(checks, blocking, ready, service),
  };
}

export function renderDoctorJson(result: DoctorResult): string {
  return JSON.stringify(
    {
      checks: result.checks.map((check) => ({
        detail: check.detail,
        id: check.id,
        status: check.status,
        title: check.title,
        ...(check.fix ? { fix: check.fix } : {}),
      })),
      ok: result.exitCode === 0,
    },
    undefined,
    2,
  );
}

/**
 * A group passes when the caller-selected members are ready. Without a selection, one ready member
 * is enough: a computer that runs Codex does not need Claude Code installed as well.
 */
function blockingGroup(checks: readonly DoctorCheck[], selected: boolean): DoctorCheck[] {
  const failed = checks.filter((check) => check.status !== "ok");
  if (selected) return failed;
  return failed.length === checks.length ? failed : [];
}

/**
 * The daemon is what runs Agents and publishes readiness, so a Computer without a usable service is
 * not ready however healthy its CLIs look. Anything short of an installed, readable, active service
 * fails closed: doctor then has no authority to declare the Computer ready.
 */
function daemonServiceCheck(service: DaemonServiceEnvironment): DoctorCheck {
  const title = "Daemon service";
  const id = "daemon-service";
  if (service.kind === "installed" && service.state === "active") {
    return { detail: "active; checks below use the PATH it runs with", id, status: "ok", title };
  }
  if (service.kind === "installed") {
    return {
      detail: `installed but ${service.state}, so nothing runs Agents or publishes readiness`,
      fix: { commands: [`${channelConfig.binName} daemon restart`], summary: "Start the OpenTag daemon service" },
      id,
      status: "unavailable",
      title,
    };
  }
  if (service.kind === "not-installed") {
    return {
      detail: "not installed, so nothing runs Agents or publishes readiness from this computer",
      fix: {
        commands: [`${channelConfig.binName} daemon install`],
        note: `If this computer is not connected yet, run \`${channelConfig.binName} computer connect <code>\` instead; it installs the service for you`,
        summary: "Install the OpenTag daemon service",
      },
      id,
      status: "install",
      title,
    };
  }
  if (service.kind === "unsupported") {
    return {
      detail: `the OpenTag daemon does not support ${service.platform}`,
      fix: { commands: [], summary: "Run OpenTag on macOS or Linux" },
      id,
      status: "error",
      title,
    };
  }
  return {
    detail: `installed but unreadable: ${service.reason}`,
    fix: {
      commands: [`${channelConfig.binName} daemon install`],
      summary: "Rewrite the OpenTag daemon service definition",
    },
    id,
    status: "error",
    title,
  };
}

/**
 * A CLI the operator can run is not necessarily a CLI the daemon can run. When the two PATHs
 * disagree, saying so — and how to close the gap — beats telling them to install what they have.
 */
async function explainPathDivergence(
  checks: readonly DoctorCheck[],
  shellPath: string,
  daemonPath: string,
): Promise<DoctorCheck[]> {
  if (shellPath === daemonPath) return [...checks];
  const explained: DoctorCheck[] = [];
  for (const check of checks) {
    const command = DOCTOR_PROBE_COMMANDS[check.id];
    if (check.status !== "install" || !command || !(await resolvesOnPath(command, shellPath))) {
      explained.push(check);
      continue;
    }
    explained.push({
      ...check,
      detail: `on this shell's PATH, but not on the PATH the daemon service runs with`,
      fix: {
        commands: [`${channelConfig.binName} daemon install`],
        note: `\`${command}\` resolves for you but not for the daemon, which uses the PATH captured when its service was installed. Re-installing the service from this shell captures the current one.`,
        summary: `Give the daemon the same PATH this shell has, so that it can run \`${command}\``,
      },
    });
  }
  return explained;
}

async function resolvesOnPath(command: string, path: string): Promise<boolean> {
  try {
    await resolveExecutable(command, { PATH: path });
    return true;
  } catch {
    return false;
  }
}

async function checkServer(options: DoctorOptions): Promise<DoctorCheck> {
  const title = "OpenTag server";
  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl(options.serverUrl, options.env);
  } catch (error) {
    return {
      detail: formatServerError(error, "<not configured>"),
      fix: { commands: [], summary: `Set OPENTAG_SERVER_URL or pass --server-url to ${channelConfig.binName} doctor` },
      id: "server",
      status: "error",
      title,
    };
  }
  const healthChecker = options.healthChecker ?? checkServerHealth;
  try {
    const health = await healthChecker(serverUrl);
    return { detail: `healthy (${health.service}) at ${serverUrl}`, id: "server", status: "ok", title };
  } catch (error) {
    return {
      detail: formatServerError(error, serverUrl),
      fix: { commands: [], summary: serverFixSummary(error, serverUrl) },
      id: "server",
      status: "error",
      title,
    };
  }
}

function serverFixSummary(error: unknown, serverUrl: string): string {
  if (error instanceof ServerHealthNetworkError) return `Check this computer's network access to ${serverUrl}`;
  if (error instanceof ServerHealthConfigurationError || error instanceof ServerHealthResponseError) {
    return `Point OpenTag at an OpenTag server base URL with --server-url or OPENTAG_SERVER_URL, instead of ${serverUrl}`;
  }
  return `Wait for the OpenTag server at ${serverUrl} to become healthy, or point OpenTag at another one`;
}

function renderDoctorText(
  checks: readonly DoctorCheck[],
  blocking: readonly DoctorCheck[],
  ready: { imProviders: readonly ImCliProvider[]; runtimes: readonly AgentRuntimeProvider[] },
  service: DaemonServiceEnvironment,
): string {
  const lines = ["Checks", ...checks.map((check) => `  ${check.title}: ${check.detail}`), ""];
  if (blocking.length === 0) {
    lines.push(
      `This computer can run an OpenTag agent on ${orList(ready.runtimes.map(agentRuntimeName))},`,
      `delivering through ${orList(ready.imProviders.map(imCliName))}. It does not know which of those`,
      "your Agent is bound to; pass --runtime and --im to check a specific pair.",
      "",
      pathSource(service),
    );
    return lines.join("\n");
  }
  lines.push(
    `${blocking.length} ${blocking.length === 1 ? "check" : "checks"} must be fixed before this computer can run an OpenTag agent.`,
    "",
  );
  const fixes = blocking.flatMap((check) => (check.fix ? [check.fix] : []));
  for (const [index, fix] of fixes.entries()) {
    lines.push(`Fix ${index + 1}/${fixes.length} — ${fix.summary}`);
    for (const command of fix.commands) lines.push(`  ${command}`);
    if (fix.note) lines.push(`  Note: ${fix.note}`);
    if (fix.docsUrl) lines.push(`  Docs: ${fix.docsUrl}`);
  }
  lines.push(
    "",
    `Re-run \`${channelConfig.binName} doctor\` once the fixes are done. The OpenTag daemon republishes readiness`,
    "about twice a minute, so a setup page waiting on this computer turns green on its own.",
    "",
    pathSource(service),
  );
  return lines.join("\n");
}

/** Naming the PATH a report was produced with is what makes the report checkable. */
function pathSource(service: DaemonServiceEnvironment): string {
  if (service.kind === "installed") {
    return `CLI checks used the PATH declared by ${service.definitionPath}, which is what the daemon service runs with.`;
  }
  return "CLI checks used this shell's PATH, because no installed daemon service could be read; the daemon may resolve a different one.";
}

function isReady(checks: readonly DoctorCheck[], id: string): boolean {
  return checks.some((check) => check.id === id && check.status === "ok");
}

function agentRuntimeName(provider: AgentRuntimeProvider): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function imCliName(provider: ImCliProvider): string {
  return provider === "feishu" ? "Feishu" : "Slack";
}

function orList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "nothing";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function formatServerError(error: unknown, serverUrl: string): string {
  if (error instanceof ServerHealthConfigurationError) {
    return `configuration error: invalid OpenTag server URL ${serverUrl}`;
  }
  if (error instanceof ServerHealthNetworkError) {
    return `network error: could not reach the OpenTag server at ${serverUrl}`;
  }
  if (error instanceof ServerHealthHttpError) {
    return `HTTP error: the OpenTag server at ${serverUrl} returned status ${error.status}`;
  }
  if (error instanceof ServerHealthResponseError) {
    return `response error: the OpenTag server at ${serverUrl} returned an invalid health response`;
  }
  return `unexpected error while checking ${serverUrl}: ${describeError(error)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
