import { describe, expect, it } from "vitest";

import {
  ACCOUNT_AGENT_CREATION_INTENT_TEMPLATE,
  ACCOUNT_AGENTS_PATH,
  ACCOUNT_CLOUD_COMPUTER_PATH,
  ACCOUNT_COMPUTER_CONNECT_CODE_TEMPLATE,
  ACCOUNT_COMPUTER_CONNECT_CODES_PATH,
  ACCOUNT_SANDBOX_RUNNER_ACCEPTANCE_TEMPLATE,
  ACCOUNT_SANDBOX_RUNNER_START_TEMPLATE,
  ACCOUNT_SANDBOX_RUNNER_STOP_TEMPLATE,
  ACCOUNT_SANDBOX_RUNNER_TEMPLATE,
  ACCOUNT_SANDBOX_TEMPLATE,
  ACCOUNT_SANDBOXES_PATH,
  ACCOUNT_SETUP_COMPLETE_PATH,
  ACCOUNT_SETUP_RESET_PATH,
  ACCOUNT_TASKS_PATH,
  AGENT_BY_ID_TEMPLATE,
  AGENT_COMPUTER_REBIND_TEMPLATE,
  AGENT_CONTEXT_TREE_TEMPLATE,
  AGENT_IM_BINDING_CONFIG_TEMPLATE,
  AGENT_IM_BINDING_HANDOFF_TEMPLATE,
  AGENT_IM_BINDING_TEMPLATE,
  AGENT_IM_BINDING_UNBIND_TEMPLATE,
  AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE,
  AGENT_MCP_AUTHORIZATION_TEMPLATE,
  AGENT_MCP_PROBE_TEMPLATE,
  AGENT_MCP_SERVER_TEMPLATE,
  AGENT_MCP_SERVERS_TEMPLATE,
  AGENT_SKILL_BUNDLE_TEMPLATE,
  AGENT_SKILL_TEMPLATE,
  AGENT_SKILLS_TEMPLATE,
  API_V1_PREFIX,
  accountAgentCreationIntentPath,
  accountComputerConnectCodePath,
  accountSandboxPath,
  accountSandboxRunnerAcceptancePath,
  accountSandboxRunnerPath,
  accountSandboxRunnerStartPath,
  accountSandboxRunnerStopPath,
  agentByIdPath,
  agentComputerRebindPath,
  agentConfigPath,
  agentContextTreePath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingHandoffPath,
  agentImBindingPath,
  agentImBindingUnbindPath,
  agentMcpAuthorizationOAuthPath,
  agentMcpAuthorizationPath,
  agentMcpProbePath,
  agentMcpServerPath,
  agentMcpServersPath,
  agentReactivatePath,
  agentRuntimeTestPath,
  agentSetupPath,
  agentSetupRefreshPath,
  agentSkillBundlePath,
  agentSkillPath,
  agentSkillsPath,
  agentSlackEventsPath,
  agentSlackOAuthStartPath,
  agentSuspendPath,
  agentUsagePath,
  COMPUTER_AGENT_SKILL_BUNDLE_TEMPLATE,
  COMPUTER_AGENT_SKILLS_TEMPLATE,
  computerAgentSkillBundlePath,
  computerAgentSkillsPath,
  feishuSetupAttemptCancelPath,
  feishuSetupAttemptCheckPath,
  feishuSetupAttemptPath,
  GITHUB_INTEGRATION_AUTHORIZATION_PATH,
  GITHUB_INTEGRATION_BINDINGS_PATH,
  GITHUB_INTEGRATION_DISCONNECT_PATH,
  GITHUB_INTEGRATION_PATH,
  GITHUB_INTEGRATION_REPOSITORIES_PATH,
  GITHUB_OAUTH_CALLBACK_PATH,
  GITHUB_WEBHOOK_PATH,
  githubIntegrationAuthorizationPath,
  githubIntegrationBindingsPath,
  githubIntegrationDisconnectPath,
  githubIntegrationPath,
  githubIntegrationRepositoriesPath,
  HTTP_PATHS,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  MCP_CLIENT_METADATA_PATH,
  MCP_OAUTH_CALLBACK_PATH,
  MCP_SERVER_BY_ID_TEMPLATE,
  MCP_SERVERS_PATH,
  mcpServerPath,
  mcpServersPath,
  RUNTIME_DURABLE_WORK_PATH,
  RUNTIME_SKILL_BUNDLE_TEMPLATE,
  RUNTIME_SKILLS_PATH,
  runtimeDurableWorkPath,
  runtimeImResourcePath,
  runtimeSkillBundlePath,
  runtimeWebSocketUrl,
  SANDBOX_RUNNER_WEBSOCKET_PATH,
  sandboxRunnerWebSocketUrl,
  TASK_BY_ID_TEMPLATE,
  TASK_CANCEL_TEMPLATE,
  taskByIdPath,
  taskCancelPath,
} from "../http-paths.js";

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const OTHER_ID = "9f1c2f5e-0000-4444-8888-abcdefabcdef";

describe("http paths", () => {
  it("anchors every path on the versioned API prefix", () => {
    expect(API_V1_PREFIX).toBe("/api/v1");
  });

  describe("task paths", () => {
    it("builds the session-scoped pair from one id", () => {
      expect(taskByIdPath(AGENT_ID)).toBe(`/api/v1/sessions/${AGENT_ID}`);
      expect(taskCancelPath(AGENT_ID)).toBe(`/api/v1/sessions/${AGENT_ID}/cancel`);
    });

    it("encodes an id that would otherwise change the path shape", () => {
      expect(taskByIdPath("a/b c")).toBe("/api/v1/sessions/a%2Fb%20c");
      expect(taskCancelPath("a/b c")).toBe("/api/v1/sessions/a%2Fb%20c/cancel");
    });
  });

  describe("account paths", () => {
    it("builds the connect-code path", () => {
      expect(accountComputerConnectCodePath(OTHER_ID)).toBe(`/api/v1/computer-connect-codes/${OTHER_ID}`);
      expect(accountComputerConnectCodePath("a/b")).toBe("/api/v1/computer-connect-codes/a%2Fb");
    });

    it("builds the sandbox path", () => {
      expect(accountSandboxPath(OTHER_ID)).toBe(`/api/v1/sandboxes/${OTHER_ID}`);
      expect(accountSandboxPath("a/b")).toBe("/api/v1/sandboxes/a%2Fb");
    });

    it("builds each Runner control path from the sandbox id", () => {
      const sandboxId = OTHER_ID;
      expect(accountSandboxRunnerPath(sandboxId)).toBe(`/api/v1/sandboxes/${sandboxId}/runner`);
      expect(accountSandboxRunnerStartPath(sandboxId)).toBe(`/api/v1/sandboxes/${sandboxId}/runner/start`);
      expect(accountSandboxRunnerStopPath(sandboxId)).toBe(`/api/v1/sandboxes/${sandboxId}/runner/stop`);
      expect(accountSandboxRunnerAcceptancePath(sandboxId)).toBe(`/api/v1/sandboxes/${sandboxId}/runner/acceptance`);
    });

    it("keeps the creation-intent path under the account agents collection", () => {
      expect(accountAgentCreationIntentPath(OTHER_ID)).toBe(`/api/v1/agents/creation-intents/${OTHER_ID}`);
      expect(accountAgentCreationIntentPath("a/b")).toBe("/api/v1/agents/creation-intents/a%2Fb");
    });
  });

  describe("runner websocket url", () => {
    it("upgrades an https backend origin to wss", () => {
      expect(sandboxRunnerWebSocketUrl("https://api.opentag.example")).toBe(
        "wss://api.opentag.example/api/v1/sandbox-runners/ws",
      );
    });

    it("leaves a plaintext backend origin on ws", () => {
      expect(sandboxRunnerWebSocketUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/api/v1/sandbox-runners/ws");
    });
  });

  describe("agent paths", () => {
    it("builds every agent-scoped path", () => {
      const agentId = AGENT_ID;
      const base = `/api/v1/agents/${agentId}`;
      expect(agentByIdPath(agentId)).toBe(base);
      expect(agentSetupPath(agentId)).toBe(`${base}/setup`);
      expect(agentSetupRefreshPath(agentId)).toBe(`${base}/setup/refresh`);
      expect(agentConfigPath(agentId)).toBe(`${base}/config`);
      expect(agentRuntimeTestPath(agentId)).toBe(`${base}/runtime-test`);
      expect(agentSuspendPath(agentId)).toBe(`${base}/suspend`);
      expect(agentReactivatePath(agentId)).toBe(`${base}/reactivate`);
      expect(agentComputerRebindPath(agentId)).toBe(`${base}/computer/rebind`);
      expect(agentContextTreePath(agentId)).toBe(`${base}/context-tree`);
    });

    it("carries the usage window as a query parameter", () => {
      expect(agentUsagePath(AGENT_ID, 30)).toBe(`/api/v1/agents/${AGENT_ID}/usage?days=30`);
      expect(agentUsagePath(AGENT_ID, 0)).toBe(`/api/v1/agents/${AGENT_ID}/usage?days=0`);
    });

    it("encodes an agent id that would otherwise change the path shape", () => {
      expect(agentByIdPath("a/b c")).toBe("/api/v1/agents/a%2Fb%20c");
      expect(agentSetupPath("a/b c")).toBe("/api/v1/agents/a%2Fb%20c/setup");
    });
  });

  describe("im binding paths", () => {
    it("builds every agent im-binding path", () => {
      const agentId = AGENT_ID;
      const base = `/api/v1/agents/${agentId}/im-binding`;
      expect(agentImBindingPath(agentId)).toBe(base);
      expect(agentImBindingHandoffPath(agentId)).toBe(`${base}/handoff`);
      expect(agentImBindingConfigPath(agentId)).toBe(`${base}/config`);
      expect(agentImBindingUnbindPath(agentId)).toBe(`${base}/unbind`);
      expect(agentFeishuSetupAttemptsPath(agentId)).toBe(`${base}/feishu/setup-attempts`);
      expect(agentSlackOAuthStartPath(agentId)).toBe(`${base}/slack/oauth/start`);
      expect(agentSlackEventsPath(agentId)).toBe(`${base}/slack/events`);
    });

    it("builds every feishu setup-attempt path", () => {
      const attemptId = OTHER_ID;
      expect(feishuSetupAttemptPath(attemptId)).toBe(`/api/v1/im-bindings/feishu/setup-attempts/${attemptId}`);
      expect(feishuSetupAttemptCancelPath(attemptId)).toBe(
        `/api/v1/im-bindings/feishu/setup-attempts/${attemptId}/cancel`,
      );
      expect(feishuSetupAttemptCheckPath(attemptId)).toBe(
        `/api/v1/im-bindings/feishu/setup-attempts/${attemptId}/check`,
      );
    });

    it("encodes attempt and binding ids", () => {
      expect(feishuSetupAttemptPath("a/b")).toBe("/api/v1/im-bindings/feishu/setup-attempts/a%2Fb");
      expect(feishuSetupAttemptCheckPath("a/b")).toBe("/api/v1/im-bindings/feishu/setup-attempts/a%2Fb/check");
      expect(imBindingDisablePath("a/b")).toBe("/api/v1/im-bindings/a%2Fb/disable");
      expect(imBindingDiagnosticsPath("a/b")).toBe("/api/v1/im-bindings/a%2Fb/diagnostics");
    });

    it("builds the im binding management paths", () => {
      expect(imBindingDisablePath(OTHER_ID)).toBe(`/api/v1/im-bindings/${OTHER_ID}/disable`);
      expect(imBindingDiagnosticsPath(OTHER_ID)).toBe(`/api/v1/im-bindings/${OTHER_ID}/diagnostics`);
    });
  });

  describe("github integration paths", () => {
    it("returns the deployment-level collection paths", () => {
      expect(githubIntegrationPath()).toBe(GITHUB_INTEGRATION_PATH);
      expect(githubIntegrationPath()).toBe("/api/v1/integrations/github");
      expect(githubIntegrationAuthorizationPath()).toBe(GITHUB_INTEGRATION_AUTHORIZATION_PATH);
      expect(githubIntegrationBindingsPath()).toBe(GITHUB_INTEGRATION_BINDINGS_PATH);
      expect(githubIntegrationBindingsPath()).toBe("/api/v1/integrations/github/bindings");
      expect(githubIntegrationDisconnectPath()).toBe(GITHUB_INTEGRATION_DISCONNECT_PATH);
    });

    it("omits the query when no cursor was given", () => {
      expect(githubIntegrationRepositoriesPath()).toBe(GITHUB_INTEGRATION_REPOSITORIES_PATH);
      expect(githubIntegrationRepositoriesPath(undefined)).toBe("/api/v1/integrations/github/repositories");
    });

    it("encodes a cursor as a query parameter", () => {
      expect(githubIntegrationRepositoriesPath("abc")).toBe("/api/v1/integrations/github/repositories?cursor=abc");
      expect(githubIntegrationRepositoriesPath("a b&c=d")).toBe(
        "/api/v1/integrations/github/repositories?cursor=a+b%26c%3Dd",
      );
      expect(githubIntegrationRepositoriesPath("")).toBe("/api/v1/integrations/github/repositories?cursor=");
    });
  });

  describe("mcp paths", () => {
    it("builds the account pool paths", () => {
      expect(mcpServersPath()).toBe(MCP_SERVERS_PATH);
      expect(mcpServersPath()).toBe("/api/v1/mcp-servers");
      expect(mcpServerPath(OTHER_ID)).toBe(`/api/v1/mcp-servers/${OTHER_ID}`);
      expect(mcpServerPath("a/b")).toBe("/api/v1/mcp-servers/a%2Fb");
    });

    it("nests every agent binding, authorization and probe path", () => {
      const agentId = AGENT_ID;
      const serverId = OTHER_ID;
      const servers = `/api/v1/agents/${agentId}/mcp-servers`;
      const server = `${servers}/${serverId}`;
      expect(agentMcpServersPath(agentId)).toBe(servers);
      expect(agentMcpServerPath(agentId, serverId)).toBe(server);
      expect(agentMcpAuthorizationPath(agentId, serverId)).toBe(`${server}/authorization`);
      expect(agentMcpAuthorizationOAuthPath(agentId, serverId)).toBe(`${server}/authorization/oauth`);
      expect(agentMcpProbePath(agentId, serverId)).toBe(`${server}/probe`);
    });

    it("encodes the server id inside an agent binding path", () => {
      expect(agentMcpServerPath(AGENT_ID, "a/b")).toBe(`/api/v1/agents/${AGENT_ID}/mcp-servers/a%2Fb`);
      expect(agentMcpProbePath(AGENT_ID, "a/b")).toBe(`/api/v1/agents/${AGENT_ID}/mcp-servers/a%2Fb/probe`);
    });
  });

  describe("runtime paths", () => {
    it("carries the im resource addressing triple as a query", () => {
      expect(runtimeImResourcePath("msg-1", 3, { sessionId: "s-1", instanceId: "i-1", placementGeneration: 7 })).toBe(
        "/api/v1/runtime/im-messages/msg-1/resources/3?sessionId=s-1&instanceId=i-1&placementGeneration=7",
      );
    });

    it("encodes an im message id that would otherwise change the path shape", () => {
      expect(runtimeImResourcePath("a/b", 0, { sessionId: "s", instanceId: "i", placementGeneration: 0 })).toBe(
        "/api/v1/runtime/im-messages/a%2Fb/resources/0?sessionId=s&instanceId=i&placementGeneration=0",
      );
    });

    it("encodes the durable work kind and key", () => {
      expect(runtimeDurableWorkPath("turn", "key-1")).toBe("/api/v1/runtime/durable-work/turn/key-1");
      expect(runtimeDurableWorkPath("a/b", "c d")).toBe("/api/v1/runtime/durable-work/a%2Fb/c%20d");
    });

    it("upgrades an https server url to wss and leaves http on ws", () => {
      expect(runtimeWebSocketUrl("https://api.opentag.example")).toBe("wss://api.opentag.example/api/v1/computer/ws");
      expect(runtimeWebSocketUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/api/v1/computer/ws");
    });
  });

  describe("skill paths", () => {
    it("nests every agent skill path", () => {
      const agentId = AGENT_ID;
      const skillId = OTHER_ID;
      const skills = `/api/v1/agents/${agentId}/skills`;
      expect(agentSkillsPath(agentId)).toBe(skills);
      expect(agentSkillPath(agentId, skillId)).toBe(`${skills}/${skillId}`);
      expect(agentSkillBundlePath(agentId, skillId)).toBe(`${skills}/${skillId}/bundle`);
    });

    it("nests the computer-scoped skill paths under the computer plane", () => {
      const agentId = AGENT_ID;
      const skills = `/api/v1/computer/agents/${agentId}/skills`;
      expect(computerAgentSkillsPath(agentId)).toBe(skills);
      expect(computerAgentSkillBundlePath(agentId, OTHER_ID)).toBe(`${skills}/${OTHER_ID}/bundle`);
    });

    it("addresses the runtime bundle by name rather than by id", () => {
      expect(runtimeSkillBundlePath("pdf-tools")).toBe("/api/v1/runtime/skills/pdf-tools/bundle");
      expect(runtimeSkillBundlePath("a/b c")).toBe("/api/v1/runtime/skills/a%2Fb%20c/bundle");
    });

    it("encodes the skill id inside every scoped bundle path", () => {
      expect(agentSkillPath(AGENT_ID, "a/b")).toBe(`/api/v1/agents/${AGENT_ID}/skills/a%2Fb`);
      expect(agentSkillBundlePath(AGENT_ID, "a/b")).toBe(`/api/v1/agents/${AGENT_ID}/skills/a%2Fb/bundle`);
      expect(computerAgentSkillBundlePath(AGENT_ID, "a/b")).toBe(
        `/api/v1/computer/agents/${AGENT_ID}/skills/a%2Fb/bundle`,
      );
    });
  });

  describe("templates and constants stay consistent with the builders", () => {
    it("renders every template with the same id the builder takes", () => {
      const agentId = AGENT_ID;
      const render = (template: string, params: Record<string, string>) =>
        template.replace(/:([a-zA-Z]+)/g, (_match, name: string) => params[name] ?? _match);

      expect(render(AGENT_BY_ID_TEMPLATE, { agentId })).toBe(agentByIdPath(agentId));
      expect(render(TASK_BY_ID_TEMPLATE, { sessionId: OTHER_ID })).toBe(taskByIdPath(OTHER_ID));
      expect(render(TASK_CANCEL_TEMPLATE, { sessionId: OTHER_ID })).toBe(taskCancelPath(OTHER_ID));
      expect(render(ACCOUNT_COMPUTER_CONNECT_CODE_TEMPLATE, { connectCodeId: OTHER_ID })).toBe(
        accountComputerConnectCodePath(OTHER_ID),
      );
      expect(render(ACCOUNT_SANDBOX_TEMPLATE, { sandboxId: OTHER_ID })).toBe(accountSandboxPath(OTHER_ID));
      expect(render(ACCOUNT_SANDBOX_RUNNER_TEMPLATE, { sandboxId: OTHER_ID })).toBe(accountSandboxRunnerPath(OTHER_ID));
      expect(render(ACCOUNT_SANDBOX_RUNNER_START_TEMPLATE, { sandboxId: OTHER_ID })).toBe(
        accountSandboxRunnerStartPath(OTHER_ID),
      );
      expect(render(ACCOUNT_SANDBOX_RUNNER_STOP_TEMPLATE, { sandboxId: OTHER_ID })).toBe(
        accountSandboxRunnerStopPath(OTHER_ID),
      );
      expect(render(ACCOUNT_SANDBOX_RUNNER_ACCEPTANCE_TEMPLATE, { sandboxId: OTHER_ID })).toBe(
        accountSandboxRunnerAcceptancePath(OTHER_ID),
      );
      expect(render(ACCOUNT_AGENT_CREATION_INTENT_TEMPLATE, { creationIntentId: OTHER_ID })).toBe(
        accountAgentCreationIntentPath(OTHER_ID),
      );
      expect(render(AGENT_COMPUTER_REBIND_TEMPLATE, { agentId })).toBe(agentComputerRebindPath(agentId));
      expect(render(AGENT_IM_BINDING_TEMPLATE, { agentId })).toBe(agentImBindingPath(agentId));
      expect(render(AGENT_IM_BINDING_HANDOFF_TEMPLATE, { agentId })).toBe(agentImBindingHandoffPath(agentId));
      expect(render(AGENT_IM_BINDING_CONFIG_TEMPLATE, { agentId })).toBe(agentImBindingConfigPath(agentId));
      expect(render(AGENT_IM_BINDING_UNBIND_TEMPLATE, { agentId })).toBe(agentImBindingUnbindPath(agentId));
      expect(render(AGENT_CONTEXT_TREE_TEMPLATE, { agentId })).toBe(agentContextTreePath(agentId));
      expect(render(MCP_SERVER_BY_ID_TEMPLATE, { mcpServerId: OTHER_ID })).toBe(mcpServerPath(OTHER_ID));
      expect(render(AGENT_MCP_SERVERS_TEMPLATE, { agentId })).toBe(agentMcpServersPath(agentId));
      expect(render(AGENT_MCP_SERVER_TEMPLATE, { agentId, mcpServerId: OTHER_ID })).toBe(
        agentMcpServerPath(agentId, OTHER_ID),
      );
      expect(render(AGENT_MCP_AUTHORIZATION_TEMPLATE, { agentId, mcpServerId: OTHER_ID })).toBe(
        agentMcpAuthorizationPath(agentId, OTHER_ID),
      );
      expect(render(AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE, { agentId, mcpServerId: OTHER_ID })).toBe(
        agentMcpAuthorizationOAuthPath(agentId, OTHER_ID),
      );
      expect(render(AGENT_MCP_PROBE_TEMPLATE, { agentId, mcpServerId: OTHER_ID })).toBe(
        agentMcpProbePath(agentId, OTHER_ID),
      );
      expect(render(AGENT_SKILLS_TEMPLATE, { agentId })).toBe(agentSkillsPath(agentId));
      expect(render(AGENT_SKILL_TEMPLATE, { agentId, skillId: OTHER_ID })).toBe(agentSkillPath(agentId, OTHER_ID));
      expect(render(AGENT_SKILL_BUNDLE_TEMPLATE, { agentId, skillId: OTHER_ID })).toBe(
        agentSkillBundlePath(agentId, OTHER_ID),
      );
      expect(render(COMPUTER_AGENT_SKILLS_TEMPLATE, { agentId })).toBe(computerAgentSkillsPath(agentId));
      expect(render(COMPUTER_AGENT_SKILL_BUNDLE_TEMPLATE, { agentId, skillId: OTHER_ID })).toBe(
        computerAgentSkillBundlePath(agentId, OTHER_ID),
      );
      expect(render(RUNTIME_SKILL_BUNDLE_TEMPLATE, { name: "pdf-tools" })).toBe(runtimeSkillBundlePath("pdf-tools"));
      expect(render(RUNTIME_DURABLE_WORK_PATH, {})).toBe(RUNTIME_DURABLE_WORK_PATH);
    });

    it("exposes the same static and template values through HTTP_PATHS", () => {
      expect(HTTP_PATHS.accountAgents).toBe(ACCOUNT_AGENTS_PATH);
      expect(HTTP_PATHS.accountCloudComputer).toBe(ACCOUNT_CLOUD_COMPUTER_PATH);
      expect(HTTP_PATHS.accountComputerConnectCodes).toBe(ACCOUNT_COMPUTER_CONNECT_CODES_PATH);
      expect(HTTP_PATHS.accountSandboxes).toBe(ACCOUNT_SANDBOXES_PATH);
      expect(HTTP_PATHS.sandboxRunnerWebSocket).toBe(SANDBOX_RUNNER_WEBSOCKET_PATH);
      expect(HTTP_PATHS.accountSetupComplete).toBe(ACCOUNT_SETUP_COMPLETE_PATH);
      expect(HTTP_PATHS.accountSetupReset).toBe(ACCOUNT_SETUP_RESET_PATH);
      expect(HTTP_PATHS.accountTasks).toBe(ACCOUNT_TASKS_PATH);
      expect(HTTP_PATHS.agentById).toBe(AGENT_BY_ID_TEMPLATE);
      expect(HTTP_PATHS.githubIntegration).toBe(GITHUB_INTEGRATION_PATH);
      expect(HTTP_PATHS.githubOAuthCallback).toBe(GITHUB_OAUTH_CALLBACK_PATH);
      expect(HTTP_PATHS.githubWebhook).toBe(GITHUB_WEBHOOK_PATH);
      expect(HTTP_PATHS.mcpServers).toBe(MCP_SERVERS_PATH);
      expect(HTTP_PATHS.mcpOAuthCallback).toBe(MCP_OAUTH_CALLBACK_PATH);
      expect(HTTP_PATHS.mcpClientMetadata).toBe(MCP_CLIENT_METADATA_PATH);
      expect(HTTP_PATHS.runtimeSkills).toBe(RUNTIME_SKILLS_PATH);
      expect(HTTP_PATHS.runtimeDurableWork).toBe(RUNTIME_DURABLE_WORK_PATH);
    });
  });
});
