import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonUninstallCommand(daemon: Command): void {
  daemon
    .command("uninstall")
    .description("Remove the daemon service while preserving local data")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = options.json
        ? await executeDaemonServiceCommand("uninstall", { json: true })
        : await executeDaemonServiceCommand("uninstall");
    });
}
