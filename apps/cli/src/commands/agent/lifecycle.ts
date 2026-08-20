import type { Command } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import { runAgentReactivate, runAgentSuspend } from "../../core/agent/mutations.js";

export function registerAgentLifecycleCommands(agent: Command): void {
  agent.command("suspend <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatAgent(await runAgentSuspend(agentId))}\n`);
  });
  agent.command("reactivate <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatAgent(await runAgentReactivate(agentId))}\n`);
  });
}
