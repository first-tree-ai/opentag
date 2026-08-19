import type { Command } from "commander";
import { runAgentDelete } from "../../core/agent/mutations.js";

export function registerAgentDeleteCommand(agent: Command): void {
  agent.command("delete <agent-id>").action(async (agentId) => {
    process.stdout.write(`${await runAgentDelete(agentId)}\n`);
  });
}
