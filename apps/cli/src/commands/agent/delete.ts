import type { Command } from "commander";
import { runAgentDelete } from "../../core/agent/mutations.js";
import { executeCommand } from "../../core/command/policy.js";

export function registerAgentDeleteCommand(agent: Command): void {
  agent
    .command("delete <agent-id>")
    .option("--json", "print JSON")
    .action(async (agentId, options: { json?: boolean }) => {
      process.exitCode = await executeCommand(() => runAgentDelete(agentId), {
        json: options.json === true,
        phase: "request",
      });
    });
}
