import type { FeishuSetupAttempt, ImBindingAdminDetail, ImBindingDiagnostics, ReceiveMode } from "@opentag/shared";
import { type AgentCommandDependencies, resolveAgentCommandContext } from "./context.js";

export async function runImBindingShow(
  agentId: string,
  options: AgentCommandDependencies = {},
): Promise<ImBindingAdminDetail | undefined> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.getAgentImBindingConfig(accessToken, agentId);
}

export async function runImBindingConnectFeishu(
  agentId: string,
  intent: "create" | "reauthorize" | "replace",
  options: AgentCommandDependencies = {},
): Promise<FeishuSetupAttempt> {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.createFeishuSetupAttempt(accessToken, agentId, intent);
}

export async function runImBindingDiagnose(
  agentId: string,
  options: AgentCommandDependencies = {},
): Promise<ImBindingDiagnostics> {
  const imBinding = await runImBindingShow(agentId, options);
  if (!imBinding) throw new Error("The Agent has no IM binding");
  const { api, accessToken } = await resolveAgentCommandContext(options);
  return api.getImBindingDiagnostics(accessToken, imBinding.id);
}

export async function runImBindingDisable(agentId: string, options: AgentCommandDependencies = {}): Promise<void> {
  const imBinding = await runImBindingShow(agentId, options);
  if (!imBinding) return;
  const { api, accessToken } = await resolveAgentCommandContext(options);
  await api.disableImBinding(accessToken, imBinding.id);
}

export async function runReceiveModeSet(
  agentId: string,
  receiveMode: ReceiveMode,
  options: AgentCommandDependencies = {},
) {
  const { api, accessToken } = await resolveAgentCommandContext(options);
  const current = await api.getAgentConfig(accessToken, agentId);
  return api.updateAgent(accessToken, agentId, { expectedRevision: current.revision, receiveMode });
}

export function formatImBinding(summary: ImBindingAdminDetail | undefined): string {
  if (!summary) return "No IM binding configured";
  const identity =
    summary.identity.provider === "feishu"
      ? `${summary.identity.appId} · ${summary.identity.teamId ?? "external Team pending first event"}`
      : `${summary.identity.appId} · ${summary.identity.teamId} · ${summary.identity.botUserId}`;
  return [
    `provider\t${summary.provider}`,
    `identity\t${identity}`,
    `receiveMode\t${summary.receiveMode}`,
    `credentialGeneration\t${summary.credentialGeneration}`,
    `reauthorizationRequired\t${summary.reauthorizationRequired}`,
    `lastValidatedAt\t${summary.lastValidatedAt ?? "-"}`,
    `lastRuntimeObservationAt\t${summary.lastRuntimeObservationAt ?? "-"}`,
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

export function formatImBindingDiagnostics(value: ImBindingDiagnostics): string {
  return [
    `provider\t${value.provider}`,
    `ready\t${value.ready}`,
    `credentialGeneration\t${value.credentialGeneration}`,
    `credentialStatus\t${value.credentialStatus}`,
    `requiredCapabilities\t${value.requiredCapabilities.join(",") || "-"}`,
    `grantedCapabilities\t${value.grantedCapabilities.join(",") || "-"}`,
    `missingCapabilities\t${value.missingCapabilities.join(",") || "-"}`,
    `reauthorizationRequired\t${value.reauthorizationRequired}`,
    `slackAppIdEvidence\t${value.slackAppId ? `${value.slackAppId.value} (${value.slackAppId.evidence}; ingress match required)` : "-"}`,
    `slackIdentityClosure\t${value.slackIdentityClosure ? `${value.slackIdentityClosure.status}${value.slackIdentityClosure.verifiedAt ? ` (${value.slackIdentityClosure.verifiedAt})` : ""}` : "-"}`,
    `agentRuntimeReadiness\t${value.agentRuntimeReadiness}`,
    `providerCliReadiness\t${value.providerCliReadiness}`,
    `connection\t${value.connection ? `${value.connection.state} (observed ${value.connection.observedAt})` : "not applicable"}`,
    `lastInboundAt\t${value.lastInboundAt ?? "-"}`,
    `lastValidatedAt\t${value.lastValidatedAt ?? "-"}`,
    `lastRuntimeObservationAt\t${value.lastRuntimeObservationAt ?? "-"}`,
    `lastErrorCode\t${value.lastErrorCode ?? "-"}`,
  ].join("\n");
}
