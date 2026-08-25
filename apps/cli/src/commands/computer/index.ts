import type { Command } from "commander";
import { registerComputerConnectCommand } from "./connect.js";
import { registerComputerListCommand } from "./list.js";

export function registerComputerCommand(program: Command): void {
  const computer = program.command("computer").description("Connect and inspect Workspace-enrolled Computers");
  registerComputerConnectCommand(computer);
  registerComputerListCommand(computer);
}
