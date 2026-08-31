import type { Command } from "commander";
import {
  formatFeishuSetup,
  formatImBinding,
  formatImBindingDiagnostics,
  runImBindingConnectFeishu,
  runImBindingDiagnose,
  runImBindingDisable,
  runImBindingShow,
  runReceiveModeSet,
} from "../../core/agent/im.js";
import { executeCommand } from "../../core/command/policy.js";

export function registerAgentImBindingCommands(agent: Command): void {
  const imBinding = agent.command("im").description("Manage an Agent IM binding");
  imBinding
    .command("show <agent-id>")
    .option("--json", "print JSON")
    .action(async (agentId, options: { json?: boolean }) => {
      process.exitCode = await executeCommand(() => runImBindingShow(agentId), {
        json: options.json === true,
        formatValue: formatImBinding,
        phase: "request",
      });
    });
  for (const [name, intent] of [
    ["connect-feishu", "create"],
    ["reauthorize-feishu", "reauthorize"],
  ] as const) {
    imBinding
      .command(`${name} <agent-id>`)
      .option("--json", "print JSON")
      .action(async (agentId, options: { json?: boolean }) => {
        process.exitCode = await executeCommand(() => runImBindingConnectFeishu(agentId, intent), {
          json: options.json === true,
          formatValue: formatFeishuSetup,
          phase: "request",
        });
      });
  }
  imBinding
    .command("diagnose <agent-id>")
    .option("--json", "print JSON")
    .action(async (agentId, options: { json?: boolean }) => {
      process.exitCode = await executeCommand(() => runImBindingDiagnose(agentId), {
        json: options.json === true,
        formatValue: formatImBindingDiagnostics,
        phase: "request",
      });
    });
  imBinding
    .command("disable <agent-id>")
    .option("--json", "print JSON")
    .action(async (agentId, options: { json?: boolean }) => {
      process.exitCode = await executeCommand(
        async () => {
          await runImBindingDisable(agentId);
          return `Disabled IM binding for Agent ${agentId}`;
        },
        { json: options.json === true, phase: "request" },
      );
    });

  const receiveMode = agent.command("receive-mode").description("Manage Agent IM receive mode");
  receiveMode
    .command("set <agent-id> <mode>")
    .option("--json", "print JSON")
    .action(async (agentId, mode, options: { json?: boolean }) => {
      if (mode !== "all-message" && mode !== "mention-only") {
        throw new Error("Receive mode must be all-message or mention-only");
      }
      process.exitCode = await executeCommand(
        async () => {
          const updated = await runReceiveModeSet(agentId, mode === "all-message" ? "all_message" : "mention_only");
          return `Updated Agent ${updated.id} receive mode to ${updated.receiveMode}`;
        },
        { json: options.json === true, phase: "validation" },
      );
    });
}
