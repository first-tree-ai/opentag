import {
  HTTP_PATHS,
  PROVIDER_READINESS_V1_HEADER,
  workspaceAgentsPath,
  workspaceComputerConnectCodesPath,
  workspaceComputersPath,
  workspaceSetupCompletePath,
} from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountScopeResolver } from "../api/account.js";
import { createApp } from "../app.js";
import type { AgentService } from "../services/agents/index.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import type { ComputerService, MachineAuthService } from "../services/computers/index.js";
import type { TaskService } from "../services/tasks/index.js";
import type { WorkspaceAdminService, WorkspaceSetupService } from "../services/workspaces/index.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const authorization = { authorization: "Bearer access" };

const agent = {
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
const agentListItem = {
  id: agentId,
  workspaceId,
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
        workspaces: [
          {
            id: workspaceId,
            name: "example",
            displayName: "Example",
            setupCompletedAt: null,
            grantedAt: "2026-08-20T00:00:00.000Z",
          },
        ],
      },
    }),
  };
}

function services() {
  return {
    accountScope: { resolveCompatibilityWorkspaceId: vi.fn().mockResolvedValue(workspaceId) },
    agentService: {
      createForWorkspace: vi.fn().mockResolvedValue(agent),
      listForWorkspace: vi.fn().mockResolvedValue({ agents: [agentListItem] }),
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
      issueForWorkspaceAdmin: vi.fn().mockResolvedValue({
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
    workspaceService: {
      listComputers: vi.fn().mockResolvedValue({ computers: [computerSummary] }),
    },
    workspaceSetupService: {
      complete: vi.fn().mockResolvedValue({ setupCompletedAt: "2026-08-19T00:00:00.000Z" }),
    },
  };
}

function appWith(overrides: Partial<ReturnType<typeof services>> = {}) {
  const service = { ...services(), ...overrides };
  const app = createApp({
    authService: authService(),
    accountScope: service.accountScope as unknown as AccountScopeResolver,
    agentService: service.agentService as unknown as AgentService,
    machineAuthService: service.machineAuthService as unknown as MachineAuthService,
    taskService: service.taskService as unknown as TaskService,
    // The legacy connect-code route is gated behind the runtime Computer service; the Account-native
    // route is not, so the equivalence comparison needs both registered.
    computerService: {} as unknown as ComputerService,
    workspaceService: service.workspaceService as unknown as WorkspaceAdminService,
    workspaceSetupService: service.workspaceSetupService as unknown as WorkspaceSetupService,
    computerConnectCode: { environment: "dev", publicUrl: "https://opentag.example" },
  });
  apps.push(app);
  return { app, service };
}

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
    expect(service.agentService.createForWorkspace).toHaveBeenCalledWith(userId, workspaceId, createAgentPayload);
    expect(service.accountScope.resolveCompatibilityWorkspaceId).toHaveBeenCalledWith(userId);

    const list = await app.inject({ method: "GET", url: HTTP_PATHS.accountAgents, headers: authorization });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ agents: [agentListItem] });
    expect(service.agentService.listForWorkspace).toHaveBeenCalledWith(userId, workspaceId);
  });

  it("returns the same resources as the legacy Workspace-scoped routes", async () => {
    const { app } = appWith();

    const [accountAgents, legacyAgents] = await Promise.all([
      app.inject({ method: "GET", url: HTTP_PATHS.accountAgents, headers: authorization }),
      app.inject({ method: "GET", url: workspaceAgentsPath(workspaceId), headers: authorization }),
    ]);
    expect(accountAgents.statusCode).toBe(legacyAgents.statusCode);
    expect(accountAgents.json()).toEqual(legacyAgents.json());

    const [accountComputers, legacyComputers] = await Promise.all([
      app.inject({ method: "GET", url: HTTP_PATHS.accountComputers, headers: authorization }),
      app.inject({ method: "GET", url: workspaceComputersPath(workspaceId), headers: authorization }),
    ]);
    expect(accountComputers.statusCode).toBe(legacyComputers.statusCode);
    expect(accountComputers.json()).toEqual(legacyComputers.json());

    const [accountSetup, legacySetup] = await Promise.all([
      app.inject({
        method: "POST",
        url: HTTP_PATHS.accountSetupComplete,
        headers: authorization,
        payload: { agentId },
      }),
      app.inject({
        method: "POST",
        url: workspaceSetupCompletePath(workspaceId),
        headers: authorization,
        payload: { agentId },
      }),
    ]);
    expect(accountSetup.statusCode).toBe(legacySetup.statusCode);
    expect(accountSetup.json()).toEqual(legacySetup.json());

    const [accountCode, legacyCode] = await Promise.all([
      app.inject({ method: "POST", url: HTTP_PATHS.accountComputerConnectCodes, headers: authorization }),
      app.inject({
        method: "POST",
        url: workspaceComputerConnectCodesPath(workspaceId),
        headers: authorization,
      }),
    ]);
    expect(accountCode.statusCode).toBe(201);
    expect(accountCode.statusCode).toBe(legacyCode.statusCode);
    expect(accountCode.json()).toEqual(legacyCode.json());
    expect(accountCode.headers["cache-control"]).toBe("no-store");
  });

  it("forwards the provider readiness opt-in header", async () => {
    const { app, service } = appWith();
    await app.inject({
      method: "GET",
      url: HTTP_PATHS.accountComputers,
      headers: { ...authorization, [PROVIDER_READINESS_V1_HEADER]: "1" },
    });
    expect(service.workspaceService.listComputers).toHaveBeenCalledWith(userId, workspaceId, true);

    await app.inject({ method: "GET", url: HTTP_PATHS.accountComputers, headers: authorization });
    expect(service.workspaceService.listComputers).toHaveBeenLastCalledWith(userId, workspaceId, false);
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

    expect(service.agentService.createForWorkspace).not.toHaveBeenCalled();
    expect(service.machineAuthService.issueForAccount).not.toHaveBeenCalled();
    expect(service.machineAuthService.issueForWorkspaceAdmin).not.toHaveBeenCalled();
    expect(service.workspaceSetupService.complete).not.toHaveBeenCalled();
    expect(service.accountScope.resolveCompatibilityWorkspaceId).not.toHaveBeenCalled();
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
    expect(service.machineAuthService.issueForWorkspaceAdmin).not.toHaveBeenCalled();
  });

  it("does not disclose whether an Account has no compatibility scope", async () => {
    const { app, service } = appWith({
      accountScope: {
        resolveCompatibilityWorkspaceId: vi
          .fn()
          .mockRejectedValue(
            new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404),
          ),
      },
    });

    for (const url of [HTTP_PATHS.accountAgents, HTTP_PATHS.accountComputers]) {
      const response = await app.inject({ method: "GET", url, headers: authorization });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("RESOURCE_NOT_FOUND");
    }
    expect(service.agentService.listForWorkspace).not.toHaveBeenCalled();
    expect(service.workspaceService.listComputers).not.toHaveBeenCalled();
  });

  it("keeps the legacy routes usable for older clients", async () => {
    const { app, service } = appWith();
    const response = await app.inject({
      method: "POST",
      url: workspaceAgentsPath(workspaceId),
      headers: authorization,
      payload: createAgentPayload,
    });
    expect(response.statusCode).toBe(201);
    expect(service.agentService.createForWorkspace).toHaveBeenCalledWith(userId, workspaceId, createAgentPayload);
    expect(service.accountScope.resolveCompatibilityWorkspaceId).not.toHaveBeenCalled();
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
    expect(service.accountScope.resolveCompatibilityWorkspaceId).not.toHaveBeenCalled();
  });

  it("registers no Account-native collection without the compatibility resolver", async () => {
    const app = createApp({
      authService: authService(),
      agentService: services().agentService as unknown as AgentService,
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: HTTP_PATHS.accountAgents, headers: authorization });
    expect(response.statusCode).toBe(404);
  });
});
