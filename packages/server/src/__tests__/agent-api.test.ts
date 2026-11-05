import {
  AGENT_ACTIVITY_QUEUED_COUNT_HEADER,
  AGENT_ACTIVITY_TASK_COUNT_HEADER,
  accountAgentCreationIntentPath,
  agentByIdPath,
  agentComputerRebindPath,
  agentConfigPath,
  agentContextTreePath,
  agentReactivatePath,
  agentSuspendPath,
  agentUsagePath,
  HTTP_PATHS,
  OPENTAG_PLATFORM_INSTRUCTIONS,
  RUNTIME_INSTRUCTIONS_MAX_BYTES,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ContextTreeOperationService } from "../services/agents/context-tree-operation-service.js";
import type { AgentService } from "../services/agents/index.js";
import { AgentServiceError } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const creationIntentId = "a3adbe5e-8e8e-4ac2-a013-b026684ab185";
const agent = {
  id: agentId,
  createdByUserId: userId,
  computerId,
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex" as const,
  receiveMode: "all_message" as const,
  selfConfigurationEnabled: false,
  status: "active" as const,
  revision: 1,
  runtimeConfig: {
    permissions: { approvalPolicy: "on-request", allowCommands: [] },
    contextTrees: [],
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
  selfConfigurationEnabled: _selfConfigurationEnabled,
  ...agentBase
} = agent;
const agentSummary = {
  ...agentBase,
  createdBy: { userId: createdByUserId, displayName: "Admin" },
  computer: { computerId: agentComputerId, displayName: "Laptop", platform: "linux" as const },
};
const agentListItem = {
  ...agentSummary,
  activity: { state: "idle" as const },
  usage: { windowDays: 30 as const, tasks: 0, failed: 0, tokens: 0 },
};
const agentDetail = { ...agentSummary, activity: { state: "idle" as const } };
const agentUsage = {
  windowDays: 30 as const,
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

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function authService(): UserAuthService {
  return {
    exchangeConnectCode: vi.fn(),
    refresh: vi.fn(),
    getActiveUserById: vi.fn(),
    updateSelfProfile: vi.fn(),
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      me: {
        user: { id: userId, email: "admin@example.com", displayName: "Admin" },
        setupCompletedAt: null,
      },
    }),
  };
}

function agentService() {
  return {
    createForAccount: vi.fn().mockResolvedValue(agent),
    getCreationIntentResultForAccount: vi.fn().mockResolvedValue({ kind: "found", agentId }),
    listForAccount: vi.fn().mockResolvedValue({ agents: [agentListItem] }),
    getById: vi.fn().mockResolvedValue(agentDetail),
    getUsageById: vi.fn().mockResolvedValue(agentUsage),
    getConfigById: vi.fn().mockResolvedValue(agent),
    updateById: vi.fn().mockResolvedValue({ ...agent, displayName: "Reviewer", revision: 2 }),
    suspendById: vi.fn().mockResolvedValue({ ...agent, status: "suspended", revision: 2 }),
    reactivateById: vi.fn().mockResolvedValue({ ...agent, revision: 3 }),
    rebindById: vi.fn().mockResolvedValue({ ...agent, computerId }),
    deleteById: vi.fn().mockResolvedValue(undefined),
  };
}

function appWith(service = agentService(), slackOAuthAvailable?: boolean) {
  const app = createApp({
    authService: authService(),
    agentService: service as unknown as AgentService,
    ...(slackOAuthAvailable === undefined ? {} : { slackOAuthAvailable }),
  });
  apps.push(app);
  return { app, service };
}

const authorization = { authorization: "Bearer access" };

describe("Agent HTTP API", () => {
  it("creates and lists Account Agents through strict contracts", async () => {
    const { app, service } = appWith();
    const create = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountAgents,
      headers: authorization,
      payload: {
        creationIntentId,
        name: " code-reviewer ",
        displayName: " Code Reviewer ",
        runtimeProvider: "codex",
        computerId,
        runtimeConfig: { model: "gpt-5.6" },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual(agent);
    expect(service.createForAccount).toHaveBeenCalledWith(userId, {
      creationIntentId,
      name: "code-reviewer",
      displayName: "Code Reviewer",
      runtimeProvider: "codex",
      computerId,
      runtimeConfig: { model: "gpt-5.6" },
    });

    const list = await app.inject({ method: "GET", url: HTTP_PATHS.accountAgents, headers: authorization });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ agents: [agentListItem] });
    expect(service.listForAccount).toHaveBeenCalledWith(userId);

    const reconciled = await app.inject({
      method: "GET",
      url: accountAgentCreationIntentPath(creationIntentId),
      headers: authorization,
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.headers["cache-control"]).toBe("no-store");
    expect(reconciled.json()).toEqual({ kind: "found", agentId });
    expect(service.getCreationIntentResultForAccount).toHaveBeenCalledWith(userId, creationIntentId);
  });

  it("gets, CAS-updates, suspends, reactivates, and deletes an Agent", async () => {
    const { app, service } = appWith();
    expect((await app.inject({ method: "GET", url: agentByIdPath(agentId), headers: authorization })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: agentConfigPath(agentId), headers: authorization })).json()).toEqual(
      agent,
    );
    const update = await app.inject({
      method: "PATCH",
      url: agentByIdPath(agentId),
      headers: authorization,
      payload: {
        displayName: " Reviewer ",
        expectedRevision: 1,
        runtimeConfig: { instructions: null, maxDurationMs: null, model: null },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(service.updateById).toHaveBeenCalledWith(userId, agentId, {
      displayName: "Reviewer",
      expectedRevision: 1,
      runtimeConfig: { instructions: null, maxDurationMs: null, model: null },
    });
    const suspended = await app.inject({ method: "POST", url: agentSuspendPath(agentId), headers: authorization });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({ status: "suspended", revision: 2 });
    expect(service.suspendById).toHaveBeenCalledWith(userId, agentId);
    const reactivated = await app.inject({ method: "POST", url: agentReactivatePath(agentId), headers: authorization });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json()).toMatchObject({ status: "active", revision: 3 });
    expect(service.reactivateById).toHaveBeenCalledWith(userId, agentId);
    const rebound = await app.inject({
      method: "POST",
      url: agentComputerRebindPath(agentId),
      headers: authorization,
      payload: { computerId },
    });
    expect(rebound.statusCode).toBe(200);
    expect(service.rebindById).toHaveBeenCalledWith(userId, agentId, computerId);
    const deleted = await app.inject({ method: "DELETE", url: agentByIdPath(agentId), headers: authorization });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(service.deleteById).toHaveBeenCalledWith(userId, agentId);
  });

  it.each([false, true])("projects Slack OAuth availability on Agent reads (%s)", async (slackOAuthAvailable) => {
    const { app } = appWith(undefined, slackOAuthAvailable);

    const detail = await app.inject({ method: "GET", url: agentByIdPath(agentId), headers: authorization });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ slackOAuthAvailable });

    const list = await app.inject({ method: "GET", url: HTTP_PATHS.accountAgents, headers: authorization });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ agents: [{ slackOAuthAvailable }] });
  });

  it("lets the owning Account enable Agent self-configuration", async () => {
    const service = agentService();
    service.updateById.mockResolvedValueOnce({ ...agent, selfConfigurationEnabled: true, revision: 2 });
    const { app } = appWith(service);

    const response = await app.inject({
      method: "PATCH",
      url: agentByIdPath(agentId),
      headers: authorization,
      payload: { expectedRevision: 1, selfConfigurationEnabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ selfConfigurationEnabled: true, revision: 2 });
    expect(service.updateById).toHaveBeenCalledWith(userId, agentId, {
      expectedRevision: 1,
      selfConfigurationEnabled: true,
    });
  });

  it("gets Agent usage through a strict supported period and optional IANA timezone", async () => {
    const { app, service } = appWith();
    const response = await app.inject({ method: "GET", url: agentUsagePath(agentId, 30), headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(agentUsage);
    expect(service.getUsageById).toHaveBeenCalledWith(userId, agentId, 30, "UTC");

    const localized = await app.inject({
      method: "GET",
      url: agentUsagePath(agentId, 30, "Asia/Shanghai"),
      headers: authorization,
    });
    expect(localized.statusCode).toBe(200);
    expect(service.getUsageById).toHaveBeenCalledWith(userId, agentId, 30, "Asia/Shanghai");

    const invalid = await app.inject({ method: "GET", url: agentUsagePath(agentId, 14), headers: authorization });
    expect(invalid.statusCode).toBe(400);
    const invalidOffset = await app.inject({
      method: "GET",
      url: `${agentUsagePath(agentId, 30)}&timezone=%2B08%3A00`,
      headers: authorization,
    });
    expect(invalidOffset.statusCode).toBe(400);
    const invalidZone = await app.inject({
      method: "GET",
      url: `${agentUsagePath(agentId, 30)}&timezone=Mars%2FPhobos`,
      headers: authorization,
    });
    expect(invalidZone.statusCode).toBe(400);
    expect(service.getUsageById).toHaveBeenCalledTimes(2);
  });

  it("rejects missing credentials, invalid params, and immutable authority fields", async () => {
    const { app, service } = appWith();
    expect((await app.inject({ method: "GET", url: HTTP_PATHS.accountAgents })).statusCode).toBe(401);
    const invalidParam = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.accountAgents}/not-a-uuid`,
      headers: authorization,
    });
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

  it("returns safe field issues for an invalid Agent name", async () => {
    const { app, service } = appWith();
    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountAgents,
      headers: authorization,
      payload: {
        name: "Best ony",
        displayName: "Bestony",
        runtimeProvider: "codex",
        computerId,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        category: "validation",
        message: "The request payload is invalid",
        issues: [
          {
            path: ["name"],
            code: "invalid_format",
            message:
              "Agent name may contain only letters, numbers, Chinese characters, and hyphens, and must not start with a hyphen",
          },
        ],
      },
    });
    expect(service.createForAccount).not.toHaveBeenCalled();
  });

  it("rejects instructions that cannot fit beside the required platform policy", async () => {
    const { app, service } = appWith();
    const platformBytes = new TextEncoder().encode(OPENTAG_PLATFORM_INSTRUCTIONS).byteLength;
    const tooLarge = `${"界".repeat(Math.floor((RUNTIME_INSTRUCTIONS_MAX_BYTES - platformBytes) / 3))}aaaa`;
    const create = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountAgents,
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
    expect(service.createForAccount).not.toHaveBeenCalled();

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
    ["AGENT_CREATION_INTENT_CONFLICT", 409],
    ["AGENT_NAME_CONFLICT", 409],
    ["AGENT_REVISION_CONFLICT", 409],
    ["AGENT_LIFECYCLE_CONFLICT", 409],
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

  it("sends the detail's running Task count only to clients that declare they read it", async () => {
    const service = agentService();
    const working = { state: "working" as const, startedAt: agentDetail.updatedAt, runningTaskCount: 3 };
    service.getById.mockResolvedValue({ ...agentDetail, activity: working });
    const { app } = appWith(service);

    const legacy = await app.inject({ method: "GET", url: agentByIdPath(agentId), headers: authorization });
    expect(legacy.json().activity).toEqual({ state: "working", startedAt: agentDetail.updatedAt });

    const current = await app.inject({
      method: "GET",
      url: agentByIdPath(agentId),
      headers: { ...authorization, [AGENT_ACTIVITY_TASK_COUNT_HEADER]: "1" },
    });
    expect(current.json().activity).toEqual(working);
  });

  it("returns each activity count only to clients that declared it", async () => {
    const service = agentService();
    const queued = {
      state: "working" as const,
      startedAt: agentDetail.updatedAt,
      runningTaskCount: 1,
      queuedTaskCount: 2,
    };
    service.getById.mockResolvedValue({ ...agentDetail, activity: queued });
    const { app } = appWith(service);
    const read = (headers: Record<string, string>) =>
      app.inject({ method: "GET", url: agentByIdPath(agentId), headers: { ...authorization, ...headers } });
    const running = { [AGENT_ACTIVITY_TASK_COUNT_HEADER]: "1" };
    const waiting = { [AGENT_ACTIVITY_QUEUED_COUNT_HEADER]: "1" };

    expect((await read({})).json().activity).toEqual({ state: "working", startedAt: agentDetail.updatedAt });
    expect((await read(running)).json().activity).toEqual({
      state: "working",
      startedAt: agentDetail.updatedAt,
      runningTaskCount: 1,
    });
    expect((await read(waiting)).json().activity).toEqual({
      state: "working",
      startedAt: agentDetail.updatedAt,
      queuedTaskCount: 2,
    });
    expect((await read({ ...running, ...waiting })).json().activity).toEqual(queued);
    // An unknown version is not a declaration.
    expect((await read({ [AGENT_ACTIVITY_TASK_COUNT_HEADER]: "2" })).json().activity).toEqual({
      state: "working",
      startedAt: agentDetail.updatedAt,
    });
  });

  it("preserves malformed JSON as a typed client error", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountAgents,
      headers: { ...authorization, "content-type": "application/json" },
      payload: "{",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", category: "validation" } });
    expect(response.json().error).not.toHaveProperty("issues");
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

it("serves authenticated, uncached Context Tree availability with Account-scoped Agent ownership", async () => {
  const service = agentService();
  const availability = vi.fn(async () => ({ status: "failed" as const, code: "github_not_configured" as const }));
  const contextTree = new ContextTreeOperationService(
    { getConfigById: service.getConfigById, updateContextTreeSelection: vi.fn() },
    { currentInstanceId: () => "peer", supportsCapability: () => true },
    { availability, computerKind: async () => "local", run: vi.fn() },
  );
  const app = createApp({
    authService: authService(),
    agentService: service as unknown as AgentService,
    contextTreeOperationService: contextTree,
  });
  apps.push(app);
  const response = await app.inject({ method: "GET", url: agentContextTreePath(agentId), headers: authorization });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual({ status: "failed", code: "github_not_configured" });
  expect(service.getConfigById).toHaveBeenCalledWith(userId, agentId);
  expect(availability).toHaveBeenCalledWith(userId, agentId);
  service.getConfigById.mockRejectedValueOnce(
    new AgentServiceError("RESOURCE_NOT_FOUND", "deterministic", "Agent not found", 404),
  );
  expect(
    (await app.inject({ method: "GET", url: agentContextTreePath(agentId), headers: authorization })).statusCode,
  ).toBe(404);
  expect(availability).toHaveBeenCalledOnce();
  expect((await app.inject({ method: "GET", url: agentContextTreePath(agentId) })).statusCode).toBe(401);
});
