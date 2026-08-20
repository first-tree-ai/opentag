import { type Command, Option } from "commander";
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
    .option("--model <model>", "exact Codex model ID; effective Runtime Snapshots currently support Codex only")
    .option("--reasoning-effort <effort>", "Codex reasoning effort; effective Runtime Snapshots support Codex only")
    .addOption(new Option("--instructions <text>", "Agent runtime instructions").conflicts("instructionsFile"))
    .addOption(
      new Option("--instructions-file <path>", "read Agent instructions from a UTF-8 file").conflicts("instructions"),
    )
    .option("--allowed-tool <tool-id>", "allow an OpenTag runtime tool (repeatable)", collectValue)
    .option(
      "--max-duration-ms <integer>",
      "maximum duration of one Turn in milliseconds; omit to use the OpenTag default",
    )
    .action(async (options) => {
      const result = await runAgentCreate({
        name: options.name,
        displayName: options.displayName,
        runtimeProvider: options.provider,
        computerId: options.computer,
        teamName: options.team,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        instructions: options.instructions,
        instructionsFile: options.instructionsFile,
        allowedTools: options.allowedTool,
        maxDurationMs: options.maxDurationMs,
      });
      if (result.warning) process.stderr.write(`${result.warning}\n`);
      process.stdout.write(`${formatAgentCreated(result)}\n`);
    });
}

function collectValue(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}
