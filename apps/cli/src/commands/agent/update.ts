import type { Command } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import { runAgentUpdate } from "../../core/agent/mutations.js";

export function registerAgentUpdateCommand(agent: Command): void {
  agent
    .command("update <agent-id>")
    .requiredOption("--display-name <display-name>", "new human-facing Agent name")
    .action(async (agentId, options) => {
      process.stdout.write(`${formatAgent(await runAgentUpdate(agentId, { displayName: options.displayName }))}\n`);
    });
}
