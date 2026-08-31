import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonInstallCommand(daemon: Command): void {
  daemon
    .command("install")
    .description("Install or update and start the daemon service")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = options.json
        ? await executeDaemonServiceCommand("installAndStart", { json: true })
        : await executeDaemonServiceCommand("installAndStart");
    });
}
