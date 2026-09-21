import { type Command, Option } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import { runAgentUpdate } from "../../core/agent/mutations.js";
import { executeCommand } from "../../core/command/policy.js";

export function registerAgentUpdateCommand(agent: Command): void {
  agent
    .command("update <agent-id>")
    .option("--display-name <display-name>", "new human-facing Agent name")
    .addOption(new Option("--model <model>", "exact model ID for the selected runtime").conflicts("clearModel"))
    .addOption(new Option("--clear-model", "let the runtime manage model selection").conflicts("model"))
    .addOption(
      new Option("--reasoning-effort <effort>", "reasoning effort for the selected runtime").conflicts(
        "clearReasoningEffort",
      ),
    )
    .addOption(
      new Option("--clear-reasoning-effort", "let the runtime manage reasoning effort").conflicts("reasoningEffort"),
    )
    .addOption(new Option("--instructions <text>", "Agent runtime instructions").conflicts("instructionsFile"))
    .addOption(
      new Option("--instructions-file <path>", "read Agent instructions from a UTF-8 file").conflicts("instructions"),
    )
    .addOption(
      new Option("--max-duration-ms <integer>", "maximum duration of one Turn in milliseconds").conflicts(
        "clearMaxDuration",
      ),
    )
    .addOption(new Option("--clear-max-duration", "use the OpenTag default Turn duration").conflicts("maxDurationMs"))
    .option("--json", "print JSON")
    .action(async (agentId, options) => {
      process.exitCode = await executeCommand(
        () =>
          runAgentUpdate(agentId, {
            displayName: options.displayName,
            model: options.model,
            clearModel: options.clearModel,
            reasoningEffort: options.reasoningEffort,
            clearReasoningEffort: options.clearReasoningEffort,
            instructions: options.instructions,
            instructionsFile: options.instructionsFile,
            maxDurationMs: options.maxDurationMs,
            clearMaxDuration: options.clearMaxDuration,
          }),
        { json: options.json === true, formatValue: formatAgent, phase: "request" },
      );
    });
}
