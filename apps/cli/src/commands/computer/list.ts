import type { Command } from "commander";
import { executeCommand } from "../../core/command/policy.js";
import { formatComputerList } from "../../core/computer/formatting.js";
import { listComputers } from "../../core/computer/queries.js";

export function registerComputerListCommand(computer: Command): void {
  computer
    .command("list")
    .description("List Computers")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = await executeCommand(() => listComputers(), {
        json: options.json === true,
        formatValue: formatComputerList,
        phase: "request",
      });
    });
}
