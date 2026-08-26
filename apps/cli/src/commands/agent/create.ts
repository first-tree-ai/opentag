import { type Command, Option } from "commander";
import { formatAgentCreated } from "../../core/agent/formatting.js";
import { runAgentCreate } from "../../core/agent/mutations.js";

export function registerAgentCreateCommand(agent: Command): void {
  agent
    .command("create")
    .requiredOption("--name <name>", "canonical Agent name")
    .requiredOption("--display-name <display-name>", "human-facing Agent name")
    .requiredOption("--provider <provider>", "runtime provider: codex or claude-code")
    .option("--computer <uuid>", "Computer enrolled in the selected internal scope")
    .option("--workspace <name>", "legacy internal scope name")
    .option("--model <model>", "exact Codex model ID; effective Runtime Snapshots currently support Codex only")
    .option("--reasoning-effort <effort>", "Codex reasoning effort; effective Runtime Snapshots support Codex only")
    .addOption(new Option("--instructions <text>", "Agent runtime instructions").conflicts("instructionsFile"))
    .addOption(
      new Option("--instructions-file <path>", "read Agent instructions from a UTF-8 file").conflicts("instructions"),
    )
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
        workspaceName: options.workspace,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        instructions: options.instructions,
        instructionsFile: options.instructionsFile,
        maxDurationMs: options.maxDurationMs,
      });
      if (result.warning) process.stderr.write(`${result.warning}\n`);
      process.stdout.write(`${formatAgentCreated(result)}\n`);
    });
}
