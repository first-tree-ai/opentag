import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonInstallCommand(daemon: Command): void {
  daemon
    .command("install")
    .description("Install or update and start the daemon service")
    .action(async () => {
      process.exitCode = await executeDaemonServiceCommand("installAndStart");
    });
}
