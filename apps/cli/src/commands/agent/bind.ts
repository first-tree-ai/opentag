import type { Command } from "commander";
import { formatAgentBound } from "../../core/agent/formatting.js";
import { runAgentBind } from "../../core/agent/mutations.js";
import { executeCommand, redactSecrets } from "../../core/command/policy.js";

export function registerAgentBindCommand(agent: Command): void {
  agent
    .command("bind <agent-id>")
    .description("Bind an Agent to a Computer enrolled by this Account")
    .option("--computer <uuid>", "Computer enrolled by this Account")
    .option("--json", "print JSON")
    .action(async (agentId, options) => {
      process.exitCode = await executeCommand(
        async () => {
          const result = await runAgentBind(agentId, { computerId: options.computer });
          if (result.warning) process.stderr.write(`${redactSecrets(result.warning)}\n`);
          return result;
        },
        { json: options.json === true, formatValue: formatAgentBound, phase: "request" },
      );
    });
}
