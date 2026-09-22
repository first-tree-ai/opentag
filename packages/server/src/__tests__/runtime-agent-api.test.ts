import { randomUUID } from "node:crypto";
import {
  type AgentAdminConfig,
  type MCPAgentServer,
  RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH,
  RUNTIME_AGENT_MCP_SERVERS_PATH,
  RUNTIME_AGENT_PATH,
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
  status: "active",
  createdAt: now,
  updatedAt: now,
  createdByUserId: accountId,
  computerId: source.computerId,
  revision: 3,
  runtimeConfig: {
    revision: 7,
    model: null,
    reasoningEffort: null,
    instructions: "be brief",
    maxDurationMs: null,
    contextTrees: [],
  },
};

const mcpServerId = randomUUID();
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
    detachServer: vi.fn(async () => undefined),
    listAgentServers: vi.fn(async () => [mounted]),
    listAvailableServers: vi.fn(async () => [
      { id: randomUUID(), name: "search", description: null, boundAgentCount: 0 },
    ]),
    updateBinding: vi.fn(async () => ({ ...mounted, enabled: false })),
  };
  const proofs = { authenticate: vi.fn(async () => source) };
  const owners = { resolveAccountId: vi.fn(async () => accountId) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new AgentSelfService({ agents, mcp, owners, proofs, logger, ...overrides });
  const app = createApp({ runtimeAgent: { service } });
  return { agents, app, logger, mcp, owners, proofs };
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
    expect(mcp.attachServer).toHaveBeenCalledWith(accountId, source.agentId, mcpServerId, false);

    const disabled = await app.inject({
      method: "PATCH",
      url: runtimeAgentMcpServerPath(mcpServerId),
      headers,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(mcp.updateBinding).toHaveBeenCalledWith(accountId, source.agentId, mcpServerId, { enabled: false });

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
    expect(mcp.detachServer).toHaveBeenCalledWith(accountId, source.agentId, mcpServerId);

    const badId = await app.inject({ method: "DELETE", url: runtimeAgentMcpServerPath("not-a-uuid"), headers });
    expect(badId.statusCode).toBe(400);
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
