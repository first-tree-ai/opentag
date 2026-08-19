import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonUninstallCommand(daemon: Command): void {
  daemon
    .command("uninstall")
    .description("Remove the daemon service while preserving local data")
    .action(async () => {
      process.exitCode = await executeDaemonServiceCommand("uninstall");
    });
}
