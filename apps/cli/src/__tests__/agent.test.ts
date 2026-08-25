import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentAdminConfig, ImBindingDiagnostics } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { formatAgent, formatAgentCreated, formatAgentList } from "../core/agent/formatting.js";
import { formatImBindingDiagnostics } from "../core/agent/im.js";
import {
  runAgentCreate,
  runAgentDelete,
  runAgentReactivate,
  runAgentSuspend,
  runAgentUpdate,
  selectComputer,
} from "../core/agent/mutations.js";
import { runAgentList, runAgentShow } from "../core/agent/queries.js";
import { selectWorkspace } from "../core/selection/workspace.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const workspace = {
  id: workspaceId,
  name: "example",
  displayName: "Example",
  setupCompletedAt: null,
  grantedAt: "2026-08-19T00:00:00.000Z",
};
const me = {
  user: { id: userId, email: "admin@example.com", displayName: "Admin" },
  workspaces: [workspace],
};
const computer = {
  computerId,
  displayName: "workstation",
  platform: "linux" as const,
  connectionStatus: "online" as const,
  providerReadiness: [
    {
      provider: "codex" as const,
      status: "ready" as const,
      observedAt: "2026-08-19T00:00:01.000Z",
    },
  ],
  connectedAt: "2026-08-19T00:00:00.000Z",
  lastSeenAt: "2026-08-19T00:00:01.000Z",
  observedAt: "2026-08-19T00:00:01.000Z",
  enrolledAt: "2026-08-19T00:00:00.000Z",
  agentIds: [],
};
const agent: AgentAdminConfig = {
  id: agentId,
  workspaceId,
  createdByUserId: userId,
  computerId,
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex" as const,
  receiveMode: "all_message" as const,
  status: "active" as const,
  revision: 1,
  runtimeConfig: {
    revision: 1,
    model: null,
    reasoningEffort: null,
    instructions: "Follow instructions.",
    maxDurationMs: null,
  },
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const {
  runtimeConfig: _runtimeConfig,
  revision: _revision,
  createdByUserId,
  computerId: agentComputerId,
  ...agentBase
} = agent;
const agentSummary = {
  ...agentBase,
  createdBy: { userId: createdByUserId, displayName: "Admin" },
  computer: {
    computerId: agentComputerId,
    displayName: computer.displayName,
    platform: computer.platform,
  },
};

function api() {
  return {
    me: vi.fn().mockResolvedValue(me),
    listWorkspaceComputers: vi.fn().mockResolvedValue({ computers: [computer] }),
    createAgent: vi.fn().mockResolvedValue(agent),
    listAgents: vi.fn().mockResolvedValue({ agents: [agentSummary] }),
    getAgent: vi.fn().mockResolvedValue(agent),
    getAgentConfig: vi.fn().mockResolvedValue(agent),
    updateAgent: vi.fn().mockResolvedValue({ ...agent, displayName: "Reviewer", revision: 2 }),
    suspendAgent: vi.fn().mockResolvedValue({ ...agent, status: "suspended", revision: 2 }),
    reactivateAgent: vi.fn().mockResolvedValue({ ...agent, revision: 3 }),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
    getAgentImBinding: vi.fn().mockResolvedValue(undefined),
    getAgentImBindingConfig: vi.fn().mockResolvedValue(undefined),
    createFeishuSetupAttempt: vi.fn(),
    getFeishuSetupAttempt: vi.fn(),
    cancelFeishuSetupAttempt: vi.fn(),
    getImBindingDiagnostics: vi.fn(),
    disableImBinding: vi.fn(),
  };
}

describe("Agent CLI core", () => {
  it("shows provider CLI readiness in IM diagnostics", () => {
    const diagnostics: ImBindingDiagnostics = {
      imBindingId: crypto.randomUUID(),
      provider: "feishu",
      ready: false,
      agentRuntimeReadiness: "ready",
      providerCliReadiness: "install",
      credentialGeneration: 0,
      credentialStatus: "invalid",
      requiredCapabilities: ["im:message"],
      grantedCapabilities: [],
      missingCapabilities: ["im:message"],
      reauthorizationRequired: false,
      slackAppId: null,
      slackIdentityClosure: null,
      connection: null,
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
      lastErrorCode: null,
    };
    expect(formatImBindingDiagnostics(diagnostics)).toContain("providerCliReadiness\tinstall");
    expect(formatImBindingDiagnostics(diagnostics)).toContain("agentRuntimeReadiness\tready");
    expect(formatImBindingDiagnostics(diagnostics)).toContain("credentialGeneration\t0");
    expect(formatImBindingDiagnostics(diagnostics)).toContain("credentialStatus\tinvalid");
    expect(
      formatImBindingDiagnostics({
        ...diagnostics,
        provider: "slack",
        slackAppId: { value: "A1", evidence: "configured", ingressMatchRequired: true },
        slackIdentityClosure: { status: "pending", verifiedAt: null },
      }),
    ).toContain("slackIdentityClosure\tpending");
  });

  it("resolves one Workspace automatically and requires an explicit choice for multiple Workspaces", () => {
    expect(selectWorkspace(me)).toEqual(workspace);
    expect(() => selectWorkspace({ ...me, workspaces: [] })).toThrow("No Workspace administration access is available");
    const multiple = {
      ...me,
      workspaces: [workspace, { ...workspace, id: crypto.randomUUID(), name: "second" }],
    };
    expect(() => selectWorkspace(multiple)).toThrow("Available Workspaces: example, second");
    expect(selectWorkspace(multiple, "second").name).toBe("second");
    expect(() => selectWorkspace(multiple, "missing")).toThrow("is not available");
  });

  it("resolves an enrolled Computer and rejects ambiguous or unknown choices", () => {
    expect(selectComputer({ computers: [computer] })).toEqual(computer);
    expect(() => selectComputer({ computers: [] })).toThrow("start the daemon first");
    expect(() =>
      selectComputer({
        computers: [{ ...computer }, { ...computer, computerId: crypto.randomUUID() }],
      }),
    ).toThrow("use --computer");
    expect(() => selectComputer({ computers: [computer] }, crypto.randomUUID())).toThrow(
      "is not enrolled in the selected Workspace",
    );
    expect(() => selectComputer({ computers: [computer] }, "75fe9af3-d1c6-472b-b78c-8a7ccf512750")).toThrow(
      "is not enrolled in the selected Workspace",
    );
  });

  it("creates on the selected Workspace and preserves an offline warning", async () => {
    const client = api();
    client.listWorkspaceComputers.mockResolvedValue({
      computers: [{ ...computer, connectionStatus: "offline" as const }],
    });
    const result = await runAgentCreate({
      accessToken: "access",
      api: client,
      name: " code-reviewer ",
      displayName: " Code Reviewer ",
      runtimeProvider: "codex",
    });
    expect(client.createAgent).toHaveBeenCalledWith("access", workspaceId, {
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
        maxDurationMs: "30000",
      });
      expect(client.createAgent).toHaveBeenCalledWith("access", workspaceId, {
        computerId,
        displayName: "Code Reviewer",
        name: "code-reviewer",
        runtimeProvider: "codex",
        runtimeConfig: {
          model: "gpt-5",
          reasoningEffort: "high",
          instructions: "请逐行检查。\n\n",
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
    expect(client.listAgents).toHaveBeenCalledWith("access", workspaceId);
    expect(formatAgentList(response)).toContain("code-reviewer\t");
    expect(formatAgent(agent)).toContain(`revision\t1`);
    expect(formatAgent(agent)).toContain(`runtimeConfig.model\t`);
    expect(formatAgentList(response)).toContain("all_message");
    expect(formatAgentList({ agents: [] })).toBe("No Agents registered");
    await expect(runAgentShow(agentId, { accessToken: "access", api: client })).resolves.toEqual(agent);
    expect(client.getAgentConfig).toHaveBeenCalledWith("access", agentId);
  });

  it("reads the current revision before update and does not retry conflicts", async () => {
    const client = api();
    await runAgentUpdate(agentId, { accessToken: "access", api: client, displayName: "Reviewer" });
    expect(client.getAgentConfig).toHaveBeenCalledTimes(1);
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
      clearMaxDuration: true,
    });
    expect(client.updateAgent).toHaveBeenCalledWith("access", agentId, {
      expectedRevision: 1,
      runtimeConfig: {
        model: null,
        reasoningEffort: null,
        instructions: "",
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
      { maxDurationMs: "100", clearMaxDuration: true },
      { instructions: "inline", instructionsFile: "/tmp/unused" },
    ]) {
      const client = api();
      await expect(runAgentUpdate(agentId, { accessToken: "access", api: client, ...options })).rejects.toThrow(
        "cannot be used together",
      );
      expect(client.getAgentConfig).not.toHaveBeenCalled();
    }

    const invalidDuration = api();
    await expect(
      runAgentUpdate(agentId, { accessToken: "access", api: invalidDuration, maxDurationMs: "1.5" }),
    ).rejects.toThrow("positive base-10 safe integer");
    expect(invalidDuration.getAgentConfig).not.toHaveBeenCalled();

    const excessiveDuration = api();
    await expect(
      runAgentUpdate(agentId, { accessToken: "access", api: excessiveDuration, maxDurationMs: "86400001" }),
    ).rejects.toThrow();
    expect(excessiveDuration.getAgentConfig).not.toHaveBeenCalled();

    const empty = api();
    await expect(runAgentUpdate(agentId, { accessToken: "access", api: empty })).rejects.toThrow(
      "No Agent changes were provided",
    );
    expect(empty.getAgentConfig).not.toHaveBeenCalled();
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
        "--max-duration-ms",
        "--clear-max-duration",
      ]),
    );
    expect(update?.options.find((option) => option.long === "--display-name")?.mandatory).toBe(false);
    expect(create?.options.find((option) => option.long === "--computer")?.description).toBe(
      "Computer enrolled in the selected Workspace",
    );
    expect(update?.options.find((option) => option.long === "--model")?.description).toContain("Codex only");
    expect(update?.options.find((option) => option.long === "--clear-model")?.description).toContain("Codex manage");
    expect(update?.options.find((option) => option.long === "--clear-max-duration")?.description).toContain(
      "OpenTag default",
    );
  });

  it("deletes the explicit Agent without an interactive prompt", async () => {
    const client = api();
    await expect(runAgentDelete(agentId, { accessToken: "access", api: client })).resolves.toBe(
      `Deleted Agent ${agentId}`,
    );
    expect(client.deleteAgent).toHaveBeenCalledWith("access", agentId);
  });

  it("suspends and reactivates the explicit Agent", async () => {
    const client = api();
    await expect(runAgentSuspend(agentId, { accessToken: "access", api: client })).resolves.toMatchObject({
      status: "suspended",
    });
    expect(client.suspendAgent).toHaveBeenCalledWith("access", agentId);
    await expect(runAgentReactivate(agentId, { accessToken: "access", api: client })).resolves.toMatchObject({
      status: "active",
    });
    expect(client.reactivateAgent).toHaveBeenCalledWith("access", agentId);
  });
});
