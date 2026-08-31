import type { Command } from "commander";
import { formatAgentBound } from "../../core/agent/formatting.js";
import { runAgentBind } from "../../core/agent/mutations.js";

export function registerAgentBindCommand(agent: Command): void {
  agent
    .command("bind <agent-id>")
    .description("Bind an Agent to a Computer enrolled by this Account")
    .option("--computer <uuid>", "Computer enrolled by this Account")
    .action(async (agentId, options) => {
      const result = await runAgentBind(agentId, { computerId: options.computer });
      if (result.warning) process.stderr.write(`${result.warning}\n`);
      process.stdout.write(`${formatAgentBound(result)}\n`);
    });
}
