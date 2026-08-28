import {
  checkServerHealth,
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
import {
  type AgentRuntimeProbe,
  checkAgentRuntimes,
  checkImClis,
  type DoctorCheck,
  type ImCliProbe,
} from "./checks.js";

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
  runtimeProbe?: AgentRuntimeProbe;
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

  const runtimeProviders = options.runtimes ?? AGENT_RUNTIME_PROVIDERS;
  const imProviders = options.imProviders ?? IM_CLI_PROVIDERS;
  const [serverCheck, runtimeChecks, imChecks] = await Promise.all([
    checkServer(options),
    checkAgentRuntimes({
      clientVersion: options.clientVersion ?? CLI_VERSION,
      environment,
      providers: runtimeProviders,
      ...(options.probeDeadlineMs ? { probeDeadlineMs: options.probeDeadlineMs } : {}),
      ...(options.runtimeProbe ? { probe: options.runtimeProbe } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    checkImClis({
      environment,
      providers: imProviders,
      ...(options.probeDeadlineMs ? { probeDeadlineMs: options.probeDeadlineMs } : {}),
      ...(options.imProbe ? { probe: options.imProbe } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  ]);

  const checks = [serverCheck, ...environmentChecks, ...runtimeChecks, ...imChecks];
  const blocking = [
    ...(serverCheck.status === "ok" ? [] : [serverCheck]),
    ...environmentChecks,
    ...blockingGroup(runtimeChecks, Boolean(options.runtimes)),
    ...blockingGroup(imChecks, Boolean(options.imProviders)),
  ];
  return { checks, exitCode: blocking.length > 0 ? 1 : 0, message: renderDoctorText(checks, blocking) };
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

function renderDoctorText(checks: readonly DoctorCheck[], blocking: readonly DoctorCheck[]): string {
  const lines = ["Checks", ...checks.map((check) => `  ${check.title}: ${check.detail}`), ""];
  if (blocking.length === 0) {
    lines.push("This computer is ready to run an OpenTag agent.");
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
    if (fix.docsUrl) lines.push(`  Docs: ${fix.docsUrl}`);
  }
  lines.push(
    "",
    `Re-run \`${channelConfig.binName} doctor\` once the fixes are done. The OpenTag daemon republishes readiness`,
    "about twice a minute, so a setup page waiting on this computer turns green on its own.",
  );
  return lines.join("\n");
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
