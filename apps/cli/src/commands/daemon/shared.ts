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
  } = {},
): Promise<0 | 1> {
  try {
    const manager = options.manager ?? (await createDaemonServiceManager());
    const info = await manager[action]();
    (options.writeOutput ?? ((message) => process.stdout.write(`${message}\n`)))(formatDaemonServiceInfo(info));
    if (action === "status") return info.state === "active" ? 0 : 1;
    if (["installAndStart", "restart", "start"].includes(action)) return info.state === "active" ? 0 : 1;
    if (action === "stop") return ["inactive", "not-installed"].includes(info.state) ? 0 : 1;
    return info.state === "not-installed" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.writeError ?? ((value) => process.stderr.write(`${value}\n`)))(message);
    return 1;
  }
}
