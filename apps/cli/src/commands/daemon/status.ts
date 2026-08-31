import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonStatusCommand(daemon: Command): void {
  daemon
    .command("status")
    .description("Show daemon service status")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = options.json
        ? await executeDaemonServiceCommand("status", { json: true })
        : await executeDaemonServiceCommand("status");
    });
}
