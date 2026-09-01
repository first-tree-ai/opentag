export const API_V1_PREFIX = "/api/v1";
export const AGENT_BY_ID_TEMPLATE = `${API_V1_PREFIX}/agents/:agentId`;
export const AGENT_CONFIG_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/config`;
export const AGENT_RUNTIME_TEST_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/runtime-test`;
export const AGENT_USAGE_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/usage`;
export const AGENT_SUSPEND_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/suspend`;
export const AGENT_REACTIVATE_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/reactivate`;
export const AGENT_COMPUTER_REBIND_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/computer/rebind`;
export const AGENT_IM_BINDING_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding`;
export const AGENT_IM_BINDING_HANDOFF_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/handoff`;
export const AGENT_IM_BINDING_CONFIG_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/config`;
export const AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/feishu/setup-attempts`;
export const FEISHU_SETUP_ATTEMPT_TEMPLATE = `${API_V1_PREFIX}/im-bindings/feishu/setup-attempts/:attemptId`;
export const AGENT_SLACK_OAUTH_START_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/slack/oauth/start`;
export const AGENT_SLACK_EVENTS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/slack/events`;
export const IM_BINDING_BY_ID_TEMPLATE = `${API_V1_PREFIX}/im-bindings/:imBindingId`;
export const IM_BINDING_DIAGNOSTICS_TEMPLATE = `${IM_BINDING_BY_ID_TEMPLATE}/diagnostics`;
export const SLACK_EVENTS_PATH = `${API_V1_PREFIX}/im-bindings/slack/events`;
export const SLACK_OAUTH_CALLBACK_PATH = `${API_V1_PREFIX}/im-bindings/slack/oauth/callback`;
export const RUNTIME_IM_RESOURCE_TEMPLATE = `${API_V1_PREFIX}/runtime/im-messages/:imMessageId/resources/:ordinal`;
export const RUNTIME_INTERNAL_SESSIONS_PATH = `${API_V1_PREFIX}/runtime/sessions/internal`;
export const RUNTIME_SESSION_MESSAGES_PATH = `${API_V1_PREFIX}/runtime/session-messages`;
export const RUNTIME_SESSIONS_PATH = `${API_V1_PREFIX}/runtime/sessions`;
export const RUNTIME_DURABLE_WORK_PATH = `${API_V1_PREFIX}/runtime/durable-work`;
/**
 * Account-native management collections. Ownership comes only from the authenticated Account.
 */
export const ACCOUNT_AGENTS_PATH = `${API_V1_PREFIX}/agents`;
export const ACCOUNT_COMPUTERS_PATH = `${API_V1_PREFIX}/computers`;
export const ACCOUNT_COMPUTER_BY_ID_TEMPLATE = `${ACCOUNT_COMPUTERS_PATH}/:computerId`;
export const ACCOUNT_COMPUTER_CONNECT_CODES_PATH = `${API_V1_PREFIX}/computer-connect-codes`;
export const ACCOUNT_COMPUTER_CONNECT_CODE_TEMPLATE = `${ACCOUNT_COMPUTER_CONNECT_CODES_PATH}/:connectCodeId`;
export const ACCOUNT_SETUP_COMPLETE_PATH = `${API_V1_PREFIX}/me/setup/complete`;
export const ACCOUNT_SETUP_RESET_PATH = `${API_V1_PREFIX}/me/setup/reset`;
export const ACCOUNT_TASKS_PATH = `${API_V1_PREFIX}/sessions`;
export const TASK_BY_ID_TEMPLATE = `${ACCOUNT_TASKS_PATH}/:sessionId`;

export const HTTP_PATHS = {
  accountAgents: ACCOUNT_AGENTS_PATH,
  accountComputerConnectCodes: ACCOUNT_COMPUTER_CONNECT_CODES_PATH,
  accountComputers: ACCOUNT_COMPUTERS_PATH,
  accountSetupComplete: ACCOUNT_SETUP_COMPLETE_PATH,
  accountSetupReset: ACCOUNT_SETUP_RESET_PATH,
  accountTasks: ACCOUNT_TASKS_PATH,
  agentById: AGENT_BY_ID_TEMPLATE,
  slackEvents: SLACK_EVENTS_PATH,
  slackOAuthCallback: SLACK_OAUTH_CALLBACK_PATH,
  authConnectExchange: `${API_V1_PREFIX}/auth/connect/exchange`,
  computerConnectExchange: `${API_V1_PREFIX}/computer/connect/exchange`,
  authBrowserLogout: `${API_V1_PREFIX}/auth/browser/logout`,
  authDevCallback: `${API_V1_PREFIX}/auth/dev/callback`,
  /*
   * Below `/auth/email/` rather than Better Auth's own `/sign-in/email`, so these stay OpenTag routes that call into
   * the library server-side. Nothing under the base path is published except the OAuth callback.
   */
  authEmailSignIn: `${API_V1_PREFIX}/auth/email/sign-in`,
  authEmailSignUp: `${API_V1_PREFIX}/auth/email/sign-up`,
  authGoogleStart: `${API_V1_PREFIX}/auth/google/start`,
  authProviders: `${API_V1_PREFIX}/auth/providers`,
  authRefresh: `${API_V1_PREFIX}/auth/refresh`,
  computerRuntimeWebSocket: `${API_V1_PREFIX}/computer/ws`,
  runtimeInternalSessions: RUNTIME_INTERNAL_SESSIONS_PATH,
  runtimeSessionMessages: RUNTIME_SESSION_MESSAGES_PATH,
  runtimeSessions: RUNTIME_SESSIONS_PATH,
  runtimeDurableWork: RUNTIME_DURABLE_WORK_PATH,
  me: `${API_V1_PREFIX}/me`,
  meConnectCodes: `${API_V1_PREFIX}/me/connect-codes`,
} as const;

export function taskByIdPath(sessionId: string): string {
  return `${ACCOUNT_TASKS_PATH}/${encodeURIComponent(sessionId)}`;
}

export function accountComputerConnectCodePath(connectCodeId: string): string {
  return `${ACCOUNT_COMPUTER_CONNECT_CODES_PATH}/${encodeURIComponent(connectCodeId)}`;
}

export function accountComputerByIdPath(computerId: string): string {
  return `${ACCOUNT_COMPUTERS_PATH}/${encodeURIComponent(computerId)}`;
}

export function agentByIdPath(agentId: string): string {
  return `${API_V1_PREFIX}/agents/${encodeURIComponent(agentId)}`;
}

export function agentConfigPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/config`;
}

export function agentRuntimeTestPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/runtime-test`;
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

export function agentComputerRebindPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/computer/rebind`;
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

export function feishuSetupAttemptCancelPath(attemptId: string): string {
  return `${feishuSetupAttemptPath(attemptId)}/cancel`;
}

export function agentSlackOAuthStartPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/im-binding/slack/oauth/start`;
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

export function runtimeDurableWorkPath(kind: string, key: string): string {
  return `${RUNTIME_DURABLE_WORK_PATH}/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;
}
