import type { Command } from "commander";
import {
  formatFeishuSetup,
  formatIntegration,
  formatIntegrationDiagnostics,
  runIntegrationConnectFeishu,
  runIntegrationDiagnose,
  runIntegrationDisable,
  runIntegrationShow,
  runReceiveModeSet,
} from "../../core/agent/integration.js";

export function registerAgentIntegrationCommands(agent: Command): void {
  const integration = agent.command("integration").description("Manage an Agent IM Integration");
  integration.command("show <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatIntegration(await runIntegrationShow(agentId))}\n`);
  });
  integration.command("connect-feishu <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatFeishuSetup(await runIntegrationConnectFeishu(agentId, "create"))}\n`);
  });
  integration.command("reauthorize-feishu <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatFeishuSetup(await runIntegrationConnectFeishu(agentId, "reauthorize"))}\n`);
  });
  integration.command("diagnose <agent-id>").action(async (agentId) => {
    process.stdout.write(`${formatIntegrationDiagnostics(await runIntegrationDiagnose(agentId))}\n`);
  });
  integration.command("disable <agent-id>").action(async (agentId) => {
    await runIntegrationDisable(agentId);
    process.stdout.write(`Disabled IM Integration for Agent ${agentId}\n`);
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
