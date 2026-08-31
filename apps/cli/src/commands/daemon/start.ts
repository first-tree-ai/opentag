import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonStartCommand(daemon: Command): void {
  daemon
    .command("start")
    .description("Start the installed daemon service")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = options.json
        ? await executeDaemonServiceCommand("start", { json: true })
        : await executeDaemonServiceCommand("start");
    });
}
