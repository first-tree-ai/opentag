export const API_V1_PREFIX = "/api/v1";
export const WORKSPACE_AGENTS_TEMPLATE = `${API_V1_PREFIX}/workspaces/:workspaceId/agents`;
const WORKSPACE_BY_ID_TEMPLATE = `${API_V1_PREFIX}/workspaces/:workspaceId`;
export const WORKSPACE_SETUP_COMPLETE_TEMPLATE = `${WORKSPACE_BY_ID_TEMPLATE}/setup/complete`;
export const AGENT_BY_ID_TEMPLATE = `${API_V1_PREFIX}/agents/:agentId`;
export const AGENT_CONFIG_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/config`;
export const AGENT_USAGE_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/usage`;
export const AGENT_SUSPEND_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/suspend`;
export const AGENT_REACTIVATE_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/reactivate`;
export const AGENT_IM_BINDING_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding`;
export const AGENT_IM_BINDING_HANDOFF_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/handoff`;
export const AGENT_IM_BINDING_CONFIG_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/config`;
export const AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/feishu/setup-attempts`;
export const FEISHU_SETUP_ATTEMPT_TEMPLATE = `${API_V1_PREFIX}/im-bindings/feishu/setup-attempts/:attemptId`;
export const AGENT_SLACK_CONFIGURATION_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/slack/configuration`;
export const AGENT_SLACK_EVENTS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/slack/events`;
export const IM_BINDING_BY_ID_TEMPLATE = `${API_V1_PREFIX}/im-bindings/:imBindingId`;
export const IM_BINDING_DIAGNOSTICS_TEMPLATE = `${IM_BINDING_BY_ID_TEMPLATE}/diagnostics`;
export const SLACK_EVENTS_PATH = `${API_V1_PREFIX}/im-bindings/slack/events`;
export const RUNTIME_IM_RESOURCE_TEMPLATE = `${API_V1_PREFIX}/runtime/im-messages/:imMessageId/resources/:ordinal`;
export const WORKSPACE_COMPUTERS_TEMPLATE = `${API_V1_PREFIX}/workspaces/:workspaceId/computers`;
export const WORKSPACE_COMPUTER_CONNECT_CODES_TEMPLATE = `${WORKSPACE_BY_ID_TEMPLATE}/computer-connect-codes`;

export const HTTP_PATHS = {
  agentById: AGENT_BY_ID_TEMPLATE,
  slackEvents: SLACK_EVENTS_PATH,
  authConnectExchange: `${API_V1_PREFIX}/auth/connect/exchange`,
  computerConnectExchange: `${API_V1_PREFIX}/computer/connect/exchange`,
  authBrowserLogout: `${API_V1_PREFIX}/auth/browser/logout`,
  authBrowserRefresh: `${API_V1_PREFIX}/auth/browser/refresh`,
  authDevCallback: `${API_V1_PREFIX}/auth/dev/callback`,
  authGoogleCallback: `${API_V1_PREFIX}/auth/google/callback`,
  authGoogleStart: `${API_V1_PREFIX}/auth/google/start`,
  authProviders: `${API_V1_PREFIX}/auth/providers`,
  authRefresh: `${API_V1_PREFIX}/auth/refresh`,
  computerRuntimeWebSocket: `${API_V1_PREFIX}/computer/ws`,
  me: `${API_V1_PREFIX}/me`,
  meConnectCodes: `${API_V1_PREFIX}/me/connect-codes`,
  workspaceAgents: WORKSPACE_AGENTS_TEMPLATE,
} as const;

export function workspaceSetupCompletePath(workspaceId: string): string {
  return `${API_V1_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/setup/complete`;
}

export function workspaceComputersPath(workspaceId: string): string {
  return `${API_V1_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/computers`;
}

export function workspaceComputerConnectCodesPath(workspaceId: string): string {
  return `${API_V1_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/computer-connect-codes`;
}

export function workspaceAgentsPath(workspaceId: string): string {
  return `${API_V1_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/agents`;
}

export function agentByIdPath(agentId: string): string {
  return `${API_V1_PREFIX}/agents/${encodeURIComponent(agentId)}`;
}

export function agentConfigPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/config`;
}

export function agentUsagePath(agentId: string, windowDays: number): string {
  const query = new URLSearchParams({ days: String(windowDays) });
  return `${agentByIdPath(agentId)}/usage?${query.toString()}`;
}

export function agentSuspendPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/suspend`;
}

export function agentReactivatePath(agentId: string): string {
  return `${agentByIdPath(agentId)}/reactivate`;
}

export function agentImBindingPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/im-binding`;
}

export function agentImBindingHandoffPath(agentId: string): string {
  return `${agentImBindingPath(agentId)}/handoff`;
}

export function agentImBindingConfigPath(agentId: string): string {
  return `${agentImBindingPath(agentId)}/config`;
}

export function agentFeishuSetupAttemptsPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/im-binding/feishu/setup-attempts`;
}

export function feishuSetupAttemptPath(attemptId: string): string {
  return `${API_V1_PREFIX}/im-bindings/feishu/setup-attempts/${encodeURIComponent(attemptId)}`;
}

export function agentSlackConfigurationPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/im-binding/slack/configuration`;
}

export function agentSlackEventsPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/im-binding/slack/events`;
}

export function imBindingDisablePath(imBindingId: string): string {
  return `${API_V1_PREFIX}/im-bindings/${encodeURIComponent(imBindingId)}/disable`;
}

export function imBindingDiagnosticsPath(imBindingId: string): string {
  return `${API_V1_PREFIX}/im-bindings/${encodeURIComponent(imBindingId)}/diagnostics`;
}

export function runtimeImResourcePath(
  imMessageId: string,
  ordinal: number,
  input: { sessionId: string; instanceId: string; placementGeneration: number },
): string {
  const query = new URLSearchParams({
    sessionId: input.sessionId,
    instanceId: input.instanceId,
    placementGeneration: String(input.placementGeneration),
  });
  return `${API_V1_PREFIX}/runtime/im-messages/${encodeURIComponent(imMessageId)}/resources/${ordinal}?${query.toString()}`;
}

export function runtimeWebSocketUrl(serverUrl: string): string {
  const url = new URL(HTTP_PATHS.computerRuntimeWebSocket, serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
