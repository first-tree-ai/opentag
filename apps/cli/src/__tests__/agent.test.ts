import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentAdminConfig, FeishuSetupAttempt, ImBindingAdminDetail, ImBindingDiagnostics } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import { resolveAgentCommandContext } from "../core/agent/context.js";
import { formatAgent, formatAgentBound, formatAgentCreated, formatAgentList } from "../core/agent/formatting.js";
import * as agentIm from "../core/agent/im.js";
import {
  formatFeishuSetup,
  formatImBinding,
  formatImBindingDiagnostics,
  runImBindingConnectFeishu,
  runImBindingDiagnose,
  runImBindingDisable,
  runImBindingShow,
  runReceiveModeSet,
} from "../core/agent/im.js";
import * as agentMutations from "../core/agent/mutations.js";
import {
  runAgentBind,
  runAgentCreate,
  runAgentDelete,
  runAgentReactivate,
  runAgentSuspend,
  runAgentUpdate,
  selectComputer,
} from "../core/agent/mutations.js";
import * as agentQueries from "../core/agent/queries.js";
import { runAgentList, runAgentShow } from "../core/agent/queries.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const me = {
  user: { id: userId, email: "admin@example.com", displayName: "Admin" },
  setupCompletedAt: null,
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
  computerId: _agentComputerId,
  ...agentBase
} = agent;
const agentSummary = {
  ...agentBase,
  activity: { state: "idle" as const },
  createdBy: { userId: createdByUserId, displayName: "Admin" },
  // Stated rather than re-derived from the admin projection, whose `computerId` is nullable now.
  // This fixture is a bound Agent; the unbound one is built explicitly where it is asserted.
  computer: {
    computerId,
    displayName: computer.displayName,
    platform: computer.platform,
  },
  usage: { windowDays: 30 as const, tasks: 0, failed: 0, tokens: 0 },
};

function api() {
  return {
    me: vi.fn().mockResolvedValue(me),
    listAccountComputers: vi.fn().mockResolvedValue({ computers: [computer] }),
    createAgent: vi.fn().mockResolvedValue(agent),
    listAgents: vi.fn().mockResolvedValue({ agents: [agentSummary] }),
    getAgent: vi.fn().mockResolvedValue(agent),
    getAgentConfig: vi.fn().mockResolvedValue(agent),
    updateAgent: vi.fn().mockResolvedValue({ ...agent, displayName: "Reviewer", revision: 2 }),
    suspendAgent: vi.fn().mockResolvedValue({ ...agent, status: "suspended", revision: 2 }),
    reactivateAgent: vi.fn().mockResolvedValue({ ...agent, revision: 3 }),
    rebindAgentComputer: vi.fn().mockResolvedValue(agent),
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
  it("requires complete injected Agent command dependencies", async () => {
    const client = api();
    await expect(resolveAgentCommandContext({ api: client })).rejects.toThrow(
      "Agent command test dependencies must provide both api and accessToken",
    );
    await expect(resolveAgentCommandContext({ accessToken: "access" })).rejects.toThrow(
      "Agent command test dependencies must provide both api and accessToken",
    );
  });

  it("requires Account login when resolving the default Agent context", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-agent-context-"));
    try {
      await expect(resolveAgentCommandContext({ home })).rejects.toThrow("OpenTag is not logged in; run login first");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

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

  it("runs IM binding commands through the shared Agent context", async () => {
    const client = api();
    const binding: ImBindingAdminDetail = {
      id: crypto.randomUUID(),
      agentId,
      provider: "feishu",
      identity: { provider: "feishu", appId: "cli-app", teamId: null, botOpenId: "bot-open", teamBrand: null },
      receiveMode: "mention_only",
      bindingState: "active",
      bot: { displayName: "Feishu", avatarUrl: null },
      credentialGeneration: 2,
      reauthorizationRequired: false,
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
      grantedCapabilities: ["im:message"],
      lastErrorCode: null,
    };
    client.getAgentImBindingConfig.mockResolvedValue(binding);
    const attempt: FeishuSetupAttempt = {
      id: crypto.randomUUID(),
      agentId,
      intent: "reauthorize",
      state: "awaiting_user",
      qrUrl: "https://opentag.example/qr",
      expiresAt: "2026-08-19T00:01:00.000Z",
      errorCode: null,
      completedAt: null,
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    client.createFeishuSetupAttempt.mockResolvedValue(attempt);
    client.getImBindingDiagnostics.mockResolvedValue({
      imBindingId: binding.id,
      provider: "feishu",
      ready: true,
      agentRuntimeReadiness: "ready",
      providerCliReadiness: "ready",
      credentialGeneration: 2,
      credentialStatus: "valid",
      requiredCapabilities: ["im:message"],
      grantedCapabilities: ["im:message"],
      missingCapabilities: [],
      reauthorizationRequired: false,
      slackAppId: null,
      slackIdentityClosure: null,
      connection: { state: "connected", observedAt: "2026-08-19T00:00:00.000Z" },
      lastInboundAt: "2026-08-19T00:00:00.000Z",
      lastValidatedAt: "2026-08-19T00:00:00.000Z",
      lastRuntimeObservationAt: "2026-08-19T00:00:00.000Z",
      lastErrorCode: null,
    });
    client.updateAgent.mockResolvedValue({ ...agent, receiveMode: "all_message", revision: 2 });

    await expect(runImBindingShow(agentId, { accessToken: "access", api: client })).resolves.toEqual(binding);
    await expect(
      runImBindingConnectFeishu(agentId, "reauthorize", { accessToken: "access", api: client }),
    ).resolves.toEqual(attempt);
    await expect(runImBindingDiagnose(agentId, { accessToken: "access", api: client })).resolves.toMatchObject({
      ready: true,
    });
    await expect(
      runReceiveModeSet(agentId, "all_message", { accessToken: "access", api: client }),
    ).resolves.toMatchObject({
      receiveMode: "all_message",
    });
    await expect(runImBindingDisable(agentId, { accessToken: "access", api: client })).resolves.toBeUndefined();

    expect(formatImBinding(binding)).toContain("identity\tcli-app · provider Team pending first event");
    expect(
      formatImBinding({
        ...binding,
        provider: "slack",
        identity: {
          provider: "slack",
          appId: "slack-app",
          teamId: "team",
          enterpriseId: null,
          botUserId: "bot",
          appIdEvidence: "configured",
        },
      }),
    ).toContain("identity\tslack-app · team · bot");
    expect(formatImBinding(undefined)).toBe("No IM binding configured");
    expect(formatFeishuSetup(attempt)).toContain("qrUrl\thttps://opentag.example/qr");
    expect(formatFeishuSetup({ ...attempt, qrUrl: null, errorCode: "EXPIRED" })).toContain("errorCode\tEXPIRED");
    expect(client.disableImBinding).toHaveBeenCalledWith("access", binding.id);
    expect(client.getImBindingDiagnostics).toHaveBeenCalledWith("access", binding.id);
  });

  it("handles missing IM bindings without making disable calls", async () => {
    const client = api();
    client.getAgentImBindingConfig.mockResolvedValue(undefined);
    await expect(runImBindingDiagnose(agentId, { accessToken: "access", api: client })).rejects.toThrow(
      "The Agent has no IM binding",
    );
    await expect(runImBindingDisable(agentId, { accessToken: "access", api: client })).resolves.toBeUndefined();
    expect(client.disableImBinding).not.toHaveBeenCalled();
  });

  it("sends no management scope and never asks the Account to choose one", async () => {
    const client = api();
    client.me = vi.fn().mockResolvedValue({
      ...me,
      setupCompletedAt: "2026-08-19T00:00:00.000Z",
    });

    await runAgentList({ accessToken: "access", api: client });
    await runAgentCreate({
      accessToken: "access",
      api: client,
      name: "code-reviewer",
      displayName: "Code Reviewer",
      runtimeProvider: "codex",
    });

    expect(client.listAgents).toHaveBeenCalledWith("access");
    expect(client.listAccountComputers).toHaveBeenCalledWith("access");
    expect(client.createAgent).toHaveBeenCalledWith("access", expect.objectContaining({ name: "code-reviewer" }));
    expect(client.me).not.toHaveBeenCalled();
  });

  it("resolves an enrolled Computer and rejects ambiguous or unknown choices", () => {
    expect(selectComputer({ computers: [computer] })).toEqual(computer);
    // Nothing enrolled is an answer, not a failure: the Agent is created and bound later.
    expect(selectComputer({ computers: [] })).toBeUndefined();
    expect(() =>
      selectComputer({
        computers: [{ ...computer }, { ...computer, computerId: crypto.randomUUID() }],
      }),
    ).toThrow("use --computer");
    expect(() => selectComputer({ computers: [computer] }, crypto.randomUUID())).toThrow(
      "is not enrolled by this Account",
    );
    expect(() => selectComputer({ computers: [computer] }, "75fe9af3-d1c6-472b-b78c-8a7ccf512750")).toThrow(
      "is not enrolled by this Account",
    );
  });

  it("creates without a management scope and preserves an offline warning", async () => {
    const client = api();
    client.listAccountComputers.mockResolvedValue({
      computers: [{ ...computer, connectionStatus: "offline" as const }],
    });
    const result = await runAgentCreate({
      accessToken: "access",
      api: client,
      name: " code-reviewer ",
      displayName: " Code Reviewer ",
      runtimeProvider: "codex",
    });
    expect(client.createAgent).toHaveBeenCalledWith("access", {
      computerId,
      displayName: "Code Reviewer",
      name: "code-reviewer",
      runtimeProvider: "codex",
    });
    expect(result.warning).toContain("is offline");
    expect(formatAgentCreated(result)).toContain(agentId);
  });

  it("creates an Agent with no Computer and names the command that binds one", async () => {
    const client = api();
    client.listAccountComputers.mockResolvedValue({ computers: [] });
    client.createAgent.mockResolvedValue({ ...agent, computerId: null });
    const result = await runAgentCreate({
      accessToken: "access",
      api: client,
      name: "code-reviewer",
      displayName: "Code Reviewer",
      runtimeProvider: "codex",
    });
    expect(client.createAgent).toHaveBeenCalledWith("access", {
      displayName: "Code Reviewer",
      name: "code-reviewer",
      runtimeProvider: "codex",
    });
    expect(result.warning).toContain("opentag agent bind");
    expect(formatAgentCreated(result)).toContain("without a Computer");
  });

  it("binds an Agent to a Computer after creation", async () => {
    const client = api();
    const result = await runAgentBind(agentId, { accessToken: "access", api: client });
    expect(client.rebindAgentComputer).toHaveBeenCalledWith("access", agentId, computerId);
    expect(formatAgentBound(result)).toContain(computerId);
    expect(result.warning).toBeUndefined();

    const empty = api();
    empty.listAccountComputers.mockResolvedValue({ computers: [] });
    await expect(runAgentBind(agentId, { accessToken: "access", api: empty })).rejects.toThrow(
      "start the daemon first",
    );
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
      expect(client.createAgent).toHaveBeenCalledWith("access", {
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
    expect(client.listAgents).toHaveBeenCalledWith("access");
    expect(formatAgentList(response)).toContain("code-reviewer\t");
    expect(formatAgent(agent)).toContain(`revision\t1`);
    expect(formatAgent(agent)).not.toContain("workspaceId");
    expect(formatAgent(agent)).toContain(`runtimeConfig.model\t`);
    expect(formatAgentList(response)).toContain("all_message");
    expect(formatAgentList({ agents: [] })).toBe("No Agents registered");
    // An absent Computer is stated rather than left as a gap, so neither surface reads as a field
    // that went missing on the way out.
    const [listed] = response.agents;
    if (!listed) throw new Error("Agent list fixture is empty");
    expect(formatAgentList({ agents: [{ ...listed, computer: null }] })).toContain("\tnone\t");
    expect(formatAgent({ ...agent, computerId: null })).toContain("computerId\tnone");
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
    const computerCommand = program.commands.find((command) => command.name() === "computer");
    const bind = agentCommand?.commands.find((command) => command.name() === "bind");
    const create = agentCommand?.commands.find((command) => command.name() === "create");
    const update = agentCommand?.commands.find((command) => command.name() === "update");
    const list = agentCommand?.commands.find((command) => command.name() === "list");
    const connect = computerCommand?.commands.find((command) => command.name() === "connect");
    expect(agentCommand?.description()).toBe("Manage Agents available to the current Account");
    expect(computerCommand?.description()).toBe("Connect and inspect Computers available to the current Account");
    expect(connect?.description()).toBe("Enroll this Computer with a one-time code");
    expect(bind?.description()).toBe("Bind an Agent to a Computer enrolled by this Account");
    expect(bind?.options.map((option) => option.long)).toEqual(expect.arrayContaining(["--computer"]));
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
      "Computer enrolled by this Account",
    );
    expect(create?.options.find((option) => option.long === "--workspace")).toBeUndefined();
    expect(list?.options.find((option) => option.long === "--workspace")).toBeUndefined();
    expect(update?.options.find((option) => option.long === "--model")?.description).toContain("Codex only");
    expect(update?.options.find((option) => option.long === "--clear-model")?.description).toContain("Codex manage");
    expect(update?.options.find((option) => option.long === "--clear-max-duration")?.description).toContain(
      "OpenTag default",
    );
  });

  it("executes Agent lifecycle, projection, mutation, and IM command actions", async () => {
    const createSpy = vi.spyOn(agentMutations, "runAgentCreate").mockResolvedValue({ agent, warning: "offline" });
    const updateSpy = vi.spyOn(agentMutations, "runAgentUpdate").mockResolvedValue({ ...agent, revision: 2 });
    const listSpy = vi.spyOn(agentQueries, "runAgentList").mockResolvedValue({ agents: [agentSummary] });
    const showSpy = vi.spyOn(agentQueries, "runAgentShow").mockResolvedValue(agent);
    const deleteSpy = vi.spyOn(agentMutations, "runAgentDelete").mockResolvedValue(`Deleted Agent ${agentId}`);
    const suspendSpy = vi.spyOn(agentMutations, "runAgentSuspend").mockResolvedValue({ ...agent, status: "suspended" });
    const reactivateSpy = vi.spyOn(agentMutations, "runAgentReactivate").mockResolvedValue(agent);
    const binding = {
      id: crypto.randomUUID(),
      agentId,
      provider: "feishu" as const,
      identity: { provider: "feishu" as const, appId: "app", teamId: null, botOpenId: "bot", teamBrand: null },
      receiveMode: "mention_only" as const,
      bindingState: "active" as const,
      bot: { displayName: "Feishu", avatarUrl: null },
      credentialGeneration: 1,
      reauthorizationRequired: false,
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
      grantedCapabilities: [],
      lastErrorCode: null,
    };
    const showImSpy = vi.spyOn(agentIm, "runImBindingShow").mockResolvedValue(binding);
    const connectImSpy = vi.spyOn(agentIm, "runImBindingConnectFeishu").mockResolvedValue({
      id: crypto.randomUUID(),
      agentId,
      intent: "create",
      state: "awaiting_user",
      qrUrl: "https://example.test/qr",
      expiresAt: "2026-08-19T00:01:00.000Z",
      errorCode: null,
      completedAt: null,
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const diagnoseSpy = vi.spyOn(agentIm, "runImBindingDiagnose").mockResolvedValue({
      imBindingId: binding.id,
      provider: "feishu",
      ready: true,
      agentRuntimeReadiness: "ready",
      providerCliReadiness: "ready",
      credentialGeneration: 1,
      credentialStatus: "valid",
      requiredCapabilities: [],
      grantedCapabilities: [],
      missingCapabilities: [],
      reauthorizationRequired: false,
      slackAppId: null,
      slackIdentityClosure: null,
      connection: null,
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
      lastErrorCode: null,
    });
    const disableSpy = vi.spyOn(agentIm, "runImBindingDisable").mockResolvedValue(undefined);
    const receiveSpy = vi
      .spyOn(agentIm, "runReceiveModeSet")
      .mockResolvedValue({ ...agent, receiveMode: "all_message" });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const commands = [
        ["agent", "create", "--name", "reviewer", "--display-name", "Reviewer", "--provider", "codex"],
        ["agent", "update", agentId, "--display-name", "Reviewer", "--clear-model"],
        ["agent", "list"],
        ["agent", "show", agentId],
        ["agent", "delete", agentId],
        ["agent", "suspend", agentId],
        ["agent", "reactivate", agentId],
        ["agent", "im", "show", agentId],
        ["agent", "im", "connect-feishu", agentId],
        ["agent", "im", "reauthorize-feishu", agentId],
        ["agent", "im", "diagnose", agentId],
        ["agent", "im", "disable", agentId],
        ["agent", "receive-mode", "set", agentId, "all-message"],
      ] as string[][];
      for (const args of commands) await createProgram().parseAsync(["node", "opentag", ...args]);
      await expect(
        createProgram().parseAsync(["node", "opentag", "agent", "receive-mode", "set", agentId, "invalid"]),
      ).rejects.toThrow("Receive mode must be all-message or mention-only");
      expect(createSpy).toHaveBeenCalledOnce();
      expect(updateSpy).toHaveBeenCalledWith(agentId, expect.objectContaining({ clearModel: true }));
      expect(listSpy).toHaveBeenCalledOnce();
      expect(showSpy).toHaveBeenCalledWith(agentId);
      expect(deleteSpy).toHaveBeenCalledWith(agentId);
      expect(suspendSpy).toHaveBeenCalledWith(agentId);
      expect(reactivateSpy).toHaveBeenCalledWith(agentId);
      expect(showImSpy).toHaveBeenCalledWith(agentId);
      expect(connectImSpy).toHaveBeenCalledWith(agentId, "create");
      expect(connectImSpy).toHaveBeenCalledWith(agentId, "reauthorize");
      expect(diagnoseSpy).toHaveBeenCalledWith(agentId);
      expect(disableSpy).toHaveBeenCalledWith(agentId);
      expect(receiveSpy).toHaveBeenCalledWith(agentId, "all_message");
      expect(stderr).toHaveBeenCalledWith("offline\n");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = previousExitCode;
      createSpy.mockRestore();
      updateSpy.mockRestore();
      listSpy.mockRestore();
      showSpy.mockRestore();
      deleteSpy.mockRestore();
      suspendSpy.mockRestore();
      reactivateSpy.mockRestore();
      showImSpy.mockRestore();
      connectImSpy.mockRestore();
      diagnoseSpy.mockRestore();
      disableSpy.mockRestore();
      receiveSpy.mockRestore();
    }
  });

  it("presents unauthenticated Agent bind failures without a rejected Commander action", async () => {
    const bindSpy = vi
      .spyOn(agentMutations, "runAgentBind")
      .mockRejectedValue(new Error("OpenTag is not logged in; run login first"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await createProgram().parseAsync(["node", "opentag", "agent", "bind", agentId]);
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("OpenTag is not logged in; run login first"));
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
      bindSpy.mockRestore();
    }
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
