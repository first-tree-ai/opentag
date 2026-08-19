import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonStopCommand(daemon: Command): void {
  daemon
    .command("stop")
    .description("Stop the daemon service")
    .action(async () => {
      process.exitCode = await executeDaemonServiceCommand("stop");
    });
}
