import { resolveOpenTagHome } from "@opentag/client";
import { CLI_VERSION } from "../../build-info.js";
import { resolveChannelEnvironment } from "../../core/channel/environment.js";
import * as commandPolicy from "../../core/command/policy.js";
import type { DaemonServiceManager } from "../../core/daemon/service/index.js";
import { createDaemonServiceManager, formatDaemonServiceInfo } from "../../core/daemon/service/index.js";
import { detectInstallMode, type InstallMode } from "../../core/update/install-mode.js";
import { readUpdaterState } from "../../core/update/updater-state.js";

export type DaemonServiceAction = "installAndStart" | "restart" | "start" | "status" | "stop" | "uninstall";
type DaemonErrorOption = { writeError?: (message: string) => void };
type DaemonOutputOption = { writeOutput?: (message: string) => void };
type DaemonJsonOption = { json?: boolean };
type DaemonServiceCallbacks = DaemonErrorOption & DaemonOutputOption & DaemonJsonOption;
type DaemonServiceCommandOptions = { manager?: DaemonServiceManager } & DaemonServiceCallbacks;
type DaemonServiceResult = Awaited<ReturnType<DaemonServiceManager[DaemonServiceAction]>>;

export interface DaemonUpdateStatus {
  currentVersion: string;
  installMode?: InstallMode["mode"];
  state: string;
  target?: string;
  lastAttempt?: { target: string; startedAt: string; finishedAt?: string; result?: string; failureReason?: string };
  historyStatus?: "invalid";
}

/** Update-state lines for `daemon status`; running identity does not depend on durable history. */
export function formatUpdateStatus(state: DaemonUpdateStatus): string {
  const lines = [`Update current: ${state.currentVersion}`];
  if (state.installMode) lines.push(`Update install mode: ${state.installMode}`);
  lines.push(
    state.historyStatus === "invalid"
      ? "Update state: unknown (the updater state record is invalid; run the upgrade command)"
      : `Update state: ${state.state}`,
  );
  if (state.target) lines.push(`Update target: ${state.target}`);
  const attempt = state.lastAttempt;
  if (attempt) {
    const outcome = attempt.result ?? "interrupted";
    const when = attempt.finishedAt ?? attempt.startedAt;
    lines.push(
      `Update last attempt: ${attempt.target} ${outcome} at ${when}${attempt.failureReason ? ` (${attempt.failureReason})` : ""}`,
    );
  }
  return lines.join("\n");
}

export async function executeDaemonServiceCommand(
  action: DaemonServiceAction,
  options: DaemonServiceCommandOptions = {},
): Promise<commandPolicy.CommandExitCode> {
  try {
    const manager = options.manager ?? (await createDaemonServiceManager());
    const info = await manager[action]();
    const update = action === "status" ? await resolveDaemonUpdateStatus() : undefined;
    const output = renderDaemonServiceOutput(info, options.json === true, update);
    (options.writeOutput ?? ((message) => process.stdout.write(`${message}\n`)))(output);
    return daemonServiceExitCode(action, info.state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      const commandError = commandPolicy.toCommandError(error, "request");
      return commandPolicy.presentCommand(
        { ok: false, error: commandError, exitCode: commandPolicy.commandExitCode(commandError) },
        { json: true, stderr: options.writeError },
      );
    }
    (options.writeError ?? ((value) => process.stderr.write(`${value}\n`)))(commandPolicy.redactSecrets(message));
    return 1;
  }
}

async function resolveDaemonUpdateStatus(): Promise<DaemonUpdateStatus> {
  const environment = resolveChannelEnvironment(process.env);
  const installMode = detectInstallMode(environment).mode;
  const loaded = await readUpdaterState(resolveOpenTagHome(environment));
  if (loaded.status === "ok") {
    return {
      ...loaded.state,
      currentVersion: CLI_VERSION,
      installMode,
    };
  }
  return {
    currentVersion: CLI_VERSION,
    installMode,
    state: installMode === "npm-global" ? "manual" : "idle",
    ...(loaded.status === "invalid" ? { historyStatus: "invalid" as const } : {}),
  };
}

function renderDaemonServiceOutput(info: DaemonServiceResult, json: boolean, update?: DaemonUpdateStatus): string {
  if (json) return JSON.stringify({ ok: true, result: update ? { ...info, update } : info });
  return update ? `${formatDaemonServiceInfo(info)}\n${formatUpdateStatus(update)}` : formatDaemonServiceInfo(info);
}

function daemonServiceExitCode(action: DaemonServiceAction, state: DaemonServiceResult["state"]): 0 | 1 {
  if (action === "stop") return ["inactive", "not-installed"].includes(state) ? 0 : 1;
  if (action === "uninstall") return state === "not-installed" ? 0 : 1;
  return state === "active" ? 0 : 1;
}
