import {
  type CommandExitCode,
  commandExitCode,
  presentCommand,
  redactSecrets,
  toCommandError,
} from "../../core/command/policy.js";
import {
  createDaemonServiceManager,
  type DaemonServiceManager,
  formatDaemonServiceInfo,
} from "../../core/daemon/service/index.js";

export type DaemonServiceAction = "installAndStart" | "restart" | "start" | "status" | "stop" | "uninstall";

export async function executeDaemonServiceCommand(
  action: DaemonServiceAction,
  options: {
    manager?: DaemonServiceManager;
    writeError?: (message: string) => void;
    writeOutput?: (message: string) => void;
    json?: boolean;
  } = {},
): Promise<CommandExitCode> {
  try {
    const manager = options.manager ?? (await createDaemonServiceManager());
    const info = await manager[action]();
    const output = renderDaemonServiceOutput(info, options.json === true);
    (options.writeOutput ?? ((message) => process.stdout.write(`${message}\n`)))(output);
    return daemonServiceExitCode(action, info.state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      const commandError = toCommandError(error, "request");
      return presentCommand(
        { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
        { json: true, stderr: options.writeError },
      );
    }
    (options.writeError ?? ((value) => process.stderr.write(`${value}\n`)))(redactSecrets(message));
    return 1;
  }
}

function renderDaemonServiceOutput(
  info: Awaited<ReturnType<DaemonServiceManager[DaemonServiceAction]>>,
  json: boolean,
): string {
  return json ? JSON.stringify({ ok: true, result: info }) : formatDaemonServiceInfo(info);
}

function daemonServiceExitCode(
  action: DaemonServiceAction,
  state: Awaited<ReturnType<DaemonServiceManager[DaemonServiceAction]>>["state"],
): 0 | 1 {
  if (action === "stop") return ["inactive", "not-installed"].includes(state) ? 0 : 1;
  if (action === "uninstall") return state === "not-installed" ? 0 : 1;
  return state === "active" ? 0 : 1;
}
