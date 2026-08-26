import type { Command } from "commander";
import { registerAgentCreateCommand } from "./create.js";
import { registerAgentDeleteCommand } from "./delete.js";
import { registerAgentImBindingCommands } from "./im.js";
import { registerAgentLifecycleCommands } from "./lifecycle.js";
import { registerAgentListCommand } from "./list.js";
import { registerAgentShowCommand } from "./show.js";
import { registerAgentUpdateCommand } from "./update.js";

export function registerAgentCommand(program: Command): void {
  const agent = program.command("agent").description("Manage Agents available to the current Account");
  registerAgentCreateCommand(agent);
  registerAgentListCommand(agent);
  registerAgentShowCommand(agent);
  registerAgentUpdateCommand(agent);
  registerAgentLifecycleCommands(agent);
  registerAgentDeleteCommand(agent);
  registerAgentImBindingCommands(agent);
}
