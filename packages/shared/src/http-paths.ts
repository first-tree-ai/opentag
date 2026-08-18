export const API_V1_PREFIX = "/api/v1";

export const HTTP_PATHS = {
  authConnectExchange: `${API_V1_PREFIX}/auth/connect/exchange`,
  authRefresh: `${API_V1_PREFIX}/auth/refresh`,
  computerRuntimeWebSocket: `${API_V1_PREFIX}/computer/ws`,
  me: `${API_V1_PREFIX}/me`,
  meComputers: `${API_V1_PREFIX}/me/computers`,
} as const;

export function runtimeWebSocketUrl(serverUrl: string): string {
  const url = new URL(HTTP_PATHS.computerRuntimeWebSocket, serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
