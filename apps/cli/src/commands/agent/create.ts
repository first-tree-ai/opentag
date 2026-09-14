import { type Command, Option } from "commander";
import { formatAgentCreated } from "../../core/agent/formatting.js";
import { runAgentCreate } from "../../core/agent/mutations.js";
import { executeCommand, redactSecrets } from "../../core/command/policy.js";

export function registerAgentCreateCommand(agent: Command): void {
  agent
    .command("create")
    .requiredOption("--name <name>", "canonical Agent name")
    .requiredOption("--display-name <display-name>", "human-facing Agent name")
    .requiredOption("--provider <provider>", "runtime provider: codex, claude-code, or pi")
    .option("--computer <uuid>", "Computer owned by this Account")
    .option("--model <model>", "exact model ID for the selected runtime")
    .option("--reasoning-effort <effort>", "reasoning effort for the selected runtime")
    .addOption(new Option("--instructions <text>", "Agent runtime instructions").conflicts("instructionsFile"))
    .addOption(
      new Option("--instructions-file <path>", "read Agent instructions from a UTF-8 file").conflicts("instructions"),
    )
    .option(
      "--max-duration-ms <integer>",
      "maximum duration of one Turn in milliseconds; omit to use the OpenTag default",
    )
    .option("--json", "print JSON")
    .action(async (options) => {
      process.exitCode = await executeCommand(
        async () => {
          const result = await runAgentCreate({
            name: options.name,
            displayName: options.displayName,
            runtimeProvider: options.provider,
            computerId: options.computer,
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            instructions: options.instructions,
            instructionsFile: options.instructionsFile,
            maxDurationMs: options.maxDurationMs,
          });
          if (result.warning) process.stderr.write(`${redactSecrets(result.warning)}\n`);
          return result;
        },
        { json: options.json === true, formatValue: formatAgentCreated, phase: "request" },
      );
    });
}
