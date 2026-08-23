export const API_V1_PREFIX = "/api/v1";
export const TEAMS_TEMPLATE = `${API_V1_PREFIX}/teams`;
export const TEAM_AGENTS_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId/agents`;
export const TEAM_BY_ID_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId`;
export const TEAM_SETUP_COMPLETE_TEMPLATE = `${TEAM_BY_ID_TEMPLATE}/setup/complete`;
export const AGENT_BY_ID_TEMPLATE = `${API_V1_PREFIX}/agents/:agentId`;
export const AGENT_CONFIG_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/config`;
export const AGENT_SUSPEND_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/suspend`;
export const AGENT_REACTIVATE_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/reactivate`;
export const AGENT_IM_BINDING_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding`;
export const AGENT_IM_BINDING_HANDOFF_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/handoff`;
export const AGENT_IM_BINDING_CONFIG_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/config`;
export const AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/feishu/setup-attempts`;
export const FEISHU_SETUP_ATTEMPT_TEMPLATE = `${API_V1_PREFIX}/im-bindings/feishu/setup-attempts/:attemptId`;
export const IM_BINDING_BY_ID_TEMPLATE = `${API_V1_PREFIX}/im-bindings/:imBindingId`;
export const IM_BINDING_DIAGNOSTICS_TEMPLATE = `${IM_BINDING_BY_ID_TEMPLATE}/diagnostics`;
export const SLACK_EVENTS_PATH = `${API_V1_PREFIX}/im-bindings/slack/events`;
export const RUNTIME_IM_RESOURCE_TEMPLATE = `${API_V1_PREFIX}/runtime/im-messages/:imMessageId/resources/:ordinal`;
export const TEAM_MEMBERS_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId/members`;
export const TEAM_MEMBERS_CONFIG_TEMPLATE = `${TEAM_MEMBERS_TEMPLATE}/config`;
export const TEAM_MEMBER_TEMPLATE = `${TEAM_MEMBERS_TEMPLATE}/:userId`;
export const TEAM_COMPUTERS_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId/computers`;
export const TEAM_COMPUTERS_CONFIG_TEMPLATE = `${TEAM_COMPUTERS_TEMPLATE}/config`;
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
  meConnectCodes: `${API_V1_PREFIX}/me/connect-codes`,
  teamAgents: TEAM_AGENTS_TEMPLATE,
  teams: TEAMS_TEMPLATE,
} as const;

export function teamMembersPath(teamId: string): string {
  return `${API_V1_PREFIX}/teams/${encodeURIComponent(teamId)}/members`;
}

export function teamByIdPath(teamId: string): string {
  return `${API_V1_PREFIX}/teams/${encodeURIComponent(teamId)}`;
}

export function teamSetupCompletePath(teamId: string): string {
  return `${teamByIdPath(teamId)}/setup/complete`;
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

export function agentConfigPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/config`;
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

export function teamMembersConfigPath(teamId: string): string {
  return `${teamMembersPath(teamId)}/config`;
}

export function teamComputersConfigPath(teamId: string): string {
  return `${teamComputersPath(teamId)}/config`;
}

export function agentFeishuSetupAttemptsPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/im-binding/feishu/setup-attempts`;
}

export function feishuSetupAttemptPath(attemptId: string): string {
  return `${API_V1_PREFIX}/im-bindings/feishu/setup-attempts/${encodeURIComponent(attemptId)}`;
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
