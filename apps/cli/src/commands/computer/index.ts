import type { Command } from "commander";
import { registerComputerConnectCommand } from "./connect.js";
import { registerComputerListCommand } from "./list.js";

export function registerComputerCommand(program: Command): void {
  const computer = program.command("computer").description("Inspect Computers owned by the current user");
  registerComputerConnectCommand(computer);
  registerComputerListCommand(computer);
}
