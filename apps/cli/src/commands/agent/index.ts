import type { Command } from "commander";
import { registerAgentCreateCommand } from "./create.js";
import { registerAgentDeleteCommand } from "./delete.js";
import { registerAgentIntegrationCommands } from "./integration.js";
import { registerAgentListCommand } from "./list.js";
import { registerAgentShowCommand } from "./show.js";
import { registerAgentUpdateCommand } from "./update.js";

export function registerAgentCommand(program: Command): void {
  const agent = program.command("agent").description("Manage Team Agents");
  registerAgentCreateCommand(agent);
  registerAgentListCommand(agent);
  registerAgentShowCommand(agent);
  registerAgentUpdateCommand(agent);
  registerAgentDeleteCommand(agent);
  registerAgentIntegrationCommands(agent);
}
