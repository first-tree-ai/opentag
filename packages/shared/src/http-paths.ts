export const API_V1_PREFIX = "/api/v1";
export const AGENT_BY_ID_TEMPLATE = `${API_V1_PREFIX}/agents/:agentId`;
export const AGENT_SETUP_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/setup`;
export const AGENT_SETUP_REFRESH_TEMPLATE = `${AGENT_SETUP_TEMPLATE}/refresh`;
export const AGENT_CONFIG_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/config`;
export const AGENT_RUNTIME_TEST_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/runtime-test`;
export const AGENT_USAGE_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/usage`;
export const AGENT_CLOUD_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/cloud`;

export function agentCloudPath(
  agentId: string,
  options: { cursor?: string; limit?: number; sessionId?: string } = {},
): string {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.sessionId !== undefined) query.set("sessionId", options.sessionId);
  const suffix = query.toString();
  return `${API_V1_PREFIX}/agents/${encodeURIComponent(agentId)}/cloud${suffix ? `?${suffix}` : ""}`;
}
export const AGENT_SUSPEND_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/suspend`;
export const AGENT_REACTIVATE_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/reactivate`;
export const AGENT_COMPUTER_REBIND_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/computer/rebind`;
export const AGENT_IM_BINDING_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding`;
export const AGENT_IM_BINDING_HANDOFF_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/handoff`;
export const AGENT_IM_BINDING_CONFIG_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/config`;
export const AGENT_IM_BINDING_UNBIND_TEMPLATE = `${AGENT_IM_BINDING_TEMPLATE}/unbind`;
export const AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/feishu/setup-attempts`;
export const FEISHU_SETUP_ATTEMPT_TEMPLATE = `${API_V1_PREFIX}/im-bindings/feishu/setup-attempts/:attemptId`;
export const FEISHU_SETUP_ATTEMPT_CHECK_TEMPLATE = `${FEISHU_SETUP_ATTEMPT_TEMPLATE}/check`;
export const AGENT_SLACK_OAUTH_START_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/slack/oauth/start`;
export const AGENT_SLACK_EVENTS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/im-binding/slack/events`;
export const IM_BINDING_BY_ID_TEMPLATE = `${API_V1_PREFIX}/im-bindings/:imBindingId`;
export const IM_BINDING_DIAGNOSTICS_TEMPLATE = `${IM_BINDING_BY_ID_TEMPLATE}/diagnostics`;
export const SLACK_EVENTS_PATH = `${API_V1_PREFIX}/im-bindings/slack/events`;
export const SLACK_OAUTH_CALLBACK_PATH = `${API_V1_PREFIX}/im-bindings/slack/oauth/callback`;
/*
 * Account-scoped GitHub integration management. One deployment-level GitHub App, one current
 * connection per Account; the OAuth callback and webhook are the only unauthenticated paths and
 * each has its own verification (state+session claim, raw-body HMAC).
 */
export const GITHUB_INTEGRATION_PATH = `${API_V1_PREFIX}/integrations/github`;
export const GITHUB_INTEGRATION_AUTHORIZATION_PATH = `${GITHUB_INTEGRATION_PATH}/authorization`;
export const GITHUB_INTEGRATION_REPOSITORIES_PATH = `${GITHUB_INTEGRATION_PATH}/repositories`;
export const GITHUB_INTEGRATION_BINDINGS_PATH = `${GITHUB_INTEGRATION_PATH}/bindings`;
export const GITHUB_INTEGRATION_DISCONNECT_PATH = `${GITHUB_INTEGRATION_PATH}/disconnect`;
export const GITHUB_OAUTH_CALLBACK_PATH = `${GITHUB_INTEGRATION_PATH}/oauth/callback`;
export const GITHUB_WEBHOOK_PATH = `${GITHUB_INTEGRATION_PATH}/webhook`;
export const RUNTIME_IM_RESOURCE_TEMPLATE = `${API_V1_PREFIX}/runtime/im-messages/:imMessageId/resources/:ordinal`;
export const RUNTIME_INTERNAL_SESSIONS_PATH = `${API_V1_PREFIX}/runtime/sessions/internal`;
export const RUNTIME_SESSION_MESSAGES_PATH = `${API_V1_PREFIX}/runtime/session-messages`;
export const RUNTIME_SESSIONS_PATH = `${API_V1_PREFIX}/runtime/sessions`;
export const RUNTIME_DURABLE_WORK_PATH = `${API_V1_PREFIX}/runtime/durable-work`;
/**
 * Account-native management collections. Ownership comes only from the authenticated Account.
 */
export const ACCOUNT_AGENTS_PATH = `${API_V1_PREFIX}/agents`;
export const ACCOUNT_AGENT_CREATION_INTENT_TEMPLATE = `${ACCOUNT_AGENTS_PATH}/creation-intents/:creationIntentId`;
export const ACCOUNT_COMPUTERS_PATH = `${API_V1_PREFIX}/computers`;
export const ACCOUNT_CLOUD_COMPUTER_PATH = `${ACCOUNT_COMPUTERS_PATH}/cloud`;
/** The Router-sourced Cloud model choices; read-only and authenticated like the sibling Cloud routes. */
export const ACCOUNT_CLOUD_MODELS_PATH = `${ACCOUNT_CLOUD_COMPUTER_PATH}/models`;
export const ACCOUNT_COMPUTER_CONNECT_CODES_PATH = `${API_V1_PREFIX}/computer-connect-codes`;
export const ACCOUNT_SANDBOXES_PATH = `${API_V1_PREFIX}/sandboxes`;
export const ACCOUNT_SANDBOX_TEMPLATE = `${ACCOUNT_SANDBOXES_PATH}/:sandboxId`;
export const ACCOUNT_SANDBOX_RUNNER_TEMPLATE = `${ACCOUNT_SANDBOX_TEMPLATE}/runner`;
export const ACCOUNT_SANDBOX_RUNNER_START_TEMPLATE = `${ACCOUNT_SANDBOX_RUNNER_TEMPLATE}/start`;
export const ACCOUNT_SANDBOX_RUNNER_STOP_TEMPLATE = `${ACCOUNT_SANDBOX_RUNNER_TEMPLATE}/stop`;
export const ACCOUNT_SANDBOX_RUNNER_ACCEPTANCE_TEMPLATE = `${ACCOUNT_SANDBOX_RUNNER_TEMPLATE}/acceptance`;
/**
 * Outbound control channel a Cloud Runner dials from inside its Cloud Run Instance. No token ever
 * travels in the URL; authentication is a first-frame bootstrap bearer credential.
 */
export const SANDBOX_RUNNER_WEBSOCKET_PATH = `${API_V1_PREFIX}/sandbox-runners/ws`;
export const ACCOUNT_COMPUTER_CONNECT_CODE_TEMPLATE = `${ACCOUNT_COMPUTER_CONNECT_CODES_PATH}/:connectCodeId`;
export const ACCOUNT_SETUP_COMPLETE_PATH = `${API_V1_PREFIX}/me/setup/complete`;
export const ACCOUNT_SETUP_RESET_PATH = `${API_V1_PREFIX}/me/setup/reset`;
export const INTERNAL_NAVIGATION_VISIBILITY_PATH = `${API_V1_PREFIX}/internal/navigation-visibility`;
export const ACCOUNT_TASKS_PATH = `${API_V1_PREFIX}/sessions`;
export const TASK_BY_ID_TEMPLATE = `${ACCOUNT_TASKS_PATH}/:sessionId`;
export const TASK_CANCEL_TEMPLATE = `${TASK_BY_ID_TEMPLATE}/cancel`;
/*
 * MCP management plane. Server definitions live on the Account pool; every binding, authorization,
 * and probe is addressed under the Agent that owns it, because authorization is strictly per Agent.
 * The callback and the CIMD metadata document are the only unauthenticated paths and each verifies
 * its own caller (one-time state, and a public static document).
 */
export const MCP_SERVERS_PATH = `${API_V1_PREFIX}/mcp-servers`;
export const MCP_SERVER_BY_ID_TEMPLATE = `${MCP_SERVERS_PATH}/:mcpServerId`;
export const MCP_OAUTH_CALLBACK_PATH = `${MCP_SERVERS_PATH}/oauth/callback`;
export const AGENT_MCP_SERVERS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/mcp-servers`;
export const AGENT_MCP_SERVER_TEMPLATE = `${AGENT_MCP_SERVERS_TEMPLATE}/:mcpServerId`;
export const AGENT_MCP_AUTHORIZATION_TEMPLATE = `${AGENT_MCP_SERVER_TEMPLATE}/authorization`;
export const AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE = `${AGENT_MCP_AUTHORIZATION_TEMPLATE}/oauth`;
export const AGENT_MCP_PROBE_TEMPLATE = `${AGENT_MCP_SERVER_TEMPLATE}/probe`;
/** A public static document describing this deployment as an OAuth client (CIMD). */
export const MCP_CLIENT_METADATA_PATH = "/oauth/client-metadata.json";
/*
 * Agent Skills. A Skill is owned by exactly one Agent, so every Account- and Computer-scoped path is
 * addressed under an Agent. The runtime path is session-proof authenticated and takes the Skill name
 * rather than the id, because the Agent CLI only knows names; the Server resolves the proof's agent.
 */
export const AGENT_SKILLS_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/skills`;
export const AGENT_SKILL_TEMPLATE = `${AGENT_SKILLS_TEMPLATE}/:skillId`;
export const AGENT_SKILL_BUNDLE_TEMPLATE = `${AGENT_SKILL_TEMPLATE}/bundle`;
export const COMPUTER_AGENT_SKILLS_TEMPLATE = `${API_V1_PREFIX}/computer/agents/:agentId/skills`;
export const COMPUTER_AGENT_SKILL_BUNDLE_TEMPLATE = `${COMPUTER_AGENT_SKILLS_TEMPLATE}/:skillId/bundle`;
export const RUNTIME_SKILLS_PATH = `${API_V1_PREFIX}/runtime/skills`;
export const RUNTIME_SKILL_BUNDLE_TEMPLATE = `${RUNTIME_SKILLS_PATH}/:name/bundle`;

export const HTTP_PATHS = {
  accountAgents: ACCOUNT_AGENTS_PATH,
  accountCloudComputer: ACCOUNT_CLOUD_COMPUTER_PATH,
  accountCloudModels: ACCOUNT_CLOUD_MODELS_PATH,
  accountComputerConnectCodes: ACCOUNT_COMPUTER_CONNECT_CODES_PATH,
  accountComputers: ACCOUNT_COMPUTERS_PATH,
  accountSandboxes: ACCOUNT_SANDBOXES_PATH,
  sandboxRunnerWebSocket: SANDBOX_RUNNER_WEBSOCKET_PATH,
  accountSetupComplete: ACCOUNT_SETUP_COMPLETE_PATH,
  accountSetupReset: ACCOUNT_SETUP_RESET_PATH,
  internalNavigationVisibility: INTERNAL_NAVIGATION_VISIBILITY_PATH,
  accountTasks: ACCOUNT_TASKS_PATH,
  agentById: AGENT_BY_ID_TEMPLATE,
  slackEvents: SLACK_EVENTS_PATH,
  githubIntegration: GITHUB_INTEGRATION_PATH,
  githubOAuthCallback: GITHUB_OAUTH_CALLBACK_PATH,
  githubWebhook: GITHUB_WEBHOOK_PATH,
  mcpServers: MCP_SERVERS_PATH,
  mcpOAuthCallback: MCP_OAUTH_CALLBACK_PATH,
  mcpClientMetadata: MCP_CLIENT_METADATA_PATH,
  slackOAuthCallback: SLACK_OAUTH_CALLBACK_PATH,
  authConnectExchange: `${API_V1_PREFIX}/auth/connect/exchange`,
  computerConnectExchange: `${API_V1_PREFIX}/computer/connect/exchange`,
  authBrowserLogout: `${API_V1_PREFIX}/auth/browser/logout`,
  authBrowserSessionStatus: `${API_V1_PREFIX}/auth/browser/session-status`,
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
  runtimeSkills: RUNTIME_SKILLS_PATH,
  runtimeDurableWork: RUNTIME_DURABLE_WORK_PATH,
  me: `${API_V1_PREFIX}/me`,
  meConnectCodes: `${API_V1_PREFIX}/me/connect-codes`,
} as const;

export function taskByIdPath(sessionId: string): string {
  return `${ACCOUNT_TASKS_PATH}/${encodeURIComponent(sessionId)}`;
}

export function taskCancelPath(sessionId: string): string {
  return `${taskByIdPath(sessionId)}/cancel`;
}

export function accountComputerConnectCodePath(connectCodeId: string): string {
  return `${ACCOUNT_COMPUTER_CONNECT_CODES_PATH}/${encodeURIComponent(connectCodeId)}`;
}

export function accountSandboxPath(sandboxId: string): string {
  return `${ACCOUNT_SANDBOXES_PATH}/${encodeURIComponent(sandboxId)}`;
}

export function accountSandboxRunnerPath(sandboxId: string): string {
  return `${accountSandboxPath(sandboxId)}/runner`;
}

export function accountSandboxRunnerStartPath(sandboxId: string): string {
  return `${accountSandboxRunnerPath(sandboxId)}/start`;
}

export function accountSandboxRunnerStopPath(sandboxId: string): string {
  return `${accountSandboxRunnerPath(sandboxId)}/stop`;
}

export function accountSandboxRunnerAcceptancePath(sandboxId: string): string {
  return `${accountSandboxRunnerPath(sandboxId)}/acceptance`;
}

/** The exact WSS URL a Runner dials, derived from the configured backend origin (never caller input). */
export function sandboxRunnerWebSocketUrl(backendOrigin: string): string {
  const url = new URL(SANDBOX_RUNNER_WEBSOCKET_PATH, backendOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function agentByIdPath(agentId: string): string {
  return `${API_V1_PREFIX}/agents/${encodeURIComponent(agentId)}`;
}

export function accountAgentCreationIntentPath(creationIntentId: string): string {
  return `${ACCOUNT_AGENTS_PATH}/creation-intents/${encodeURIComponent(creationIntentId)}`;
}

export function agentSetupPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/setup`;
}

export function agentSetupRefreshPath(agentId: string): string {
  return `${agentSetupPath(agentId)}/refresh`;
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

export function agentImBindingUnbindPath(agentId: string): string {
  return `${agentImBindingPath(agentId)}/unbind`;
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

export function feishuSetupAttemptCheckPath(attemptId: string): string {
  return `${feishuSetupAttemptPath(attemptId)}/check`;
}

export function agentSlackOAuthStartPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/im-binding/slack/oauth/start`;
}

export function agentSlackEventsPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/im-binding/slack/events`;
}

export function githubIntegrationPath(): string {
  return GITHUB_INTEGRATION_PATH;
}

export function githubIntegrationAuthorizationPath(): string {
  return GITHUB_INTEGRATION_AUTHORIZATION_PATH;
}

export function githubIntegrationRepositoriesPath(cursor?: string): string {
  if (cursor === undefined) return GITHUB_INTEGRATION_REPOSITORIES_PATH;
  return `${GITHUB_INTEGRATION_REPOSITORIES_PATH}?${new URLSearchParams({ cursor }).toString()}`;
}

export function githubIntegrationBindingsPath(): string {
  return GITHUB_INTEGRATION_BINDINGS_PATH;
}

export function githubIntegrationDisconnectPath(): string {
  return GITHUB_INTEGRATION_DISCONNECT_PATH;
}

export function imBindingDisablePath(imBindingId: string): string {
  return `${API_V1_PREFIX}/im-bindings/${encodeURIComponent(imBindingId)}/disable`;
}

export function imBindingDiagnosticsPath(imBindingId: string): string {
  return `${API_V1_PREFIX}/im-bindings/${encodeURIComponent(imBindingId)}/diagnostics`;
}

export function mcpServersPath(): string {
  return MCP_SERVERS_PATH;
}

export function mcpServerPath(mcpServerId: string): string {
  return `${MCP_SERVERS_PATH}/${encodeURIComponent(mcpServerId)}`;
}

export function agentMcpServersPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/mcp-servers`;
}

export function agentMcpServerPath(agentId: string, mcpServerId: string): string {
  return `${agentMcpServersPath(agentId)}/${encodeURIComponent(mcpServerId)}`;
}

export function agentMcpAuthorizationPath(agentId: string, mcpServerId: string): string {
  return `${agentMcpServerPath(agentId, mcpServerId)}/authorization`;
}

export function agentMcpAuthorizationOAuthPath(agentId: string, mcpServerId: string): string {
  return `${agentMcpAuthorizationPath(agentId, mcpServerId)}/oauth`;
}

export function agentMcpProbePath(agentId: string, mcpServerId: string): string {
  return `${agentMcpServerPath(agentId, mcpServerId)}/probe`;
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

export const AGENT_CONTEXT_TREE_TEMPLATE = `${AGENT_BY_ID_TEMPLATE}/context-tree`;
export function agentContextTreePath(agentId: string): string {
  return `${agentByIdPath(agentId)}/context-tree`;
}

export function agentSkillsPath(agentId: string): string {
  return `${agentByIdPath(agentId)}/skills`;
}

export function agentSkillPath(agentId: string, skillId: string): string {
  return `${agentSkillsPath(agentId)}/${encodeURIComponent(skillId)}`;
}

export function agentSkillBundlePath(agentId: string, skillId: string): string {
  return `${agentSkillPath(agentId, skillId)}/bundle`;
}

export function computerAgentSkillsPath(agentId: string): string {
  return `${API_V1_PREFIX}/computer/agents/${encodeURIComponent(agentId)}/skills`;
}

export function computerAgentSkillBundlePath(agentId: string, skillId: string): string {
  return `${computerAgentSkillsPath(agentId)}/${encodeURIComponent(skillId)}/bundle`;
}

export function runtimeSkillBundlePath(name: string): string {
  return `${RUNTIME_SKILLS_PATH}/${encodeURIComponent(name)}/bundle`;
}
