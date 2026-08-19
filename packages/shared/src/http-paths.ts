export const API_V1_PREFIX = "/api/v1";
export const TEAM_AGENTS_TEMPLATE = `${API_V1_PREFIX}/teams/:teamId/agents`;
export const AGENT_BY_ID_TEMPLATE = `${API_V1_PREFIX}/agents/:agentId`;

export const HTTP_PATHS = {
  agentById: AGENT_BY_ID_TEMPLATE,
  authConnectExchange: `${API_V1_PREFIX}/auth/connect/exchange`,
  authRefresh: `${API_V1_PREFIX}/auth/refresh`,
  computerRuntimeWebSocket: `${API_V1_PREFIX}/computer/ws`,
  me: `${API_V1_PREFIX}/me`,
  meComputers: `${API_V1_PREFIX}/me/computers`,
  teamAgents: TEAM_AGENTS_TEMPLATE,
} as const;

export function teamAgentsPath(teamId: string): string {
  return `${API_V1_PREFIX}/teams/${encodeURIComponent(teamId)}/agents`;
}

export function agentByIdPath(agentId: string): string {
  return `${API_V1_PREFIX}/agents/${encodeURIComponent(agentId)}`;
}

export function runtimeWebSocketUrl(serverUrl: string): string {
  const url = new URL(HTTP_PATHS.computerRuntimeWebSocket, serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
