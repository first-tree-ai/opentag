import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";

const PI_CLI = fileURLToPath(
  new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture HTTP server has no port");
  return address.port;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function jsonBody(request: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

it("exposes only one MCP proxy and completes a bearer-authorized tool call through real Pi RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-pi-mcp-smoke-"));
  const piHome = join(root, "pi");
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions");
  await Promise.all([mkdir(piHome), mkdir(workspace), mkdir(sessions)]);
  const bearer = "otmg_fixture_execution";
  const mcpCalls: Array<{ method: unknown; authorization: string | undefined; params: unknown }> = [];
  const modelCalls: Record<string, unknown>[] = [];
  const mcpServer = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    const rpc = await jsonBody(request);
    mcpCalls.push({ method: rpc.method, authorization: request.headers.authorization, params: rpc.params });
    if (rpc.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: (rpc.params as { protocolVersion: string }).protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          }
        : rpc.method === "tools/list"
          ? {
              tools: [
                {
                  name: "fixture_ping",
                  description: "Fixture ping tool",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : { content: [{ type: "text", text: "pong" }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  const modelServer = createServer(async (request, response) => {
    modelCalls.push(await jsonBody(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta =
      modelCalls.length === 1
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fixture-tool-call",
                type: "function",
                function: { name: "mcp", arguments: JSON.stringify({ tool: "fixture_ping", args: {} }) },
              },
            ],
          }
        : { role: "assistant", content: "done" };
    for (const choice of [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: modelCalls.length === 1 ? "tool_calls" : "stop" },
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  });
  let runtime: Awaited<ReturnType<PiAgentRuntimeFactory["create"]>> | undefined;
  try {
    await Promise.all([listen(mcpServer), listen(modelServer)]);
    await Promise.all([
      writeFile(
        join(piHome, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: `http://127.0.0.1:${portOf(modelServer)}/v1`,
              models: [{ id: "mock", name: "mock", contextWindow: 128_000, maxTokens: 2_048 }],
            },
          },
        }),
      ),
      writeFile(join(piHome, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-key" } })),
    ]);
    const factory = new PiAgentRuntimeFactory({
      process: {
        command: process.execPath,
        args: [PI_CLI],
        env: { ...process.env, PI_CODING_AGENT_DIR: piHome },
        sessionDirectory: sessions,
      },
    });
    runtime = await factory.create({
      eventSink: () => undefined,
      systemPrompt: "Use the mcp tool when needed.",
      workspace: { cwd: workspace },
      policy: {
        approvals: "never",
        fileSystem: "unrestricted",
        network: "enabled",
        tools: { mode: "provider-default" },
      },
      configuration: {
        model: "fixture/mock",
        provider: {
          mcpGateway: { url: `http://127.0.0.1:${portOf(mcpServer)}/api/v1/mcp`, token: bearer },
        },
      },
    });
    const result = await runtime.prompt({
      runId: "mcp-real-rpc-smoke",
      input: { items: [{ type: "text", text: "Call the fixture MCP tool." }] },
      signal: AbortSignal.timeout(25_000),
    });
    expect(result).toMatchObject({ status: "completed", output: [{ type: "text", text: "done" }] });
    const tools = ((modelCalls[0]?.tools as Array<{ function?: { name?: string } }> | undefined) ?? []).map(
      (tool) => tool.function?.name,
    );
    expect(tools.filter((name) => name?.startsWith("mcp"))).toEqual(["mcp"]);
    expect(modelCalls).toHaveLength(2);
    expect(mcpCalls.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(mcpCalls.at(-1)?.params).toMatchObject({ name: "fixture_ping" });
    expect(mcpCalls.every((call) => call.authorization === `Bearer ${bearer}`)).toBe(true);
    expect(JSON.stringify(modelCalls)).not.toContain(bearer);
    expect(JSON.stringify(runtime.binding)).not.toContain(bearer);
  } finally {
    await runtime?.close();
    await Promise.all([close(mcpServer), close(modelServer)]);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
