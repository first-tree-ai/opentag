import type { Command } from "commander";
import { formatAgentCreated, runAgentCreate } from "../core/agent-create.js";
import { runAgentDelete } from "../core/agent-delete.js";
import { formatAgentList, runAgentList } from "../core/agent-list.js";
import { formatAgent, runAgentShow } from "../core/agent-show.js";
import { runAgentUpdate } from "../core/agent-update.js";

export function registerAgentCommand(program: Command): void {
  const agent = program.command("agent").description("Manage Team Agents");

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

  agent
    .command("list")
    .option("--team <name>", "Team canonical name")
    .action(async (options) => {
      process.stdout.write(`${formatAgentList(await runAgentList({ teamName: options.team }))}\n`);
    });

  agent.command("show <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatAgent(await runAgentShow(agentId))}\n`);
  });

  agent
    .command("update <agent-id>")
    .requiredOption("--display-name <display-name>", "new human-facing Agent name")
    .action(async (agentId, options) => {
      process.stdout.write(`${formatAgent(await runAgentUpdate(agentId, { displayName: options.displayName }))}\n`);
    });

  agent.command("delete <agent-id>").action(async (agentId) => {
    process.stdout.write(`${await runAgentDelete(agentId)}\n`);
  });
}
