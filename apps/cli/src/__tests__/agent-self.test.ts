import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdminConfig, MCPAgentServer, SelfMCPOAuthStatus } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli/program.js";
import * as agentSelf from "../core/agent/self.js";
import {
  type AgentSelfApiClient,
  runAgentSelfMcpAdd,
  runAgentSelfMcpAttach,
  runAgentSelfMcpAvailable,
  runAgentSelfMcpCheckOAuthStatus,
  runAgentSelfMcpDelete,
  runAgentSelfMcpDetach,
  runAgentSelfMcpEnable,
  runAgentSelfMcpGenerateOAuthUrl,
  runAgentSelfMcpList,
  runAgentSelfMcpSearch,
  runAgentSelfShow,
  runAgentSelfUpdate,
} from "../core/agent/self.js";

const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const mcpServerId = "0f4c8f7e-4a4d-4b7b-9a51-7c8f1d2e3a4b";
const availableId = "7d2a9c41-5b8e-4f3a-8c6d-2e1f0a9b8c7d";
const now = "2026-09-22T00:00:00.000Z";

const config: AgentAdminConfig = {
  id: agentId,
  name: "helper",
  displayName: "Helper",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  selfConfigurationEnabled: true,
  status: "active",
  createdAt: now,
  updatedAt: now,
  createdByUserId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  computerId: null,
  revision: 5,
  runtimeConfig: {
    permissions: { approvalPolicy: "on-request", allowCommands: [] },
    revision: 9,
    model: null,
    reasoningEffort: null,
    instructions: "old",
    maxDurationMs: null,
    contextTrees: [],
  },
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

const status: SelfMCPOAuthStatus = {
  mcpServerId,
  name: "docs",
  enabled: true,
  authKind: "oauth",
  authStatus: "active",
  probeState: "succeeded",
  probeError: null,
  failureCode: null,
  toolsCount: 1,
  toolsTruncated: false,
  tools: [{ name: "search_docs", description: "Search docs" }],
};

function fakeApi() {
  const api = {
    getRuntimeAgentConfig: vi.fn(async () => config),
    updateRuntimeAgentConfig: vi.fn(async () => ({ ...config, revision: 6 })),
    listRuntimeAgentMcpServers: vi.fn(async () => ({ servers: [mounted] })),
    listRuntimeAgentAvailableMcpServers: vi.fn(async () => ({
      servers: [{ id: availableId, name: "search", description: null, boundAgentCount: 1 }],
    })),
    attachRuntimeAgentMcpServer: vi.fn(async () => mounted),
    updateRuntimeAgentMcpBinding: vi.fn(async () => ({ ...mounted, enabled: false })),
    detachRuntimeAgentMcpServer: vi.fn(async () => undefined),
    createRuntimeAgentMcpServer: vi.fn(async () => mounted),
    deleteRuntimeAgentMcpServerDefinition: vi.fn(async () => undefined),
    setRuntimeAgentMcpBearerKey: vi.fn(async () => mounted),
    startRuntimeAgentMcpOAuth: vi.fn(async () => ({
      authorizationUrl: "https://provider.example/authorize?x=1",
      expiresAt: now,
    })),
    getRuntimeAgentMcpOAuthStatus: vi.fn(async () => status),
  } satisfies AgentSelfApiClient;
  return { api, deps: { api, proof: "fixture-proof" } };
}

describe("agent self core", () => {
  it("reads the Agent through the Session proof and updates it at the current revision", async () => {
    const { api, deps } = fakeApi();
    await expect(runAgentSelfShow(deps)).resolves.toEqual(config);
    expect(api.getRuntimeAgentConfig).toHaveBeenCalledWith("fixture-proof");

    await runAgentSelfUpdate({ ...deps, instructions: "new", clearModel: true, reasoningEffort: "high" });
    expect(api.updateRuntimeAgentConfig).toHaveBeenCalledWith("fixture-proof", {
      expectedRevision: 5,
      runtimeConfig: { model: null, reasoningEffort: "high", instructions: "new" },
    });
  });

  it("reads replacement instructions from a file", async () => {
    const { api, deps } = fakeApi();
    const directory = await mkdtemp(join(tmpdir(), "opentag-agent-self-"));
    try {
      const file = join(directory, "instructions.md");
      await writeFile(file, "from file\n", "utf8");
      await runAgentSelfUpdate({ ...deps, instructionsFile: file, clearReasoningEffort: true, model: "gpt-x" });
      expect(api.updateRuntimeAgentConfig).toHaveBeenCalledWith("fixture-proof", {
        expectedRevision: 5,
        runtimeConfig: { model: "gpt-x", reasoningEffort: null, instructions: "from file\n" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects empty and contradictory updates before any request", async () => {
    const { api, deps } = fakeApi();
    await expect(runAgentSelfUpdate(deps)).rejects.toThrow("No Agent changes were provided");
    await expect(runAgentSelfUpdate({ ...deps, model: "m", clearModel: true })).rejects.toThrow(
      "--model and --clear-model cannot be used together",
    );
    await expect(runAgentSelfUpdate({ ...deps, reasoningEffort: "low", clearReasoningEffort: true })).rejects.toThrow(
      "--reasoning-effort and --clear-reasoning-effort cannot be used together",
    );
    await expect(runAgentSelfUpdate({ ...deps, instructions: "a", instructionsFile: "/x" })).rejects.toThrow(
      "--instructions and --instructions-file cannot be used together",
    );
    expect(api.getRuntimeAgentConfig).not.toHaveBeenCalled();
  });

  it("resolves MCP Servers by name or id from the Agent's own views", async () => {
    const { api, deps } = fakeApi();
    await expect(runAgentSelfMcpList(deps)).resolves.toEqual([mounted]);
    await expect(runAgentSelfMcpAvailable(deps)).resolves.toHaveLength(1);

    await runAgentSelfMcpAttach("search", false, deps);
    expect(api.attachRuntimeAgentMcpServer).toHaveBeenCalledWith("fixture-proof", {
      mcpServerId: availableId,
      enabled: false,
    });
    await expect(runAgentSelfMcpAttach("docs", true, deps)).rejects.toThrow("No unmounted Account MCP Server named");

    await runAgentSelfMcpEnable(mcpServerId, false, deps);
    expect(api.updateRuntimeAgentMcpBinding).toHaveBeenCalledWith("fixture-proof", mcpServerId, { enabled: false });

    await expect(runAgentSelfMcpDetach("docs", deps)).resolves.toEqual(mounted);
    expect(api.detachRuntimeAgentMcpServer).toHaveBeenCalledWith("fixture-proof", mcpServerId);
    await expect(runAgentSelfMcpDetach("missing", deps)).rejects.toThrow("This Agent does not mount");
  });

  it("adds a connector from the catalog's own name and auth kind", async () => {
    const { api, deps } = fakeApi();

    const presets = runAgentSelfMcpSearch("docs");
    expect(presets.every((preset) => preset.url === null || preset.url.startsWith("http"))).toBe(true);
    // A query that names an entry outright resolves to that entry, not to its token neighbours.
    const named = runAgentSelfMcpSearch("notion");
    expect(named[0]).toMatchObject({ id: "notion", installable: true });
    expect(named[0]?.url).toMatch(/^https:\/\//);

    await runAgentSelfMcpAdd({ ...deps, name: "hubspot", url: "https://mcp.hubspot.example/mcp", authKind: "oauth" });
    expect(api.createRuntimeAgentMcpServer).toHaveBeenLastCalledWith("fixture-proof", {
      name: "hubspot",
      url: "https://mcp.hubspot.example/mcp",
      defaultAuthKind: "oauth",
    });

    await runAgentSelfMcpAdd({ ...deps, name: "cmdb", url: "https://cmdb.example/mcp", apiKey: "k" });
    expect(api.createRuntimeAgentMcpServer).toHaveBeenLastCalledWith("fixture-proof", {
      name: "cmdb",
      url: "https://cmdb.example/mcp",
      defaultAuthKind: "bearer",
      apiKey: "k",
    });
  });

  it("rejects the anonymous and mismatched combinations before any request", async () => {
    const { api, deps } = fakeApi();
    await expect(
      runAgentSelfMcpAdd({ ...deps, name: "x", url: "https://mcp.example.com/mcp", authKind: "none" }),
    ).rejects.toThrow("requires no credentials");
    await expect(
      runAgentSelfMcpAdd({ ...deps, name: "x", url: "https://mcp.example/mcp", authKind: "token" }),
    ).rejects.toThrow("auth_kind must be oauth or bearer");
    await expect(
      runAgentSelfMcpAdd({ ...deps, name: "x", url: "https://mcp.example/mcp", authKind: "oauth", apiKey: "k" }),
    ).rejects.toThrow("--api-key can only be used with auth_kind bearer");
    expect(api.createRuntimeAgentMcpServer).not.toHaveBeenCalled();
  });

  it("deletes by name from this Agent's own mounts", async () => {
    const { api, deps } = fakeApi();
    await expect(runAgentSelfMcpDelete("docs", deps)).resolves.toEqual(mounted);
    expect(api.deleteRuntimeAgentMcpServerDefinition).toHaveBeenCalledWith("fixture-proof", mcpServerId);
    await expect(runAgentSelfMcpDelete("missing", deps)).rejects.toThrow("This Agent does not mount");
  });

  it("starts OAuth against the mount it resolved and reports the URL", async () => {
    const { api, deps } = fakeApi();
    await expect(runAgentSelfMcpGenerateOAuthUrl("docs", { ...deps, scopes: ["read"] })).resolves.toMatchObject({
      authorizationUrl: "https://provider.example/authorize?x=1",
      server: mounted,
    });
    expect(api.startRuntimeAgentMcpOAuth).toHaveBeenCalledWith("fixture-proof", mcpServerId, { scopes: ["read"] });
  });

  it("polls the status until it settles, and returns at once with no wait budget", async () => {
    const { api, deps } = fakeApi();
    api.getRuntimeAgentMcpOAuthStatus.mockResolvedValueOnce({ ...status, probeState: "pending" });
    await expect(runAgentSelfMcpCheckOAuthStatus("docs", deps)).resolves.toMatchObject({ probeState: "pending" });
    expect(api.getRuntimeAgentMcpOAuthStatus).toHaveBeenCalledTimes(1);

    api.getRuntimeAgentMcpOAuthStatus.mockReset();
    api.getRuntimeAgentMcpOAuthStatus
      .mockResolvedValueOnce({ ...status, authStatus: "pending", probeState: "pending" })
      .mockResolvedValueOnce(status);
    await expect(
      runAgentSelfMcpCheckOAuthStatus("docs", { ...deps, waitSeconds: 5, pollIntervalMs: 1 }),
    ).resolves.toEqual(status);
    expect(api.getRuntimeAgentMcpOAuthStatus).toHaveBeenCalledTimes(2);
  });

  it("pages the Agent's mounts in the CLI", async () => {
    const { api, deps } = fakeApi();
    const second = { ...mounted, mcpServerId: availableId, name: "search" };
    api.listRuntimeAgentMcpServers.mockResolvedValue({ servers: [mounted, second, { ...second, name: "third" }] });

    await expect(runAgentSelfMcpList({ ...deps, page: 2, limit: 2 })).resolves.toEqual([{ ...second, name: "third" }]);
    await expect(runAgentSelfMcpList({ ...deps, page: 1, limit: 1 })).resolves.toEqual([mounted]);
    await expect(runAgentSelfMcpList({ ...deps, page: 0 })).rejects.toThrow("--page must be a positive integer");
    await expect(runAgentSelfMcpList({ ...deps, limit: 0 })).rejects.toThrow("--limit must be a positive integer");
  });

  it("refuses to run outside a managed Session and rejects half-injected dependencies", async () => {
    await expect(runAgentSelfShow({ environment: {} })).rejects.toMatchObject({
      code: "AGENT_SELF_SESSION_REQUIRED",
    });
    const { api } = fakeApi();
    await expect(runAgentSelfShow({ api })).rejects.toThrow("must provide both api and proof");
    await expect(runAgentSelfShow({ proof: "p" })).rejects.toThrow("must provide both api and proof");
  });
});

describe("agent self commands", () => {
  it("registers show, update, and mcp subcommands without an Agent id", async () => {
    const show = vi.spyOn(agentSelf, "runAgentSelfShow").mockResolvedValue(config);
    const update = vi.spyOn(agentSelf, "runAgentSelfUpdate").mockResolvedValue(config);
    const list = vi.spyOn(agentSelf, "runAgentSelfMcpList").mockResolvedValue([mounted]);
    const available = vi
      .spyOn(agentSelf, "runAgentSelfMcpAvailable")
      .mockResolvedValue([{ id: availableId, name: "search", description: "Search", boundAgentCount: 0 }]);
    const attach = vi.spyOn(agentSelf, "runAgentSelfMcpAttach").mockResolvedValue(mounted);
    const enable = vi.spyOn(agentSelf, "runAgentSelfMcpEnable").mockResolvedValue(mounted);
    const detach = vi.spyOn(agentSelf, "runAgentSelfMcpDetach").mockResolvedValue(mounted);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      for (const args of [
        ["agent", "self", "show"],
        ["agent", "self", "update", "--instructions", "new", "--clear-model", "--reasoning-effort", "low"],
        ["agent", "self", "mcp", "list"],
        ["agent", "self", "mcp", "available"],
        ["agent", "self", "mcp", "attach", "search", "--disabled"],
        ["agent", "self", "mcp", "enable", "docs"],
        ["agent", "self", "mcp", "disable", "docs"],
        ["agent", "self", "mcp", "detach", "docs"],
      ]) {
        await createProgram().parseAsync(["node", "opentag", ...args]);
      }
      expect(show).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ instructions: "new", clearModel: true, reasoningEffort: "low" }),
      );
      expect(list).toHaveBeenCalledOnce();
      expect(available).toHaveBeenCalledOnce();
      expect(attach).toHaveBeenCalledWith("search", false);
      expect(enable).toHaveBeenCalledWith("docs", true);
      expect(enable).toHaveBeenCalledWith("docs", false);
      expect(detach).toHaveBeenCalledWith("docs");
      const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).toContain(`search\t${availableId}\tSearch`);
      expect(output).toContain(`Detached docs (${mcpServerId})`);
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      vi.restoreAllMocks();
    }
  });

  it("prints an empty available list plainly", async () => {
    vi.spyOn(agentSelf, "runAgentSelfMcpAvailable").mockResolvedValue([]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createProgram().parseAsync(["node", "opentag", "agent", "self", "mcp", "available"]);
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("No unmounted Account MCP Servers");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("registers the search, add, delete, and OAuth subcommands, including at the root", async () => {
    const search = vi.spyOn(agentSelf, "runAgentSelfMcpSearch").mockReturnValue([
      {
        id: "notion",
        name: "notion",
        title: "Notion",
        url: "https://mcp.notion.example/mcp",
        defaultAuthKind: "oauth",
        installable: true,
        oauthScopes: null,
      },
    ]);
    const add = vi.spyOn(agentSelf, "runAgentSelfMcpAdd").mockResolvedValue(mounted);
    const remove = vi.spyOn(agentSelf, "runAgentSelfMcpDelete").mockResolvedValue(mounted);
    const oauthUrl = vi.spyOn(agentSelf, "runAgentSelfMcpGenerateOAuthUrl").mockResolvedValue({
      server: mounted,
      authorizationUrl: "https://provider.example/authorize?x=1",
      expiresAt: now,
    });
    const oauthStatus = vi.spyOn(agentSelf, "runAgentSelfMcpCheckOAuthStatus").mockResolvedValue(status);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      for (const args of [
        ["self", "mcp", "search", "notion"],
        ["self", "mcp", "add", "hubspot", "https://mcp.hubspot.example/mcp", "oauth"],
        ["self", "mcp", "delete", "docs"],
        ["self", "mcp", "generate_oauth_url", "docs", "--scopes", "read,write"],
        ["self", "mcp", "check_oauth_status", "docs"],
        ["self", "mcp", "check_oauth_status", "docs", "--wait"],
        ["agent", "self", "mcp", "check_oauth_status", "docs", "--wait", "10"],
      ]) {
        await createProgram().parseAsync(["node", "opentag", ...args]);
      }
      expect(search).toHaveBeenCalledWith("notion", undefined);
      expect(add).toHaveBeenCalledWith({
        name: "hubspot",
        url: "https://mcp.hubspot.example/mcp",
        authKind: "oauth",
      });
      expect(remove).toHaveBeenCalledWith("docs");
      expect(oauthUrl).toHaveBeenCalledWith("docs", { scopes: ["read", "write"] });
      // A bare status read does not wait; `--wait` takes the default budget; an explicit value is honoured.
      expect(oauthStatus.mock.calls.map(([, options]) => options?.waitSeconds)).toEqual([0, 45, 10]);

      const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).toContain("notion\toauth\thttps://mcp.notion.example/mcp\tnotion");
      expect(output).toContain(`Unmounted docs (${mcpServerId})`);
      expect(output).toContain("https://provider.example/authorize?x=1");
      expect(output).toContain("docs\tactive\tsucceeded\t1 tools");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      vi.restoreAllMocks();
    }
  });
});
