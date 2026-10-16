import type { Command } from "commander";
import { runSlackAgentProvision } from "../../core/agent/slack-provision.js";
import { executeCommand } from "../../core/command/policy.js";

export function registerAgentSlackProvisionCommand(agent: Command): void {
  agent
    .command("provision-slack")
    .description(
      "Create an Agent and bind its independent Slack App with one Account operation code (managed Session only)",
    )
    .requiredOption(
      "--request-file <path>",
      "Agent creation JSON with a stable creationIntentId; uses the current Computer and default permissions/duration",
    )
    .requiredOption("--credentials-file <path>", "private Slack credentials JSON from the deploy hook")
    .option(
      "--code-file <path>",
      "private file containing the one-time operation code; omit to show the Account confirmation link without a request",
    )
    .option("--json", "print JSON")
    .addHelpText(
      "after",
      `
Example request-file JSON (replace the example UUID once for this operation):
{
  "creationIntentId": "2e33a796-16d0-44ec-9a15-f624b2f7ae72",
  "name": "helper",
  "displayName": "Helper",
  "runtimeProvider": "codex",
  "runtimeConfig": {
    "model": "gpt-6.1-sol",
    "reasoningEffort": "high",
    "instructions": "Help with the user's tasks."
  }
}
Use a provider and model supported by the target Computer. Cloud requires an
explicit runtimeConfig.model. Do not set computerId, permissions or maxDurationMs;
this operation uses the current Computer, source Agent Runtime Provider and default permissions/duration.
Keep the same creationIntentId and configuration when recovering this operation.
`,
    )
    .action(async (options) => {
      process.exitCode = await executeCommand(() => runSlackAgentProvision(options), {
        json: options.json === true,
        phase: "request",
        formatValue: (value) => JSON.stringify(value, null, 2),
      });
    });
}
