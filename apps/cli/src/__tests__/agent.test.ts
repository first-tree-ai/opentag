import { describe, expect, it, vi } from "vitest";
import { formatAgent, formatAgentCreated, formatAgentList } from "../core/agent/formatting.js";
import { runAgentCreate, runAgentDelete, runAgentUpdate, selectComputer } from "../core/agent/mutations.js";
import { runAgentList, runAgentShow } from "../core/agent/queries.js";
import { selectTeam } from "../core/selection/team.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const membership = { teamId, teamName: "example", teamDisplayName: "Example", role: "admin" as const };
const me = {
  user: { id: userId, email: "admin@example.com", displayName: "Admin" },
  memberships: [membership],
};
const computer = {
  id: computerId,
  ownerUserId: userId,
  displayName: "workstation",
  platform: "linux" as const,
  arch: "x64",
  clientVersion: "0.0.1",
  connectionStatus: "online" as const,
  connectedAt: "2026-08-19T00:00:00.000Z",
  lastSeenAt: "2026-08-19T00:00:01.000Z",
};
const agent = {
  id: agentId,
  teamId,
  managerUserId: userId,
  computerId,
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex" as const,
  receiveMode: "all_message" as const,
  revision: 1,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};

function api() {
  return {
    me: vi.fn().mockResolvedValue(me),
    listComputers: vi.fn().mockResolvedValue({ computers: [computer] }),
    createAgent: vi.fn().mockResolvedValue(agent),
    listAgents: vi.fn().mockResolvedValue({ agents: [agent] }),
    getAgent: vi.fn().mockResolvedValue(agent),
    updateAgent: vi.fn().mockResolvedValue({ ...agent, displayName: "Reviewer", revision: 2 }),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    getAgentIntegration: vi.fn().mockResolvedValue(undefined),
    createFeishuSetupAttempt: vi.fn(),
    getFeishuSetupAttempt: vi.fn(),
    cancelFeishuSetupAttempt: vi.fn(),
    getIntegrationDiagnostics: vi.fn(),
    disableIntegration: vi.fn(),
  };
}

describe("Agent CLI core", () => {
  it("resolves one Team automatically and requires an explicit choice for multiple Teams", () => {
    expect(selectTeam(me)).toEqual(membership);
    expect(() => selectTeam({ ...me, memberships: [] })).toThrow("No active Team membership");
    const multiple = {
      ...me,
      memberships: [membership, { ...membership, teamId: crypto.randomUUID(), teamName: "second" }],
    };
    expect(() => selectTeam(multiple)).toThrow("Available Teams: example, second");
    expect(selectTeam(multiple, "second").teamName).toBe("second");
    expect(() => selectTeam(multiple, "missing")).toThrow("is not available");
  });

  it("resolves an owned Computer and rejects ambiguous or unknown choices", () => {
    expect(selectComputer({ computers: [computer] })).toEqual(computer);
    expect(() => selectComputer({ computers: [] })).toThrow("start the daemon first");
    expect(() => selectComputer({ computers: [computer, { ...computer, id: crypto.randomUUID() }] })).toThrow(
      "use --computer",
    );
    expect(() => selectComputer({ computers: [computer] }, crypto.randomUUID())).toThrow("is not owned");
  });

  it("creates on the selected Team and preserves an offline warning", async () => {
    const client = api();
    client.listComputers.mockResolvedValue({ computers: [{ ...computer, connectionStatus: "offline" as const }] });
    const result = await runAgentCreate({
      accessToken: "access",
      api: client,
      name: " code-reviewer ",
      displayName: " Code Reviewer ",
      runtimeProvider: "codex",
    });
    expect(client.createAgent).toHaveBeenCalledWith("access", teamId, {
      computerId,
      displayName: "Code Reviewer",
      name: "code-reviewer",
      runtimeProvider: "codex",
    });
    expect(result.warning).toContain("is offline");
    expect(formatAgentCreated(result)).toContain(agentId);
  });

  it("lists and formats deterministic Agent projections", async () => {
    const client = api();
    const response = await runAgentList({ accessToken: "access", api: client });
    expect(client.listAgents).toHaveBeenCalledWith("access", teamId);
    expect(formatAgentList(response)).toContain("code-reviewer\t");
    expect(formatAgent(agent)).toContain(`revision\t1`);
    expect(formatAgentList({ agents: [] })).toBe("No Agents registered");
    await expect(runAgentShow(agentId, { accessToken: "access", api: client })).resolves.toEqual(agent);
    expect(client.getAgent).toHaveBeenCalledWith("access", agentId);
  });

  it("reads the current revision before update and does not retry conflicts", async () => {
    const client = api();
    await runAgentUpdate(agentId, { accessToken: "access", api: client, displayName: "Reviewer" });
    expect(client.getAgent).toHaveBeenCalledTimes(1);
    expect(client.updateAgent).toHaveBeenCalledWith("access", agentId, {
      displayName: "Reviewer",
      expectedRevision: 1,
    });

    client.updateAgent.mockRejectedValueOnce(new Error("revision conflict"));
    await expect(runAgentUpdate(agentId, { accessToken: "access", api: client, displayName: "Again" })).rejects.toThrow(
      "revision conflict",
    );
    expect(client.updateAgent).toHaveBeenCalledTimes(2);
  });

  it("deletes the explicit Agent without an interactive prompt", async () => {
    const client = api();
    await expect(runAgentDelete(agentId, { accessToken: "access", api: client })).resolves.toBe(
      `Deleted Agent ${agentId}`,
    );
    expect(client.deleteAgent).toHaveBeenCalledWith("access", agentId);
  });
});
