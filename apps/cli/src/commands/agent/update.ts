import { type Command, Option } from "commander";
import { formatAgent } from "../../core/agent/formatting.js";
import { runAgentUpdate } from "../../core/agent/mutations.js";

export function registerAgentUpdateCommand(agent: Command): void {
  agent
    .command("update <agent-id>")
    .option("--display-name <display-name>", "new human-facing Agent name")
    .addOption(new Option("--model <model>", "exact Provider-native model ID").conflicts("clearModel"))
    .addOption(new Option("--clear-model", "let the Provider manage model selection").conflicts("model"))
    .addOption(
      new Option("--reasoning-effort <effort>", "Provider-native reasoning effort").conflicts("clearReasoningEffort"),
    )
    .addOption(
      new Option("--clear-reasoning-effort", "let the Provider manage reasoning effort").conflicts("reasoningEffort"),
    )
    .addOption(new Option("--instructions <text>", "Agent runtime instructions").conflicts("instructionsFile"))
    .addOption(
      new Option("--instructions-file <path>", "read Agent instructions from a UTF-8 file").conflicts("instructions"),
    )
    .addOption(
      new Option("--allowed-tool <tool-id>", "allow an OpenTag runtime tool (repeatable)")
        .argParser(collectValue)
        .conflicts("clearAllowedTools"),
    )
    .addOption(new Option("--clear-allowed-tools", "clear the runtime tool allowlist").conflicts("allowedTool"))
    .addOption(
      new Option("--max-duration-ms <integer>", "maximum duration of one Turn in milliseconds").conflicts(
        "clearMaxDuration",
      ),
    )
    .addOption(new Option("--clear-max-duration", "use OpenTag's 30-minute Turn default").conflicts("maxDurationMs"))
    .action(async (agentId, options) => {
      process.stdout.write(
        `${formatAgent(
          await runAgentUpdate(agentId, {
            displayName: options.displayName,
            model: options.model,
            clearModel: options.clearModel,
            reasoningEffort: options.reasoningEffort,
            clearReasoningEffort: options.clearReasoningEffort,
            instructions: options.instructions,
            instructionsFile: options.instructionsFile,
            allowedTools: options.allowedTool,
            clearAllowedTools: options.clearAllowedTools,
            maxDurationMs: options.maxDurationMs,
            clearMaxDuration: options.clearMaxDuration,
          }),
        )}\n`,
      );
    });
}

function collectValue(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}
