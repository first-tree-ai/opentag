import type { Command } from "commander";
import { formatComputerList, listComputers } from "../core/computer-list.js";

export function registerComputerCommand(program: Command): void {
  const computer = program.command("computer").description("Inspect Computers owned by the current user");
  computer
    .command("list")
    .description("List Computers")
    .action(async () => {
      process.stdout.write(`${formatComputerList(await listComputers())}\n`);
    });
}
