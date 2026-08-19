import type { Command } from "commander";
import { formatAgentCreated } from "../../core/agent/formatting.js";
import { runAgentCreate } from "../../core/agent/mutations.js";

export function registerAgentCreateCommand(agent: Command): void {
  agent
    .command("create")
    .requiredOption("--name <name>", "canonical Agent name")
    .requiredOption("--display-name <display-name>", "human-facing Agent name")
    .requiredOption("--provider <provider>", "runtime provider: codex or claude-code")
    .option("--computer <uuid>", "Computer owned by the current user")
    .option("--team <name>", "Team canonical name")
    .action(async (options) => {
      const result = await runAgentCreate({
        name: options.name,
        displayName: options.displayName,
        runtimeProvider: options.provider,
        computerId: options.computer,
        teamName: options.team,
      });
      if (result.warning) process.stderr.write(`${result.warning}\n`);
      process.stdout.write(`${formatAgentCreated(result)}\n`);
    });
}
