import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Agent } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
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
const agent: Agent = {
  id: agentId,
  teamId,
  managerUserId: userId,
  computerId,
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex" as const,
  receiveMode: "all_message" as const,
  revision: 1,
  runtimeConfig: {
    revision: 1,
    model: null,
    reasoningEffort: null,
    instructions: "Follow instructions.",
    allowedTools: ["opentag_message_react", "opentag_message_reply", "opentag_message_send"],
    maxDurationMs: null,
  },
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const { runtimeConfig, ...agentBase } = agent;
const agentSummary = { ...agentBase, runtimeConfigRevision: runtimeConfig.revision };

function api() {
  return {
    me: vi.fn().mockResolvedValue(me),
    listComputers: vi.fn().mockResolvedValue({ computers: [computer] }),
    createAgent: vi.fn().mockResolvedValue(agent),
    listAgents: vi.fn().mockResolvedValue({ agents: [agentSummary] }),
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

  it("creates runtime settings and preserves UTF-8 instruction file contents", async () => {
    const home = await mkdtemp(resolve(tmpdir(), "opentag-agent-cli-"));
    try {
      const instructionsFile = resolve(home, "instructions.txt");
      await writeFile(instructionsFile, "请逐行检查。\n\n", "utf8");
      const client = api();
      await runAgentCreate({
        accessToken: "access",
        api: client,
        name: "code-reviewer",
        displayName: "Code Reviewer",
        runtimeProvider: "codex",
        model: "gpt-5",
        reasoningEffort: "high",
        instructionsFile,
        allowedTools: ["opentag_message_send", "opentag_message_reply"],
        maxDurationMs: "30000",
      });
      expect(client.createAgent).toHaveBeenCalledWith("access", teamId, {
        computerId,
        displayName: "Code Reviewer",
        name: "code-reviewer",
        runtimeProvider: "codex",
        runtimeConfig: {
          model: "gpt-5",
          reasoningEffort: "high",
          instructions: "请逐行检查。\n\n",
          allowedTools: ["opentag_message_reply", "opentag_message_send"],
          maxDurationMs: 30_000,
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("lists and formats deterministic Agent projections", async () => {
    const client = api();
    const response = await runAgentList({ accessToken: "access", api: client });
    expect(client.listAgents).toHaveBeenCalledWith("access", teamId);
    expect(formatAgentList(response)).toContain("code-reviewer\t");
    expect(formatAgent(agent)).toContain(`revision\t1`);
    expect(formatAgent(agent)).toContain(`runtimeConfig.model\t`);
    expect(formatAgentList(response)).toContain("runtimeConfigRevision=1");
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

  it("updates runtime settings and maps explicit clears onto the existing CAS writer", async () => {
    const client = api();
    await runAgentUpdate(agentId, {
      accessToken: "access",
      api: client,
      instructions: "",
      clearModel: true,
      clearReasoningEffort: true,
      clearAllowedTools: true,
      clearMaxDuration: true,
    });
    expect(client.updateAgent).toHaveBeenCalledWith("access", agentId, {
      expectedRevision: 1,
      runtimeConfig: {
        model: null,
        reasoningEffort: null,
        instructions: "",
        allowedTools: [],
        maxDurationMs: null,
      },
    });
  });

  it("rejects conflicting, duplicate, invalid, and empty runtime mutations before API access", async () => {
    const createConflict = api();
    await expect(
      runAgentCreate({
        accessToken: "access",
        api: createConflict,
        name: "code-reviewer",
        displayName: "Code Reviewer",
        runtimeProvider: "codex",
        instructions: "inline",
        instructionsFile: "/tmp/unused",
      }),
    ).rejects.toThrow("cannot be used together");
    expect(createConflict.me).not.toHaveBeenCalled();

    for (const options of [
      { model: "gpt-5", clearModel: true },
      { reasoningEffort: "high", clearReasoningEffort: true },
      { allowedTools: ["opentag_message_send"], clearAllowedTools: true },
      { maxDurationMs: "100", clearMaxDuration: true },
      { instructions: "inline", instructionsFile: "/tmp/unused" },
    ]) {
      const client = api();
      await expect(runAgentUpdate(agentId, { accessToken: "access", api: client, ...options })).rejects.toThrow(
        "cannot be used together",
      );
      expect(client.getAgent).not.toHaveBeenCalled();
    }

    const invalidDuration = api();
    await expect(
      runAgentUpdate(agentId, { accessToken: "access", api: invalidDuration, maxDurationMs: "1.5" }),
    ).rejects.toThrow("positive base-10 safe integer");
    expect(invalidDuration.getAgent).not.toHaveBeenCalled();

    const excessiveDuration = api();
    await expect(
      runAgentUpdate(agentId, { accessToken: "access", api: excessiveDuration, maxDurationMs: "86400001" }),
    ).rejects.toThrow();
    expect(excessiveDuration.getAgent).not.toHaveBeenCalled();

    const unknownTool = api();
    await expect(
      runAgentUpdate(agentId, { accessToken: "access", api: unknownTool, allowedTools: ["unknown_tool"] }),
    ).rejects.toThrow();
    expect(unknownTool.getAgent).not.toHaveBeenCalled();

    const duplicateTools = api();
    await expect(
      runAgentUpdate(agentId, {
        accessToken: "access",
        api: duplicateTools,
        allowedTools: ["opentag_message_send", "opentag_message_send"],
      }),
    ).rejects.toThrow("Agent tool IDs must be unique");
    expect(duplicateTools.getAgent).not.toHaveBeenCalled();

    const empty = api();
    await expect(runAgentUpdate(agentId, { accessToken: "access", api: empty })).rejects.toThrow(
      "No Agent changes were provided",
    );
    expect(empty.getAgent).not.toHaveBeenCalled();
  });

  it("registers every runtime setting option and keeps update display name optional", () => {
    const program = createProgram();
    const agentCommand = program.commands.find((command) => command.name() === "agent");
    const create = agentCommand?.commands.find((command) => command.name() === "create");
    const update = agentCommand?.commands.find((command) => command.name() === "update");
    expect(create?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--model",
        "--reasoning-effort",
        "--instructions",
        "--instructions-file",
        "--allowed-tool",
        "--max-duration-ms",
      ]),
    );
    expect(update?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        "--model",
        "--clear-model",
        "--reasoning-effort",
        "--clear-reasoning-effort",
        "--instructions",
        "--instructions-file",
        "--allowed-tool",
        "--clear-allowed-tools",
        "--max-duration-ms",
        "--clear-max-duration",
      ]),
    );
    expect(update?.options.find((option) => option.long === "--display-name")?.mandatory).toBe(false);
  });

  it("deletes the explicit Agent without an interactive prompt", async () => {
    const client = api();
    await expect(runAgentDelete(agentId, { accessToken: "access", api: client })).resolves.toBe(
      `Deleted Agent ${agentId}`,
    );
    expect(client.deleteAgent).toHaveBeenCalledWith("access", agentId);
  });
});
