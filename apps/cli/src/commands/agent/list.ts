import type { Command } from "commander";
import { formatAgentList } from "../../core/agent/formatting.js";
import { runAgentList } from "../../core/agent/queries.js";

export function registerAgentListCommand(agent: Command): void {
  agent
    .command("list")
    .option("--workspace <name>", "legacy internal scope name")
    .action(async (options) => {
      process.stdout.write(`${formatAgentList(await runAgentList({ workspaceName: options.workspace }))}\n`);
    });
}
