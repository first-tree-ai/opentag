import type { Command } from "commander";
import { type CommandExitCode, commandExitCode, presentCommand, toCommandError } from "../../core/command/policy.js";
import {
  createDaemonServiceManager,
  type DaemonServiceManager,
  formatDaemonServiceInfo,
} from "../../core/daemon/service/index.js";

/**
 * `daemon refresh-service` (hidden) — rewrite the platform supervisor definition using the current
 * binary's templates without restarting the daemon.
 *
 * This is the portable upgrade's service-refresh step: after the new version is live behind the
 * stable shim, the running daemon invokes this command through the shim, so the definition the
 * supervisor reloads comes from the newly installed binary. The reserved exit-code handoff owns the
 * actual restart; this command must never trigger one itself.
 */
export async function executeDaemonRefreshService(
  options: {
    manager?: Pick<DaemonServiceManager, "refreshDefinition">;
    writeError?: (message: string) => void;
    writeOutput?: (message: string) => void;
  } = {},
): Promise<CommandExitCode> {
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(`${message}\n`));
  const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
  try {
    const manager = options.manager ?? (await createDaemonServiceManager());
    const info = await manager.refreshDefinition();
    writeOutput(formatDaemonServiceInfo(info));
    return 0;
  } catch (error) {
    const commandError = toCommandError(error, "request");
    return presentCommand(
      { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
      { stderr: writeError },
    );
  }
}

export function registerDaemonRefreshServiceCommand(daemon: Command): void {
  daemon
    .command("refresh-service", { hidden: true })
    .description("Rewrite the daemon service definition from the current binary without restarting (internal)")
    .action(async () => {
      process.exitCode = await executeDaemonRefreshService();
    });
}
