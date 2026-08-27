import type { Command } from "commander";
import { formatComputerList } from "../../core/computer/formatting.js";
import { listComputers } from "../../core/computer/queries.js";

export function registerComputerListCommand(computer: Command): void {
  computer
    .command("list")
    .description("List Computers")
    .action(async () => {
      process.stdout.write(`${formatComputerList(await listComputers())}\n`);
    });
}
