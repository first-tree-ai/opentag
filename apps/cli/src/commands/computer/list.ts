import type { Command } from "commander";
import { formatComputerList } from "../../core/computer/formatting.js";
import { listComputers } from "../../core/computer/queries.js";

export function registerComputerListCommand(computer: Command): void {
  computer
    .command("list")
    .description("List Computers")
    .option("--workspace <name-or-id>", "Workspace canonical name or UUID")
    .action(async (options) => {
      process.stdout.write(`${formatComputerList(await listComputers(options.workspace))}\n`);
    });
}
