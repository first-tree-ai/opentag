import type { Command } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import { runAgentReactivate, runAgentSuspend } from "../../core/agent/mutations.js";
import { executeCommand } from "../../core/command/policy.js";

export function registerAgentLifecycleCommands(agent: Command): void {
  for (const [name, run] of [
    ["suspend", runAgentSuspend],
    ["reactivate", runAgentReactivate],
  ] as const) {
    agent
      .command(`${name} <agent-id>`)
      .option("--json", "print JSON")
      .action(async (agentId, options: { json?: boolean }) => {
        process.exitCode = await executeCommand(() => run(agentId), {
          json: options.json === true,
          formatValue: formatAgent,
          phase: "request",
        });
      });
  }
}
