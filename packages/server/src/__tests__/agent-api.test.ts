import {
  agentByIdPath,
  OPENTAG_PLATFORM_INSTRUCTIONS,
  RUNTIME_INSTRUCTIONS_MAX_BYTES,
  teamAgentsPath,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AgentService } from "../services/agents/index.js";
import { AgentServiceError } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
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
  runtimeConfig: {
    revision: 1,
    model: null,
    reasoningEffort: null,
    instructions: "Follow instructions.",
    allowedTools: ["opentag_message_react", "opentag_message_reply", "opentag_message_send"] as const,
    maxDurationMs: null,
  },
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
};
const { runtimeConfig, ...agentBase } = agent;
const agentSummary = { ...agentBase, runtimeConfigRevision: runtimeConfig.revision };

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Admin" },
        memberships: [{ teamId, teamName: "example", teamDisplayName: "Example", role: "admin" }],
      },
    }),
  };
}

function agentService() {
  return {
    createForTeam: vi.fn().mockResolvedValue(agent),
    listForTeam: vi.fn().mockResolvedValue({ agents: [agentSummary] }),
    getById: vi.fn().mockResolvedValue(agent),
    updateById: vi.fn().mockResolvedValue({ ...agent, displayName: "Reviewer", revision: 2 }),
    deleteById: vi.fn().mockResolvedValue(undefined),
  };
}

function appWith(service = agentService()) {
  const app = createApp({ authService: authService(), agentService: service as unknown as AgentService });
  apps.push(app);
  return { app, service };
}

const authorization = { authorization: "Bearer access" };

describe("Agent HTTP API", () => {
  it("creates and lists Team Agents through strict contracts", async () => {
    const { app, service } = appWith();
    const create = await app.inject({
      method: "POST",
      url: teamAgentsPath(teamId),
      headers: authorization,
      payload: {
        name: " code-reviewer ",
        displayName: " Code Reviewer ",
        runtimeProvider: "codex",
        computerId,
        runtimeConfig: { allowedTools: ["opentag_message_send", "opentag_message_react"], model: "gpt-5.6" },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual(agent);
    expect(service.createForTeam).toHaveBeenCalledWith(userId, teamId, {
      name: "code-reviewer",
      displayName: "Code Reviewer",
      runtimeProvider: "codex",
      computerId,
      runtimeConfig: { allowedTools: ["opentag_message_react", "opentag_message_send"], model: "gpt-5.6" },
    });

    const list = await app.inject({ method: "GET", url: teamAgentsPath(teamId), headers: authorization });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ agents: [agentSummary] });
    expect(service.listForTeam).toHaveBeenCalledWith(userId, teamId);
  });

  it("gets, CAS-updates, and deletes an Agent", async () => {
    const { app, service } = appWith();
    expect((await app.inject({ method: "GET", url: agentByIdPath(agentId), headers: authorization })).statusCode).toBe(
      200,
    );
    const update = await app.inject({
      method: "PATCH",
      url: agentByIdPath(agentId),
      headers: authorization,
      payload: {
        displayName: " Reviewer ",
        expectedRevision: 1,
        runtimeConfig: { maxDurationMs: null, model: null },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(service.updateById).toHaveBeenCalledWith(userId, agentId, {
      displayName: "Reviewer",
      expectedRevision: 1,
      runtimeConfig: { maxDurationMs: null, model: null },
    });
    const deleted = await app.inject({ method: "DELETE", url: agentByIdPath(agentId), headers: authorization });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(service.deleteById).toHaveBeenCalledWith(userId, agentId);
  });

  it("rejects missing credentials, invalid params, and immutable authority fields", async () => {
    const { app, service } = appWith();
    expect((await app.inject({ method: "GET", url: teamAgentsPath(teamId) })).statusCode).toBe(401);
    const invalidParam = await app.inject({ method: "GET", url: teamAgentsPath("not-a-uuid"), headers: authorization });
    expect(invalidParam.statusCode).toBe(400);
    const immutable = await app.inject({
      method: "PATCH",
      url: agentByIdPath(agentId),
      headers: authorization,
      payload: { displayName: "Reviewer", expectedRevision: 1, computerId },
    });
    expect(immutable.statusCode).toBe(400);
    expect(service.updateById).not.toHaveBeenCalled();
  });

  it("rejects instructions that cannot fit beside the required platform policy", async () => {
    const { app, service } = appWith();
    const platformBytes = new TextEncoder().encode(OPENTAG_PLATFORM_INSTRUCTIONS).byteLength;
    const tooLarge = `${"界".repeat(Math.floor((RUNTIME_INSTRUCTIONS_MAX_BYTES - platformBytes) / 3))}aaaa`;
    const create = await app.inject({
      method: "POST",
      url: teamAgentsPath(teamId),
      headers: authorization,
      payload: {
        computerId,
        displayName: "Code Reviewer",
        name: "code-reviewer",
        runtimeProvider: "codex",
        runtimeConfig: { instructions: tooLarge },
      },
    });
    expect(create.statusCode).toBe(400);
    expect(service.createForTeam).not.toHaveBeenCalled();

    const update = await app.inject({
      method: "PATCH",
      url: agentByIdPath(agentId),
      headers: authorization,
      payload: { expectedRevision: 1, runtimeConfig: { instructions: tooLarge } },
    });
    expect(update.statusCode).toBe(400);
    expect(service.updateById).not.toHaveBeenCalled();
  });

  it.each([
    ["AGENT_FORBIDDEN", 403],
    ["COMPUTER_NOT_FOUND", 404],
    ["RESOURCE_NOT_FOUND", 404],
    ["AGENT_NAME_CONFLICT", 409],
    ["AGENT_REVISION_CONFLICT", 409],
  ] as const)("maps %s to HTTP %s", async (code, statusCode) => {
    const service = agentService();
    service.getById.mockRejectedValue(
      new AgentServiceError(code, "deterministic", "The Agent request failed", statusCode),
    );
    const { app } = appWith(service);
    const response = await app.inject({ method: "GET", url: agentByIdPath(agentId), headers: authorization });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ error: { code, category: "deterministic" } });
  });

  it("preserves malformed JSON as a typed client error", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: teamAgentsPath(teamId),
      headers: { ...authorization, "content-type": "application/json" },
      payload: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", category: "validation" } });
  });

  it("classifies an invalid service response as a typed internal error", async () => {
    const service = agentService();
    service.getById.mockResolvedValue({ ...agent, deletedAt: null });
    const { app } = appWith(service);
    const response = await app.inject({ method: "GET", url: agentByIdPath(agentId), headers: authorization });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR", category: "transient" } });
  });
});
