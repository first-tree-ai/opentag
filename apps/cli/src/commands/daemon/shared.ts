import { resolveOpenTagHome } from "@opentag/client";
import {
  createDaemonServiceManager,
  type DaemonServiceManager,
  formatDaemonServiceInfo,
} from "../../core/daemon/service/index.js";
import { readUpdaterState } from "../../core/update/updater-state.js";

export type DaemonServiceAction = "installAndStart" | "restart" | "start" | "status" | "stop" | "uninstall";

/** Update-state lines for `daemon status`, read from the durable updater record when one exists. */
export function formatUpdateStatus(state: {
  currentVersion: string;
  state: string;
  target?: string;
  lastAttempt?: { target: string; startedAt: string; finishedAt?: string; result?: string; failureReason?: string };
}): string {
  const lines = [`Update current: ${state.currentVersion}`, `Update state: ${state.state}`];
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
  options: {
    manager?: DaemonServiceManager;
    writeError?: (message: string) => void;
    writeOutput?: (message: string) => void;
  } = {},
): Promise<0 | 1> {
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(`${message}\n`));
  try {
    const manager = options.manager ?? (await createDaemonServiceManager());
    const info = await manager[action]();
    writeOutput(formatDaemonServiceInfo(info));
    if (action === "status") {
      const update = await readUpdaterState(resolveOpenTagHome(process.env));
      if (update.status === "ok") writeOutput(formatUpdateStatus(update.state));
      else if (update.status === "invalid") {
        writeOutput("Update state: unknown (the updater state record is invalid; run the upgrade command)");
      }
    }
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
