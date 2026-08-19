import type { Command } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import { runAgentShow } from "../../core/agent/queries.js";

export function registerAgentShowCommand(agent: Command): void {
  agent.command("show <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatAgent(await runAgentShow(agentId))}\n`);
  });
}
