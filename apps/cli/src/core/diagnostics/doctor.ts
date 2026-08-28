import { userInfo } from "node:os";
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
import type { DoctorFix } from "./fixes.js";
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
  // Readiness is published by the installed daemon service, so the service's own environment — not
  // the operator's shell — is the only one whose answer matches what the Server receives.
  const service = await readDaemonServiceEnvironment({
    env: baseEnvironment,
    home,
    ...(options.serviceManager ? { manager: options.serviceManager } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const serviceCheck = daemonServiceCheck(service);
  const environmentChecks: DoctorCheck[] = [];
  const serviceEnvironment =
    service.kind === "installed"
      ? serviceProcessEnvironment(baseEnvironment, service)
      : unmanagedProbeEnvironment(baseEnvironment, options.platform ?? process.platform);
  let probeEnvironment = serviceEnvironment;
  try {
    // The daemon layers daemon.env over its service environment, filling only unset keys.
    probeEnvironment = (await loadDaemonEnvironment(home, serviceEnvironment)).env;
  } catch (error) {
    environmentChecks.push({
      detail: `${describeError(error)}; the daemon reads the same file and fails the same way`,
      fix: { commands: [], summary: `Repair or remove the daemon environment file under ${home}` },
      id: "daemon-environment",
      status: "error",
      title: "Daemon environment",
    });
  }
  // The invoking shell's PATH is comparison-only: it explains a divergence, it never probes.
  const shellPath = baseEnvironment.PATH ?? "";

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
 * Variables a user service receives from the service manager itself rather than from any shell.
 * launchd and systemd both establish the account's own identity and locations for the process; a
 * shell export such as `ANTHROPIC_API_KEY` or `CODEX_HOME` never reaches it. Keeping this list
 * strict makes the diagnostic err toward "not ready", which is the safe direction: the daemon
 * gets its extra configuration from `daemon.env`, and that is layered on separately.
 */
const SERVICE_MANAGER_VARIABLES: Readonly<Record<"launchd" | "systemd", readonly string[]>> = {
  launchd: ["TMPDIR"],
  systemd: ["XDG_RUNTIME_DIR"],
};

export interface ServiceAccount {
  readonly homedir: string;
  readonly shell: string | null;
  readonly username: string;
}

/**
 * Reconstruct the environment the installed service's process actually has: the account-level
 * variables its manager provides, overlaid with exactly what its definition declares.
 *
 * The account identity comes from the operating system rather than the invoking environment. A
 * service manager starts the job from the user account itself, so a shell that exported a different
 * `HOME` would otherwise send the probes looking for provider homes the daemon never uses. The
 * per-user temporary directory still comes from the environment: the same account resolves it to
 * the same value, and it carries no credential.
 */
export function serviceProcessEnvironment(
  base: NodeJS.ProcessEnv,
  service: { readonly environment: Readonly<Record<string, string>>; readonly platform: "launchd" | "systemd" },
  account: ServiceAccount = userInfo(),
): NodeJS.ProcessEnv {
  return { ...accountEnvironment(base, service.platform, account), ...service.environment };
}

/**
 * What to probe with when no service definition can be read. The account reconstruction still
 * applies, so a check line means the same thing on every path; only the executable search path falls
 * back to the invoking shell, because nothing else has one to offer. A service installed later
 * captures its own, and inherits none of this shell's credentials either — so dropping them here
 * predicts that service rather than flattering the current terminal.
 */
export function unmanagedProbeEnvironment(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  account: ServiceAccount = userInfo(),
): NodeJS.ProcessEnv {
  const manager = platform === "linux" ? "systemd" : platform === "darwin" ? "launchd" : undefined;
  const environment = accountEnvironment(base, manager, account);
  if (base.PATH !== undefined) environment.PATH = base.PATH;
  return environment;
}

function accountEnvironment(
  base: NodeJS.ProcessEnv,
  manager: "launchd" | "systemd" | undefined,
  account: ServiceAccount,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: account.homedir,
    LOGNAME: account.username,
    USER: account.username,
    ...(account.shell ? { SHELL: account.shell } : {}),
  };
  for (const key of manager ? SERVICE_MANAGER_VARIABLES[manager] : []) {
    const value = base[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
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
  if (service.kind === "home-mismatch") {
    return {
      detail: `active for another OpenTag home (${service.serviceHome}), not ${service.requestedHome}`,
      fix: {
        commands: [],
        summary: `Run doctor against the home the installed service belongs to: OPENTAG_HOME=${service.serviceHome}`,
      },
      id,
      status: "error",
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
      detail: "on this shell's PATH, but not on the PATH the daemon service runs with",
      // One shared fix object: several diverging CLIs have one cause and one remedy, and the
      // renderer collapses identical fixes so the operator is not told the same thing four times.
      fix: STALE_DAEMON_PATH_FIX,
    });
  }
  return explained;
}

const STALE_DAEMON_PATH_FIX: DoctorFix = {
  commands: [`${channelConfig.binName} daemon install`],
  note: "The daemon uses the PATH captured when its service was installed. Re-installing the service from this shell captures the current one.",
  summary: "Give the daemon the same PATH this shell has, so that it can resolve the CLIs above",
};

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
  const fixes = uniqueFixes(blocking.flatMap((check) => (check.fix ? [check.fix] : [])));
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

/** Two checks with one cause deserve one instruction, not the same instruction twice. */
function uniqueFixes(fixes: readonly DoctorFix[]): DoctorFix[] {
  const seen = new Set<string>();
  return fixes.filter((fix) => {
    const key = JSON.stringify([fix.summary, fix.commands, fix.note, fix.docsUrl]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Naming the PATH a report was produced with is what makes the report checkable. */
function pathSource(service: DaemonServiceEnvironment): string {
  if (service.kind === "installed") {
    return `CLI checks used the PATH declared by ${service.definitionPath}, which is what the daemon service runs with.`;
  }
  return "CLI checks used this account and this shell's PATH, because no installed daemon service could be read. A service installed later resolves its own PATH and inherits nothing else from this shell.";
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
