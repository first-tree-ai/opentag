import { readFile, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { AgentHostedTools } from "../agent-runtime/types.js";
import { startClaudeCodeHostedToolBridge } from "../providers/claude-code/hosted-tool-bridge.js";

describe("Claude Code hosted tool bridge", () => {
  it("always supplies a private strict-MCP configuration and removes it idempotently", async () => {
    const bridge = await startClaudeCodeHostedToolBridge(undefined, "run-empty", new AbortController().signal);
    expect(bridge.allowedTools).toEqual([]);
    await expect(readFile(bridge.configPath, "utf8")).resolves.toBe('{"mcpServers":{}}\n');
    expect((await stat(bridge.configPath)).mode & 0o777).toBe(0o600);

    await bridge.close();
    await bridge.close();
    await expect(readFile(bridge.configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves only authenticated OpenTag tools over owned loopback HTTP", async () => {
    const handler = vi.fn<AgentHostedTools["handler"]>(async (call) => ({
      success: call.name === "opentag_message_reply",
      content: [{ type: "text", text: call.name }],
      ...(call.name === "opentag_message_send" ? { error: { code: "IM_FAILED", message: "send failed" } } : {}),
    }));
    const bridge = await startClaudeCodeHostedToolBridge(
      {
        definitions: [
          {
            name: "opentag_message_reply",
            description: "Reply to the current conversation",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
          { name: "opentag_message_send", inputSchema: { type: "object" } },
        ],
        handler,
      },
      "run-1",
      new AbortController().signal,
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

    expect(bridge.allowedTools).toEqual(["mcp__opentag__opentag_message_reply", "mcp__opentag__opentag_message_send"]);
    await expect(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { capabilities: { tools: {} }, serverInfo: { name: "OpenTag" } } });
    await expect(
      rpc({ jsonrpc: "2.0", id: "list", method: "tools/list" }).then((response) => response.json()),
    ).resolves.toMatchObject({
      result: { tools: [{ name: "opentag_message_reply" }, { name: "opentag_message_send" }] },
    });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    await expect(
      rpc({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: { name: "opentag_message_reply", arguments: { text: "hello" } },
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { content: [{ text: "opentag_message_reply" }], isError: false } });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        toolCallId: "call-1",
        name: "opentag_message_reply",
        input: { text: "hello" },
      }),
    );
    await expect(
      rpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "opentag_message_send", arguments: {} },
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { isError: true, structuredContent: { error: { code: "IM_FAILED" } } } });
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
        params: { name: "opentag_message_reply", arguments: undefined },
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { isError: false } });
    await expect(
      rpc({
        jsonrpc: "2.0",
        id: {},
        method: "tools/call",
        params: { name: "opentag_message_reply", arguments: BigInt(1).toString() },
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ result: { isError: false } });
    await expect(
      rpc(
        '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"opentag_message_reply","arguments":1e400}}',
      ).then((response) => response.json()),
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
    await expect(startClaudeCodeHostedToolBridge(undefined, "run", controller.signal)).rejects.toThrow(
      "turn cancelled",
    );
    const definition = { name: "duplicate", inputSchema: { type: "object" } } as const;
    await expect(
      startClaudeCodeHostedToolBridge(
        { definitions: [definition, definition], handler: async () => ({ success: true, content: [] }) },
        "run",
        new AbortController().signal,
      ),
    ).rejects.toThrow("unique names");
  });
});
