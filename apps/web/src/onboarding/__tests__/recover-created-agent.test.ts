import type { AgentAdminConfig, AgentSummary, CreateAgentRequest } from "@opentag/shared/browser";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api.js";
import {
  type AgentCreationPort,
  createOrRecoverAgent,
  findRecoverableAgent,
  isAgentNameConflict,
} from "../recover-created-agent.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const otherUserId = "7c9f0a11-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";

const request: CreateAgentRequest = {
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  computerId,
};

function summary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: agentId,
    teamId,
    name: "reviewer",
    displayName: "Reviewer",
    manager: { userId, displayName: "Ada" },
    computer: { id: computerId, displayName: "Ada's Mac", platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function config(overrides: Partial<AgentAdminConfig> = {}): AgentAdminConfig {
  return {
    id: agentId,
    teamId,
    name: "reviewer",
    displayName: "Reviewer",
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    managerUserId: userId,
    computerId,
    revision: 1,
    runtimeConfig: {
      revision: 1,
      model: null,
      reasoningEffort: null,
      instructions: "",
      allowedTools: [],
      maxDurationMs: null,
    },
    ...overrides,
  };
}

function nameConflict(): ApiError {
  return new ApiError(409, "An active Agent already uses this name", "AGENT_NAME_CONFLICT", "deterministic");
}

function port(overrides: Partial<AgentCreationPort> = {}): AgentCreationPort {
  return {
    createAgent: vi.fn(async () => config()),
    listAgents: vi.fn(async () => [summary()]),
    agentConfig: vi.fn(async () => config()),
    ...overrides,
  };
}

describe("isAgentNameConflict", () => {
  it("matches the Server name conflict envelope", () => {
    expect(isAgentNameConflict(nameConflict())).toBe(true);
  });

  it.each([
    ["a different code", new ApiError(409, "Stale", "AGENT_REVISION_CONFLICT")],
    ["a different status", new ApiError(403, "Denied", "AGENT_NAME_CONFLICT")],
    ["a plain error", new Error("Network down")],
  ])("does not match %s", (_label, error) => {
    expect(isAgentNameConflict(error)).toBe(false);
  });
});

describe("findRecoverableAgent", () => {
  it("finds the Agent this manager already owns", () => {
    expect(findRecoverableAgent([summary()], "reviewer", userId)).toBeDefined();
  });

  it("ignores a name held by another manager", () => {
    const foreign = summary({ manager: { userId: otherUserId, displayName: "Grace" } });
    expect(findRecoverableAgent([foreign], "reviewer", userId)).toBeUndefined();
  });

  it("ignores an unrelated Agent name", () => {
    expect(findRecoverableAgent([summary({ name: "builder" })], "reviewer", userId)).toBeUndefined();
  });
});

describe("createOrRecoverAgent", () => {
  it("creates the Agent when the name is free", async () => {
    const dependencies = port();
    await expect(createOrRecoverAgent(dependencies, request, userId)).resolves.toEqual({
      kind: "created",
      agent: config(),
    });
    expect(dependencies.listAgents).not.toHaveBeenCalled();
  });

  it("recovers the existing Agent after a lost create response", async () => {
    const dependencies = port({
      createAgent: vi.fn(async () => {
        throw nameConflict();
      }),
    });
    await expect(createOrRecoverAgent(dependencies, request, userId)).resolves.toEqual({
      kind: "recovered",
      agent: config(),
    });
    expect(dependencies.agentConfig).toHaveBeenCalledWith(agentId);
  });

  it("creates exactly one Agent when the create is retried", async () => {
    let created = 0;
    const dependencies = port({
      createAgent: vi.fn(async () => {
        created += 1;
        throw nameConflict();
      }),
    });
    await createOrRecoverAgent(dependencies, request, userId);
    await createOrRecoverAgent(dependencies, request, userId);
    expect(created).toBe(2);
    expect(dependencies.agentConfig).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dependencies.agentConfig).mock.calls.every(([id]) => id === agentId)).toBe(true);
  });

  it("surfaces a name held by another manager instead of adopting it", async () => {
    const dependencies = port({
      createAgent: vi.fn(async () => {
        throw nameConflict();
      }),
      listAgents: vi.fn(async () => [summary({ manager: { userId: otherUserId, displayName: "Grace" } })]),
    });
    await expect(createOrRecoverAgent(dependencies, request, userId)).rejects.toThrow(
      "An active Agent already uses this name",
    );
  });

  it("does not attempt recovery for unrelated failures", async () => {
    const dependencies = port({
      createAgent: vi.fn(async () => {
        throw new ApiError(503, "Server unavailable");
      }),
    });
    await expect(createOrRecoverAgent(dependencies, request, userId)).rejects.toThrow("Server unavailable");
    expect(dependencies.listAgents).not.toHaveBeenCalled();
  });
});
