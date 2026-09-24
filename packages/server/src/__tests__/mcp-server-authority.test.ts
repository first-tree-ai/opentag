import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentMcpServers, agents, mcpServerAuthorizations, users } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ComputerService } from "../services/computers/index.js";
import { MCP_ERROR_CODES } from "../services/mcp/errors.js";
import { McpServerService } from "../services/mcp/mcp-server-service.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let unit: UnitDatabase;
let service: McpServerService;
beforeAll(async () => {
  unit = await createUnitDatabase();
}, 60_000);
afterAll(async () => unit?.close());
beforeEach(async () => {
  await unit.reset();
  service = new McpServerService({ database: unit.database });
});

async function owner() {
  const id = randomUUID();
  await unit.database.insert(users).values({ id, email: `${id}@example.test`, displayName: "MCP owner" });
  return id;
}

async function agent(accountId: string) {
  const computer = await new ComputerService(
    unit.database,
    {
      getActiveUserById: async () => {
        throw new Error("Unused Account projection");
      },
    },
    { cloudIdentities: { enabled: true, runnerVersion: "0.0.5" } },
  ).ensureCloudComputerForAccount(accountId);
  return new AgentService(unit.database, { cloudIdentitiesEnabled: true }).createForAccount(accountId, {
    name: `mcp-${randomUUID().slice(0, 8)}`,
    displayName: "MCP Agent",
    runtimeProvider: "pi",
    computerId: computer.computerId,
  });
}

const definition = { name: "docs", url: "https://mcp.example.test/api", defaultAuthKind: "none" as const };

describe("MCP management authority in the unit database", () => {
  it("scopes definitions and mounts to the owner, rejects duplicate mounts, and removes detached authorization", async () => {
    const accountId = await owner();
    const foreignId = await owner();
    const local = await agent(accountId);
    const foreign = await agent(foreignId);
    expect(await service.listServers(accountId)).toEqual([]);
    const server = await service.createServer(accountId, definition);
    expect(await service.listServers(foreignId)).toEqual([]);
    // PGlite names the error field `constraint`; production postgres-js uses `constraint_name`.
    // The PostgreSQL suite verifies public error mapping; here verify the uniqueness boundary.
    await expect(service.createServer(accountId, definition)).rejects.toThrow();
    expect(await service.listServers(accountId)).toHaveLength(1);
    await expect(service.attachServer(accountId, foreign.id, server.id, true)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.SERVER_NOT_FOUND,
    });
    await expect(service.attachServer(foreignId, foreign.id, server.id, true)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.SERVER_NOT_FOUND,
    });
    expect(await service.listAvailableServers(accountId, local.id)).toMatchObject([{ id: server.id }]);
    const mounted = await service.attachServer(accountId, local.id, server.id, true);
    expect(mounted).toMatchObject({ enabled: true, authorization: { status: "active", hasCredential: false } });
    await expect(service.attachServer(accountId, local.id, server.id, true)).rejects.toThrow();
    expect(await service.listAvailableServers(accountId, local.id)).toEqual([]);
    expect(await service.listAgentServers(accountId, local.id)).toHaveLength(1);
    expect(await service.readJoinedBinding(foreignId, local.id, server.id)).toBeUndefined();
    await expect(service.listAgentServers(foreignId, local.id)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.SERVER_NOT_FOUND,
    });
    await expect(service.deleteServer(foreignId, server.id)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.SERVER_NOT_FOUND,
    });
    await service.detachServer(accountId, local.id, server.id);
    expect(await unit.database.select().from(mcpServerAuthorizations)).toEqual([]);
    await expect(service.readAgentServer(accountId, local.id, server.id)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.BINDING_NOT_FOUND,
    });
    await expect(service.detachServer(accountId, local.id, server.id)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.BINDING_NOT_FOUND,
    });
  });

  it("distinguishes inherited, empty, and overridden configuration without changing another Agent", async () => {
    const accountId = await owner();
    const first = await agent(accountId);
    const second = await agent(accountId);
    const server = await service.createServer(accountId, {
      ...definition,
      authHeader: "x-token",
      authScheme: "Token",
      extraHeaders: { "X-Team": "shared" },
    });
    await service.attachServer(accountId, first.id, server.id, true);
    await service.attachServer(accountId, second.id, server.id, true);
    const changed = await service.updateBinding(accountId, first.id, server.id, {
      url: "https://agent.example.test/mcp",
      authHeader: "x-agent-token",
      authScheme: "",
      extraHeaders: { "X-Team": "agent" },
    });
    expect(changed.effective).toEqual({
      url: "https://agent.example.test/mcp",
      authHeader: "x-agent-token",
      authScheme: "",
      extraHeaders: { "x-team": "agent" },
    });
    expect(changed.overridden).toEqual({ url: true, authHeader: true, authScheme: true, extraHeaders: true });
    const untouched = await service.readAgentServer(accountId, second.id, server.id);
    expect(untouched.effective.extraHeaders).toEqual({ "x-team": "shared" });
    expect(untouched.overridden).toEqual({ url: false, authHeader: false, authScheme: false, extraHeaders: false });
    await expect(
      service.updateBinding(accountId, first.id, server.id, { extraHeaders: { "X-Agent-Token": "collision" } }),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.AUTH_HEADER_INVALID });
    const empty = await service.updateBinding(accountId, first.id, server.id, {
      emptyExtraHeaders: true,
      enabled: false,
    });
    expect(empty.effective.extraHeaders).toEqual({});
    expect(empty.authorization?.status).toBe("active");
    const inherited = await service.updateBinding(accountId, first.id, server.id, {
      clearUrl: true,
      clearAuthHeader: true,
      clearAuthScheme: true,
      clearExtraHeaders: true,
      enabled: true,
    });
    expect(inherited.effective).toEqual(untouched.effective);
    expect(inherited.overridden).toEqual(untouched.overridden);
    const edited = await service.updateServer(accountId, server.id, {
      expectedRevision: server.revision,
      description: "Docs",
      defaultAuthKind: "bearer",
      authHeader: "x-key",
      authScheme: "",
      extraHeaders: { "X-New": "value" },
    });
    expect(edited).toMatchObject({
      revision: server.revision + 1,
      description: "Docs",
      authScheme: "",
      extraHeaders: { "x-new": "value" },
    });
    await expect(
      service.updateServer(accountId, server.id, { expectedRevision: server.revision, description: "stale" }),
    ).rejects.toMatchObject({ code: MCP_ERROR_CODES.SERVER_REVISION_CONFLICT });
    expect(
      (await service.updateServer(accountId, server.id, { expectedRevision: edited.revision, clearExtraHeaders: true }))
        .extraHeaders,
    ).toEqual({});
  });

  it("revokes origin-bound OAuth and its in-flight flow on endpoint change while retaining bearer authorization", async () => {
    const accountId = await owner();
    const oauthAgent = await agent(accountId);
    const bearerAgent = await agent(accountId);
    const server = await service.createServer(accountId, { ...definition, defaultAuthKind: "oauth" });
    expect((await service.attachServer(accountId, oauthAgent.id, server.id, true)).authorization).toBeNull();
    await service.attachServer(accountId, bearerAgent.id, server.id, true);
    const now = new Date();
    await unit.database.insert(mcpServerAuthorizations).values([
      {
        mcpServerId: server.id,
        agentId: oauthAgent.id,
        kind: "oauth",
        status: "active",
        ciphertext: "unit-sealed-oauth",
        keyId: "unit-key",
        state: "unit-flow",
        stateExpiresAt: new Date(now.getTime() + 60_000),
        pkceCiphertext: "unit-sealed-pkce",
        loginSessionHash: "unit-login-hash",
        protocolEra: "modern",
        protocolVersion: "2025-03-26",
        probeState: "succeeded",
        probedAt: now,
        tools: [{ name: "read", description: null, inputSchema: { type: "object" } }],
        toolsCount: 1,
        accessTokenExpiresAt: new Date(now.getTime() + 60_000),
      },
      {
        mcpServerId: server.id,
        agentId: bearerAgent.id,
        kind: "bearer",
        status: "active",
        ciphertext: "unit-sealed-bearer",
        keyId: "unit-key",
        protocolEra: "modern",
        protocolVersion: "2025-03-26",
        probeState: "succeeded",
        probedAt: now,
      },
    ]);
    const before = await service.getServerDetail(accountId, server.id);
    expect(before.server).toMatchObject({
      boundAgentCount: 2,
      authorizedAgentCount: 2,
      lastProbedAt: now.toISOString(),
    });
    const publicView = await service.readAgentServer(accountId, oauthAgent.id, server.id);
    expect(publicView.snapshot?.tools).toHaveLength(1);
    expect(JSON.stringify(publicView)).not.toContain("unit-sealed");
    await service.updateServer(accountId, server.id, {
      expectedRevision: server.revision,
      url: "https://new.example.test/mcp",
    });
    const oauth = await service.readProbeContext(accountId, oauthAgent.id, server.id);
    expect(oauth.authorization).toMatchObject({
      status: "revoked",
      ciphertext: null,
      keyId: null,
      state: null,
      stateExpiresAt: null,
      pkceCiphertext: null,
      loginSessionHash: null,
      accessTokenExpiresAt: null,
      protocolEra: null,
      protocolVersion: null,
      probeState: "pending",
      revision: 2,
    });
    const bearer = await service.readProbeContext(accountId, bearerAgent.id, server.id);
    expect(bearer.authorization).toMatchObject({
      status: "active",
      ciphertext: "unit-sealed-bearer",
      protocolEra: null,
      probeState: "pending",
      revision: 2,
    });
    expect((await service.readAgentServer(accountId, oauthAgent.id, server.id)).snapshot?.tools).toEqual(
      publicView.snapshot?.tools,
    );
    expect((await service.listServers(accountId))[0]?.authorizedAgentCount).toBe(1);
  });

  it("guards disabled live mounts but removes soft-deleted Agents from counts, readers, and deletion blockers", async () => {
    const accountId = await owner();
    const local = await agent(accountId);
    const server = await service.createServer(accountId, definition);
    await service.attachServer(accountId, local.id, server.id, false);
    await expect(service.deleteServer(accountId, server.id)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.SERVER_IN_USE,
      detail: { boundAgentCount: 1 },
    });
    expect((await service.getServerDetail(accountId, server.id)).agents).toMatchObject([
      { agentId: local.id, enabled: false },
    ]);
    await unit.database.update(agents).set({ status: "deleted" }).where(eq(agents.id, local.id));
    expect(await service.readJoinedBinding(accountId, local.id, server.id)).toBeUndefined();
    await expect(service.readProbeContext(accountId, local.id, server.id)).rejects.toMatchObject({
      code: MCP_ERROR_CODES.BINDING_NOT_FOUND,
    });
    const detail = await service.getServerDetail(accountId, server.id);
    expect(detail.server).toMatchObject({ boundAgentCount: 0, authorizedAgentCount: 0 });
    expect(detail.agents).toEqual([]);
    await service.deleteServer(accountId, server.id);
    expect(await service.listServers(accountId)).toEqual([]);
    expect(await unit.database.select().from(agentMcpServers)).toEqual([]);
    expect(await unit.database.select().from(mcpServerAuthorizations)).toEqual([]);
  });
});

describe("effective connection changes", () => {
  async function connectedPair() {
    const accountId = await owner();
    const first = await agent(accountId);
    const second = await agent(accountId);
    const server = await service.createServer(accountId, {
      ...definition,
      defaultAuthKind: "oauth",
      extraHeaders: { "x-team": "shared", "x-mode": "tools" },
    });
    for (const current of [first, second]) {
      await service.attachServer(accountId, current.id, server.id, true);
      await unit.database.insert(mcpServerAuthorizations).values({
        mcpServerId: server.id,
        agentId: current.id,
        kind: "oauth",
        status: "active",
        ciphertext: "sealed-test-token",
        keyId: "test-key",
        probeState: "succeeded",
        protocolEra: "modern",
        protocolVersion: "2026-07-28",
        probedAt: new Date(),
        toolsCount: 1,
      });
    }
    return { accountId, first, second, server };
  }
  it("does not revoke overridden URLs when a shared endpoint changes", async () => {
    const { accountId, first, second, server } = await connectedPair();
    // Pin the same URL before the shared edit. This changes ownership, not the actual connection.
    await service.updateBinding(accountId, first.id, server.id, { url: server.url });
    const pinnedBefore = await service.readAgentServer(accountId, first.id, server.id);
    expect(pinnedBefore.authorization).toMatchObject({
      status: "active",
      probeState: "succeeded",
      hasCredential: true,
    });
    await service.updateServer(accountId, server.id, {
      expectedRevision: server.revision,
      url: "https://new.example.test/mcp",
    });
    const pinnedAfter = await service.readAgentServer(accountId, first.id, server.id);
    expect(pinnedAfter.authorization).toEqual(pinnedBefore.authorization);
    expect(pinnedAfter.effective.url).toBe(server.url);
    const inherited = await service.readAgentServer(accountId, second.id, server.id);
    expect(inherited.authorization).toMatchObject({ status: "revoked", probeState: "pending", hasCredential: false });
    expect(inherited.snapshot?.protocolEra).toBeNull();
  });
  it("keeps successful discovery for header reorder, metadata edits and equal-value restores", async () => {
    const { accountId, first, server } = await connectedPair();
    const before = await service.readAgentServer(accountId, first.id, server.id);
    await service.updateBinding(accountId, first.id, server.id, {
      url: server.url,
      extraHeaders: { "x-mode": "tools", "x-team": "shared" },
    });
    await service.updateBinding(accountId, first.id, server.id, { clearUrl: true, clearExtraHeaders: true });
    await service.updateServer(accountId, server.id, {
      expectedRevision: server.revision,
      description: "Updated description",
      extraHeaders: { "x-mode": "tools", "x-team": "shared" },
    });
    expect((await service.readAgentServer(accountId, first.id, server.id)).authorization).toEqual(before.authorization);
  });
  it("rechecks only Agents inheriting a changed header and retains their OAuth credentials", async () => {
    const { accountId, first, second, server } = await connectedPair();
    await service.updateBinding(accountId, first.id, server.id, { extraHeaders: server.extraHeaders });
    const before = await service.readAgentServer(accountId, first.id, server.id);
    await service.updateServer(accountId, server.id, {
      expectedRevision: server.revision,
      extraHeaders: { "x-team": "new" },
    });
    expect((await service.readAgentServer(accountId, first.id, server.id)).authorization).toEqual(before.authorization);
    expect((await service.readAgentServer(accountId, second.id, server.id)).authorization).toMatchObject({
      status: "active",
      probeState: "pending",
      hasCredential: true,
    });
  });
});
