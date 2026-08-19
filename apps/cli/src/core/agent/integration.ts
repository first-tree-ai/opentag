import type { FeishuSetupAttempt, IntegrationDiagnostics, IntegrationSummary, ReceiveMode } from "@opentag/shared";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./context.js";

export async function runIntegrationShow(
  agentId: string,
  options: AgentCommandDependencies = {},
): Promise<IntegrationSummary | undefined> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.getAgentIntegration(accessToken, agentId);
}

export async function runIntegrationConnectFeishu(
  agentId: string,
  intent: "create" | "reauthorize" | "replace",
  options: AgentCommandDependencies = {},
): Promise<FeishuSetupAttempt> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.createFeishuSetupAttempt(accessToken, agentId, intent);
}

export async function runIntegrationDiagnose(
  agentId: string,
  options: AgentCommandDependencies = {},
): Promise<IntegrationDiagnostics> {
  const integration = await runIntegrationShow(agentId, options);
  if (!integration) throw new Error("The Agent has no IM Integration");
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.getIntegrationDiagnostics(accessToken, integration.integration.id);
}

export async function runIntegrationDisable(agentId: string, options: AgentCommandDependencies = {}): Promise<void> {
  const integration = await runIntegrationShow(agentId, options);
  if (!integration) return;
  const { api, accessToken } = await resolveAgentCommandContext(options);
  await api.disableIntegration(accessToken, integration.integration.id);
}

export async function runReceiveModeSet(
  agentId: string,
  receiveMode: ReceiveMode,
  options: AgentCommandDependencies = {},
) {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const current = await api.getAgent(accessToken, agentId);
  return api.updateAgent(accessToken, agentId, { expectedRevision: current.revision, receiveMode });
}

export function formatIntegration(summary: IntegrationSummary | undefined): string {
  if (!summary) return "No IM Integration configured";
  const identity =
    summary.identity.provider === "feishu"
      ? `${summary.identity.appId} · ${summary.identity.tenantKey ?? "tenant pending first event"}`
      : `${summary.identity.appId} · ${summary.identity.teamId} · ${summary.identity.botUserId}`;
  return [
    `provider\t${summary.integration.provider}`,
    `identity\t${identity}`,
    `receiveMode\t${summary.receiveMode}`,
    `credentialGeneration\t${summary.credentialGeneration}`,
    `reauthorizationRequired\t${summary.reauthorizationRequired}`,
    `disabledAt\t${summary.integration.disabledAt ?? "-"}`,
  ].join("\n");
}

export function formatFeishuSetup(attempt: FeishuSetupAttempt): string {
  return [
    `attemptId\t${attempt.id}`,
    `state\t${attempt.state}`,
    `qrUrl\t${attempt.qrUrl ?? "-"}`,
    `expiresAt\t${attempt.expiresAt}`,
    `errorCode\t${attempt.errorCode ?? "-"}`,
  ].join("\n");
}

export function formatIntegrationDiagnostics(value: IntegrationDiagnostics): string {
  return [
    `provider\t${value.provider}`,
    `ready\t${value.ready}`,
    `credentialGeneration\t${value.credentialGeneration}`,
    `reauthorizationRequired\t${value.reauthorizationRequired}`,
    `connection\t${value.connection ? `${value.connection.state} (observed ${value.connection.observedAt})` : "not applicable"}`,
    `lastInboundAt\t${value.lastInboundAt ?? "-"}`,
    `lastOutboundAt\t${value.lastOutboundAt ?? "-"}`,
    `lastErrorCode\t${value.lastErrorCode ?? "-"}`,
  ].join("\n");
}
