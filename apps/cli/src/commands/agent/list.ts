import type { Command } from "commander";
import { formatAgentList } from "../../core/agent/formatting.js";
import { runAgentList } from "../../core/agent/queries.js";

export function registerAgentListCommand(agent: Command): void {
  agent.command("list").action(async () => {
    process.stdout.write(`${formatAgentList(await runAgentList())}\n`);
  });
}
