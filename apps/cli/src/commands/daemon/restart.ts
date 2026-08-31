import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonRestartCommand(daemon: Command): void {
  daemon
    .command("restart")
    .description("Restart the installed daemon service")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = options.json
        ? await executeDaemonServiceCommand("restart", { json: true })
        : await executeDaemonServiceCommand("restart");
    });
}
