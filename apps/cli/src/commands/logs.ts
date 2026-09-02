import type { Command } from "commander";
import { executeCommand } from "../core/command/policy.js";
import { formatLogs, runLogs } from "../core/diagnostics/logs.js";

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Bundle local Client logs and a safe environment summary")
    .option("--home <path>", "OpenTag home directory")
    .option("--json", "print JSON")
    .action(async (options: { home?: string; json?: boolean }) => {
      process.exitCode = await executeCommand(() => runLogs({ home: options.home }), {
        json: options.json === true,
        formatValue: formatLogs,
        phase: "request",
      });
    });
}
