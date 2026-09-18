import { describe, expect, it, vi } from "vitest";
import { resolveBearerKeySource } from "../commands/mcp/options.js";
import {
  runAgentMcpAttach,
  runAgentMcpConfig,
  runMcpAuthorize,
  runMcpCreate,
  runMcpShow,
  runMcpUpdate,
  runMcpUse,
} from "../core/mcp/operations.js";
import { extraHeadersFrom, type McpApiClient, resolveMcpCommandContext, resolveMcpServer } from "../core/mcp/shared.js";

function fixture() {
  const server = { id: "d91ba522-498b-4d5e-845b-06f8dc9d562c", name: "tools", revision: 4 };
  const api = {
    listMcpServers: vi.fn().mockResolvedValue({ servers: [server] }),
    createMcpServer: vi.fn().mockResolvedValue(server),
    getMcpServer: vi.fn().mockResolvedValue({ server, agents: [] }),
    updateMcpServer: vi.fn().mockResolvedValue(server),
    attachMcpServer: vi.fn().mockResolvedValue({}),
    updateAgentMcpServer: vi.fn().mockResolvedValue({}),
    listAgentMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    setMcpAuthorization: vi.fn().mockResolvedValue({}),
    startMcpOAuth: vi.fn().mockResolvedValue({
      authorizationUrl: "https://auth.example.test/authorize",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
  };
  return { api, server, dependencies: { api: api as unknown as McpApiClient, accessToken: "fixture-account-access" } };
}

describe("MCP CLI authority and configuration", () => {
  it("resolves both handles and IDs before an Agent-scoped mutation, refusing an unknown definition", async () => {
    const f = fixture();
    expect(await resolveMcpServer(f.server.id, f.dependencies)).toEqual(f.server);
    await runAgentMcpAttach("agent-a", "tools", false, f.dependencies);
    expect(f.api.attachMcpServer).toHaveBeenCalledWith("fixture-account-access", "agent-a", {
      mcpServerId: f.server.id,
      enabled: false,
    });
    await expect(runAgentMcpAttach("agent-a", "missing", true, f.dependencies)).rejects.toThrow("No MCP Server");
    expect(f.api.attachMcpServer).toHaveBeenCalledTimes(1);
    await expect(resolveMcpCommandContext({ api: f.dependencies.api })).rejects.toThrow("both api and accessToken");
    await expect(resolveMcpCommandContext({ accessToken: "fixture" })).rejects.toThrow("both api and accessToken");
  });

  it("distinguishes a definition's defaults, explicit empty scheme, and optimistic revision", async () => {
    const f = fixture();
    await runMcpCreate({ name: "tools", url: "https://tools.example.test/mcp" }, f.dependencies);
    expect(f.api.createMcpServer).toHaveBeenLastCalledWith("fixture-account-access", {
      name: "tools",
      url: "https://tools.example.test/mcp",
      defaultAuthKind: "oauth",
    });
    await runMcpCreate(
      {
        name: "tools",
        url: "https://tools.example.test/mcp",
        defaultAuthKind: "bearer",
        authHeader: "x-key",
        authScheme: "",
        extraHeader: ["X-Tenant=team=a"],
      },
      f.dependencies,
    );
    expect(f.api.createMcpServer.mock.lastCall?.[1]).toMatchObject({
      authScheme: "",
      extraHeaders: { "x-tenant": "team=a" },
    });
    await runMcpUpdate("tools", {}, f.dependencies);
    expect(f.api.updateMcpServer.mock.lastCall?.[2]).toEqual({ expectedRevision: 4 });
    await runMcpUpdate(
      "tools",
      {
        description: "new",
        url: "https://new.example.test/mcp",
        defaultAuthKind: "none",
        authHeader: "x-auth",
        authScheme: "",
        extraHeader: ["x-tenant=a"],
        expectedRevision: 7,
      },
      f.dependencies,
    );
    expect(f.api.updateMcpServer.mock.lastCall?.[2]).toEqual({
      description: "new",
      url: "https://new.example.test/mcp",
      defaultAuthKind: "none",
      authHeader: "x-auth",
      authScheme: "",
      extraHeaders: { "x-tenant": "a" },
      expectedRevision: 7,
    });
    await runMcpUpdate("tools", { clearExtraHeaders: true }, f.dependencies);
    expect(f.api.updateMcpServer.mock.lastCall?.[2]).toEqual({ expectedRevision: 4, clearExtraHeaders: true });
    await runMcpUpdate("tools", { emptyExtraHeaders: true }, f.dependencies);
    expect(f.api.updateMcpServer.mock.lastCall?.[2]).toEqual({ expectedRevision: 4, clearExtraHeaders: true });
  });

  it("keeps clearing inheritance separate from an Agent's intentional empty headers", async () => {
    const f = fixture();
    await runAgentMcpConfig("agent-a", "tools", {}, f.dependencies);
    expect(f.api.updateAgentMcpServer.mock.lastCall?.[3]).toEqual({});
    await runAgentMcpConfig(
      "agent-a",
      "tools",
      { url: "https://agent.example.test/mcp", authHeader: "x-key", authScheme: "", extraHeader: ["x-tenant=private"] },
      f.dependencies,
    );
    expect(f.api.updateAgentMcpServer.mock.lastCall?.[3]).toEqual({
      url: "https://agent.example.test/mcp",
      authHeader: "x-key",
      authScheme: "",
      extraHeaders: { "x-tenant": "private" },
    });
    await runAgentMcpConfig(
      "agent-a",
      "tools",
      { clearUrl: true, clearAuthHeader: true, clearAuthScheme: true, clearExtraHeaders: true },
      f.dependencies,
    );
    expect(f.api.updateAgentMcpServer.mock.lastCall?.[3]).toEqual({
      clearUrl: true,
      clearAuthHeader: true,
      clearAuthScheme: true,
      clearExtraHeaders: true,
    });
    await runAgentMcpConfig("agent-a", "tools", { emptyExtraHeaders: true }, f.dependencies);
    expect(f.api.updateAgentMcpServer.mock.lastCall?.[3]).toEqual({ emptyExtraHeaders: true });
    expect(f.api.updateMcpServer).not.toHaveBeenCalled();
  });

  it("requires a key for bearer authorization and never gives anonymous authorization a key", async () => {
    const f = fixture();
    await expect(runMcpUse("agent-a", "tools", { kind: "bearer" }, f.dependencies)).rejects.toThrow(
      "bearer key is required",
    );
    await expect(runMcpUse("agent-a", "tools", { kind: "bearer", bearerKey: "" }, f.dependencies)).rejects.toThrow(
      "bearer key is required",
    );
    expect(f.api.setMcpAuthorization).not.toHaveBeenCalled();
    await runMcpUse("agent-a", "tools", { kind: "bearer", bearerKey: "fixture-key" }, f.dependencies);
    expect(f.api.setMcpAuthorization).toHaveBeenLastCalledWith("fixture-account-access", "agent-a", f.server.id, {
      kind: "bearer",
      bearerKey: "fixture-key",
    });
    await runMcpUse("agent-a", "tools", { kind: "none", bearerKey: "must-not-forward" }, f.dependencies);
    expect(f.api.setMcpAuthorization.mock.lastCall?.[3]).toEqual({ kind: "none" });
  });

  it("publishes the OAuth URL immediately and treats a failed renewal as failure even with an active old credential", async () => {
    const f = fixture();
    const onStarted = vi.fn();
    await runMcpAuthorize("agent-a", "tools", { noWait: true, scopes: ["read"] }, { ...f.dependencies, onStarted });
    expect(onStarted).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationUrl: "https://auth.example.test/authorize" }),
    );
    expect(f.api.listAgentMcpServers).not.toHaveBeenCalled();
    f.api.listAgentMcpServers.mockResolvedValue({
      servers: [{ mcpServerId: f.server.id, authorization: { status: "active", failureCode: "user_denied" } }],
    });
    await expect(runMcpAuthorize("agent-a", "tools", {}, f.dependencies)).rejects.toThrow("user_denied");
    f.api.listAgentMcpServers.mockResolvedValue({
      servers: [{ mcpServerId: f.server.id, authorization: { status: "revoked" } }],
    });
    await expect(runMcpAuthorize("agent-a", "tools", {}, f.dependencies)).rejects.toThrow("revoked");
    f.api.listAgentMcpServers.mockResolvedValue({
      servers: [
        {
          mcpServerId: f.server.id,
          authorization: {
            status: "active",
            probeState: "succeeded",
            toolsCount: 3,
            toolsTruncated: false,
            probeError: null,
          },
          snapshot: { protocolEra: "modern", protocolVersion: "test" },
        },
      ],
    });
    expect((await runMcpAuthorize("agent-a", "tools", {}, f.dependencies)).probe).toMatchObject({
      probeState: "succeeded",
      toolsCount: 3,
    });
  });

  it("does not substitute a different Agent's mount when showing the effective configuration", async () => {
    const f = fixture();
    expect(await runMcpShow("tools", f.dependencies)).toEqual({ server: { server: f.server, agents: [] } });
    await expect(runMcpShow("tools", { ...f.dependencies, agentId: "agent-a" })).rejects.toThrow("does not mount");
    const mount = { mcpServerId: f.server.id, enabled: false };
    f.api.listAgentMcpServers.mockResolvedValue({ servers: [mount] });
    expect((await runMcpShow("tools", { ...f.dependencies, agentId: "agent-a" })).agentView).toEqual(mount);
  });

  it("rejects ambiguous static headers and confused credential-source options", () => {
    expect(extraHeadersFrom(undefined)).toBeUndefined();
    expect(extraHeadersFrom([])).toBeUndefined();
    expect(extraHeadersFrom(["X-Tenant=value=with=equals"])).toEqual({ "x-tenant": "value=with=equals" });
    for (const entries of [["missing"], ["=value"], [" =value"], ["X-Tenant=a", "x-tenant=b"]]) {
      expect(() => extraHeadersFrom(entries)).toThrow();
    }
    expect(resolveBearerKeySource({ kind: "none" })).toEqual({ kind: "none" });
    expect(() => resolveBearerKeySource({ kind: "none", bearerKey: "key" })).toThrow();
    expect(() => resolveBearerKeySource({ kind: "none", bearerKeyStdin: true })).toThrow();
    expect(() => resolveBearerKeySource({ kind: "oauth" })).toThrow("mcp authorize");
    expect(resolveBearerKeySource({})).toEqual({ kind: "bearer", source: "prompt" });
    expect(resolveBearerKeySource({ kind: "bearer", bearerKey: "key" })).toMatchObject({
      source: "argument",
      value: "key",
    });
    expect(resolveBearerKeySource({ bearerKey: "key", bearerKeyStdin: true })).toMatchObject({ source: "stdin" });
  });
});
