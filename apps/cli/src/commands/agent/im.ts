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

export function registerAgentImBindingCommands(agent: Command): void {
  const imBinding = agent.command("im").description("Manage an Agent IM binding");
  imBinding.command("show <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatImBinding(await runImBindingShow(agentId))}\n`);
  });
  imBinding.command("connect-feishu <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatFeishuSetup(await runImBindingConnectFeishu(agentId, "create"))}\n`);
  });
  imBinding.command("reauthorize-feishu <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatFeishuSetup(await runImBindingConnectFeishu(agentId, "reauthorize"))}\n`);
  });
  imBinding.command("diagnose <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatImBindingDiagnostics(await runImBindingDiagnose(agentId))}\n`);
  });
  imBinding.command("disable <agent-id>").action(async (agentId) => {
    await runImBindingDisable(agentId);
    process.stdout.write(`Disabled IM binding for Agent ${agentId}\n`);
  });

  const receiveMode = agent.command("receive-mode").description("Manage Agent IM receive mode");
  receiveMode.command("set <agent-id> <mode>").action(async (agentId, mode) => {
    if (mode !== "all-message" && mode !== "mention-only") {
      throw new Error("Receive mode must be all-message or mention-only");
    }
    const updated = await runReceiveModeSet(agentId, mode === "all-message" ? "all_message" : "mention_only");
    process.stdout.write(`Updated Agent ${updated.id} receive mode to ${updated.receiveMode}\n`);
  });
}
