export const API_V1_PREFIX = "/api/v1";
export const TEAM_AGENTS_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId/agents`;
export const AGENT_BY_ID_TEMPLATE = `${API_V1_PREFIX}/agents/:agentId`;
export const AGENT_INTEGRATION_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/integration`;
export const AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/integrations/feishu/setup-attempts`;
export const FEISHU_SETUP_ATTEMPT_TEMPLATE = `${API_V1_PREFIX}/integrations/feishu/setup-attempts/:attemptId`;
export const INTEGRATION_BY_ID_TEMPLATE = `${API_V1_PREFIX}/integrations/:integrationId`;
export const INTEGRATION_DIAGNOSTICS_TEMPLATE = `${INTEGRATION_BY_ID_TEMPLATE}/diagnostics`;
export const SLACK_EVENTS_PATH = `${API_V1_PREFIX}/integrations/slack/events`;
export const RUNTIME_IM_RESOURCE_TEMPLATE = `${API_V1_PREFIX}/runtime/im-messages/:imMessageId/resources/:ordinal`;
export const TEAM_MEMBERS_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId/members`;
export const TEAM_MEMBER_TEMPLATE = `${TEAM_MEMBERS_TEMPLATE}/:userId`;
export const TEAM_COMPUTERS_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId/computers`;
export const TEAM_INVITATION_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId/invitation`;
export const INVITATION_PREVIEW_TEMPLATE = `${API_V1_PREFIX}/invitations/:token/preview`;
export const INVITATION_REDEEM_TEMPLATE = `${API_V1_PREFIX}/invitations/:token/redeem`;

export const HTTP_PATHS = {
  agentById: AGENT_BY_ID_TEMPLATE,
  slackEvents: SLACK_EVENTS_PATH,
  authConnectExchange: `${API_V1_PREFIX}/auth/connect/exchange`,
  authBrowserLogout: `${API_V1_PREFIX}/auth/browser/logout`,
  authBrowserRefresh: `${API_V1_PREFIX}/auth/browser/refresh`,
  authDevCallback: `${API_V1_PREFIX}/auth/dev/callback`,
  authGoogleCallback: `${API_V1_PREFIX}/auth/google/callback`,
  authGoogleStart: `${API_V1_PREFIX}/auth/google/start`,
  authProviders: `${API_V1_PREFIX}/auth/providers`,
  authRefresh: `${API_V1_PREFIX}/auth/refresh`,
  computerRuntimeWebSocket: `${API_V1_PREFIX}/computer/ws`,
  me: `${API_V1_PREFIX}/me`,
  meComputers: `${API_V1_PREFIX}/me/computers`,
  teamAgents: TEAM_AGENTS_TEMPLATE,
} as const;

export function teamMembersPath(teamId: string): string {
  return `${API_V1_PREFIX}/teams/${encodeURIComponent(teamId)}/members`;
}

export function teamMemberPath(teamId: string, userId: string): string {
  return `${teamMembersPath(teamId)}/${encodeURIComponent(userId)}`;
}

export function teamMemberRemovePath(teamId: string, userId: string): string {
  return `${teamMemberPath(teamId, userId)}/remove`;
}

export function teamMemberRestorePath(teamId: string, userId: string): string {
  return `${teamMemberPath(teamId, userId)}/restore`;
}

export function teamLeavePath(teamId: string): string {
  return `${API_V1_PREFIX}/teams/${encodeURIComponent(teamId)}/leave`;
}

export function teamComputersPath(teamId: string): string {
  return `${API_V1_PREFIX}/teams/${encodeURIComponent(teamId)}/computers`;
}

export function teamInvitationPath(teamId: string): string {
  return `${API_V1_PREFIX}/teams/${encodeURIComponent(teamId)}/invitation`;
}

export function teamInvitationRotatePath(teamId: string): string {
  return `${teamInvitationPath(teamId)}/rotate`;
}

export function invitationPreviewPath(token: string): string {
  return `${API_V1_PREFIX}/invitations/${encodeURIComponent(token)}/preview`;
}

export function invitationRedeemPath(token: string): string {
  return `${API_V1_PREFIX}/invitations/${encodeURIComponent(token)}/redeem`;
}

export function teamAgentsPath(teamId: string): string {
  return `${API_V1_PREFIX}/teams/${encodeURIComponent(teamId)}/agents`;
}

export function agentByIdPath(agentId: string): string {
  return `${API_V1_PREFIX}/agents/${encodeURIComponent(agentId)}`;
}

export function agentIntegrationPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/integration`;
}

export function agentFeishuSetupAttemptsPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/integrations/feishu/setup-attempts`;
}

export function feishuSetupAttemptPath(attemptId: string): string {
  return `${API_V1_PREFIX}/integrations/feishu/setup-attempts/${encodeURIComponent(attemptId)}`;
}

export function integrationDisablePath(integrationId: string): string {
  return `${API_V1_PREFIX}/integrations/${encodeURIComponent(integrationId)}/disable`;
}

export function integrationDiagnosticsPath(integrationId: string): string {
  return `${API_V1_PREFIX}/integrations/${encodeURIComponent(integrationId)}/diagnostics`;
}

export function runtimeImResourcePath(
  imMessageId: string,
  ordinal: number,
  input: { sessionId: string; computerId: string; instanceId: string; placementGeneration: number },
): string {
  const query = new URLSearchParams({
    sessionId: input.sessionId,
    computerId: input.computerId,
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
