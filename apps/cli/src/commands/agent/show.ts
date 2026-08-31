import type { Command } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import { runAgentShow } from "../../core/agent/queries.js";
import { executeCommand } from "../../core/command/policy.js";

export function registerAgentShowCommand(agent: Command): void {
  agent
    .command("show <agent-id>")
    .option("--json", "print JSON")
    .action(async (agentId, options: { json?: boolean }) => {
      process.exitCode = await executeCommand(() => runAgentShow(agentId), {
        json: options.json === true,
        formatValue: formatAgent,
        phase: "request",
      });
    });
}
