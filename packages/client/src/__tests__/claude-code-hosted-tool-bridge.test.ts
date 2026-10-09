import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentHostedTools } from "../agent-runtime/types.js";
import { startClaudeCodeHostedToolBridge } from "../providers/claude-code/hosted-tool-bridge.js";

describe("Claude Code hosted tool bridge", () => {
  it("exposes only Agent Home skills through a private plugin and cleans up its wrapper", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-claude-skills-test-"));
    const settingsRoot = join(home, ".claude");
    const skills = join(settingsRoot, "skills");
    await mkdir(join(skills, "example"), { recursive: true });
    await writeFile(join(skills, "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\nHelp.");
    await writeFile(join(settingsRoot, "settings.json"), '{"apiKeyHelper":"untrusted-command"}');
    await mkdir(join(settingsRoot, "hooks"));
    await writeFile(join(settingsRoot, "hooks", "hooks.json"), '{"hooks":{}}');
    const bridge = await startClaudeCodeHostedToolBridge(undefined, "run-skills", new AbortController().signal, skills);
    try {
      expect(await readdir(bridge.pluginPath)).toEqual(["skills"]);
      expect(await realpath(join(bridge.pluginPath, "skills"))).toBe(await realpath(skills));
      await expect(readFile(join(bridge.pluginPath, "skills", "example", "SKILL.md"), "utf8")).resolves.toContain(
        "Help.",
      );
      expect((await stat(join(bridge.pluginPath, ".."))).mode & 0o777).toBe(0o700);
      await bridge.close();
      await expect(stat(bridge.pluginPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(skills)).resolves.toBeDefined();
    } finally {
      await bridge.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("always supplies a private strict-MCP configuration and removes it idempotently", async () => {
    const bridge = await startClaudeCodeHostedToolBridge(
      undefined,
      "run-empty",
      new AbortController().signal,
      "/workspace/.claude/skills",
    );
    expect(bridge.allowedTools).toEqual([]);
    await expect(readFile(bridge.configPath, "utf8")).resolves.toBe('{"mcpServers":{}}\n');
    expect((await stat(bridge.configPath)).mode & 0o777).toBe(0o600);

    await bridge.close();
    await bridge.close();
    await expect(readFile(bridge.configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves only authenticated OpenTag tools over owned loopback HTTP", async () => {
    const handler = vi.fn<AgentHostedTools["handler"]>(async (call) => ({
      success: call.name === "example_success",
      content: [{ type: "text", text: call.name }],
      ...(call.name === "example_failure" ? { error: { code: "EXAMPLE_FAILED", message: "example failed" } } : {}),
    }));
    const bridge = await startClaudeCodeHostedToolBridge(
      {
        definitions: [
          {
            name: "example_success",
            description: "Reply to the current conversation",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
          { name: "example_failure", inputSchema: { type: "object" } },
        ],
        handler,
      },
      "run-1",
      new AbortController().signal,
      "/workspace/.claude/skills",
    );
    const configuration = JSON.parse(await readFile(bridge.configPath, "utf8")) as {
      mcpServers: { opentag: { headers: Record<string, string>; url: string } };
    };
    const endpoint = configuration.mcpServers.opentag;
    const rpc = async (body: unknown, headers = endpoint.headers) =>
      fetch(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    expect(bridge.allowedTools).toEqual(["mcp__opentag__example_success", "mcp__opentag__example_failure"]);
    await expect(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { capabilities: { tools: {} }, serverInfo: { name: "OpenTag" } } });
    await expect(
      rpc({ jsonrpc: "2.0", id: "list", method: "tools/list" }).then((response) => response.json()),
    ).resolves.toMatchObject({
      result: { tools: [{ name: "example_success" }, { name: "example_failure" }] },
    });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    await expect(
      rpc({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: { name: "example_success", arguments: { text: "hello" } },
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { content: [{ text: "example_success" }], isError: false } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        toolCallId: "call-1",
        name: "example_success",
        input: { text: "hello" },
      }),
    );
    await expect(
      rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "example_failure", arguments: {} },
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { isError: true, structuredContent: { error: { code: "EXAMPLE_FAILED" } } } });
    await expect(
      rpc({ jsonrpc: "2.0", id: null, method: "tools/call", params: { name: "missing", arguments: {} } }).then(
        (response) => response.json(),
      ),
    ).resolves.toMatchObject({ result: { isError: true } });
    await expect(
      rpc({
        jsonrpc: "2.0",
        id: "",
        method: "tools/call",
        params: { name: "example_success", arguments: undefined },
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { isError: false } });
    await expect(
      rpc({
        jsonrpc: "2.0",
        id: {},
        method: "tools/call",
        params: { name: "example_success", arguments: BigInt(1).toString() },
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { isError: false } });
    await expect(
      rpc('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"example_success","arguments":1e400}}').then(
        (response) => response.json(),
      ),
    ).resolves.toMatchObject({ result: { isError: true } });
    await expect(
      rpc({ jsonrpc: "2.0", id: 4, method: "unknown" }).then((response) => response.json()),
    ).resolves.toMatchObject({ error: { code: -32601 } });
    expect((await rpc("not-json")).status).toBe(400);
    expect((await rpc([])).status).toBe(400);
    expect((await rpc({ jsonrpc: "1.0", id: 5, method: "initialize" })).status).toBe(400);
    expect((await rpc({ jsonrpc: "2.0", id: 6, method: "initialize" }, { Authorization: "Bearer wrong" })).status).toBe(
      404,
    );
    await expect(rpc("x".repeat(1024 * 1024 + 1))).rejects.toThrow();

    await bridge.close();
  });

  it("rejects aborted setup and duplicate hosted definitions before opening a bridge", async () => {
    const controller = new AbortController();
    controller.abort(new Error("turn cancelled"));
    await expect(
      startClaudeCodeHostedToolBridge(undefined, "run", controller.signal, "/workspace/.claude/skills"),
    ).rejects.toThrow("turn cancelled");
    const definition = { name: "duplicate", inputSchema: { type: "object" } } as const;
    await expect(
      startClaudeCodeHostedToolBridge(
        { definitions: [definition, definition], handler: async () => ({ success: true, content: [] }) },
        "run",
        new AbortController().signal,
        "/workspace/.claude/skills",
      ),
    ).rejects.toThrow("unique names");
  });

  it("returns an internal error when a hosted tool handler rejects", async () => {
    const bridge = await startClaudeCodeHostedToolBridge(
      {
        definitions: [{ name: "failing", inputSchema: { type: "object" } }],
        handler: async () => {
          throw new Error("handler failed");
        },
      },
      "run-failing-handler",
      new AbortController().signal,
      "/workspace/.claude/skills",
    );
    const configuration = JSON.parse(await readFile(bridge.configPath, "utf8")) as {
      mcpServers: { opentag: { headers: Record<string, string>; url: string } };
    };
    const response = await fetch(configuration.mcpServers.opentag.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...configuration.mcpServers.opentag.headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "failing-call",
        method: "tools/call",
        params: { name: "failing", arguments: {} },
      }),
    });

    expect(response.status).toBe(500);
    await bridge.close();
  });
});

describe("Claude Code MCP gateway entry", () => {
  const gateway = { url: "https://server.example.test/api/v1/mcp", token: "otmg_secret" };

  /*
   * The gateway entry is independent of the loopback bridge: an execution may hold an MCP bearer
   * while the run has no hosted tools at all, and it must still reach its bound MCP Servers.
   */
  it("writes the remote entry with no hosted tools and starts no local server", async () => {
    const bridge = await startClaudeCodeHostedToolBridge(
      undefined,
      "run-mcp-only",
      new AbortController().signal,
      "/workspace/.claude/skills",
      gateway,
    );
    try {
      const configuration = JSON.parse(await readFile(bridge.configPath, "utf8")) as {
        mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
      };
      expect(Object.keys(configuration.mcpServers)).toEqual(["opentag-mcp"]);
      expect(configuration.mcpServers["opentag-mcp"]).toEqual({
        type: "http",
        url: gateway.url,
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      expect((await stat(bridge.configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await bridge.close();
    }
  });

  /*
   * A whole-server rule rather than one per tool: the catalogue is resolved by the Server at
   * `tools/list` time, so its tool names are not known when this file is written.
   */
  it("allows the gateway as a whole server", async () => {
    const bridge = await startClaudeCodeHostedToolBridge(
      undefined,
      "run-mcp-allow",
      new AbortController().signal,
      "/workspace/.claude/skills",
      gateway,
    );
    try {
      expect(bridge.allowedTools).toEqual(["mcp__opentag-mcp"]);
    } finally {
      await bridge.close();
    }
  });

  it("carries both entries when the run also has hosted tools", async () => {
    const bridge = await startClaudeCodeHostedToolBridge(
      { definitions: [{ name: "example", inputSchema: { type: "object" } }], handler: vi.fn() },
      "run-both",
      new AbortController().signal,
      "/workspace/.claude/skills",
      gateway,
    );
    try {
      const configuration = JSON.parse(await readFile(bridge.configPath, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(configuration.mcpServers).sort()).toEqual(["opentag", "opentag-mcp"]);
      expect(bridge.allowedTools).toEqual(["mcp__opentag__example", "mcp__opentag-mcp"]);
    } finally {
      await bridge.close();
    }
  });

  it("writes no remote entry when the execution holds no bearer", async () => {
    const bridge = await startClaudeCodeHostedToolBridge(
      undefined,
      "run-none",
      new AbortController().signal,
      "/workspace/.claude/skills",
    );
    try {
      await expect(readFile(bridge.configPath, "utf8")).resolves.toBe('{"mcpServers":{}}\n');
    } finally {
      await bridge.close();
    }
  });
});
