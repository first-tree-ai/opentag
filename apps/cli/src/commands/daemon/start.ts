import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonStartCommand(daemon: Command): void {
  daemon
    .command("start")
    .description("Start the installed daemon service")
    .action(async () => {
      process.exitCode = await executeDaemonServiceCommand("start");
    });
}
