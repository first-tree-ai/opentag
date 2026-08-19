import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonRestartCommand(daemon: Command): void {
  daemon
    .command("restart")
    .description("Restart the installed daemon service")
    .action(async () => {
      process.exitCode = await executeDaemonServiceCommand("restart");
    });
}
