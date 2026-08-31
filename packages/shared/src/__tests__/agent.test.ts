import { describe, expect, it } from "vitest";
import {
  AgentAdminConfigSchema,
  AgentDetailSchema,
  AgentNameSchema,
  AgentRuntimeConfigSchema,
  AgentSummarySchema,
  AgentUsageDetailSchema,
  AgentUsageWindowDaysSchema,
  CreateAgentRequestSchema,
  ListAgentsResponseSchema,
  RebindAgentComputerRequestSchema,
  UpdateAgentRequestSchema,
} from "../agent.js";
import { AgentNameSchema as BrowserAgentNameSchema } from "../browser.js";
import {
  ACCOUNT_AGENTS_PATH,
  ACCOUNT_COMPUTER_CONNECT_CODES_PATH,
  ACCOUNT_COMPUTERS_PATH,
  ACCOUNT_SETUP_COMPLETE_PATH,
  ACCOUNT_TASKS_PATH,
  AGENT_BY_ID_TEMPLATE,
  AGENT_COMPUTER_REBIND_TEMPLATE,
  AGENT_CONFIG_TEMPLATE,
  AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE,
  AGENT_IM_BINDING_CONFIG_TEMPLATE,
  AGENT_IM_BINDING_HANDOFF_TEMPLATE,
  AGENT_IM_BINDING_TEMPLATE,
  AGENT_REACTIVATE_TEMPLATE,
  AGENT_SLACK_EVENTS_TEMPLATE,
  AGENT_SLACK_OAUTH_START_TEMPLATE,
  AGENT_SUSPEND_TEMPLATE,
  AGENT_USAGE_TEMPLATE,
  agentByIdPath,
  agentComputerRebindPath,
  agentConfigPath,
  agentFeishuSetupAttemptsPath,
  agentImBindingConfigPath,
  agentImBindingHandoffPath,
  agentImBindingPath,
  agentReactivatePath,
  agentSlackEventsPath,
  agentSlackOAuthStartPath,
  agentSuspendPath,
  agentUsagePath,
  feishuSetupAttemptPath,
  HTTP_PATHS,
  imBindingDiagnosticsPath,
  imBindingDisablePath,
  RUNTIME_IM_RESOURCE_TEMPLATE,
  runtimeImResourcePath,
  runtimeWebSocketUrl,
  taskByIdPath,
  WORKSPACE_AGENTS_TEMPLATE,
  workspaceAgentsPath,
  workspaceComputerConnectCodesPath,
  workspaceComputersPath,
  workspaceSetupCompletePath,
} from "../http-paths.js";
import { OPENTAG_PLATFORM_INSTRUCTIONS, RUNTIME_INSTRUCTIONS_MAX_BYTES } from "../runtime-config.js";

const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const agent = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  createdByUserId: "bfcdab09-b57a-44ac-a170-09f7c3af20df",
  computerId,
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex",
  receiveMode: "all_message",
  status: "active",
  revision: 1,
  runtimeConfig: {
    revision: 1,
    model: null,
    reasoningEffort: null,
    instructions: "Follow the managed workspace instructions.",
    maxDurationMs: null,
  },
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const creationIntentId = "a3adbe5e-8e8e-4ac2-a013-b026684ab185";

describe("Agent contracts", () => {
  it("normalizes canonical names and strict create/update payloads", () => {
    expect(AgentNameSchema.parse("  code-reviewer  ")).toBe("code-reviewer");
    expect(
      CreateAgentRequestSchema.parse({
        creationIntentId,
        name: " code-reviewer ",
        displayName: " Code Reviewer ",
        runtimeProvider: "claude-code",
        computerId,
        runtimeConfig: { model: "claude-sonnet" },
      }),
    ).toEqual({
      creationIntentId,
      name: "code-reviewer",
      displayName: "Code Reviewer",
      runtimeProvider: "claude-code",
      computerId,
      runtimeConfig: { model: "claude-sonnet" },
    });
    expect(UpdateAgentRequestSchema.parse({ expectedRevision: 1, displayName: " Reviewer " })).toEqual({
      expectedRevision: 1,
      displayName: "Reviewer",
    });
    expect(
      UpdateAgentRequestSchema.parse({
        expectedRevision: 1,
        runtimeConfig: { maxDurationMs: null, model: null, reasoningEffort: null },
      }),
    ).toEqual({
      expectedRevision: 1,
      runtimeConfig: { maxDurationMs: null, model: null, reasoningEffort: null },
    });
  });

  it.each(["", "UPPER", "has space", "under_score", "-leading"])("rejects invalid canonical name %j", (name) =>
    expect(() => AgentNameSchema.parse(name)).toThrow(),
  );

  it.each([
    ["", "Agent name is required"],
    ["a".repeat(65), "Agent name must be at most 64 characters"],
    [
      "Bestony",
      "Agent name must start with a lowercase letter or number and contain only lowercase letters, numbers, and hyphens",
    ],
  ])("provides a stable validation message for %j", (name, message) => {
    const result = AgentNameSchema.safeParse(name);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(message);
  });

  it("accepts only UUID creation intent identities", () => {
    expect(
      CreateAgentRequestSchema.parse({
        creationIntentId,
        computerId,
        displayName: agent.displayName,
        name: agent.name,
        runtimeProvider: agent.runtimeProvider,
      }),
    ).toMatchObject({ creationIntentId });
    expect(() =>
      CreateAgentRequestSchema.parse({
        creationIntentId: "retry-by-name",
        computerId,
        displayName: agent.displayName,
        name: agent.name,
        runtimeProvider: agent.runtimeProvider,
      }),
    ).toThrow();
  });

  it("rejects unexpected authority and immutable update fields", () => {
    expect(() => CreateAgentRequestSchema.parse({ ...agent, createdByUserId: agent.createdByUserId })).toThrow();
    expect(() =>
      UpdateAgentRequestSchema.parse({
        expectedRevision: 1,
        displayName: "Reviewer",
        runtimeProvider: "codex",
      }),
    ).toThrow();
    expect(() => UpdateAgentRequestSchema.parse({ expectedRevision: 1 })).toThrow();
    expect(() => UpdateAgentRequestSchema.parse({ expectedRevision: 1, runtimeConfig: {} })).toThrow();
  });

  it("validates strict Agent response projections", () => {
    expect(AgentAdminConfigSchema.parse(agent)).toEqual(agent);
    const { runtimeConfig: _, revision: _revision, createdByUserId, computerId: adminComputerId, ...base } = agent;
    const summary = {
      ...base,
      createdBy: { userId: createdByUserId, displayName: "Creator" },
      computer: { computerId: adminComputerId, displayName: "Laptop", platform: "darwin" },
    };
    expect(AgentSummarySchema.parse(summary)).toEqual(summary);
    const listItem = {
      ...summary,
      activity: { state: "idle" },
      usage: { windowDays: 30, tasks: 3, failed: 1, tokens: 420 },
    };
    expect(ListAgentsResponseSchema.parse({ agents: [listItem] })).toEqual({ agents: [listItem] });
    expect(
      ListAgentsResponseSchema.parse({
        agents: [
          {
            ...summary,
            activity: { state: "working", startedAt: agent.updatedAt },
            usage: { windowDays: 30, tasks: 1, failed: 0, tokens: 0 },
          },
        ],
      }),
    ).toMatchObject({ agents: [{ activity: { state: "working", startedAt: agent.updatedAt } }] });
    expect(() =>
      ListAgentsResponseSchema.parse({
        agents: [
          {
            ...summary,
            activity: { state: "working", startedAt: agent.updatedAt, summary: "Private conversation content" },
            usage: { windowDays: 30, tasks: 1, failed: 0, tokens: 0 },
          },
        ],
      }),
    ).toThrow();
    expect(AgentDetailSchema.parse({ ...summary, activity: { state: "idle" } })).toMatchObject({
      activity: { state: "idle" },
    });
    expect(() =>
      AgentDetailSchema.parse({
        ...summary,
        activity: { state: "working", startedAt: agent.updatedAt, summary: "Private conversation content" },
      }),
    ).toThrow();
    expect(() => AgentAdminConfigSchema.parse({ ...agent, deletedAt: null })).toThrow();
    expect(() => AgentRuntimeConfigSchema.parse({ ...agent.runtimeConfig, allowedTools: [] })).toThrow();
  });

  it("validates detailed Agent usage and supported periods", () => {
    const usage = {
      windowDays: 30,
      startedAt: "2026-07-25T12:00:00.000Z",
      endedAt: "2026-08-24T12:00:00.000Z",
      tasks: 2,
      measuredTasks: 1,
      failed: 0,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      tokens: 14,
      daily: [
        {
          date: "2026-08-24",
          tasks: 2,
          measuredTasks: 1,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          tokens: 14,
        },
      ],
    };
    expect(AgentUsageDetailSchema.parse(usage)).toEqual(usage);
    expect(AgentUsageDetailSchema.parse({ ...usage, cachedInputTokens: 11 })).toMatchObject({
      cachedInputTokens: 11,
    });
    expect(() => AgentUsageDetailSchema.parse({ ...usage, measuredTasks: 3 })).toThrow();
    expect(() => AgentUsageDetailSchema.parse({ ...usage, tokens: 15 })).toThrow();
    expect(() =>
      AgentUsageDetailSchema.parse({ ...usage, daily: [{ ...usage.daily[0], date: "08/24/2026" }] }),
    ).toThrow();
    expect([7, 30, 90].map((days) => AgentUsageWindowDaysSchema.parse(days))).toEqual([7, 30, 90]);
    expect(() => AgentUsageWindowDaysSchema.parse(14)).toThrow();
  });

  it("rejects inconsistent detailed usage relationships", () => {
    const usage = {
      windowDays: 30,
      startedAt: "2026-07-25T12:00:00.000Z",
      endedAt: "2026-08-24T12:00:00.000Z",
      tasks: 2,
      measuredTasks: 1,
      failed: 0,
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      tokens: 14,
      daily: [
        {
          date: "2026-08-23",
          tasks: 2,
          measuredTasks: 1,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          tokens: 14,
        },
        {
          date: "2026-08-24",
          tasks: 1,
          measuredTasks: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          tokens: 2,
        },
      ],
    };
    expect(() => AgentUsageDetailSchema.parse({ ...usage, failed: 3 })).toThrow("Failed Tasks cannot exceed Tasks");
    expect(() => AgentUsageDetailSchema.parse({ ...usage, measuredTasks: 3 })).toThrow(
      "Measured Tasks cannot exceed Tasks",
    );
    expect(() => AgentUsageDetailSchema.parse({ ...usage, startedAt: "2026-08-25T12:00:00.000Z" })).toThrow(
      "Usage start cannot follow usage end",
    );
    expect(() => AgentUsageDetailSchema.parse({ ...usage, daily: [{ ...usage.daily[0], measuredTasks: 3 }] })).toThrow(
      "Measured Tasks cannot exceed Tasks",
    );
    expect(() =>
      AgentUsageDetailSchema.parse({ ...usage, daily: [usage.daily[0], usage.daily[1], usage.daily[1]] }),
    ).toThrow("Daily usage dates must be unique and ordered");
  });

  it("enforces runtime config UTF-8 and duration boundaries", () => {
    expect(() =>
      CreateAgentRequestSchema.parse({
        computerId,
        displayName: agent.displayName,
        name: agent.name,
        runtimeProvider: agent.runtimeProvider,
        runtimeConfig: { instructions: "界".repeat(8_193) },
      }),
    ).toThrow();
    expect(() =>
      UpdateAgentRequestSchema.parse({ expectedRevision: 1, runtimeConfig: { allowedTools: [] } }),
    ).toThrow();
    expect(() =>
      UpdateAgentRequestSchema.parse({ expectedRevision: 1, runtimeConfig: { maxDurationMs: 0 } }),
    ).toThrow();
    expect(
      UpdateAgentRequestSchema.parse({ expectedRevision: 1, runtimeConfig: { maxDurationMs: 86_400_000 } }),
    ).toMatchObject({ runtimeConfig: { maxDurationMs: 86_400_000 } });
    expect(() =>
      UpdateAgentRequestSchema.parse({ expectedRevision: 1, runtimeConfig: { maxDurationMs: 86_400_001 } }),
    ).toThrow();
  });

  it("reserves the shared platform instruction budget on create and update", () => {
    const encoder = new TextEncoder();
    const agentBudget = RUNTIME_INSTRUCTIONS_MAX_BYTES - encoder.encode(OPENTAG_PLATFORM_INSTRUCTIONS).byteLength;
    const exactAscii = "a".repeat(agentBudget);
    const exactUtf8 = "界".repeat(Math.floor(agentBudget / 3)) + "a".repeat(agentBudget % 3);
    const createInput = {
      computerId,
      displayName: agent.displayName,
      name: agent.name,
      runtimeProvider: agent.runtimeProvider,
    };

    expect(
      CreateAgentRequestSchema.parse({ ...createInput, runtimeConfig: { instructions: exactAscii } }),
    ).toMatchObject({ runtimeConfig: { instructions: exactAscii } });
    expect(() =>
      CreateAgentRequestSchema.parse({ ...createInput, runtimeConfig: { instructions: `${exactAscii}a` } }),
    ).toThrow("combined 24 KiB limit");
    expect(
      UpdateAgentRequestSchema.parse({ expectedRevision: 1, runtimeConfig: { instructions: exactUtf8 } }),
    ).toMatchObject({ runtimeConfig: { instructions: exactUtf8 } });
    expect(() =>
      UpdateAgentRequestSchema.parse({ expectedRevision: 1, runtimeConfig: { instructions: `${exactUtf8}a` } }),
    ).toThrow("combined 24 KiB limit");
  });

  it("shares route templates and encoded path builders", () => {
    expect(WORKSPACE_AGENTS_TEMPLATE).toBe("/api/v1/workspaces/:workspaceId/agents");
    expect(AGENT_BY_ID_TEMPLATE).toBe("/api/v1/agents/:agentId");
    expect(workspaceAgentsPath("workspace/value")).toBe("/api/v1/workspaces/workspace%2Fvalue/agents");
    expect(agentByIdPath("agent/value")).toBe("/api/v1/agents/agent%2Fvalue");
    expect(AGENT_SUSPEND_TEMPLATE).toBe("/api/v1/agents/:agentId/suspend");
    expect(agentSuspendPath("agent/value")).toBe("/api/v1/agents/agent%2Fvalue/suspend");
    expect(AGENT_REACTIVATE_TEMPLATE).toBe("/api/v1/agents/:agentId/reactivate");
    expect(agentReactivatePath("agent/value")).toBe("/api/v1/agents/agent%2Fvalue/reactivate");
    expect(AGENT_USAGE_TEMPLATE).toBe("/api/v1/agents/:agentId/usage");
    expect(agentUsagePath("agent/value", 30)).toBe("/api/v1/agents/agent%2Fvalue/usage?days=30");
    expect(AGENT_COMPUTER_REBIND_TEMPLATE).toBe("/api/v1/agents/:agentId/computer/rebind");
    expect(agentComputerRebindPath("agent/value")).toBe("/api/v1/agents/agent%2Fvalue/computer/rebind");
    expect(RebindAgentComputerRequestSchema.parse({ computerId })).toEqual({ computerId });
    expect(() =>
      RebindAgentComputerRequestSchema.parse({
        computerId,
        workspaceId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
      }),
    ).toThrow();
    expect(BrowserAgentNameSchema.parse("browser-barrel")).toBe("browser-barrel");
  });

  it("builds every account, Agent, IM, runtime, and workspace path", () => {
    expect(HTTP_PATHS.accountAgents).toBe(ACCOUNT_AGENTS_PATH);
    expect(HTTP_PATHS.accountComputers).toBe(ACCOUNT_COMPUTERS_PATH);
    expect(HTTP_PATHS.accountComputerConnectCodes).toBe(ACCOUNT_COMPUTER_CONNECT_CODES_PATH);
    expect(HTTP_PATHS.accountSetupComplete).toBe(ACCOUNT_SETUP_COMPLETE_PATH);
    expect(HTTP_PATHS.accountTasks).toBe(ACCOUNT_TASKS_PATH);
    expect(HTTP_PATHS.agentById).toBe(AGENT_BY_ID_TEMPLATE);
    expect(AGENT_CONFIG_TEMPLATE).toBe("/api/v1/agents/:agentId/config");
    expect(agentConfigPath("a/b")).toBe("/api/v1/agents/a%2Fb/config");
    expect(agentImBindingPath("a/b")).toBe("/api/v1/agents/a%2Fb/im-binding");
    expect(AGENT_IM_BINDING_TEMPLATE).toBe("/api/v1/agents/:agentId/im-binding");
    expect(agentImBindingHandoffPath("a/b")).toBe("/api/v1/agents/a%2Fb/im-binding/handoff");
    expect(AGENT_IM_BINDING_HANDOFF_TEMPLATE).toBe("/api/v1/agents/:agentId/im-binding/handoff");
    expect(agentImBindingConfigPath("a/b")).toBe("/api/v1/agents/a%2Fb/im-binding/config");
    expect(AGENT_IM_BINDING_CONFIG_TEMPLATE).toBe("/api/v1/agents/:agentId/im-binding/config");
    expect(agentFeishuSetupAttemptsPath("a/b")).toBe("/api/v1/agents/a%2Fb/im-binding/feishu/setup-attempts");
    expect(AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE).toBe("/api/v1/agents/:agentId/im-binding/feishu/setup-attempts");
    expect(feishuSetupAttemptPath("attempt/value")).toBe("/api/v1/im-bindings/feishu/setup-attempts/attempt%2Fvalue");
    expect(agentSlackOAuthStartPath("a/b")).toBe("/api/v1/agents/a%2Fb/im-binding/slack/oauth/start");
    expect(AGENT_SLACK_OAUTH_START_TEMPLATE).toBe("/api/v1/agents/:agentId/im-binding/slack/oauth/start");
    expect(agentSlackEventsPath("a/b")).toBe("/api/v1/agents/a%2Fb/im-binding/slack/events");
    expect(AGENT_SLACK_EVENTS_TEMPLATE).toBe("/api/v1/agents/:agentId/im-binding/slack/events");
    expect(imBindingDisablePath("binding/value")).toBe("/api/v1/im-bindings/binding%2Fvalue/disable");
    expect(imBindingDiagnosticsPath("binding/value")).toBe("/api/v1/im-bindings/binding%2Fvalue/diagnostics");
    expect(taskByIdPath("session/value")).toBe("/api/v1/sessions/session%2Fvalue");
    expect(workspaceSetupCompletePath("workspace/value")).toBe("/api/v1/workspaces/workspace%2Fvalue/setup/complete");
    expect(workspaceComputersPath("workspace/value")).toBe("/api/v1/workspaces/workspace%2Fvalue/computers");
    expect(workspaceComputerConnectCodesPath("workspace/value")).toBe(
      "/api/v1/workspaces/workspace%2Fvalue/computer-connect-codes",
    );
    expect(
      runtimeImResourcePath("message/value", 2, {
        sessionId: "session",
        instanceId: "instance",
        placementGeneration: 3,
      }),
    ).toBe(
      "/api/v1/runtime/im-messages/message%2Fvalue/resources/2?sessionId=session&instanceId=instance&placementGeneration=3",
    );
    expect(RUNTIME_IM_RESOURCE_TEMPLATE).toContain(":imMessageId");
    expect(runtimeWebSocketUrl("https://example.test/base")).toBe("wss://example.test/api/v1/computer/ws");
    expect(runtimeWebSocketUrl("http://example.test")).toBe("ws://example.test/api/v1/computer/ws");
  });
});
