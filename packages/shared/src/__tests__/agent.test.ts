import { describe, expect, it } from "vitest";
import {
  AgentAdminConfigSchema,
  AgentDetailSchema,
  AgentNameSchema,
  AgentRuntimeConfigSchema,
  AgentSummarySchema,
  CreateAgentRequestSchema,
  ListAgentsResponseSchema,
  UpdateAgentRequestSchema,
} from "../agent.js";
import {
  AGENT_BY_ID_TEMPLATE,
  AGENT_REACTIVATE_TEMPLATE,
  AGENT_SUSPEND_TEMPLATE,
  agentByIdPath,
  agentReactivatePath,
  agentSuspendPath,
  TEAM_AGENTS_TEMPLATE,
  teamAgentsPath,
} from "../http-paths.js";
import { OPENTAG_PLATFORM_INSTRUCTIONS, RUNTIME_INSTRUCTIONS_MAX_BYTES } from "../runtime-config.js";

const agent = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  teamId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
  managerUserId: "bfcdab09-b57a-44ac-a170-09f7c3af20df",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
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
        computerId: agent.computerId,
        runtimeConfig: { model: "claude-sonnet" },
      }),
    ).toEqual({
      creationIntentId,
      name: "code-reviewer",
      displayName: "Code Reviewer",
      runtimeProvider: "claude-code",
      computerId: agent.computerId,
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
        computerId: agent.computerId,
        displayName: agent.displayName,
        name: agent.name,
        runtimeProvider: agent.runtimeProvider,
      }),
    ).toMatchObject({ creationIntentId });
    expect(() =>
      CreateAgentRequestSchema.parse({
        creationIntentId: "retry-by-name",
        computerId: agent.computerId,
        displayName: agent.displayName,
        name: agent.name,
        runtimeProvider: agent.runtimeProvider,
      }),
    ).toThrow();
  });

  it("rejects unexpected authority and immutable update fields", () => {
    expect(() => CreateAgentRequestSchema.parse({ ...agent, managerUserId: agent.managerUserId })).toThrow();
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
    const { runtimeConfig: _, revision: _revision, managerUserId, computerId, ...base } = agent;
    const summary = {
      ...base,
      manager: { userId: managerUserId, displayName: "Manager" },
      computer: { id: computerId, displayName: "Laptop", platform: "darwin" },
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
    expect(AgentDetailSchema.parse({ ...summary, viewerCapabilities: { canManage: false } })).toMatchObject({
      viewerCapabilities: { canManage: false },
    });
    expect(() => AgentAdminConfigSchema.parse({ ...agent, deletedAt: null })).toThrow();
    expect(() => AgentRuntimeConfigSchema.parse({ ...agent.runtimeConfig, allowedTools: [] })).toThrow();
  });

  it("enforces runtime config UTF-8 and duration boundaries", () => {
    expect(() =>
      CreateAgentRequestSchema.parse({
        computerId: agent.computerId,
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
      computerId: agent.computerId,
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
    expect(TEAM_AGENTS_TEMPLATE).toBe("/api/v1/teams/:teamId/agents");
    expect(AGENT_BY_ID_TEMPLATE).toBe("/api/v1/agents/:agentId");
    expect(teamAgentsPath("team/value")).toBe("/api/v1/teams/team%2Fvalue/agents");
    expect(agentByIdPath("agent/value")).toBe("/api/v1/agents/agent%2Fvalue");
    expect(AGENT_SUSPEND_TEMPLATE).toBe("/api/v1/agents/:agentId/suspend");
    expect(agentSuspendPath("agent/value")).toBe("/api/v1/agents/agent%2Fvalue/suspend");
    expect(AGENT_REACTIVATE_TEMPLATE).toBe("/api/v1/agents/:agentId/reactivate");
    expect(agentReactivatePath("agent/value")).toBe("/api/v1/agents/agent%2Fvalue/reactivate");
  });
});
