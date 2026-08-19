import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonStatusCommand(daemon: Command): void {
  daemon
    .command("status")
    .description("Show daemon service status")
    .action(async () => {
      process.exitCode = await executeDaemonServiceCommand("status");
    });
}
