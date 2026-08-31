import { HTTP_PATHS, PROVIDER_READINESS_V1_HEADER, workspaceComputersPath } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ComputerService, MachineAuthService } from "../services/computers/index.js";
import { OnboardingResetError } from "../services/onboarding-reset/index.js";
import type { TaskService } from "../services/tasks/index.js";
import type { WorkspaceSetupService } from "../services/workspaces/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const authorization = { authorization: "Bearer access" };

const agent = {
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
const agentListItem = {
  id: agentId,
  name: agent.name,
  displayName: agent.displayName,
  runtimeProvider: agent.runtimeProvider,
  receiveMode: agent.receiveMode,
  status: agent.status,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
  createdBy: { userId, displayName: "Admin" },
  computer: { computerId, displayName: "Laptop", platform: "linux" as const },
  activity: { state: "idle" as const },
  usage: { windowDays: 30 as const, tasks: 0, failed: 0, tokens: 0 },
};
const computerSummary = {
  computerId,
  displayName: "Laptop",
  platform: "linux" as const,
  connectionStatus: "online" as const,
  connectedAt: "2026-08-19T00:00:00.000Z",
  lastSeenAt: "2026-08-19T00:00:00.000Z",
  observedAt: "2026-08-19T00:00:00.000Z",
  enrolledAt: "2026-08-18T00:00:00.000Z",
  agentIds: [agentId],
};
const createAgentPayload = {
  name: "code-reviewer",
  displayName: "Code Reviewer",
  runtimeProvider: "codex" as const,
  computerId,
};
const taskSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  agent: { id: agentId, name: agent.name, displayName: agent.displayName, runtimeProvider: agent.runtimeProvider },
  source: { provider: "feishu" as const, conversationKind: "dm" as const, channelId: "oc_debug", threadKey: null },
  sessionKind: "channel" as const,
  title: "Inspect the latest Turn",
  status: "completed" as const,
  createdAt: "2026-08-19T00:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-08-19T00:01:00.000Z",
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

function services() {
  return {
    agentService: {
      createForAccount: vi.fn().mockResolvedValue(agent),
      listForAccount: vi.fn().mockResolvedValue({ agents: [agentListItem] }),
      getById: vi.fn(),
      getUsageById: vi.fn(),
      getConfigById: vi.fn(),
      updateById: vi.fn(),
      suspendById: vi.fn(),
      reactivateById: vi.fn(),
      deleteById: vi.fn(),
    },
    machineAuthService: {
      issueForAccount: vi.fn().mockResolvedValue({
        code: "connect-code-value",
        expiresIn: 900,
        issuedAt: new Date("2026-08-19T00:00:00.000Z"),
        mode: "create",
      }),
    },
    taskService: {
      list: vi.fn().mockResolvedValue({ tasks: [taskSummary], nextCursor: null }),
      get: vi.fn().mockResolvedValue({
        task: taskSummary,
        turns: [],
        internalSessions: [],
        collaborationMessages: [],
        nextCursor: null,
      }),
    },
    computerService: {
      listAccountComputers: vi.fn().mockResolvedValue({ computers: [computerSummary] }),
    },
    workspaceSetupService: {
      complete: vi.fn().mockResolvedValue({ setupCompletedAt: "2026-08-19T00:00:00.000Z" }),
      completeForAccount: vi.fn().mockResolvedValue({ setupCompletedAt: "2026-08-19T00:00:00.000Z" }),
    },
  };
}

function appWith(
  overrides: Partial<ReturnType<typeof services>> = {},
  setupReset?: { reboard: ReturnType<typeof vi.fn>; resetOnboarding: ReturnType<typeof vi.fn> },
) {
  const service = { ...services(), ...overrides };
  const app = createApp({
    ...(setupReset ? { setupResetService: setupReset as never } : {}),
    authService: authService(),
    agentService: service.agentService as unknown as AgentService,
    machineAuthService: service.machineAuthService as unknown as MachineAuthService,
    taskService: service.taskService as unknown as TaskService,
    computerService: service.computerService as unknown as ComputerService,
    workspaceSetupService: service.workspaceSetupService as unknown as WorkspaceSetupService,
    computerConnectCode: { environment: "dev", publicUrl: "https://opentag.example" },
  });
  apps.push(app);
  return { app, service };
}

describe("undoing setup on the authenticated Account", () => {
  function resetService() {
    return { reboard: vi.fn().mockResolvedValue(undefined), resetOnboarding: vi.fn().mockResolvedValue(undefined) };
  }

  it("routes each mode to the operation it names", async () => {
    const setupReset = resetService();
    const { app } = appWith({}, setupReset);

    const all = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountSetupReset,
      headers: authorization,
      payload: { mode: "all" },
    });
    expect(all.statusCode).toBe(204);
    expect(setupReset.resetOnboarding).toHaveBeenCalledWith(userId);
    expect(setupReset.reboard).not.toHaveBeenCalled();

    const reboard = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountSetupReset,
      headers: authorization,
      payload: { mode: "reboard" },
    });
    expect(reboard.statusCode).toBe(204);
    expect(setupReset.reboard).toHaveBeenCalledWith(userId);
    expect(setupReset.resetOnboarding).toHaveBeenCalledTimes(1);
  });

  it("takes the Account from the token, so no body can name another one", async () => {
    const setupReset = resetService();
    const { app } = appWith({}, setupReset);

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountSetupReset,
      headers: authorization,
      payload: { mode: "reboard", accountId: "11111111-1111-4111-8111-111111111111" },
    });

    // Rejected outright rather than ignored: a caller who thought they were choosing an Account
    // should be told they were not.
    expect(response.statusCode).toBe(400);
    expect(setupReset.reboard).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const setupReset = resetService();
    const { app } = appWith({}, setupReset);

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountSetupReset,
      payload: { mode: "reboard" },
    });

    expect(response.statusCode).toBe(401);
    expect(setupReset.reboard).not.toHaveBeenCalled();
  });

  it("reports a refused reset as the deterministic conflict the service raised", async () => {
    const setupReset = resetService();
    const { app } = appWith({}, setupReset);
    setupReset.resetOnboarding.mockRejectedValueOnce(
      new OnboardingResetError("ONBOARDING_RESET_UNVERIFIED", 409, "The Account still has active OpenTag resources"),
    );

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountSetupReset,
      headers: authorization,
      payload: { mode: "all" },
    });

    // A refusal the caller can act on, not a failure: the reset stopped before clearing setup, so
    // the same request is worth making again once the Account is quiet.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "ONBOARDING_RESET_UNVERIFIED",
        category: "deterministic",
        message: "The Account still has active OpenTag resources",
      },
    });
  });

  it("is not registered when the deployment does not offer it", async () => {
    const { app } = appWith();

    const response = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountSetupReset,
      headers: authorization,
      payload: { mode: "reboard" },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe("Account-native management collections", () => {
  it("lists and reads read-only Tasks in the authenticated Account scope", async () => {
    const { app, service } = appWith();

    const list = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.accountTasks}?limit=25&kind=channel&agentId=${agentId}`,
      headers: authorization,
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.json()).toEqual({ tasks: [taskSummary], nextCursor: null });
    expect(service.taskService.list).toHaveBeenCalledWith(userId, {
      agentId,
      kind: "channel",
      limit: 25,
    });

    const detail = await app.inject({
      method: "GET",
      url: `${HTTP_PATHS.accountTasks}/${taskSummary.id}`,
      headers: authorization,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(service.taskService.get).toHaveBeenCalledWith(userId, taskSummary.id, { limit: 50 });
  });

  it("creates and lists Agents without a client-selected scope", async () => {
    const { app, service } = appWith();

    const create = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountAgents,
      headers: authorization,
      payload: createAgentPayload,
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual(agent);
    expect(service.agentService.createForAccount).toHaveBeenCalledWith(userId, createAgentPayload);

    const list = await app.inject({ method: "GET", url: HTTP_PATHS.accountAgents, headers: authorization });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ agents: [agentListItem] });
    expect(service.agentService.listForAccount).toHaveBeenCalledWith(userId);
  });

  it("does not register management Workspace routes", async () => {
    const { app } = appWith();
    const response = await app.inject({
      method: "GET",
      url: workspaceComputersPath(workspaceId),
      headers: authorization,
    });
    expect(response.statusCode).toBe(404);
  });

  it("forwards the provider readiness opt-in header", async () => {
    const { app, service } = appWith();
    await app.inject({
      method: "GET",
      url: HTTP_PATHS.accountComputers,
      headers: { ...authorization, [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
    expect(service.computerService.listAccountComputers).toHaveBeenCalledWith(userId, true);

    await app.inject({ method: "GET", url: HTTP_PATHS.accountComputers, headers: authorization });
    expect(service.computerService.listAccountComputers).toHaveBeenLastCalledWith(userId, false);
  });

  it("rejects a client-selected scope on every creation route", async () => {
    const { app, service } = appWith();

    const routes = [
      { url: HTTP_PATHS.accountAgents, base: createAgentPayload },
      { url: HTTP_PATHS.accountComputerConnectCodes, base: {} },
      { url: HTTP_PATHS.accountSetupComplete, base: { agentId } },
    ];
    for (const route of routes) {
      for (const selector of [{ workspaceId }, { accountId: userId }]) {
        const response = await app.inject({
          method: "POST",
          url: route.url,
          headers: authorization,
          payload: { ...route.base, ...selector },
        });
        expect({ url: route.url, selector, status: response.statusCode }).toEqual({
          url: route.url,
          selector,
          status: 400,
        });
        expect(response.json().error.code).toBe("VALIDATION_ERROR");
      }
    }

    expect(service.agentService.createForAccount).not.toHaveBeenCalled();
    expect(service.machineAuthService.issueForAccount).not.toHaveBeenCalled();
    expect(service.workspaceSetupService.completeForAccount).not.toHaveBeenCalled();
  });

  it("still issues a connect code for an empty or absent body", async () => {
    const { app, service } = appWith();

    for (const payload of [undefined, {}]) {
      const response = await app.inject({
        method: "POST",
        url: HTTP_PATHS.accountComputerConnectCodes,
        headers: authorization,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(201);
    }
    expect(service.machineAuthService.issueForAccount).toHaveBeenCalledTimes(2);
  });

  it("lists Account-owned collections without a compatibility Workspace", async () => {
    const { app, service } = appWith();

    for (const url of [HTTP_PATHS.accountAgents, HTTP_PATHS.accountComputers, HTTP_PATHS.accountTasks]) {
      const response = await app.inject({ method: "GET", url, headers: authorization });
      expect(response.statusCode).toBe(200);
    }
    const setup = await app.inject({
      method: "POST",
      url: HTTP_PATHS.accountSetupComplete,
      headers: authorization,
      payload: { agentId },
    });
    expect(setup.statusCode).toBe(200);
    expect(service.agentService.listForAccount).toHaveBeenCalledWith(userId);
    expect(service.computerService.listAccountComputers).toHaveBeenCalledWith(userId, false);
    expect(service.taskService.list).toHaveBeenCalledWith(userId, { limit: 50 });
    expect(service.workspaceSetupService.completeForAccount).toHaveBeenCalledWith(userId, agentId);
  });

  it("requires an authenticated Account on every collection", async () => {
    const { app, service } = appWith();

    for (const [method, url] of [
      ["GET", HTTP_PATHS.accountAgents],
      ["POST", HTTP_PATHS.accountAgents],
      ["GET", HTTP_PATHS.accountComputers],
      ["POST", HTTP_PATHS.accountComputerConnectCodes],
      ["POST", HTTP_PATHS.accountSetupComplete],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
    }
    expect(service.agentService.listForAccount).not.toHaveBeenCalled();
  });

  it("registers Account-native collections without the compatibility resolver", async () => {
    const service = services();
    const app = createApp({
      authService: authService(),
      agentService: service.agentService as unknown as AgentService,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: HTTP_PATHS.accountAgents, headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(service.agentService.listForAccount).toHaveBeenCalledWith(userId);
  });
});
