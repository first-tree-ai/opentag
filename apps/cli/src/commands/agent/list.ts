import type { Command } from "commander";
import { formatAgentList } from "../../core/agent/formatting.js";
import { runAgentList } from "../../core/agent/queries.js";

export function registerAgentListCommand(agent: Command): void {
  agent
    .command("list")
    .option("--team <name>", "Team canonical name")
    .action(async (options) => {
      process.stdout.write(`${formatAgentList(await runAgentList({ teamName: options.team }))}\n`);
    });
}
