import type { Command } from "commander";
import { executeDaemonServiceCommand } from "./shared.js";

export function registerDaemonStopCommand(daemon: Command): void {
  daemon
    .command("stop")
    .description("Stop the daemon service")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = options.json
        ? await executeDaemonServiceCommand("stop", { json: true })
        : await executeDaemonServiceCommand("stop");
    });
}
