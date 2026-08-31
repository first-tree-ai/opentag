import * as commandPolicy from "../../core/command/policy.js";
import type { DaemonServiceManager } from "../../core/daemon/service/index.js";
import { createDaemonServiceManager, formatDaemonServiceInfo } from "../../core/daemon/service/index.js";

export type DaemonServiceAction = "installAndStart" | "restart" | "start" | "status" | "stop" | "uninstall";
type DaemonErrorOption = { writeError?: (message: string) => void };
type DaemonOutputOption = { writeOutput?: (message: string) => void };
type DaemonJsonOption = { json?: boolean };
type DaemonServiceCallbacks = DaemonErrorOption & DaemonOutputOption & DaemonJsonOption;
type DaemonServiceCommandOptions = { manager?: DaemonServiceManager } & DaemonServiceCallbacks;
type DaemonServiceResult = Awaited<ReturnType<DaemonServiceManager[DaemonServiceAction]>>;

export async function executeDaemonServiceCommand(
  action: DaemonServiceAction,
  options: DaemonServiceCommandOptions = {},
): Promise<commandPolicy.CommandExitCode> {
  try {
    const manager = options.manager ?? (await createDaemonServiceManager());
    const info = await manager[action]();
    const output = renderDaemonServiceOutput(info, options.json === true);
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

function renderDaemonServiceOutput(info: DaemonServiceResult, json: boolean): string {
  return json ? JSON.stringify({ ok: true, result: info }) : formatDaemonServiceInfo(info);
}

function daemonServiceExitCode(action: DaemonServiceAction, state: DaemonServiceResult["state"]): 0 | 1 {
  if (action === "stop") return ["inactive", "not-installed"].includes(state) ? 0 : 1;
  if (action === "uninstall") return state === "not-installed" ? 0 : 1;
  return state === "active" ? 0 : 1;
}
