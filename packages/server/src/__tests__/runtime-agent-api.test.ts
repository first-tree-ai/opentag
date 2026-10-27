import { randomUUID } from "node:crypto";
import {
  type AgentAdminConfig,
  type MCPAgentServer,
  type MCPServer,
  RUNTIME_AGENT_MCP_SERVER_DEFINITIONS_PATH,
  RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH,
  RUNTIME_AGENT_MCP_SERVERS_PATH,
  RUNTIME_AGENT_PATH,
  runtimeAgentMcpServerCredentialsPath,
  runtimeAgentMcpServerDefinitionPath,
  runtimeAgentMcpServerOAuthStartPath,
  runtimeAgentMcpServerOAuthStatusPath,
  runtimeAgentMcpServerPath,
  SESSION_CLI_PROOF_HEADER,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { AgentSelfService, type AgentSelfServiceOptions } from "../services/agents/index.js";
import { SessionCliProofError } from "../services/sessions/index.js";

const accountId = randomUUID();
const source = {
  agentId: randomUUID(),
  computerId: randomUUID(),
  connectionInstanceId: randomUUID(),
  placementGeneration: 1,
  sessionId: randomUUID(),
  sessionKind: "channel" as const,
  installationId: randomUUID(),
};
const now = "2026-09-22T00:00:00.000Z";

const config: AgentAdminConfig = {
  id: source.agentId,
  name: "helper",
  displayName: "Helper",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  selfConfigurationEnabled: true,
  status: "active",
  createdAt: now,
  updatedAt: now,
  createdByUserId: accountId,
  computerId: source.computerId,
  revision: 3,
  runtimeConfig: {
    permissions: { approvalPolicy: "on-request", allowCommands: [] },
    revision: 7,
    model: null,
    reasoningEffort: null,
    instructions: "be brief",
    maxDurationMs: null,
    contextTrees: [],
  },
};

const mcpServerId = randomUUID();

const serverRow: MCPServer = {
  id: mcpServerId,
  name: "docs",
  description: null,
  url: "https://mcp.example.com/mcp",
  defaultAuthKind: "oauth",
  authHeader: "authorization",
  authScheme: "Bearer",
  extraHeaders: {},
  revision: 1,
  boundAgentCount: 1,
  authorizedAgentCount: 0,
  lastProbedAt: null,
  createdAt: now,
  updatedAt: now,
};

const mounted: MCPAgentServer = {
  mcpServerId,
  name: "docs",
  description: null,
  discoveredDescription: null,
  enabled: true,
  effective: {
    url: "https://mcp.example.com/mcp",
    authHeader: "Authorization",
    authScheme: "Bearer",
    extraHeaders: {},
  },
  overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
  authorization: null,
  snapshot: null,
  createdAt: now,
  updatedAt: now,
};

function fixture(overrides: Partial<AgentSelfServiceOptions> = {}) {
  const agents = {
    getConfigById: vi.fn(async () => config),
    updateById: vi.fn(async () => ({
      ...config,
      revision: 4,
      runtimeConfig: { ...config.runtimeConfig, revision: 8 },
    })),
  };
  const mcp = {
    attachServer: vi.fn(async () => mounted),
    createAndAttachServer: vi.fn(async () => mounted),
    createServer: vi.fn(async () => serverRow),
    deleteServer: vi.fn(async () => undefined),
    detachServer: vi.fn(async () => undefined),
    listAgentServers: vi.fn(async () => [mounted]),
    listAvailableServers: vi.fn(async () => [
      { id: randomUUID(), name: "search", description: null, boundAgentCount: 0 },
    ]),
    readAgentServer: vi.fn(async () => mounted),
    readServer: vi.fn(async () => ({
      id: mcpServerId,
      accountId,
      name: "docs",
      description: "Created by Agent self-service",
      url: "https://mcp.example.com/mcp",
      defaultAuthKind: "oauth" as const,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      revision: 1,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })),
    updateBinding: vi.fn(async () => ({ ...mounted, enabled: false })),
  };
  const authorization = {
    probe: vi.fn(async () => ({
      probeState: "succeeded" as const,
      probeError: null,
      toolsCount: 2,
      toolsTruncated: false,
      protocolEra: "modern" as const,
      protocolVersion: "2026-06-01",
    })),
    setBearerOrNone: vi.fn(async () => undefined),
  };
  const flows = {
    start: vi.fn(async () => ({
      authorizationUrl: "https://provider.example/authorize?x=1",
      expiresAt: new Date(now),
      state: "state-probe",
    })),
    startWithHandoff: vi.fn(async () => ({
      authorizationUrl: "https://test.local/api/v1/mcp-servers/oauth/handoff?token=handoff-token",
      expiresAt: new Date(now),
      state: "state-probe",
    })),
  };
  const proofs = { authenticate: vi.fn(async () => source) };
  const owners = {
    isSelfConfigurationEnabled: vi.fn(async () => true),
    resolveAccountId: vi.fn(async () => accountId),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new AgentSelfService({
    agents,
    authorization,
    flows,
    mcp,
    owners,
    proofs,
    logger,
    publicOrigin: "https://test.local",
    ...overrides,
  });
  const app = createApp({ runtimeAgent: { service } });
  return { agents, app, authorization, flows, logger, mcp, owners, proofs };
}

const headers = { [SESSION_CLI_PROOF_HEADER]: "proof" };

describe("Runtime Agent self-configuration routes", () => {
  it("reads and updates only the proof's Agent under its owning Account", async () => {
    const { agents, app, logger, owners, proofs } = fixture();

    const shown = await app.inject({ method: "GET", url: RUNTIME_AGENT_PATH, headers });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers["cache-control"]).toBe("no-store");
    expect(shown.json()).toMatchObject({ id: source.agentId, revision: 3 });
    expect(proofs.authenticate).toHaveBeenCalledWith("proof");
    expect(owners.resolveAccountId).toHaveBeenCalledWith(source.agentId);
    expect(agents.getConfigById).toHaveBeenCalledWith(accountId, source.agentId);

    const updated = await app.inject({
      method: "PATCH",
      url: RUNTIME_AGENT_PATH,
      headers,
      payload: { expectedRevision: 3, runtimeConfig: { instructions: "be thorough", model: null } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ revision: 4 });
    expect(agents.updateById).toHaveBeenCalledWith(accountId, source.agentId, {
      expectedRevision: 3,
      runtimeConfig: { instructions: "be thorough", model: null },
    });
    const audit = logger.info.mock.calls.find(([bindings]) => bindings.event === "agent_self.config_updated");
    expect(audit?.[0]).toMatchObject({ fields: ["instructions", "model"], revision: 4, runtimeConfigRevision: 8 });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("be thorough");
    await app.close();
  });

  it("rejects fields outside the self-configuration surface", async () => {
    const { agents, app } = fixture();
    for (const payload of [
      { expectedRevision: 3, displayName: "Renamed", runtimeConfig: { model: "m" } },
      { expectedRevision: 3, receiveMode: "all_message", runtimeConfig: { model: "m" } },
      { expectedRevision: 3, selfConfigurationEnabled: true, runtimeConfig: { model: "m" } },
      { expectedRevision: 3, runtimeConfig: { maxDurationMs: 999_999 } },
      { expectedRevision: 3, runtimeConfig: {} },
      { agentId: randomUUID(), expectedRevision: 3, runtimeConfig: { model: "m" } },
    ]) {
      const response = await app.inject({ method: "PATCH", url: RUNTIME_AGENT_PATH, headers, payload });
      expect(response.statusCode).toBe(400);
    }
    expect(agents.updateById).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects every self route while the Agent owner has disabled self-configuration", async () => {
    const { app, agents, mcp, owners } = fixture();
    owners.isSelfConfigurationEnabled.mockResolvedValue(false);

    const responses = await Promise.all([
      app.inject({ method: "GET", url: RUNTIME_AGENT_PATH, headers }),
      app.inject({
        method: "PATCH",
        url: RUNTIME_AGENT_PATH,
        headers,
        payload: { expectedRevision: 3, runtimeConfig: { model: "m" } },
      }),
      app.inject({ method: "GET", url: RUNTIME_AGENT_MCP_SERVERS_PATH, headers }),
      app.inject({ method: "GET", url: RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH, headers }),
      app.inject({
        method: "POST",
        url: RUNTIME_AGENT_MCP_SERVERS_PATH,
        headers,
        payload: { mcpServerId, enabled: true },
      }),
      app.inject({
        method: "PATCH",
        url: runtimeAgentMcpServerPath(mcpServerId),
        headers,
        payload: { enabled: false },
      }),
      app.inject({ method: "DELETE", url: runtimeAgentMcpServerPath(mcpServerId), headers }),
      app.inject({
        method: "POST",
        url: RUNTIME_AGENT_MCP_SERVER_DEFINITIONS_PATH,
        headers,
        payload: { name: "docs", url: "https://mcp.example.com/mcp" },
      }),
      app.inject({ method: "DELETE", url: runtimeAgentMcpServerDefinitionPath(mcpServerId), headers }),
      app.inject({
        method: "POST",
        url: runtimeAgentMcpServerCredentialsPath(mcpServerId),
        headers,
        payload: { apiKey: "key" },
      }),
      app.inject({ method: "POST", url: runtimeAgentMcpServerOAuthStartPath(mcpServerId), headers, payload: {} }),
      app.inject({ method: "GET", url: runtimeAgentMcpServerOAuthStatusPath(mcpServerId), headers }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403,
    ]);
    for (const response of responses) {
      expect(response.json()).toMatchObject({
        error: { code: "AGENT_SELF_CONFIGURATION_DISABLED", category: "deterministic" },
      });
    }
    expect(agents.getConfigById).not.toHaveBeenCalled();
    expect(agents.updateById).not.toHaveBeenCalled();
    expect(mcp.listAgentServers).not.toHaveBeenCalled();
    expect(mcp.attachServer).not.toHaveBeenCalled();
    expect(mcp.updateBinding).not.toHaveBeenCalled();
    expect(mcp.detachServer).not.toHaveBeenCalled();
    expect(mcp.createAndAttachServer).not.toHaveBeenCalled();
    expect(mcp.deleteServer).not.toHaveBeenCalled();
    await app.close();
  });

  it("manages MCP mounts but only toggles enablement on a binding", async () => {
    const { app, mcp } = fixture();

    const listed = await app.inject({ method: "GET", url: RUNTIME_AGENT_MCP_SERVERS_PATH, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().servers).toHaveLength(1);
    expect(mcp.listAgentServers).toHaveBeenCalledWith(accountId, source.agentId);

    const available = await app.inject({ method: "GET", url: RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH, headers });
    expect(available.statusCode).toBe(200);
    expect(available.json().servers[0]).toMatchObject({ name: "search" });
    expect(mcp.listAvailableServers).toHaveBeenCalledWith(accountId, source.agentId);

    const attached = await app.inject({
      method: "POST",
      url: RUNTIME_AGENT_MCP_SERVERS_PATH,
      headers,
      payload: { mcpServerId, enabled: false },
    });
    expect(attached.statusCode).toBe(201);
    expect(mcp.attachServer).toHaveBeenCalledWith(accountId, source.agentId, mcpServerId, false, "agent-self");

    const disabled = await app.inject({
      method: "PATCH",
      url: runtimeAgentMcpServerPath(mcpServerId),
      headers,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(mcp.updateBinding).toHaveBeenCalledWith(
      accountId,
      source.agentId,
      mcpServerId,
      { enabled: false },
      "agent-self",
    );

    const override = await app.inject({
      method: "PATCH",
      url: runtimeAgentMcpServerPath(mcpServerId),
      headers,
      payload: { enabled: true, url: "https://attacker.example/mcp" },
    });
    expect(override.statusCode).toBe(400);
    expect(mcp.updateBinding).toHaveBeenCalledTimes(1);

    const detached = await app.inject({ method: "DELETE", url: runtimeAgentMcpServerPath(mcpServerId), headers });
    expect(detached.statusCode).toBe(204);
    expect(mcp.detachServer).toHaveBeenCalledWith(accountId, source.agentId, mcpServerId, "agent-self");

    const badId = await app.inject({ method: "DELETE", url: runtimeAgentMcpServerPath("not-a-uuid"), headers });
    expect(badId.statusCode).toBe(400);
    await app.close();
  });

  it("registers a definition, mounts it, and writes the Agent's own Bearer key", async () => {
    const { app, authorization, mcp } = fixture();

    const created = await app.inject({
      method: "POST",
      url: RUNTIME_AGENT_MCP_SERVER_DEFINITIONS_PATH,
      headers,
      payload: { name: "docs", url: "https://mcp.example.com/mcp", defaultAuthKind: "bearer", apiKey: "key-1" },
    });
    expect(created.statusCode).toBe(201);
    expect(mcp.createAndAttachServer).toHaveBeenCalledWith(
      accountId,
      source.agentId,
      {
        name: "docs",
        description: "Created by Agent self-service",
        url: "https://mcp.example.com/mcp",
        defaultAuthKind: "bearer",
      },
      true,
      "agent-self",
    );
    expect(authorization.setBearerOrNone).toHaveBeenCalledWith(
      accountId,
      source.agentId,
      mcpServerId,
      { kind: "bearer", bearerKey: "key-1" },
      "agent-self",
    );
    expect(authorization.probe).toHaveBeenCalledWith(accountId, source.agentId, mcpServerId);
    expect(created.body).not.toContain("key-1");

    const rewritten = await app.inject({
      method: "POST",
      url: runtimeAgentMcpServerCredentialsPath(mcpServerId),
      headers,
      payload: { apiKey: "key-2" },
    });
    expect(rewritten.statusCode).toBe(200);
    expect(authorization.setBearerOrNone).toHaveBeenLastCalledWith(
      accountId,
      source.agentId,
      mcpServerId,
      { kind: "bearer", bearerKey: "key-2" },
      "agent-self",
    );
    expect(rewritten.body).not.toContain("key-2");
    await app.close();
  });

  it("refuses an anonymous definition and a key on an OAuth definition", async () => {
    const { app, mcp } = fixture();
    for (const payload of [
      { name: "docs", url: "https://mcp.example.com/mcp", defaultAuthKind: "none" },
      { name: "docs", url: "https://mcp.example.com/mcp", defaultAuthKind: "oauth", apiKey: "key" },
      { name: "Docs", url: "https://mcp.example.com/mcp" },
      { name: "docs", url: "not-a-url" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: RUNTIME_AGENT_MCP_SERVER_DEFINITIONS_PATH,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(mcp.createAndAttachServer).not.toHaveBeenCalled();
    await app.close();
  });

  it("unmounts the server on delete without dropping the account definition (Option 1 pure detach)", async () => {
    const { app, mcp } = fixture();
    const removed = await app.inject({
      method: "DELETE",
      url: runtimeAgentMcpServerDefinitionPath(mcpServerId),
      headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(mcp.detachServer).toHaveBeenCalledWith(accountId, source.agentId, mcpServerId, "agent-self");
    expect(mcp.deleteServer).not.toHaveBeenCalled();
    await app.close();
  });

  it("starts an OAuth flow and reports the projected status", async () => {
    const { app, flows, mcp } = fixture();

    const started = await app.inject({
      method: "POST",
      url: runtimeAgentMcpServerOAuthStartPath(mcpServerId),
      headers,
      payload: { scopes: ["read"] },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      authorizationUrl: "https://test.local/api/v1/mcp-servers/oauth/handoff?token=handoff-token",
    });
    expect(flows.startWithHandoff).toHaveBeenCalledWith(
      accountId,
      source.agentId,
      mcpServerId,
      ["read"],
      "https://test.local",
      "agent-self",
    );

    mcp.readAgentServer.mockResolvedValueOnce({
      ...mounted,
      authorization: {
        kind: "oauth",
        status: "active",
        hasCredential: true,
        scopes: ["read"],
        accessTokenExpiresAt: null,
        authorizationServer: "https://provider.example",
        probeState: "succeeded",
        probedAt: now,
        probeError: null,
        toolsCount: 1,
        toolsTruncated: false,
        failureCode: null,
        revision: 2,
      },
      snapshot: {
        protocolEra: "modern",
        protocolVersion: "2026-06-01",
        serverInfo: null,
        capabilities: null,
        instructions: null,
        tools: [{ name: "search_docs", description: "Search docs", inputSchema: { type: "object", secret: 1 } }],
      },
    });
    const status = await app.inject({
      method: "GET",
      url: runtimeAgentMcpServerOAuthStatusPath(mcpServerId),
      headers,
    });
    expect(status.statusCode).toBe(200);
    // Tool names and descriptions only: the input schema never leaves the Server on a poll.
    expect(status.json()).toMatchObject({
      authStatus: "active",
      probeState: "succeeded",
      toolsCount: 1,
      tools: [{ name: "search_docs", description: "Search docs" }],
    });
    expect(status.body).not.toContain("secret");
    await app.close();
  });

  it("authenticates before interpreting the request and fails closed", async () => {
    const { agents, app, owners } = fixture({
      proofs: {
        authenticate: async () => {
          throw new SessionCliProofError("invalid_proof", "invalid");
        },
      },
    });
    const response = await app.inject({
      method: "PATCH",
      url: RUNTIME_AGENT_PATH,
      payload: { not: "valid" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "SESSION_PROOF_INVALID" } });
    expect(owners.resolveAccountId).not.toHaveBeenCalled();
    expect(agents.updateById).not.toHaveBeenCalled();
    await app.close();
  });
});
