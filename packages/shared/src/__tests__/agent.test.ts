import { describe, expect, it } from "vitest";
import {
  AgentNameSchema,
  AgentSchema,
  CreateAgentRequestSchema,
  ListAgentsResponseSchema,
  UpdateAgentRequestSchema,
} from "../agent.js";
import { AGENT_BY_ID_TEMPLATE, agentByIdPath, TEAM_AGENTS_TEMPLATE, teamAgentsPath } from "../http-paths.js";

const agent = {
  id: "1a63a21e-f6c7-4474-91ea-4dabf0566a24",
  teamId: "d3fda800-7ce2-4338-aae8-3d2120401ed6",
  managerUserId: "bfcdab09-b57a-44ac-a170-09f7c3af20df",
  computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex",
  revision: 1,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};

describe("Agent contracts", () => {
  it("normalizes canonical names and strict create/update payloads", () => {
    expect(AgentNameSchema.parse("  code-reviewer  ")).toBe("code-reviewer");
    expect(
      CreateAgentRequestSchema.parse({
        name: " code-reviewer ",
        displayName: " Code Reviewer ",
        runtimeProvider: "claude-code",
        computerId: agent.computerId,
      }),
    ).toEqual({
      name: "code-reviewer",
      displayName: "Code Reviewer",
      runtimeProvider: "claude-code",
      computerId: agent.computerId,
    });
    expect(UpdateAgentRequestSchema.parse({ expectedRevision: 1, displayName: " Reviewer " })).toEqual({
      expectedRevision: 1,
      displayName: "Reviewer",
    });
  });

  it.each(["", "UPPER", "has space", "under_score", "-leading"])("rejects invalid canonical name %j", (name) =>
    expect(() => AgentNameSchema.parse(name)).toThrow(),
  );

  it("rejects unexpected authority and immutable update fields", () => {
    expect(() => CreateAgentRequestSchema.parse({ ...agent, managerUserId: agent.managerUserId })).toThrow();
    expect(() =>
      UpdateAgentRequestSchema.parse({
        expectedRevision: 1,
        displayName: "Reviewer",
        runtimeProvider: "codex",
      }),
    ).toThrow();
  });

  it("validates strict Agent response projections", () => {
    expect(AgentSchema.parse(agent)).toEqual(agent);
    expect(ListAgentsResponseSchema.parse({ agents: [agent] })).toEqual({ agents: [agent] });
    expect(() => AgentSchema.parse({ ...agent, deletedAt: null })).toThrow();
  });

  it("shares route templates and encoded path builders", () => {
    expect(TEAM_AGENTS_TEMPLATE).toBe("/api/v1/teams/:teamId/agents");
    expect(AGENT_BY_ID_TEMPLATE).toBe("/api/v1/agents/:agentId");
    expect(teamAgentsPath("team/value")).toBe("/api/v1/teams/team%2Fvalue/agents");
    expect(agentByIdPath("agent/value")).toBe("/api/v1/agents/agent%2Fvalue");
  });
});
