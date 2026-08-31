import type { Command } from "commander";
import { formatAgentList } from "../../core/agent/formatting.js";
import { runAgentList } from "../../core/agent/queries.js";
import { executeCommand } from "../../core/command/policy.js";

export function registerAgentListCommand(agent: Command): void {
  agent
    .command("list")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }) => {
      process.exitCode = await executeCommand(() => runAgentList(), {
        json: options.json === true,
        formatValue: formatAgentList,
        phase: "request",
      });
    });
}
